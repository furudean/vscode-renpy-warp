import * as vscode from 'vscode'
import path from 'upath'
import { sh } from 'puka'

import { focus_window, ProcessManager, RenpyProcess } from './process'
import { FollowCursor, sync_editor_with_renpy } from './follow_cursor'
import { get_config } from './util'
import { get_logger } from './logger'
import { find_game_root, get_renpy_sh } from './sh'
import { has_any_rpe, has_current_rpe, install_rpe } from './rpe'
import { start_websocket_server, get_open_port } from './socket'
import { StatusBar } from './status_bar'

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
		extensions_enabled
	) {
		if (pm.length > 1) {
			vscode.window.showErrorMessage(
				"Multiple Ren'Py instances running. Cannot warp inside open Ren'Py window.",
				'OK'
			)
			return
		}

		await vscode.window.withProgress(
			{
				title: 'Warping inside window' + (intent ? ' ' + intent : ''),
				location: vscode.ProgressLocation.Notification,
			},
			async () => {
				logger.info('warping in existing window')

				const rpp = pm.at(0) as RenpyProcess

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
			const socket_port = await get_open_port()

			const renpy_sh = await get_renpy_sh({
				WARP_ENABLED: extensions_enabled ? '1' : undefined,
				WARP_WS_PORT: socket_port.toString(),
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

			if (extensions_enabled) {
				if (!(await has_any_rpe())) {
					const selection =
						await vscode.window.showInformationMessage(
							`Before we start: Ren'Py Launch and Sync can install a script to synchronize the game and editor. Would you like to install it?`,
							'Yes, install',
							'No, never install',
							'Cancel'
						)
					if (selection === 'Yes, install') {
						const installed_path = await install_rpe({
							renpy_sh,
							game_root,
							context,
						})

						vscode.window.showInformationMessage(
							`Ren'Py Extensions were installed at ${installed_path}`,
							'OK'
						)
					} else if (selection === 'No, never install') {
						extensions_enabled = false
						await vscode.workspace
							.getConfiguration('renpyWarp')
							.update('renpyExtensionsEnabled', false, true)

						vscode.window.showInformationMessage(
							'No RPE script will be installed. Keep in mind that some features are disabled without it.',
							'OK'
						)
					} else {
						throw new Error('user cancelled')
					}
					logger.info('selected:', selection)
				} else if (!(await has_current_rpe(renpy_sh))) {
					await install_rpe({ game_root, context, renpy_sh })
					vscode.window.showInformationMessage(
						"Ren'Py extensions in project/SDK have been updated.",
						'OK'
					)
				} else if (is_development_mode) {
					await install_rpe({ game_root, context, renpy_sh })
				}

				await start_websocket_server({
					pm,
					port: socket_port,
				})
			}

			if (strategy === 'Replace Window') pm.kill_all()

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
								if (!follow_cursor.active) return

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
						!follow_cursor.active &&
						extensions_enabled &&
						get_config('followCursorOnLaunch') &&
						pm.length === 1
					) {
						logger.info('enabling follow cursor on launch')
						await follow_cursor.enable(rpp)
					}

					if (
						pm.length > 1 &&
						follow_cursor.active &&
						strategy !== 'Replace Window'
					) {
						follow_cursor.disable()
						vscode.window.showInformationMessage(
							"Follow cursor was disabled because multiple Ren'Py instances are running",
							'OK'
						)
					}

					const cancelation = cancel.onCancellationRequested(() => {
						rpp.kill()
						status_bar.update(({ starting_processes }) => ({
							starting_processes: starting_processes - 1,
						}))
					})

					if (extensions_enabled) {
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
			throw e
		} finally {
			status_bar.update(({ starting_processes }) => ({
				starting_processes: starting_processes - 1,
			}))
		}
	}
}
