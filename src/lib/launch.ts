import * as vscode from 'vscode'
import path from 'upath'
import child_process from 'child_process'

import { ProcessManager, ManagedProcess, AnyProcess } from './process'
import { get_config, show_file } from './config'
import { get_logger } from './logger'
import { get_editor_path, get_executable, find_project_root } from './sh'
import { has_current_rpe, install_rpe } from './rpe'
import { StatusBar } from './status_bar'
import { get_sdk_path } from './path'
import { prompt_configure_extensions } from './onboard'
import { focus_window } from './window'

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
}: LaunchRenpyOptions): Promise<ManagedProcess | undefined> {
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

	const project_root = find_project_root(file)
	const filename_relative = path.relative(
		path.join(project_root, 'game/'),
		file
	)
	logger.debug('game root:', project_root)

	if (!project_root) {
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
		logger.info('warping in existing window')

		const rpp = pm.at(-1) as AnyProcess

		await rpp.warp_to_line(filename_relative, line + 1)

		status_bar.notify(
			`$(debug-line-by-line) Warped to ${filename_relative}:${line + 1}`
		)

		if (get_config('focusWindowOnWarp') && rpp.pid) {
			logger.info('focusing window')
			await focus_window(rpp.pid)
		}

		return
	} else {
		logger.info("opening new ren'py window")

		const run_id = Math.trunc(Math.random() * 2047483648)
		status_bar.set_process(run_id, 'starting')

		try {
			const sdk_path = await get_sdk_path()
			if (!sdk_path) return

			const executable = await get_executable(sdk_path, true)
			if (!executable) return
			const executable_flat = executable.join(' ')

			if (extensions_enabled === 'Not set') {
				await prompt_configure_extensions(executable.join(' '))
				extensions_enabled = get_config('renpyExtensionsEnabled')
			}

			if (extensions_enabled === 'Enabled') {
				if (
					!(await has_current_rpe({
						executable: executable_flat,
						sdk_path,
						context,
					}))
				) {
					const installed_path = await install_rpe({
						sdk_path,
						project_root,
						context,
						executable: executable_flat,
					})
					vscode.window
						.showInformationMessage(
							`Ren'Py Extensions were installed/updated`,
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
						project_root,
						context,
						executable: executable_flat,
					})
				}
			}

			let socket_port: number | undefined

			if (strategy === 'Replace Window') pm.kill_all()

			const nonce = Math.trunc(Math.random() * 2047483648)

			let cmds = [...executable, project_root]

			if (line !== undefined) {
				cmds = [...cmds, '--warp', `${filename_relative}:${line + 1}`]
			}

			const process_env = {
				WARP_IS_MANAGED: '1',
				WARP_WS_PORT: socket_port?.toString(),
				WARP_WS_NONCE: nonce.toString(),
				// see: https://www.renpy.org/doc/html/editor.html
				RENPY_EDIT_PY: await get_editor_path(sdk_path),
			}

			return await vscode.window.withProgress(
				{
					title: "Starting Ren'Py" + (intent ? ' ' + intent : ''),
					location: vscode.ProgressLocation.Notification,
					cancellable: true,
				},
				async (_, cancel) => {
					logger.info(
						'spawning process',
						cmds.join(' '),
						'\n',
						'with env',
						process_env
					)
					const process = child_process.spawn(
						cmds[0],
						cmds.slice(1),
						{
							env: process_env,
							stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
						}
					)
					process.on('error', (e) => {
						logger.error('process error:', e)
					})

					if (!process.pid) {
						throw new Error('failed to start process')
					}

					logger.info('sucessfully spawned process', process.pid)

					const rpp = new ManagedProcess({
						process,
						project_root: project_root,
					})
					pm.add(nonce, rpp)
					rpp.on('exit', () => {
						status_bar.delete_process(run_id)
					})

					cancel.onCancellationRequested(() => {
						rpp.kill()
					})

					if (extensions_enabled === 'Enabled') {
						try {
							await rpp.wait_for_socket(10_000)
						} catch (error: unknown) {
							logger.error('timed out waiting for socket:', error)
							if (rpp.dead === false) {
								vscode.window.showErrorMessage(
									"Timed out trying to connect to Ren'Py window. Is the socket client running?",
									'OK'
								)
							}
							throw error
						}
					}

					status_bar.set_process(run_id, 'idle')

					return rpp
				}
			)
		} catch (error) {
			status_bar.delete_process(run_id)
			throw error
		}
	}
}
