import * as vscode from 'vscode'
import { AnyProcess } from './process'
import path from 'upath'
import { get_config } from './config'

interface State {
	line: number
	path: string
}

export class DecorationService {
	private state = new Map<number, State>()
	private decorations = new Set<vscode.Disposable>()
	private subscriptions: vscode.Disposable[]
	private enabled: boolean
	private decoration: vscode.TextEditorDecorationType

	constructor({ context }: { context: vscode.ExtensionContext }) {
		this.enabled = get_config('showEditorDecorations') as boolean

		this.decoration = vscode.window.createTextEditorDecorationType({
			gutterIconPath: context.asAbsolutePath('dist/arrow-right.svg'),
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

		this.subscriptions = [
			this.decoration,
			vscode.window.onDidChangeActiveTextEditor(() =>
				this.update_decorations()
			),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('renpyWarp.showEditorDecorations')) {
					this.enabled = get_config(
						'showEditorDecorations'
					) as boolean
					this.update_decorations()
				}
			}),
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (e.contentChanges.length) {
					this.update_decorations()
				}
			}),
		]
	}

	private update_decorations() {
		for (const editor of vscode.window.visibleTextEditors) {
			editor.setDecorations(this.decoration, [])
			if (!this.enabled) return

			const ranges: vscode.Range[] = []

			for (const [, state] of this.state) {
				if (
					path.toUnix(editor.document.uri.fsPath) ===
					path.toUnix(state.path)
				) {
					const line = state.line - 1
					ranges.push(new vscode.Range(line, 0, line, 0))
				}
			}

			if (ranges.length) {
				this.decorations.add(this.decoration)
				editor.setDecorations(this.decoration, ranges)
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
		this.subscriptions.forEach((subscription) => subscription.dispose())
	}
}
