const vscode = require('vscode')
const path = require('upath')
const child_process = require('node:child_process')
const os = require('node:os')
const fs = require('node:fs/promises')
const untildify = require('untildify')
const { quoteForShell } = require('puka')

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

/** @type {vscode.LogOutputChannel} */
let logger

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

function open_sdk_path() {
	vscode.commands.executeCommand(
		'workbench.action.openSettings',
		'renpyWarp.sdkPath'
	)
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
	const raw_sdk_path = vscode.workspace
		.getConfiguration('renpyWarp')
		.get('sdkPath')

	logger.debug('raw sdk path:', raw_sdk_path)

	if (!raw_sdk_path.trim()) {
		throw new NoSDKError()
	}

	const expanded_sdk_path = path.resolve(untildify(raw_sdk_path))

	logger.debug('expanded sdk path:', expanded_sdk_path)

	// on windows, we call python.exe and pass renpy.py as an argument
	// on unix, we call renpy.sh directly
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

	const editor = path.resolve(
		expanded_sdk_path,
		'launcher/Visual Studio Code (System).edit.py'
	)
	const editor_env = `RENPY_EDIT_PY='${editor}'`

	if (is_windows) {
		const win_renpy_path = path.join(expanded_sdk_path, 'renpy.py')
		// RENPY_EDIT_PY=editor.edit.py python.exe renpy.py
		return editor_env + ' && ' + make_cmd([executable, win_renpy_path])
	} else {
		// RENPY_EDIT_PY=editor.edit.py renpy.sh
		return editor_env + ' ' + make_cmd([executable])
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
				.then(open_sdk_path)
			return
		} else if (err instanceof NoSDKError) {
			vscode.window
				.showErrorMessage(
					"Please set a Ren'Py SDK path in the settings",
					'Open Settings'
				)
				.then(open_sdk_path)
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
		100
	)
	launch_status_bar.command = 'renpyWarp.launch'
	launch_status_bar.text = `$(play) Launch project`
	launch_status_bar.show()

	context.subscriptions.push(
		vscode.commands.registerCommand('renpyWarp.warpToLine', (uri) =>
			main({ uri, mode: 'line' })
		),
		vscode.commands.registerCommand('renpyWarp.warpToFile', (uri) => {
			main({ uri, mode: 'file' })
		}),
		vscode.commands.registerCommand('renpyWarp.launch', (uri) =>
			main({ uri, mode: 'launch' })
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
