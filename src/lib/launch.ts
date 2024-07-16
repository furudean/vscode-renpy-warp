import * as vscode from 'vscode'
import path from 'upath'
import { sh } from 'puka'

import { focus_window, ProcessManager, RenpyProcess } from './process'
import { FollowCursor, sync_editor_with_renpy } from './follow_cursor'
import { get_config, show_file } from './util'
import { get_logger } from './logger'
import { find_game_root, get_editor_path, get_executable, add_env } from './sh'
import { has_any_rpe, has_current_rpe, install_rpe } from './rpe'
import { start_websocket_server, get_open_port } from './socket'
import { StatusBar } from './status_bar'
import { get_sdk_path } from './path'
import { prompt_configure_extensions } from './onboard'

const logger = get_logger()

interface LaunchRenpyOptions {
	intent?: string
	/**
	 * fs path representing the current editor. selects the file to warp to. if
	 * null, simply open ren'py and detect the project root
	 */
	file?: string
	/** zero-indexed line number. if set, warp to line will be attempted */
	line?: number
	context: vscode.ExtensionContext
	pm: ProcessManager
	follow_cursor: FollowCursor
	status_bar: StatusBar
}

/**
 * starts or warps depending on arguments and settings specified for the
 * extension
 *
 * if strategy is `Update Window`, no new window is opened and the current one
 * is updated instead.
 *
 * @returns
 * resolves with the process if a new instance was opened, otherwise undefined
 */
export async function launch_renpy({
	intent,
	file,
	line,
	context,
	pm,
	status_bar,
	follow_cursor,
}: LaunchRenpyOptions): Promise<RenpyProcess | undefined> {
	const is_development_mode =
		context.extensionMode === vscode.ExtensionMode.Development

	logger.info('launch_renpy:', { file, line })

	if (!file) {
		file = await vscode.workspace
			.findFiles('**/game/**/*.rpy', null, 1)
			.then((files) => (files.length ? files[0].fsPath : undefined))
	}

	if (!file) {
		vscode.window.showErrorMessage("No Ren'Py project in workspace", 'OK')
		return
	}

	const game_root = find_game_root(file)
	const filename_relative = path.relative(path.join(game_root, 'game/'), file)
	logger.debug('game root:', game_root)

	if (!game_root) {
		vscode.window.showErrorMessage(
			'Unable to find "game" folder in parent directory. Not a Ren\'Py project?',
			'OK'
		)
		logger.info(`cannot find game root in ${file}`)
		return
	}

	const strategy = get_config('strategy')
	let extensions_enabled = get_config('renpyExtensionsEnabled')

	if (
		pm.length &&
		line !== undefined &&
		Number.isInteger(line) &&
		strategy === 'Update Window' &&
		extensions_enabled === 'Enabled'
	) {
		await vscode.window.withProgress(
			{
				title: 'Warping inside window' + (intent ? ' ' + intent : ''),
				location: vscode.ProgressLocation.Notification,
			},
			async () => {
				logger.info('warping in existing window')

				const rpp = pm.at(-1) as RenpyProcess

				await rpp.warp_to_line(filename_relative, line + 1)

				if (get_config('focusWindowOnWarp') && rpp.process?.pid) {
					logger.info('focusing window')
					await focus_window(rpp.process.pid)
				}
			}
		)

		return
	} else {
		logger.info("opening new ren'py window")

		status_bar.update(({ starting_processes }) => ({
			starting_processes: starting_processes + 1,
		}))

		try {
			const sdk_path = await get_sdk_path()
			if (!sdk_path) return

			const executable = await get_executable(sdk_path, true)
			if (!executable) return

			if (extensions_enabled === 'Not set') {
				extensions_enabled = await prompt_configure_extensions(
					executable
				)
			}

			if (extensions_enabled === 'Enabled') {
				if (!(await has_any_rpe(sdk_path))) {
					const installed_path = await install_rpe({
						sdk_path,
						game_root,
						context,
						executable,
					})
					vscode.window
						.showInformationMessage(
							`Ren'Py Extensions were installed at ${installed_path}`,
							'OK',
							'Show'
						)
						.then((selection) => {
							if (selection === 'Show') {
								show_file(installed_path)
							}
						})
				} else if (!(await has_current_rpe({ executable, sdk_path }))) {
					const installed_path = await install_rpe({
						sdk_path,
						game_root,
						context,
						executable,
					})
					vscode.window
						.showInformationMessage(
							"Ren'Py extensions have been updated",
							'OK',
							'Show'
						)
						.then((selection) => {
							if (selection === 'Show') {
								show_file(installed_path)
							}
						})
				} else if (is_development_mode) {
					await install_rpe({
						sdk_path,
						game_root,
						context,
						executable,
					})
				}
			}

			let socket_port: number | undefined

			if (extensions_enabled === 'Enabled') {
				socket_port = await get_open_port()
				await start_websocket_server({
					pm,
					port: socket_port,
				})
			}

			if (strategy === 'Replace Window') pm.kill_all()

			const renpy_sh = await add_env(executable, {
				WARP_ENABLED:
					extensions_enabled === 'Enabled' ? '1' : undefined,
				WARP_WS_PORT: socket_port?.toString(),
				RENPY_EDIT_PY: await get_editor_path(sdk_path),
			})
			if (!renpy_sh) throw new Error('no renpy.sh found')

			let cmd: string

			if (line === undefined) {
				cmd = renpy_sh + ' ' + sh`${game_root}`
			} else {
				cmd =
					renpy_sh +
					' ' +
					sh`${game_root} --warp ${filename_relative}:${line + 1}`
			}

			return await vscode.window.withProgress(
				{
					title: "Starting Ren'Py" + (intent ? ' ' + intent : ''),
					location: vscode.ProgressLocation.Notification,
					cancellable: true,
				},
				async (_, cancel) => {
					const rpp = new RenpyProcess({
						cmd,
						game_root,
						socket_port,
						async message_handler(message) {
							if (message.type === 'current_line') {
								logger.debug(
									`current line reported as ${message.relative_path}:${message.line}`
								)
								if (!follow_cursor.active_process) return

								await sync_editor_with_renpy({
									path: message.path,
									relative_path: message.relative_path,
									line: message.line - 1,
								})
							} else {
								logger.warn('unhandled message:', message)
							}
						},
						context,
					})
					pm.add(rpp)

					if (
						extensions_enabled === 'Enabled' &&
						(get_config('followCursorOnLaunch') ||
							follow_cursor.active_process) // follow cursor is already active, replace it
					) {
						logger.info('enabling follow cursor for new process')
						await follow_cursor.set(rpp)
					}

					const cancelation = cancel.onCancellationRequested(() => {
						rpp.kill()
						status_bar.update(({ starting_processes }) => ({
							starting_processes: starting_processes - 1,
						}))
					})

					if (extensions_enabled === 'Enabled') {
						logger.info('waiting for process to connect to socket')

						while (!rpp.socket && !rpp.dead) {
							await new Promise((resolve) =>
								setTimeout(resolve, 100)
							)
						}
						if (rpp.dead) throw new Error('panic')

						logger.debug('process connected to socket first time')
					}

					status_bar.update(({ starting_processes }) => ({
						starting_processes: starting_processes - 1,
					}))
					cancelation.dispose()

					return rpp
				}
			)
		} catch (e) {
			status_bar.update(({ starting_processes }) => ({
				starting_processes: starting_processes - 1,
			}))
			throw e
		}
	}
}
