import * as vscode from 'vscode'

import { ProcessManager } from './lib/process/manager'
import { FollowCursor } from './lib/follow_cursor'
import { get_logger } from './lib/logger'
import { get_executable } from './lib/sh'
import { uninstall_rpes, prompt_install_rpe } from './lib/rpe'
import { launch_renpy } from './lib/launch'
import {
	get_config,
	get_configuration_object,
	set_config,
	show_file,
} from './lib/config'
import {
	resolve_path,
	path_exists,
	path_is_sdk,
	get_sdk_path,
} from './lib/path'
import { StatusBar } from './lib/status_bar'
import { prompt_configure_extensions } from './lib/onboard'
import { ensure_socket_server, stop_socket_server } from './lib/socket'
import { AnyProcess } from './lib/process'

const logger = get_logger()

export function activate(context: vscode.ExtensionContext) {
	const status_bar = new StatusBar()
	const follow_cursor = new FollowCursor({ status_bar })
	const pm = new ProcessManager()

	context.subscriptions.push(pm, follow_cursor, status_bar)

	const extensions_enabled = get_config('renpyExtensionsEnabled')

	pm.on('exit', () => {
		if (follow_cursor.active_process && extensions_enabled === 'Enabled') {
			const most_recent = pm.at(-1)

			if (most_recent) {
				follow_cursor.set(most_recent)
				status_bar.notify(
					`$(debug-line-by-line) Now following pid ${most_recent.pid}`
				)
			}
		}
	})

	pm.on('attach', async (rpp: AnyProcess) => {
		if (
			extensions_enabled === 'Enabled' &&
			(get_config('followCursorOnLaunch') || follow_cursor.active_process) // follow cursor is already active, replace it
		) {
			logger.info('enabling follow cursor for new process')
			await follow_cursor.set(rpp)

			if (pm.length > 1) {
				status_bar.notify(
					`$(debug-line-by-line) Now following pid ${rpp.pid}`
				)
			}
		}
	})

	context.subscriptions.push(
		vscode.commands.registerCommand('renpyWarp.warpToLine', async () => {
			const editor = vscode.window.activeTextEditor
			if (!editor) return

			try {
				await launch_renpy({
					intent: 'at line',
					file: editor?.document.uri.fsPath,
					line: editor?.selection.active.line,
					context,
					pm,
					status_bar,
					follow_cursor,
				})
			} catch (error: unknown) {
				logger.error(error as Error)
			}
		}),

		vscode.commands.registerCommand(
			'renpyWarp.warpToFile',
			async (uri: vscode.Uri) => {
				const fs_path = uri
					? uri.fsPath
					: vscode.window.activeTextEditor?.document.uri.fsPath

				try {
					await launch_renpy({
						intent: 'at file',
						file: fs_path,
						line: 0,
						context,
						pm,
						status_bar,
						follow_cursor,
					})
				} catch (error: unknown) {
					logger.error(error as Error)
				}
			}
		),

		vscode.commands.registerCommand('renpyWarp.launch', async () => {
			try {
				await launch_renpy({ context, pm, status_bar, follow_cursor })
			} catch (error: unknown) {
				logger.error(error as Error)
			}
		}),

		vscode.commands.registerCommand('renpyWarp.toggleFollowCursor', () => {
			if (follow_cursor.active_process) {
				follow_cursor.off()
			} else {
				const process = pm.at(-1)

				if (process === undefined) {
					vscode.window.showErrorMessage(
						"Ren'Py not running. Cannot follow cursor.",
						'OK'
					)
					return
				}

				follow_cursor.set(process)
			}
		}),

		vscode.commands.registerCommand('renpyWarp.killAll', () =>
			pm.kill_all()
		),

		vscode.commands.registerCommand('renpyWarp.installRpe', async () => {
			const installed_path = await prompt_install_rpe(context)
			if (!installed_path) return

			vscode.window
				.showInformationMessage(
					`Ren'Py extensions were successfully installed at ${installed_path}`,
					'OK',
					'Show'
				)
				.then(async (selection) => {
					if (selection === 'Show') {
						await show_file(installed_path)
					}
				})
		}),

		vscode.commands.registerCommand('renpyWarp.uninstallRpe', async () => {
			const sdk_path = await get_sdk_path()
			if (!sdk_path) return

			await uninstall_rpes(sdk_path)
			vscode.window.showInformationMessage(
				"Ren'Py extensions were successfully uninstalled from the project and SDK"
			)
		}),

		vscode.commands.registerCommand('renpyWarp.setSdkPath', async () => {
			const input_path = await vscode.window.showInputBox({
				title: "Set Ren'Py SDK path",
				prompt: "Input path to the Ren'Py SDK you want to use",
				value: get_config('sdkPath') as string,
				placeHolder: '~/renpy-8.2.3-sdk',
				ignoreFocusOut: true,
				async validateInput(value) {
					const parsed_path = resolve_path(value)
					const exists = await path_exists(parsed_path)
					if (!exists) return 'Path does not exist'

					const is_sdk = await path_is_sdk(parsed_path)
					if (!is_sdk) return "Path is not a Ren'Py SDK"

					return null
				},
			})
			if (!input_path) return

			await set_config('sdkPath', input_path)

			return input_path
		}),

		vscode.commands.registerCommand(
			'renpyWarp.setExtensionsPreference',
			async () => {
				const sdk_path = await get_sdk_path()
				if (!sdk_path) return

				const executable = await get_executable(sdk_path, true)
				if (!executable) return

				try {
					await prompt_configure_extensions(executable.join(' '))
				} catch (error: unknown) {
					logger.error(error as Error)
				}
			}
		),

		vscode.commands.registerCommand(
			'renpyWarp.startSocketServer',
			async () => {
				if (get_config('renpyExtensionsEnabled') === 'Enabled') {
					const started = await ensure_socket_server({
						pm,
						status_bar,
						follow_cursor,
						context,
					})
					if (!started) {
						vscode.window
							.showErrorMessage(
								'Failed to start socket server',
								'OK',
								'Logs'
							)
							.then((selection) => {
								if (selection === 'Logs') {
									logger.show()
								}
							})
					}
				} else {
					vscode.window.showErrorMessage(
						"Ren'Py extensions must be enabled to use the socket server",
						'OK'
					)
				}
			}
		),

		vscode.commands.registerCommand('renpyWarp.stopSocketServer', () => {
			stop_socket_server(pm, status_bar)
		})
	)

	const save_text_handler = vscode.workspace.onWillSaveTextDocument(
		async ({ document }) => {
			try {
				if (!document.fileName.endsWith('.rpy')) return
				if (document.isDirty === false) return
				if (get_config('setAutoReloadOnSave') !== true) return

				if (
					vscode.window.activeTextEditor?.selection.active.line ===
					undefined
				)
					return

				for (const process of pm) {
					if (!process.socket) return

					logger.info('reloading process on save', process.pid)
					await process.set_autoreload()
				}
			} catch (error: unknown) {
				logger.error(error as Error)
			}
		}
	)

	context.subscriptions.push(save_text_handler)

	const conf = get_configuration_object()
	// migrate settings from version<=1.5.0 where renpyExtensionsEnabled was a boolean
	if (
		typeof conf.inspect('renpyExtensionsEnabled')?.globalValue === 'boolean'
	) {
		set_config('renpyExtensionsEnabled', undefined, false)
	}
	if (
		typeof conf.inspect('renpyExtensionsEnabled')?.workspaceValue ===
		'boolean'
	) {
		set_config('renpyExtensionsEnabled', undefined, true)
	}

	if (
		extensions_enabled === 'Enabled' &&
		get_config('autoStartSocketServer')
	) {
		ensure_socket_server({ pm, status_bar, follow_cursor, context }).catch(
			(error) => {
				logger.error('failed to start socket server:', error)
			}
		)
	}

	if (extensions_enabled === 'Enabled') {
		prompt_install_rpe(context).catch((error) => {
			logger.error(error)
			vscode.window
				.showErrorMessage('Failed to install RPE', 'Logs', 'OK')
				.then((selection) => {
					if (selection === 'Logs') {
						logger.show()
					}
				})
		})
	}

	const server_on_change = vscode.workspace.onDidChangeConfiguration((e) => {
		if (
			e.affectsConfiguration('renpyWarp.autoStartSocketServer') ||
			e.affectsConfiguration('renpyWarp.renpyExtensionsEnabled')
		) {
			logger.info('server settings changed')
			if (
				get_config('autoStartSocketServer') &&
				get_config('renpyExtensionsEnabled') === 'Enabled'
			) {
				ensure_socket_server({ pm, status_bar, follow_cursor, context })
			} else {
				stop_socket_server(pm, status_bar)
			}
		}
	})
	context.subscriptions.push(server_on_change)
}

export function deactivate() {
	logger.dispose()
}
