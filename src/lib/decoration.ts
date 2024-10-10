import * as vscode from 'vscode'
import { AnyProcess } from './process'
import path from 'upath'
import { get_config } from './config'

interface State {
	line: number
	path: string
}

export class DecorationService {
	private context: vscode.ExtensionContext
	private state = new Map<number, State>()
	private decorations = new Set<vscode.Disposable>()
	private handlers: vscode.Disposable[]
	private enabled: boolean

	constructor({ context }: { context: vscode.ExtensionContext }) {
		this.context = context
		this.enabled = get_config('showEditorDecorations') as boolean

		this.handlers = [
			vscode.window.onDidChangeActiveTextEditor(() =>
				this.update_decorations()
			),
			vscode.workspace.onDidChangeConfiguration(async (e) => {
				if (e.affectsConfiguration('renpyWarp.showEditorDecorations')) {
					this.enabled = get_config(
						'showEditorDecorations'
					) as boolean
					this.update_decorations()
				}
			}),
		]
	}

	private update_decorations() {
		this.decorations.forEach((decoration) => decoration.dispose())
		this.decorations.clear()

		if (!this.enabled) return

		for (const editor of vscode.window.visibleTextEditors) {
			const ranges: vscode.Range[] = []

			for (const [, state] of this.state) {
				if (
					path.toUnix(editor.document.uri.fsPath) ===
					path.toUnix(state.path)
				) {
					const line = state.line - 1
					ranges.push(
						new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER)
					)
				}
			}

			if (ranges.length) {
				const decoration = vscode.window.createTextEditorDecorationType(
					{
						gutterIconPath: this.context.asAbsolutePath(
							'dist/arrow-right.svg'
						),
						gutterIconSize: '70%',
						dark: {
							gutterIconPath: this.context.asAbsolutePath(
								'dist/arrow-right-white.svg'
							),
						},
						overviewRulerColor: new vscode.ThemeColor(
							'editorCursor.foreground'
						),
						overviewRulerLane: vscode.OverviewRulerLane.Center,
					}
				)

				this.decorations.add(decoration)
				editor.setDecorations(decoration, ranges)
			}
		}
	}

	track(process: AnyProcess) {
		process.on('socketMessage', (message) => {
			if (message.type !== 'current_line') return

			this.state.set(process.pid, message as unknown as State)
			this.update_decorations()
		})
		process.on('exit', () => {
			this.state.delete(process.pid)
			this.update_decorations()
		})
	}

	dispose() {
		this.decorations.forEach((decoration) => decoration.dispose())
		this.handlers.forEach((subscription) => subscription.dispose())
	}
}
