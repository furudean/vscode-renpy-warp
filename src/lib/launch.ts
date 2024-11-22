import * as vscode from 'vscode'
import path from 'upath'
import child_process from 'child_process'

import { ProcessManager, ManagedProcess, AnyProcess } from './process'
import { get_config } from './config'
import { get_logger } from './logger'
import { get_editor_path, get_executable, find_project_root } from './sh'
import { prompt_install_rpe } from './rpe'
import { StatusBar } from './status_bar'
import { get_sdk_path, paths, prompt_projects_in_workspaces } from './path'
import { prompt_configure_extensions } from './onboard'
import { focus_window } from './window'
import { WarpSocketService } from './socket'
import { mkdir, open } from 'fs/promises'

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
	wss: WarpSocketService
	extra_environment?: Record<string, string | undefined>
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
	wss,
	extra_environment,
}: LaunchRenpyOptions): Promise<ManagedProcess | undefined> {
	logger.info('launch_renpy:', { file, line })

	const strategy = get_config('strategy')
	let extensions_enabled = get_config('renpyExtensionsEnabled')

	if (
		file &&
		pm.length &&
		line !== undefined &&
		Number.isInteger(line) &&
		strategy === 'Update Window' &&
		extensions_enabled === 'Enabled'
	) {
		logger.info('warping in existing window')

		const project_root = find_project_root(file)
		logger.debug('game root:', project_root)

		const filename_relative = path.relative(
			path.join(project_root, 'game/'),
			file
		)

		const rpp = pm.at(-1) as AnyProcess

		const promises = [rpp.warp_to_line(filename_relative, line + 1)]

		if (get_config('focusWindowOnWarp') && rpp.pid) {
			promises.push(focus_window(rpp.pid))
		}

		await Promise.all(promises)

		status_bar.notify(
			`$(debug-line-by-line) Warped to ${filename_relative}:${line + 1}`
		)

		return
	} else {
		logger.info("opening new ren'py window")

		const nonce = Math.trunc(Math.random() * Number.MAX_SAFE_INTEGER)
		status_bar.set_process(nonce, 'starting')

		const project_root = file
			? find_project_root(file)
			: await prompt_projects_in_workspaces()

		if (!project_root) {
			status_bar.delete_process(nonce)
			return
		}

		try {
			const sdk_path = await get_sdk_path()
			if (!sdk_path) {
				status_bar.delete_process(nonce)
				return undefined
			}

			const executable = await get_executable(sdk_path, true)
			if (!executable) {
				status_bar.delete_process(nonce)
				return undefined
			}
			if (extensions_enabled === 'Not set') {
				await prompt_configure_extensions(executable)
				extensions_enabled = get_config('renpyExtensionsEnabled')
			}

			if (extensions_enabled === 'Enabled') {
				const installed_path = await prompt_install_rpe(context)

				if (!installed_path) {
					status_bar.delete_process(nonce)
					return undefined
				}

				await wss.start()
			}

			if (strategy === 'Replace Window') pm.at(-1)?.kill()

			let cmds = [...executable, project_root]

			if (file && line !== undefined) {
				const filename_relative = path.relative(
					path.join(project_root, 'game/'),
					file
				)
				cmds = [...cmds, '--warp', `${filename_relative}:${line + 1}`]
			}

			const process_env: Record<string, string | undefined> = {
				...process.env,
				...(get_config('processEnvironment') as object),
				...extra_environment,
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
						'spawning process:',
						Object.entries(process_env)
							.map(([k, v]) => `${k}="${v}"`)
							.join(' '),
						cmds.map((k) => `"${k}"`).join(' ')
					)

					const log_file = path.join(
						paths.log,
						`process-${nonce}.log`
					)
					await mkdir(paths.log, { recursive: true })
					const file_handle = await open(log_file, 'w+')
					logger.info('logging to', log_file)

					const process = child_process.spawn(
						cmds[0],
						cmds.slice(1),
						{
							env: process_env,
							detached: true,
							stdio: ['ignore', file_handle.fd, file_handle.fd],
						}
					)
					process.on('error', (e) => {
						logger.error('process error:', e)
					})

					// close the file handle for parent process, since the child has a copy
					file_handle.close()

					if (!process.pid) {
						throw new Error('failed to start process')
					}

					logger.info('sucessfully spawned process', process.pid)

					const rpp = new ManagedProcess({
						process,
						project_root,
						log_file,
					})
					rpp.on('exit', () => {
						status_bar.delete_process(nonce)
						file_handle.close()
					})

					cancel.onCancellationRequested(() => {
						rpp.kill()
					})
					pm.add(nonce, rpp)

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

					status_bar.set_process(nonce, 'idle')

					return rpp
				}
			)
		} catch (error) {
			status_bar.delete_process(nonce)
			throw error
		}
	}
}
