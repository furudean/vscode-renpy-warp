import * as vscode from 'vscode'

export function get_config(key: string): any {
	return vscode.workspace.getConfiguration('renpyWarp').get(key)
}

export async function set_config(
	key: string,
	value: any,
	workspace = false
): Promise<void> {
	return vscode.workspace
		.getConfiguration('renpyWarp')
		.update(
			key,
			value,
			workspace
				? vscode.ConfigurationTarget.Workspace
				: vscode.ConfigurationTarget.Global
		)
}
