import * as vscode from 'vscode'

import { ProcessManager } from './lib/process'
import { FollowCursor } from './lib/follow_cursor'
import { get_logger } from './lib/logger'
import { find_game_root } from './lib/sh'
import { install_rpe } from './lib/rpe'
import { launch_renpy } from './lib/launch'

const logger = get_logger()

let pm: ProcessManager
let follow_cursor: FollowCursor

export function activate(context: vscode.ExtensionContext) {
	follow_cursor = new FollowCursor({ context })
	pm = new ProcessManager({ follow_cursor })
	follow_cursor.add_pm(pm)

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
					})
				} catch (error: any) {
					logger.error(error)
				}
			}
		),

		vscode.commands.registerCommand('renpyWarp.launch', async () => {
			try {
				await launch_renpy({ context, pm, follow_cursor })
			} catch (error: any) {
				logger.error(error)
			}
		}),

		vscode.commands.registerCommand('renpyWarp.toggleFollowCursor', () => {
			if (follow_cursor.active) {
				follow_cursor.disable()
			} else {
				follow_cursor.enable()
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

			await vscode.workspace
				.getConfiguration('renpyWarp')
				.update('renpyExtensionsEnabled', true, true)

			await install_rpe({ game_root, context })

			await vscode.window.showInformationMessage(
				"Ren'Py extensions were successfully installed/updated"
			)
		})
	)
}

export function deactivate() {
	pm.kill_all()
	logger.dispose()
}
