import * as vscode from 'vscode'
import { get_config } from './config'
import { get_logger } from './log'
import { ProcessManager } from './process'
import { WarpSocketService } from './socket'
import { uninstall_rpes } from './rpe'

const logger = get_logger()

export function register_handlers(
	context: vscode.ExtensionContext,
	pm: ProcessManager,
	wss: WarpSocketService
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
	const server_on_change = vscode.workspace.onDidChangeConfiguration(
		async (e) => {
			if (
				e.affectsConfiguration('renpyWarp.autoStartSocketServer') ||
				e.affectsConfiguration('renpyWarp.renpyExtensionsEnabled') ||
				e.affectsConfiguration('renpyWarp.sdkPath')
			) {
				logger.info('server settings changed')
				if (
					get_config('autoStartSocketServer') &&
					get_config('renpyExtensionsEnabled') === 'Enabled'
				) {
					wss.start()
				} else {
					wss.close()
					const sdk_path = get_config('sdkPath') as string

					if (sdk_path) {
						for (const folder of vscode.workspace
							.workspaceFolders ?? []) {
							await uninstall_rpes(sdk_path, folder.uri)
						}
					}
				}

				vscode.commands.executeCommand(
					'setContext',
					'renpyWarp.renpyExtensionsEnabled',
					get_config('renpyExtensionsEnabled') === 'Enabled'
				)
			}
		}
	)
	context.subscriptions.push(server_on_change)
}
