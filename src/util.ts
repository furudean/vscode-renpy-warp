import * as vscode from 'vscode'

export function get_config(key: string): any {
	return vscode.workspace.getConfiguration('renpyWarp').get(key)
}
