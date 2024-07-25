import * as vscode from 'vscode'
import { get_config } from './util'
import { RenpyProcess } from './process'
import { get_logger } from './logger'
import path from 'upath'
import p_throttle from 'p-throttle'
import { find_game_root } from './sh'
import { StatusBar } from './status_bar'

const logger = get_logger()
const last_warps = new Map<number, string>()

interface SyncEditorWithRenpyOptions {
	/** absolute path to the file */
	path: string
	/** path relative from the game folder (e.g. `script.rpy`) */
	relative_path: string
	/** 0-indexed line number */
	line: number
}

export async function sync_editor_with_renpy({
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
	//
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

export async function warp_renpy_to_cursor(
	rp: RenpyProcess,
	status_bar: StatusBar
): Promise<void> {
	const editor = vscode.window.activeTextEditor

	if (!editor) return

	const language_id = editor.document.languageId
	const file = editor.document.uri.fsPath
	const line = editor.selection.active.line

	if (language_id !== 'renpy') return

	const game_root = find_game_root(file)
	const filename_relative = path.relative(path.join(game_root, 'game/'), file)

	const warp_spec = `${filename_relative}:${line + 1}`

	if (warp_spec === last_warps.get(process.pid)) return // no change
	last_warps.set(process.pid, warp_spec)

	if (!rp) {
		logger.warn('no renpy process found')
		return
	}

	await rp.warp_to_line(filename_relative, line + 1)
	status_bar.update(() => ({
		message: `$(debug-line-by-line) Warped to ${filename_relative}:${
			line + 1
		}`,
	}))
	logger.info('warped to', warp_spec)
}

const throttle = p_throttle({
	limit: 1,
	interval: get_config('followCursorExecInterval'),
})

const warp_renpy_to_cursor_throttled = throttle(warp_renpy_to_cursor)

export class FollowCursor {
	private status_bar: StatusBar
	private text_editor_handle: vscode.Disposable | undefined

	active_process: RenpyProcess | undefined

	constructor({ status_bar }: { status_bar: StatusBar }) {
		this.status_bar = status_bar
	}

	async set(process: RenpyProcess) {
		if (get_config('renpyExtensionsEnabled') !== 'Enabled') {
			vscode.window.showErrorMessage(
				"Follow cursor only works with Ren'Py extensions enabled.",
				'OK'
			)
			return
		}

		this.active_process = process

		this.text_editor_handle?.dispose()
		this.text_editor_handle = vscode.window.onDidChangeTextEditorSelection(
			async (event) => {
				if (
					[
						"Visual Studio Code updates Ren'Py",
						'Update both',
					].includes(get_config('followCursorMode')) &&
					event.kind !== vscode.TextEditorSelectionChangeKind.Command
				) {
					await warp_renpy_to_cursor_throttled(
						process,
						this.status_bar
					)
				}
			}
		)

		this.status_bar.update(() => ({
			is_follow_cursor: true,
		}))

		if (
			["Visual Studio Code updates Ren'Py", 'Update both'].includes(
				get_config('followCursorMode')
			)
		) {
			await warp_renpy_to_cursor_throttled(process, this.status_bar)
		}
	}

	off() {
		if (!this.active_process) return

		this.active_process = undefined

		this.text_editor_handle?.dispose()
		this.text_editor_handle = undefined

		this.status_bar.update(() => ({
			is_follow_cursor: false,
		}))
	}

	dispose() {
		this.text_editor_handle?.dispose()
	}
}
