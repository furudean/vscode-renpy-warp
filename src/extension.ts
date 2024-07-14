import * as vscode from 'vscode'

import { ProcessManager } from './lib/process'
import { FollowCursor } from './lib/follow_cursor'
import { get_logger } from './lib/logger'
import { find_game_root, get_executable } from './lib/sh'
import { install_rpe, uninstall_rpes } from './lib/rpe'
import { launch_renpy } from './lib/launch'
import { get_config, set_config } from './lib/util'
import {
	resolve_path,
	path_exists,
	path_is_sdk,
	get_sdk_path,
} from './lib/path'
import { StatusBar } from './lib/status_bar'

const logger = get_logger()

export function activate(context: vscode.ExtensionContext) {
	const status_bar = new StatusBar()
	const follow_cursor = new FollowCursor({ status_bar })
	const pm = new ProcessManager({ status_bar })

	context.subscriptions.push(pm, follow_cursor, status_bar)

	context.subscriptions.push(
		vscode.commands.registerCommand('renpyWarp.warpToLine', async () => {
			try {
				await launch_renpy({
					intent: 'at line',
					file: vscode.window.activeTextEditor?.document.uri.fsPath,
					line: vscode.window.activeTextEditor?.selection.active.line,
					context,
					pm,
					follow_cursor,
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
						follow_cursor,
						status_bar,
					})
				} catch (error: any) {
					logger.error(error)
				}
			}
		),

		vscode.commands.registerCommand('renpyWarp.launch', async () => {
			try {
				await launch_renpy({ context, pm, follow_cursor, status_bar })
			} catch (error: any) {
				logger.error(error)
			}
		}),

		vscode.commands.registerCommand('renpyWarp.toggleFollowCursor', () => {
			if (follow_cursor.active) {
				follow_cursor.disable()
			} else {
				if (pm.length > 1) {
					vscode.window.showErrorMessage(
						"Can't follow cursor with multiple open processes",
						'OK'
					)
					return
				}

				const process = pm.at(0)

				if (process === undefined) {
					vscode.window.showErrorMessage(
						"Ren'Py not running. Cannot follow cursor.",
						'OK'
					)
					return
				}

				follow_cursor.enable(process)
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

			const game_root = find_game_root(file_path)

			if (!game_root) {
				vscode.window.showErrorMessage(
					'Unable to find "game" folder in parent directory. Not a Ren\'Py project?',
					'OK'
				)
				return
			}

			const sdk_path = await get_sdk_path()
			if (!sdk_path) return

			const executable = await get_executable(sdk_path)
			if (!executable) {
				vscode.window
					.showErrorMessage(
						"Ren'Py SDK path is invalid. Please set it in the extension settings.",
						'Open settings'
					)
					.then((selection) => {
						if (selection === 'Open settings') {
							vscode.commands.executeCommand(
								'workbench.action.openSettings',
								'@ext:PaisleySoftworks.renpyWarp'
							)
						}
					})
				return
			}

			const installed_path = await install_rpe({
				sdk_path,
				game_root,
				context,
				executable,
			})

			await vscode.window.showInformationMessage(
				`Ren'Py extensions were successfully installed at ${installed_path}`,
				'OK'
			)
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

			set_config('sdkPath', input_path)

			return input_path
		})
	)
}

export function deactivate() {
	logger.dispose()
}
