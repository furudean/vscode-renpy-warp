import * as vscode from 'vscode'

export const logger = vscode.window.createOutputChannel(
	"Ren'Py Launch and Sync - Extension",
	{
		log: true,
	}
)
