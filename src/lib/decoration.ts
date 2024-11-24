import * as vscode from 'vscode'
import { AnyProcess } from './process'
import path from 'upath'
import { get_config } from './config'
import { CurrentLineSocketMessage, SocketMessage } from './socket'
import { realpath } from 'node:fs/promises'
import { get_logger } from './logger'

const logger = get_logger()

async function safe_realpath(p: string): Promise<string | void> {
	try {
		return await realpath(p)
	} catch {
		return undefined
	}
}

export class DecorationService {
	private state = new Map<number, CurrentLineSocketMessage>()
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
			vscode.window.onDidChangeActiveTextEditor(() => {
				this.update_decorations().catch(logger.error)
			}),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('renpyWarp.showEditorDecorations')) {
					this.enabled = get_config(
						'showEditorDecorations'
					) as boolean
					this.update_decorations().catch(logger.error)
				}
			}),
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (
					e.document.uri.scheme === 'file' &&
					e.contentChanges.length
				) {
					this.update_decorations().catch(logger.error)
				}
			}),
		]
	}

	private async update_decorations() {
		for (const editor of vscode.window.visibleTextEditors) {
			if (!this.enabled) {
				editor.setDecorations(this.decoration, [])
				continue
			}

			if (editor.document.uri.scheme !== 'file') continue

			const editor_path = await safe_realpath(editor.document.uri.fsPath)
			if (!editor_path) continue

			const ranges: vscode.Range[] = []

			for (const [, state] of this.state) {
				if (path.relative(editor_path, state.path) === '') {
					const line = state.line - 1
					ranges.push(new vscode.Range(line, 0, line, 0))
				}
			}

			editor.setDecorations(this.decoration, ranges)
		}
	}

	track(process: AnyProcess) {
		process.on('socketMessage', (message: SocketMessage) => {
			if (message.type !== 'current_line') return

			this.state.set(process.pid, message as CurrentLineSocketMessage)
			this.update_decorations().catch(logger.error)
		})
		process.on('exit', () => {
			this.state.delete(process.pid)
			this.update_decorations().catch(logger.error)
		})
	}

	dispose() {
		this.subscriptions.forEach((subscription) => subscription.dispose())
	}
}
