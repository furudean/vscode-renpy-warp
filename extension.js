const vscode = require('vscode')
const path = require('upath')
const child_process = require('node:child_process')
const os = require('node:os')
const fs = require('node:fs/promises')
const untildify = require('untildify')
const { quoteForShell } = require('puka')

/** @type {vscode.LogOutputChannel} */
let logger

/**
 * @param {string} cmd
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
 * @param {string[]} l
 * @returns {string}
 */
function make_cmd(l) {
	return l
		.filter(Boolean)
		.map((i) => ' ' + quoteForShell(i))
		.join('')
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
 * @param {vscode.Uri} [uri]
 * @param {Partial<{warp: boolean, line: boolean}>} options
 */
async function main(uri, options = {}) {
	options = {
		warp: false,
		line: true,
		...options,
	}

	const raw_sdk_path = vscode.workspace
		.getConfiguration('renpyWarp')
		.get('sdkPath')

	logger.debug('raw sdk path:', raw_sdk_path)

	if (!raw_sdk_path) {
		vscode.window
			.showErrorMessage(
				"Please set a valid Ren'Py SDK path",
				'Open Settings'
			)
			.then(open_sdk_path)
		return
	}

	/** @type {string} */
	let sdk_path = path.resolve(untildify(raw_sdk_path))

	// https://www.renpy.org/doc/html/cli.html#command-line-interface
	const executable_name =
		os.platform() === 'win32'
			? 'lib/py3-windows-x86_64/python.exe'
			: 'renpy.sh'

	const executable = path.join(sdk_path, executable_name)

	try {
		await fs.access(executable)
	} catch (err) {
		logger.error(`no cli executable found, looked in ${executable}`, err)
		vscode.window
			.showErrorMessage(
				`No valid Ren'Py CLI found in '${sdk_path}'. Please set a valid SDK path in settings`,
				'Open Settings'
			)
			.then(open_sdk_path)
		return
	}

	const current_file =
		(uri && uri.fsPath) || vscode.window.activeTextEditor.document.fileName
	const game_root = find_game_root(current_file)

	if (!game_root) {
		vscode.window.showErrorMessage(
			'Unable to find "game" folder in parent directory. Not a Renpy project?'
		)
		logger.info(`cannot find game root in ${current_file}`)
		return
	}

	const filename_relative = path.relative(
		path.join(game_root, 'game'),
		current_file
	)

	/** @type {string} */
	let cmd

	// windows calls python.exe and then renpy.py as an arg
	const win_renpy_path =
		os.platform() === 'win32' ? path.join(sdk_path, 'renpy.py') : null

	if (options.warp) {
		const line_number = options.line
			? vscode.window.activeTextEditor.selection.active.line + 1
			: 1

		cmd = make_cmd([
			executable,
			win_renpy_path,
			game_root,
			'--warp',
			`${filename_relative}:${line_number}`,
		])
	} else {
		cmd = make_cmd([executable, win_renpy_path, game_root])
	}

	try {
		logger.info('executing subshell', cmd)
		await exec_shell(cmd)
	} catch (err) {
		logger.error(err)
		vscode.window.showErrorMessage(err.message)
	}
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	logger = vscode.window.createOutputChannel("Ren'Py Warp to Line", {
		log: true,
	})

	context.subscriptions.push(
		vscode.commands.registerCommand('renpyWarp.warpToLine', (uri) =>
			main(uri, { warp: true })
		),
		vscode.commands.registerCommand('renpyWarp.launch', (uri) => main(uri)),
		vscode.commands.registerCommand('renpyWarp.warpToFile', (uri) => {
			main(uri, { warp: true, line: false })
		})
	)
}

function deactivate() {
	logger.dispose()
}

module.exports = {
	activate,
	deactivate,
}
