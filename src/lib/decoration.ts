import * as vscode from 'vscode'
import { AnyProcess } from './process'

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
		editor &&
		editor.document.uri.fsPath.endsWith(current_path)
	) {
		current_decoration = vscode.window.createTextEditorDecorationType({
			gutterIconPath: context.asAbsolutePath('dist/arrow-right.svg'),
			gutterIconSize: '60%',
			dark: {
				gutterIconPath: context.asAbsolutePath(
					'dist/arrow-right-white.svg'
				),
			},
			overviewRulerColor: new vscode.ThemeColor(
				'editor.selectionHighlightBackground'
			),
			overviewRulerLane: vscode.OverviewRulerLane.Center,
		})
		editor.setDecorations(current_decoration, [
			new vscode.Range(current_line, 0, current_line, 0),
		])
		context.subscriptions.push(current_decoration)
		process.on('exit', () => {
			current_decoration?.dispose()
		})
	}
}
