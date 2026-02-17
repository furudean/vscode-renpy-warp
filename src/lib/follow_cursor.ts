import * as vscode from "vscode"
import { get_config } from "./config"
import { AnyProcess } from "./process"
import { get_logger } from "./log"
import path from "upath"
import { find_project_root } from "./sh"
import { StatusBar } from "./status_bar"

const logger = get_logger()
const last_warps = new Map<number, string>()

interface SyncEditorWithRenpyOptions {
	/** absolute path to the file */
	path: string
	/** path relative from the game folder (e.g. `script.rpy`) */
	relative_path: string
	/** 0-indexed line number */
	line: number
	/** skip redundancy checks */
	force?: boolean
}

export async function sync_editor_with_renpy({
	path,
	relative_path,
	line,
	force
}: SyncEditorWithRenpyOptions): Promise<void> {
	const warp_spec = `${path}:${line + 1}`
	if (!force && warp_spec === last_warps.get(process.pid)) return // no change
	last_warps.set(process.pid, warp_spec)

	const doc = await vscode.workspace.openTextDocument(path)
	const editor = await vscode.window.showTextDocument(doc)

	logger.debug(`syncing editor to ${relative_path}:${line}`)

	const end_of_line = editor.document.lineAt(line).range.end.character
	const pos = new vscode.Position(line, end_of_line)
	const selection = new vscode.Selection(pos, pos)

	editor.revealRange(
		selection,
		vscode.TextEditorRevealType.InCenterIfOutsideViewport
	)

	// if the cursor is already on the correct line, don't munge it
	if (editor.selection.start.line !== line) {
		editor.selection = selection
	}
}

export async function warp_renpy_to_cursor(
	rp: AnyProcess,
	status_bar: StatusBar
): Promise<void> {
	const editor = vscode.window.activeTextEditor

	if (!editor) return

	const filename = editor.document.fileName
	const file = editor.document.uri.fsPath
	const line = editor.selection.active.line

	if (!filename.endsWith(".rpy")) return

	const project_root = find_project_root(file)
	const filename_relative = path.relative(
		path.join(project_root, "game/"),
		file
	)

	const warp_spec = `${filename_relative}:${line + 1}`

	if (warp_spec === last_warps.get(process.pid)) return // no change
	last_warps.set(process.pid, warp_spec)

	if (!rp) {
		logger.warn("no renpy process found")
		return
	}

	await rp.warp_to_line(filename_relative, line + 1)
	status_bar.notify(`$(debug-line-by-line) Warped to ${warp_spec}`)
	logger.info("warped to", warp_spec)
}

export class FollowCursorService {
	private status_bar: StatusBar
	private text_editor_handle: vscode.Disposable | undefined

	enabled = false
	active_process: AnyProcess | undefined

	constructor({ status_bar }: { status_bar: StatusBar }) {
		this.status_bar = status_bar
	}

	async set(process: AnyProcess) {
		if (get_config("renpyExtensionsEnabled") !== "Enabled") return

		this.active_process = process
		this.enabled = true

		this.text_editor_handle?.dispose()
		this.text_editor_handle = vscode.window.onDidChangeTextEditorSelection(
			async (event) => {
				if (
					["Visual Studio Code updates Ren'Py", "Update both"].includes(
						get_config("followCursorMode") as string
					) &&
					event.kind !== vscode.TextEditorSelectionChangeKind.Command
				) {
					await warp_renpy_to_cursor(process, this.status_bar)
				}
			}
		)

		this.status_bar.update(() => ({
			is_follow_cursor: true
		}))

		if (
			["Visual Studio Code updates Ren'Py", "Update both"].includes(
				get_config("followCursorMode") as string
			)
		) {
			await warp_renpy_to_cursor(process, this.status_bar)
		}
	}

	off() {
		this.enabled = false
		if (!this.active_process) return

		this.active_process = undefined

		this.text_editor_handle?.dispose()
		this.text_editor_handle = undefined

		this.status_bar.update(() => ({
			is_follow_cursor: false
		}))
	}

	dispose() {
		this.text_editor_handle?.dispose()
	}
}
