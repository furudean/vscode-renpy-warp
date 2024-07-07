import * as vscode from 'vscode'

let logger: vscode.LogOutputChannel

export function get_logger(): vscode.LogOutputChannel {
	if (!logger) {
		logger = vscode.window.createOutputChannel(
			"Ren'Py Launch and Sync - Extension",
			{
				log: true,
			}
		)
	}
	return logger
}
