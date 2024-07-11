import * as vscode from 'vscode'

export function get_config(key: string): any {
	return vscode.workspace.getConfiguration('renpyWarp').get(key)
}

export function set_config(key: string, value: any): void {
	vscode.workspace
		.getConfiguration('renpyWarp')
		.update(key, value, vscode.ConfigurationTarget.Global)
}
