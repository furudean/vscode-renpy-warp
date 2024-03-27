const vscode = require('vscode')
const path = require('upath')
const child_process = require('node:child_process')
const os = require('node:os')
const fs = require('node:fs/promises')
const untildify = require('untildify')

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

/**
 * @param {string} arg
 */
function escape_shell_args(arg) {
	return `'${arg.replace(/'/g, `'\\''`)}'`
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

async function main() {
	const active_editor = vscode.window.activeTextEditor
	/** @type {string} */
	let sdk_path = path.resolve(
		untildify(vscode.workspace.getConfiguration('renpyWarp').get('sdkPath'))
	)

	if (!active_editor) {
		return
	}

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
			.then(() => {
				vscode.commands.executeCommand(
					'workbench.action.openSettings',
					'renpyWarp.sdkPath'
				)
			})
		return
	}

	// is renpy file
	if (active_editor.document.languageId !== 'renpy') {
		vscode.window.showErrorMessage('Not in Renpy file')
		logger.info('not in renpy file')
		return
	}

	const line = active_editor.selection.active.line + 1
	const current_file = active_editor.document.fileName
	const game_root = find_game_root(current_file)

	if (!game_root) {
		vscode.window.showErrorMessage(
			'Unable to find "game" folder in parent directory. Not a Renpy project?'
		)
		logger.info(`cannot find game root in ${current_file}`)
		return
	}

	const filename_relative = path.relative(path.join(game_root, 'game'), current_file)

	const cmd = [
		escape_shell_args(executable),
		os.platform() === 'win32' ? 'renpy.py' : null,
		escape_shell_args(game_root),
		'--warp',
		escape_shell_args(filename_relative + ':' + line),
	]
		.filter(Boolean)
		.join(' ')

	try {
		logger.info(cmd)
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
		vscode.commands.registerCommand('renpyWarp.warp', main)
	)
}

function deactivate() {
	logger.dispose()
}

module.exports = {
	activate,
	deactivate,
}
