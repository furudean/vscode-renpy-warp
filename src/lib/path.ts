import * as vscode from 'vscode'
import path from 'upath'
import untildify from 'untildify'
import fs from 'node:fs/promises'
import { get_logger } from './logger'
import { get_config } from './config'
import { get_executable } from './sh'

const logger = get_logger()

/**
 * @param {string} str
 * @returns {string}
 */
export function resolve_path(str: string): string {
	return path.resolve(untildify(str))
}

export async function path_exists(path: string): Promise<boolean> {
	try {
		await fs.access(path, fs.constants.F_OK)
		return true
	} catch {
		return false
	}
}

export function find_game_root(
	filename: string,
	haystack: string | null = null,
	depth: number = 1
): string | null {
	if (haystack) {
		haystack = path.resolve(haystack, '..')
	} else {
		haystack = path.dirname(filename)
	}

	if (path.basename(haystack) === 'game') {
		return path.resolve(haystack, '..') // return parent
	}

	const workspace_root =
		vscode.workspace.workspaceFolders &&
		vscode.workspace.workspaceFolders[0]
			? vscode.workspace.workspaceFolders[0].uri.fsPath
			: null

	if (
		haystack === workspace_root ||
		haystack === path.resolve('/') ||
		depth >= 10
	) {
		logger.info('exceeded recursion depth at', filename, haystack)
		return null
	}

	return find_game_root(filename, haystack, depth + 1)
}

export async function path_is_sdk(absolute_path: string): Promise<boolean> {
	const exists = await path_exists(absolute_path)
	if (!exists) return false

	const executable = await get_executable(absolute_path)
	if (executable === undefined) return false

	return true
}

/**
 * Returns the path to the Ren'Py SDK as specified in the settings. Prompts the
 * user to set the path if it is not set.
 */
export async function get_sdk_path(): Promise<string | undefined> {
	let sdk_path_setting: string = get_config('sdkPath')

	logger.debug('raw sdk path:', sdk_path_setting)

	if (!sdk_path_setting.trim()) {
		const selection = await vscode.window.showInformationMessage(
			"Please set a Ren'Py SDK path to continue",
			'Set SDK Path',
			'Cancel'
		)
		if (selection === 'Set SDK Path') {
			sdk_path_setting = await vscode.commands.executeCommand(
				'renpyWarp.setSdkPath'
			)
		}
		if (!sdk_path_setting) return
	}

	return resolve_path(sdk_path_setting)
}
