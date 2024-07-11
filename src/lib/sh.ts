import * as vscode from 'vscode'
import path from 'node:path'
import { get_logger } from './logger'
import { get_config } from './util'
import { sh, quoteForShell } from 'puka'
import os from 'node:os'
import child_process from 'node:child_process'
import { get_sdk_path, path_exists, resolve_path } from './path'

const logger = get_logger()
const IS_WINDOWS = os.platform() === 'win32'

/**
 * @param renpy_sh
 * base renpy.sh command
 */
export function get_version(renpy_sh: string): {
	semver: string
	major: number
	minor: number
	patch: number
	rest: string
} {
	const RENPY_VERSION_REGEX =
		/^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:\.(?<rest>.*))?$/

	const version_string = child_process
		.execSync(renpy_sh + ' --version')
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

async function get_editor_path(sdk_path: string): Promise<string | undefined> {
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

export async function get_executable(
	sdk_path: string
): Promise<string | undefined> {
	// on windows, we call python.exe and pass renpy.py as an argument
	// on all other systems, we call renpy.sh directly
	// https://www.renpy.org/doc/html/cli.html#command-line-interface
	const executable_name = IS_WINDOWS
		? 'lib/py3-windows-x86_64/python.exe'
		: 'renpy.sh'

	const executable = path.join(sdk_path, executable_name)

	if (await path_exists(executable)) {
		return IS_WINDOWS ? `${executable} renpy.py` : executable
	} else {
		return undefined
	}
}

export async function get_renpy_sh(
	environment: Record<string, string | undefined> = {}
): Promise<string | undefined> {
	const sdk_path = await get_sdk_path()
	if (!sdk_path) return

	const executable = await get_executable(sdk_path)

	if (!executable) {
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

	const editor_path = await get_editor_path(sdk_path)
	if (!editor_path) return

	if (IS_WINDOWS) {
		// set RENPY_EDIT_PY=editor.edit.py && /path/to/python.exe renpy.py
		return (
			env_string({ ...environment, RENPY_EDIT_PY: editor_path }) +
			' && ' +
			sh`${executable}`
		)
	} else {
		// RENPY_EDIT_PY=editor.edit.py /path/to/renpy.sh
		return (
			env_string({ ...environment, RENPY_EDIT_PY: editor_path }) +
			' ' +
			sh`${executable}`
		)
	}
}
