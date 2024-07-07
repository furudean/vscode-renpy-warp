import * as vscode from 'vscode'
import path from 'node:path'
import { get_logger } from './logger'
import { get_config } from './util'
import { quoteForShell } from 'puka'
import os from 'node:os'
import child_process from 'node:child_process'
import fs from 'node:fs/promises'
import { resolve_path } from './path'

const logger = get_logger()
const IS_WINDOWS = os.platform() === 'win32'

/**
 * @param renpy_sh
 * base renpy.sh command
 */
export function get_version(renpy_sh: string) {
	const RENPY_VERSION_REGEX =
		/^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:\.(?<rest>.*))?$/

	const version_string = child_process
		.execSync(renpy_sh + ' --version')
		.toString('utf-8')
		.trim()
		.replace("Ren'Py ", '')

	const { major, minor, patch, rest } =
		RENPY_VERSION_REGEX.exec(version_string)?.groups ?? {}

	return {
		semver: `${major}.${minor}.${patch}`,
		major: Number(major),
		minor: Number(minor),
		patch: Number(patch),
		rest,
	}
}

/**
 * @example
 * // on unix
 * env_string({ FOO: 'bar', BAZ: 'qux' })
 * // "FOO='bar' BAZ='qux'"
 *
 * // on windows
 * env_string({ FOO: 'bar', BAZ: 'qux' })
 * // 'set "FOO=bar" && set "BAZ=qux"'
 */
export function env_string(entries: Record<string, string>): string {
	return Object.entries(entries)
		.map(([key, value]) =>
			IS_WINDOWS ? `set "${key}=${value}"` : `${key}='${value}'`
		)
		.join(IS_WINDOWS ? ' && ' : ' ')
}

export function make_cmd(cmds: string[]): string {
	return cmds
		.filter(Boolean)
		.map((i) => ' ' + quoteForShell(i))
		.join('')
		.trim()
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

/**
 * Returns the path to the Ren'Py SDK as specified in the settings
 */
export async function get_sdk_path(): Promise<string | undefined> {
	/** @type {string} */
	const sdk_path_setting: string = get_config('sdkPath')

	logger.debug('raw sdk path:', sdk_path_setting)

	if (!sdk_path_setting.trim()) {
		vscode.window
			.showErrorMessage(
				"Please set a Ren'Py SDK path in the settings",
				'Open Settings'
			)
			.then((selection) => {
				if (!selection) return

				vscode.commands.executeCommand(
					'workbench.action.openSettings',
					'@ext:PaisleySoftworks.renpyWarp'
				)
			})

		return
	}

	const parsed_path = resolve_path(sdk_path_setting)

	try {
		await fs.access(parsed_path)
	} catch (err) {
		logger.warn('invalid sdk path:', err)
		vscode.window
			.showErrorMessage(
				`Invalid Ren'Py SDK path: ${sdk_path_setting}`,
				'Open Settings'
			)
			.then((selection) => {
				if (!selection) return
				vscode.commands.executeCommand(
					'workbench.action.openSettings',
					'@ext:PaisleySoftworks.renpyWarp'
				)
			})
		return
	}

	return parsed_path
}

export async function get_renpy_sh(
	environment: Record<string, string | number | boolean> = {}
): Promise<string | undefined> {
	const sdk_path = await get_sdk_path()

	if (!sdk_path) return

	// on windows, we call python.exe and pass renpy.py as an argument
	// on all other systems, we call renpy.sh directly
	// https://www.renpy.org/doc/html/cli.html#command-line-interface
	const executable_name = IS_WINDOWS
		? 'lib/py3-windows-x86_64/python.exe'
		: 'renpy.sh'

	const executable = path.join(sdk_path, executable_name)

	try {
		await fs.access(executable)
	} catch (err) {
		logger.warn('invalid renpy.sh path:', err)
		vscode.window
			.showErrorMessage(
				`Invalid Ren'Py SDK path: ${sdk_path}`,
				'Open Settings'
			)
			.then((selection) => {
				if (!selection) return
				vscode.commands.executeCommand(
					'workbench.action.openSettings',
					'@ext:PaisleySoftworks.renpyWarp'
				)
			})
		return
	}

	/** @type {string} */
	const editor_setting: string = get_config('editor')

	/** @type {string} */
	let editor: string

	if (path.isAbsolute(editor_setting)) {
		editor = resolve_path(editor_setting)
	} else {
		// relative path to launcher
		editor = path.resolve(sdk_path, editor_setting)
	}

	try {
		await fs.access(editor)
	} catch (err: any) {
		vscode.window
			.showErrorMessage(
				`Invalid Ren'Py editor path: '${err.editor_path}'`,
				'Open Settings'
			)
			.then((selection) => {
				if (!selection) return

				vscode.commands.executeCommand(
					'workbench.action.openSettings',
					'@ext:PaisleySoftworks.renpyWarp'
				)
			})
		return
	}

	if (IS_WINDOWS) {
		const win_renpy_path = path.join(sdk_path, 'renpy.py')
		// set RENPY_EDIT_PY=editor.edit.py && python.exe renpy.py
		return (
			env_string({ ...environment, RENPY_EDIT_PY: editor }) +
			' && ' +
			make_cmd([executable, win_renpy_path])
		)
	} else {
		// RENPY_EDIT_PY=editor.edit.py renpy.sh
		return (
			env_string({ ...environment, RENPY_EDIT_PY: editor }) +
			' ' +
			make_cmd([executable])
		)
	}
}
