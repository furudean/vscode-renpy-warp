import * as vscode from 'vscode'
import path from 'node:path'
import { get_logger } from './logger'
import { get_config } from './config'
import os from 'node:os'
import child_process from 'node:child_process'
import { path_exists, resolve_path } from './path'
import { sh } from 'puka'

const logger = get_logger()
const IS_WINDOWS = os.platform() === 'win32'

/**
 * @param executable_str
 * base renpy.sh command
 */
export function get_version(executable_str: string): {
	semver: string
	major: number
	minor: number
	patch: number
	rest: string
} {
	const RENPY_VERSION_REGEX =
		/^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:\.(?<rest>.*))?$/

	const version_string = child_process
		.execSync(executable_str + ' --version')
		.toString('utf-8')
		.trim()
		.replace("Ren'Py ", '')

	const { major, minor, patch, rest } =
		RENPY_VERSION_REGEX.exec(version_string)?.groups ?? {}

	if (major === undefined || minor === undefined || patch === undefined) {
		throw new Error('bad version string: ' + version_string)
	}

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
export function env_string(
	/** undefined values are not included */
	entries: Record<string, string | undefined>
): string {
	return Object.entries(entries)
		.filter(([key, value]) => value !== undefined)
		.map(([key, value]) =>
			IS_WINDOWS ? `set "${key}=${value}"` : `${key}='${value}'`
		)
		.join(IS_WINDOWS ? ' && ' : ' ')
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
		vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? null

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

export async function get_editor_path(
	sdk_path: string
): Promise<string | undefined> {
	const editor_setting: string = get_config('editor')
	let editor_path: string

	if (path.isAbsolute(editor_setting)) {
		editor_path = resolve_path(editor_setting)
	} else {
		// relative path to launcher
		editor_path = path.resolve(sdk_path, editor_setting)
	}

	if (!(await path_exists(editor_path))) {
		vscode.window
			.showErrorMessage(
				`Invalid Ren'Py editor path: '${editor_setting}' (resolved to '${editor_path}')`,
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

	return editor_path
}

/**
 * Returns the path to the Ren'Py SDK directory, if not set, prompts the user with an error message.
 */
export async function get_executable(
	sdk_path: string,
	prompt = false
): Promise<string | undefined> {
	// on windows, we call python.exe and pass renpy.py as an argument
	// on all other systems, we call renpy.sh directly
	// https://www.renpy.org/doc/html/cli.html#command-line-interface
	const executable_name = IS_WINDOWS
		? 'lib/py3-windows-x86_64/python.exe'
		: 'renpy.sh'

	const executable = path.join(sdk_path, executable_name)

	if (await path_exists(executable)) {
		const renpy_path = path.join(sdk_path, 'renpy.py')

		return IS_WINDOWS ? sh`${executable} ${renpy_path}` : sh`${executable}`
	} else {
		if (prompt) {
			vscode.window
				.showErrorMessage(
					"Ren'Py SDK path is invalid. Please set it in the extension settings.",
					'Open settings'
				)
				.then((selection) => {
					if (selection === 'Open settings') {
						vscode.commands.executeCommand(
							'workbench.action.openSettings',
							'@ext:PaisleySoftworks.renpyWarp'
						)
					}
				})
		}

		return undefined
	}
}

export async function add_env(
	executable: string,
	environment: Record<string, string | undefined> = {}
): Promise<string | undefined> {
	if (IS_WINDOWS) {
		// set RENPY_EDIT_PY=editor.edit.py && /path/to/python.exe /path/to/renpy.py
		return env_string(environment) + ' && ' + executable
	} else {
		// RENPY_EDIT_PY=editor.edit.py /path/to/renpy.sh
		return env_string(environment) + ' ' + executable
	}
}
