import * as vscode from 'vscode'
import path from 'node:path'
import { get_logger } from './logger'
import { get_config } from './config'
import os from 'node:os'
import child_process from 'node:child_process'
import { path_exists, path_is_sdk, resolve_path } from './path'
import find_process from 'find-process'
import p_find from 'p-locate'

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
		/^Ren'Py (?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:\.(?<rest>.*))?\s*$/

	logger.debug('getting version for', executable_str)

	const version_string = child_process.spawnSync(
		executable_str,
		['--version'],
		{
			stdio: 'pipe',
			encoding: 'utf-8',
		}
	)

	if (version_string.error) throw version_string.error

	// output commonly usually stderr, but we try and capture whichever one has
	// a valid value just in case
	const output = version_string.output.find(
		(o) => typeof o === 'string' && o.length > 0
	) as string | undefined

	if (output === undefined) {
		throw new Error(
			`bad output from version command ${version_string.output}`
		)
	}

	const { major, minor, patch, rest } =
		RENPY_VERSION_REGEX.exec(output)?.groups ?? {}

	if (major === undefined || minor === undefined || patch === undefined) {
		throw new Error('bad version string: ' + output)
	}

	return {
		semver: `${major}.${minor}.${patch}`,
		major: Number(major),
		minor: Number(minor),
		patch: Number(patch),
		rest,
	}
}

export function find_project_root(
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

	return find_project_root(filename, haystack, depth + 1)
}

export async function get_editor_path(
	sdk_path: string
): Promise<string | undefined> {
	const editor_setting = get_config('editor') as string
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
 * Returns an array of executable commands to run the Ren'Py CLI.
 *
 * If not configured correctly, prompts the user with an error message.
 */
export async function get_executable(
	sdk_path: string,
	prompt = false
): Promise<string[] | undefined> {
	if (!(await path_is_sdk(sdk_path))) {
		logger.debug('not valid sdk', sdk_path)

		if (prompt) {
			vscode.window
				.showErrorMessage(
					"Ren'Py SDK path is invalid",
					'Update SDK Path'
				)
				.then((selection) => {
					if (selection === 'Update SDK Path') {
						vscode.commands.executeCommand('renpyWarp.setSdkPath')
					}
				})
		}

		return undefined
	}

	if (IS_WINDOWS) {
		// on windows, we call python.exe and pass renpy.py as an argument
		const machine_type = os.machine()

		const candidate_paths = [
			`lib/py3-windows-${machine_type}/python.exe`,
			`lib/py2-windows-${machine_type}/python.exe`,
		]

		const executable = await p_find(candidate_paths, async (candidate) =>
			path_exists(path.join(sdk_path, candidate))
		)

		if (!executable) {
			logger.error(
				`could not find a valid python executable in ${candidate_paths}`
			)
			return undefined
		}

		return [
			path.join(sdk_path, executable),
			path.join(sdk_path, 'renpy.py'),
		]
	} else {
		// on all other systems, we call renpy.sh directly
		// https://www.renpy.org/doc/html/cli.html#command-line-interface
		return [path.join(sdk_path, 'renpy.sh')]
	}
}

export async function process_finished(pid: number): Promise<boolean> {
	const [process] = await find_process('pid', pid)

	logger.trace(`process ${pid} status:`, process)

	// defunct processes are zombies - they're dead, but still in the process
	// table. the renpy launcher will leave a defunct process behind until it's
	// closed, so we need to check for this specifically.
	return process === undefined || process.name === '<defunct>'
}
