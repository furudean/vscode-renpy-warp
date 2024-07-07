import * as vscode from 'vscode'
import path from 'upath'
import { WebSocketServer } from 'ws'

import { ProcessManager } from './process'
import { FollowCursor } from './follow_cursor'
import { get_logger } from './logger'
import { find_game_root } from './sh'
import { install_rpe } from './rpe'
import { launch_renpy } from './launch'

const logger = get_logger()

let wss: WebSocketServer | undefined
let pm: ProcessManager
let follow_cursor: FollowCursor

function associate_progress_notification<T>(
	message: string,
	run: (...args: any[]) => Promise<T>
): (...args: any[]) => Promise<T> {
	return function (...args) {
		return new Promise((resolve) => {
			vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: message,
				},
				async () => {
					try {
						const result = await run(...args)
						resolve(result)
					} catch (err: any) {
						logger.error(err)
						resolve(err)
					}
				}
			)
		})
	}
}

export function activate(context: vscode.ExtensionContext) {
	follow_cursor = new FollowCursor({ context })
	pm = new ProcessManager({ follow_cursor })
	follow_cursor.add_pm(pm)

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'renpyWarp.warpToLine',
			associate_progress_notification(
				'Warping to line...',
				async () =>
					await launch_renpy({
						file: vscode.window.activeTextEditor?.document.uri
							.fsPath,
						line: vscode.window.activeTextEditor?.selection.active
							.line,
						context,
						pm,
						follow_cursor,
					})
			)
		),

		vscode.commands.registerCommand(
			'renpyWarp.warpToFile',
			associate_progress_notification(
				'Warping to file...',
				/** @param {vscode.Uri} uri */
				async (uri: vscode.Uri) => {
					const fs_path = uri
						? uri.fsPath
						: vscode.window.activeTextEditor?.document.uri.fsPath

					await launch_renpy({
						file: fs_path,
						line: 0,
						context,
						pm,
						follow_cursor,
					})
				}
			)
		),

		vscode.commands.registerCommand(
			'renpyWarp.launch',
			associate_progress_notification(
				"Launching Ren'Py...",
				async () => await launch_renpy({ context, pm, follow_cursor })
			)
		),

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
	wss?.close()
	logger.dispose()
}
