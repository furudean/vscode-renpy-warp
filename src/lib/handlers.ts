import * as vscode from 'vscode'
import { get_config } from './config'
import { get_logger } from './logger'
import { ProcessManager } from './process'
import { ensure_socket_server, stop_socket_server } from './socket'
import { StatusBar } from './status_bar'
import { FollowCursor } from './follow_cursor'

const logger = get_logger()

export function register_handlers(
	context: vscode.ExtensionContext,
	pm: ProcessManager,
	status_bar: StatusBar,
	follow_cursor: FollowCursor
) {
	const save_text_handler = vscode.workspace.onWillSaveTextDocument(
		async ({ document }) => {
			try {
				if (!document.fileName.endsWith('.rpy')) return
				if (document.isDirty === false) return
				if (get_config('setAutoReloadOnSave') !== true) return

				if (
					vscode.window.activeTextEditor?.selection.active.line ===
					undefined
				)
					return

				for (const process of pm) {
					if (!process.socket) return

					logger.info('reloading process on save', process.pid)
					await process.set_autoreload()
				}
			} catch (error: unknown) {
				logger.error(error as Error)
			}
		}
	)
	context.subscriptions.push(save_text_handler)

	vscode.commands.executeCommand(
		'setContext',
		'renpyWarp.renpyExtensionsEnabled',
		get_config('renpyExtensionsEnabled') === 'Enabled'
	)
	const server_on_change = vscode.workspace.onDidChangeConfiguration((e) => {
		if (
			e.affectsConfiguration('renpyWarp.autoStartSocketServer') ||
			e.affectsConfiguration('renpyWarp.renpyExtensionsEnabled')
		) {
			logger.info('server settings changed')
			if (
				get_config('autoStartSocketServer') &&
				get_config('renpyExtensionsEnabled') === 'Enabled'
			) {
				ensure_socket_server({ pm, status_bar, follow_cursor, context })
			} else {
				stop_socket_server(pm, status_bar)
			}

			vscode.commands.executeCommand(
				'setContext',
				'renpyWarp.renpyExtensionsEnabled',
				get_config('renpyExtensionsEnabled') === 'Enabled'
			)
		}
	})
	context.subscriptions.push(server_on_change)
}
