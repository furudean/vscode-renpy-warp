import * as vscode from 'vscode'
import path from 'upath'
import { WebSocketServer } from 'ws'

import { focus_window, ProcessManager, RenpyProcess } from './process'
import { FollowCursor } from './follow_cursor'
import { get_config } from './util'
import { logger } from './logger'
import { find_game_root, get_renpy_sh, make_cmd } from './sh'
import { has_any_rpe, has_current_rpe, install_rpe } from './rpe'

let wss: WebSocketServer | undefined
let pm: ProcessManager

let follow_cursor: FollowCursor

let is_development_mode = false

interface SyncEditorWithRenpyOptions {
	/** absolute path to the file */
	path: string
	/** path relative from the game folder (e.g. `script.rpy`) */
	relative_path: string
	/** 0-indexed line number */
	line: number
}

async function sync_editor_with_renpy({
	path,
	relative_path,
	line,
}: SyncEditorWithRenpyOptions): Promise<void> {
	if (
		!["Ren'Py updates Visual Studio Code", 'Update both'].includes(
			get_config('followCursorMode')
		)
	)
		return

	// prevent feedback loop with warp to cursor
	//
	// TODO: this will still happen if renpy warps to a different line
	// than the one requested.

	// TODO: wtf
	// last_warp_spec = `${relative_path}:${line}`

	const doc = await vscode.workspace.openTextDocument(path)
	await vscode.window.showTextDocument(doc)
	const editor = vscode.window.activeTextEditor

	if (!editor) {
		logger.warn('no active text editor')
		return
	}

	// if the cursor is already on the correct line, don't munge it
	if (editor.selection.start.line !== line) {
		logger.debug(`syncing editor to ${relative_path}:${line}`)

		const end_of_line = editor.document.lineAt(line).range.end.character
		const pos = new vscode.Position(line, end_of_line)
		const selection = new vscode.Selection(pos, pos)

		editor.selection = selection
		editor.revealRange(selection)
	}
}

interface LaunchRenpyOptions {
	/**
	 * fs path representing the current editor. selects the file to warp to. if
	 * null, simply open ren'py and detect the project root
	 */
	file?: string
	/** zero-indexed line number. if set, warp to line will be attempted */
	line?: number
	context: vscode.ExtensionContext
}

/**
 * starts or warps depending on arguments and settings specified for the
 * extension
 *
 * if strategy is `Update Window`, no new window is opened and the current one
 * is updated instead.
 *
 * @returns
 * resolves with the child process if a new instance was opened, otherwise
 * undefined
 */
async function launch_renpy({
	file,
	line,
	context,
}: LaunchRenpyOptions): Promise<RenpyProcess | undefined> {
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
	const extensions_enabled = get_config('renpyExtensionsEnabled')

	if (
		pm.length &&
		line !== undefined &&
		Number.isInteger(line) &&
		strategy === 'Update Window' &&
		extensions_enabled
	) {
		logger.info('warping in existing window')

		if (pm.length > 1) {
			vscode.window.showErrorMessage(
				"Multiple Ren'Py instances running. Cannot warp inside open Ren'Py window.",
				'OK'
			)
			return
		}

		const rpp = pm.at(0) as RenpyProcess

		await rpp.warp_to_line(filename_relative, line + 1)

		if (get_config('focusWindowOnWarp') && rpp.process?.pid) {
			logger.info('focusing window')
			await focus_window(rpp.process.pid)
		}

		return
	} else {
		logger.info("opening new ren'py window")

		const renpy_sh = await get_renpy_sh({
			WARP_WS_PORT: get_config('webSocketsPort'),
		})
		if (!renpy_sh) return

		/** @type {string} */
		let cmd: string

		if (line === undefined) {
			cmd = renpy_sh + ' ' + make_cmd([game_root])
		} else {
			cmd =
				renpy_sh +
				' ' +
				make_cmd([
					game_root,
					'--warp',
					`${filename_relative}:${line + 1}`,
				])
		}

		if (strategy === 'Replace Window') pm.kill_all()

		if (get_config('renpyExtensionsEnabled')) {
			if (!(await has_any_rpe())) {
				const selection = await vscode.window.showInformationMessage(
					`Ren'Py Launch and Sync can install a script in your Ren'Py project to synchronize the game and editor. Would you like to install it?`,
					'Yes, install',
					'No, do not install'
				)
				if (selection === 'Yes, install') {
					await install_rpe({ game_root, context })
				} else {
					await vscode.workspace
						.getConfiguration('renpyWarp')
						.update('renpyExtensionsEnabled', false, true)

					vscode.window.showInformationMessage(
						'No RPE script will be installed. Keep in mind that some features may not work as expected.',
						'OK'
					)
				}
			} else if (!(await has_current_rpe(renpy_sh))) {
				await install_rpe({ game_root, context })
				vscode.window.showInformationMessage(
					"Ren'Py extensions in this project have been updated.",
					'OK'
				)
			} else if (is_development_mode) {
				await install_rpe({ game_root, context })
			}
		}

		const rp = new RenpyProcess({
			cmd,
			game_root,
			async message_handler(message) {
				if (message.type === 'current_line') {
					logger.debug(
						`current line reported as ${message.line} in ${message.relative_path}`
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
			pm,
		})
		pm.add(rp)

		if (
			follow_cursor.active === false &&
			extensions_enabled &&
			get_config('followCursorOnLaunch') &&
			pm.length === 1
		) {
			logger.info('enabling follow cursor on launch')
			await follow_cursor.enable()
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

		return rp
	}
}

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
	is_development_mode =
		context.extensionMode === vscode.ExtensionMode.Development

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
					})
				}
			)
		),

		vscode.commands.registerCommand(
			'renpyWarp.launch',
			associate_progress_notification(
				"Launching Ren'Py...",
				async () => await launch_renpy({ context })
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
		})
	)
}

export function deactivate() {
	pm.kill_all()
	wss?.close()
	logger.dispose()
}
