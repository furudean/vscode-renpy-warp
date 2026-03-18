import * as vscode from "vscode"

import { name as extension_name } from "../../package.json"

const config_cache = new Map<string, unknown>()

export function init_config_cache(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(extension_name)) {
				config_cache.clear()
			}
		})
	)
}

export function get_configuration_object(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(extension_name)
}

export function get_config(key: string): unknown {
	if (config_cache.has(key)) {
		return config_cache.get(key)
	}
	const value = vscode.workspace.getConfiguration(extension_name).get(key)
	config_cache.set(key, value)
	return value
}

export async function set_config(
	key: string,
	value: unknown,
	workspace = false
): Promise<void> {
	config_cache.clear()
	return vscode.workspace
		.getConfiguration(extension_name)
		.update(
			key,
			value,
			workspace
				? vscode.ConfigurationTarget.Workspace
				: vscode.ConfigurationTarget.Global
		)
}

/**
 * sets a configuration value exclusively for the workspace or globally,
 * removing the other setting if it exists
 */
export async function set_config_exclusive(
	key: string,
	value: unknown,
	workspace = false
): Promise<void> {
	await set_config(key, value, workspace)
	await set_config(key, undefined, !workspace)
}

export async function show_file(path: string): Promise<void> {
	const doc = await vscode.workspace.openTextDocument(path)
	await vscode.window.showTextDocument(doc)
}

export async function get_user_ignore_pattern(): Promise<string> {
	const extension_ignores = get_config("exclude") as string[]
	const vscode_ignores = Object.entries(
		vscode.workspace.getConfiguration("files").get("exclude") as Record<
			string,
			boolean
		>
	)
		.filter(([, value]) => value === true)
		.map(([key]) => key)
	return "{" + [...extension_ignores, ...vscode_ignores].join(",") + "}"
}
