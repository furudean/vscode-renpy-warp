import * as vscode from 'vscode'
import { AnyProcess } from './process'
import path from 'upath'

let current_decoration: vscode.TextEditorDecorationType | undefined
let current_line: number | undefined
let current_path: string | undefined
let current_subscription: vscode.Disposable | undefined

export function update_decorations(
	line: number,
	path: string,
	process: AnyProcess,
	context: vscode.ExtensionContext
) {
	current_line = line
	current_path = path

	current_decoration?.dispose()
	current_subscription?.dispose()
	current_subscription = vscode.window.onDidChangeActiveTextEditor(() => {
		set_decorations(process, context)
	})
	context.subscriptions.push(current_subscription)
	set_decorations(process, context)
}

function set_decorations(
	process: AnyProcess,
	context: vscode.ExtensionContext
) {
	const editor = vscode.window.activeTextEditor
	if (
		current_line &&
		current_path &&
		editor?.document.uri.fsPath ===
			path.join(process.project_root, 'game', current_path)
	) {
		current_decoration = vscode.window.createTextEditorDecorationType({
			gutterIconPath: context.asAbsolutePath('dist/arrow-right.svg'),
			gutterIconSize: '70%',
			dark: {
				gutterIconPath: context.asAbsolutePath(
					'dist/arrow-right-white.svg'
				),
			},
			overviewRulerColor: new vscode.ThemeColor(
				'editorCursor.foreground'
			),
			overviewRulerLane: vscode.OverviewRulerLane.Center,
		})
		editor.setDecorations(current_decoration, [
			new vscode.Range(current_line, 0, current_line, 0),
		])
		context.subscriptions.push(current_decoration)
		process.on('exit', () => {
			current_line = undefined
			current_path = undefined
			current_subscription?.dispose()
			current_decoration?.dispose()
		})
	}
}
