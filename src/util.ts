import * as vscode from 'vscode'

/**
 * @param {string} key
 * @returns {any}
 */
export function get_config(key: string): any {
	return vscode.workspace.getConfiguration('renpyWarp').get(key)
}
