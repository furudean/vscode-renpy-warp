import * as vscode from 'vscode'

import { ProcessManager } from './lib/process/manager'
import { FollowCursor, sync_editor_with_renpy } from './lib/follow_cursor'
import { get_logger } from './lib/logger'
import { find_project_root, get_executable } from './lib/sh'
import { install_rpe, uninstall_rpes } from './lib/rpe'
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
import { get_socket_port, start_websocket_server } from './lib/socket'
import { AnyProcess } from './lib/process'

const logger = get_logger()

async function ensure_socket_server(
	pm: ProcessManager,
	status_bar: StatusBar,
	follow_cursor: FollowCursor,
	context: vscode.ExtensionContext
): Promise<void> {
	const file_path = await vscode.workspace
		.findFiles('**/game/**/*.rpy', null, 1)
		.then((files) => (files.length ? files[0].fsPath : null))

	if (!file_path) {
		throw new Error("No Ren'Py project in workspace")
	}

	const project_root = find_project_root(file_path)

	if (!project_root) {
		throw new Error("No Ren'Py project in workspace")
	}

	const port = await get_socket_port()
	const server = await start_websocket_server({
		port,
		pm,
		status_bar,
		project_root,
		async message_handler(process, message) {
			if (message.type === 'current_line') {
				logger.debug(
					`current line reported as ${message.relative_path}:${message.line}`
				)
				if (follow_cursor.active_process === process) {
					await sync_editor_with_renpy({
						path: message.path,
						relative_path: message.relative_path,
						line: message.line - 1,
					})
				}
			} else {
				logger.warn('unhandled message:', message)
			}
		},
	})

	context.subscriptions.push({
		dispose() {
			server.close()
		},
	})
}

export function activate(context: vscode.ExtensionContext) {
	const status_bar = new StatusBar()
	const follow_cursor = new FollowCursor({ status_bar })
	const pm = new ProcessManager()

	context.subscriptions.push(pm, follow_cursor, status_bar)

	const extensions_enabled = get_config('renpyExtensionsEnabled')

	pm.on('exit', () => {
		if (
			follow_cursor.active_process &&
			get_config('renpyExtensionsEnabled') === 'Enabled'
		) {
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

	if (extensions_enabled === 'Enabled') {
		ensure_socket_server(pm, status_bar, follow_cursor, context).catch(
			(error) => {
				logger.error(error)
			}
		)
	}

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
				})
			} catch (error: any) {
				logger.error(error)
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
					})
				} catch (error: any) {
					logger.error(error)
				}
			}
		),

		vscode.commands.registerCommand('renpyWarp.launch', async () => {
			try {
				await launch_renpy({ context, pm, status_bar })
			} catch (error: any) {
				logger.error(error)
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
			const file_path = await vscode.workspace
				.findFiles('**/game/**/*.rpy', null, 1)
				.then((files) => (files.length ? files[0].fsPath : null))

			if (!file_path) {
				vscode.window.showErrorMessage(
					"No Ren'Py project in workspace",
					'OK'
				)
				return
			}

			const project_root = find_project_root(file_path)

			if (!project_root) {
				vscode.window.showErrorMessage(
					'Unable to find "game" folder in parent directory. Not a Ren\'Py project?',
					'OK'
				)
				return
			}

			const sdk_path = await get_sdk_path()
			if (!sdk_path) return

			const executable = await get_executable(sdk_path, true)
			if (!executable) return

			const installed_path = await install_rpe({
				sdk_path,
				project_root,
				context,
				executable: executable.join(' '),
			})

			const selection = await vscode.window.showInformationMessage(
				`Ren'Py extensions were successfully installed at ${installed_path}`,
				'OK',
				'Show'
			)

			if (selection === 'Show') {
				await show_file(installed_path)
			}
		}),

		vscode.commands.registerCommand('renpyWarp.uninstallRpe', async () => {
			const sdk_path = await get_sdk_path()
			if (!sdk_path) return

			await uninstall_rpes(sdk_path)
			vscode.window.showInformationMessage(
				"Ren'Py extensions were successfully uninstalled from the project and SDK",
				'OK'
			)
		}),

		vscode.commands.registerCommand('renpyWarp.setSdkPath', async () => {
			const input_path = await vscode.window.showInputBox({
				title: "Set Ren'Py SDK path",
				prompt: "Input path to the Ren'Py SDK you want to use",
				value: get_config('sdkPath'),
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
				} catch (error: any) {
					logger.error(error)
				}
			}
		)
	)

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

	const save_text_handler = vscode.workspace.onWillSaveTextDocument(
		async ({ document }) => {
			try {
				if (document.languageId !== 'renpy') return
				if (document.isDirty === false) return
				if (get_config('warpOnSave') !== true) return

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
			} catch (error: any) {
				logger.error(error)
			}
		}
	)

	context.subscriptions.push(save_text_handler)
}

export function deactivate() {
	logger.dispose()
}
