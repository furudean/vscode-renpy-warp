const vscode = require('vscode')
const path = require('upath')
const child_process = require('node:child_process')
const os = require('node:os')
const fs = require('node:fs/promises')
const untildify = require('untildify')
const { quoteForShell } = require('puka')

/** @type {vscode.LogOutputChannel} */
let logger

class NoSDKError extends Error {
	/**
	 * @param {string} [message]
	 */
	constructor(message) {
		super(message)
		this.name = 'NoSDKError'
	}
}

class BadSDKError extends Error {
	/**
	 * @param {string} [message]
	 * @param {string} [sdk_path]
	 */
	constructor(message, sdk_path) {
		super(message)
		this.name = 'BadSDKError'
		this.sdk_path = sdk_path
	}
}

class BadEditorError extends Error {
	/**
	 * @param {string} [message]
	 * @param {string} [editor_path]
	 */
	constructor(message, editor_path) {
		super(message)
		this.name = 'BadEditorError'
		this.editor_path = editor_path
	}
}

/**
 * @param {string} str
 * @returns {string}
 */
function parse_path(str) {
	return path.resolve(untildify(str))
}

/**
 * @param {string} cmd
 * @returns {Promise<string>}
 */
function exec_shell(cmd) {
	return new Promise((resolve, reject) => {
		child_process.exec(cmd, (err, out) => {
			if (err) {
				return reject(err)
			}
			return resolve(out)
		})
	})
}

/**
 * @param {string[]} cmds
 * @returns {string}
 */
function make_cmd(cmds) {
	return cmds
		.filter(Boolean)
		.map((i) => ' ' + quoteForShell(i))
		.join('')
		.trim()
}

/**
 * @param {string} filename
 * @param {string} [haystack]
 * @param {number} [depth]
 * @returns {string | null}
 */
function find_game_root(filename, haystack = null, depth = 1) {
	const workspace_root =
		vscode.workspace.workspaceFolders &&
		vscode.workspace.workspaceFolders[0]
			? vscode.workspace.workspaceFolders[0].uri.fsPath
			: null

	if (haystack) {
		haystack = path.resolve(haystack, '..')
	} else {
		haystack = path.dirname(filename)
	}

	if (path.basename(haystack) === 'game') {
		return path.resolve(haystack, '..') // return parent
	}

	if (haystack === workspace_root || depth >= 10) {
		logger.info('exceeded recursion depth at', haystack)
		return null
	}

	return find_game_root(filename, haystack, depth + 1)
}

/**
 * @returns {Promise<string>}
 */
async function get_renpy_sh() {
	const is_windows = os.platform() === 'win32'

	/** @type {string} */
	const sdk_path_setting = vscode.workspace
		.getConfiguration('renpyWarp')
		.get('sdkPath')

	logger.debug('raw sdk path:', sdk_path_setting)

	if (!sdk_path_setting.trim()) {
		throw new NoSDKError()
	}

	const expanded_sdk_path = parse_path(sdk_path_setting)

	logger.debug('expanded sdk path:', expanded_sdk_path)

	// on windows, we call python.exe and pass renpy.py as an argument
	// on all other systems, we call renpy.sh directly
	// https://www.renpy.org/doc/html/cli.html#command-line-interface
	const executable_name = is_windows
		? 'lib/py3-windows-x86_64/python.exe'
		: 'renpy.sh'

	const executable = path.join(expanded_sdk_path, executable_name)

	try {
		await fs.access(executable)
	} catch (err) {
		throw new BadSDKError('cannot find renpy.sh', expanded_sdk_path)
	}

	/** @type {string} */
	const editor_setting = vscode.workspace
		.getConfiguration('renpyWarp')
		.get('editor')

	/** @type {string} */
	let editor

	if (path.isAbsolute(editor_setting)) {
		editor = parse_path(editor_setting)
	} else {
		// relative path to launcher
		editor = path.resolve(expanded_sdk_path, editor_setting)
	}

	try {
		await fs.access(editor)
	} catch (err) {
		throw new BadEditorError('cannot find editor', editor)
	}

	if (is_windows) {
		const win_renpy_path = path.join(expanded_sdk_path, 'renpy.py')
		// set RENPY_EDIT_PY=editor.edit.py && python.exe renpy.py
		return (
			`set "RENPY_EDIT_PY=${editor}" && ` +
			make_cmd([executable, win_renpy_path])
		)
	} else {
		// RENPY_EDIT_PY=editor.edit.py renpy.sh
		return `RENPY_EDIT_PY='${editor}' ` + make_cmd([executable])
	}
}

/**
 * @param {Partial<{mode: 'line' | 'file' | 'launch', uri: vscode.Uri}>} options
 */
async function main({ mode, uri } = {}) {
	/** @type {string} */
	let renpy_sh

	try {
		renpy_sh = await get_renpy_sh()
	} catch (err) {
		logger.error(err)
		if (err instanceof BadSDKError) {
			vscode.window
				.showErrorMessage(
					`Invalid Ren'Py SDK path: ${err.sdk_path}`,
					'Open Settings'
				)
				.then(() => {
					vscode.commands.executeCommand(
						'workbench.action.openSettings',
						'renpyWarp.sdkPath'
					)
				})
			return
		} else if (err instanceof NoSDKError) {
			vscode.window
				.showErrorMessage(
					"Please set a Ren'Py SDK path in the settings",
					'Open Settings'
				)
				.then(() => {
					vscode.commands.executeCommand(
						'workbench.action.openSettings',
						'renpyWarp.sdkPath'
					)
				})
			return
		} else if (err instanceof BadEditorError) {
			vscode.window
				.showErrorMessage(
					`Invalid Ren'Py editor path: '${err.editor_path}'`,
					'Open Settings'
				)
				.then(() => {
					vscode.commands.executeCommand(
						'workbench.action.openSettings',
						'renpyWarp.editor'
					)
				})
			return
		}
		throw err
	}

	const active_editor = vscode.window.activeTextEditor

	const renpy_file_in_workspace = await vscode.workspace
		.findFiles('**/game/**/*.rpy', null, 1)
		.then((files) => (files.length ? files[0].path : null))

	const current_file =
		mode === 'launch'
			? renpy_file_in_workspace
			: (uri && uri.fsPath) ||
			  (active_editor && active_editor.document.fileName)

	if (!current_file) {
		vscode.window.showErrorMessage("No Ren'Py project in workspace")
		return
	}

	logger.info('current file:', current_file)

	const game_root = find_game_root(current_file)

	if (!game_root) {
		vscode.window.showErrorMessage(
			'Unable to find "game" folder in parent directory. Not a Ren\'Py project?'
		)
		logger.info(`cannot find game root in ${current_file}`)
		return
	}

	const filename_relative = path.relative(
		path.join(game_root, 'game/'),
		current_file
	)

	/** @type {string} */
	let cmd

	if (mode === 'launch') {
		cmd = renpy_sh + ' ' + make_cmd([game_root])
	} else {
		const line_number =
			mode === 'line'
				? vscode.window.activeTextEditor.selection.active.line + 1
				: 1

		cmd =
			renpy_sh +
			' ' +
			make_cmd([
				game_root,
				'--warp',
				`${filename_relative}:${line_number}`,
			])
	}

	try {
		logger.info('executing subshell:', cmd)
		await exec_shell(cmd)
	} catch (err) {
		logger.error(err)
		vscode.window
			.showErrorMessage("Ren'Py closed with errors", 'Open Log')
			.then(() => {
				logger.show()
			})
	}
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	logger = vscode.window.createOutputChannel("Ren'Py Warp to Line", {
		log: true,
	})

	const launch_status_bar = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		0
	)
	launch_status_bar.command = 'renpyWarp.launch'
	launch_status_bar.text = `$(play) Launch project`
	launch_status_bar.show()

	/** @type {NodeJS.Timeout} */
	let launch_timeout

	function has_spinner(fn) {
		return (...args) => {
			clearTimeout(launch_timeout)

			launch_status_bar.text = `$(sync~spin) Launching...`

			launch_timeout = setTimeout(() => {
				launch_status_bar.text = `$(play) Launch project`
			}, 2000)

			return fn(...args)
		}
	}

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'renpyWarp.warpToLine',
			has_spinner((uri) => main({ uri, mode: 'line' }))
		),
		vscode.commands.registerCommand(
			'renpyWarp.warpToFile',
			has_spinner((uri) => main({ uri, mode: 'file' }))
		),
		vscode.commands.registerCommand(
			'renpyWarp.launch',
			has_spinner((uri) => main({ uri, mode: 'launch' }))
		),
		launch_status_bar,
		logger
	)
}

function deactivate() {}

module.exports = {
	activate,
	deactivate,
}
