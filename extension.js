const vscode = require('vscode')
const path = require('path')
const child_process = require('child_process')
const fs = require('fs/promises')
const untildify = require('untildify')

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
		return null
	}

	return find_game_root(filename, haystack, depth + 1)
}

async function main() {
	const active_editor = vscode.window.activeTextEditor
	let sdk_path = vscode.workspace.getConfiguration('renpyWarp').get('sdkPath')

	if (!active_editor) {
		return
	}

	sdk_path = untildify(sdk_path)
	const executable = path.join(sdk_path, 'renpy.sh')

	try {
		await fs.access(executable, fs.constants.X_OK)
	} catch (err) {
		console.error(err)
		vscode.window
			.showErrorMessage(
				`No valid renpy.sh found at ${executable}. Please set a valid SDK path in \`renpyWarp.sdkPath\`.`,
				'Open Settings'
			)
			.then((selection) => {
				if (selection === 'Open Settings') {
					vscode.commands.executeCommand(
						'workbench.action.openSettings',
						'renpyWarp.sdkPath'
					)
				}
			})
		return
	}

	// is renpy file
	if (active_editor.document.languageId !== 'renpy') {
		vscode.window.showErrorMessage('Not in Renpy file')
		return
	}

	const line = active_editor.selection.active.line + 1
	const current_file = active_editor.document.fileName
	const game_root = find_game_root(current_file)

	if (!game_root) {
		vscode.window.showErrorMessage(
			'Unable to find "game" folder in parent directory. Not a Renpy project?'
		)
		return
	}

	const filename_relative = current_file.replace(game_root + '/', '')

	const cmd = [
		escape_shell_args(executable),
		escape_shell_args(game_root),
		'--warp',
		escape_shell_args(filename_relative + ':' + line),
	].join(' ')

	try {
		console.log(cmd)
		await exec_shell(cmd)
	} catch (err) {
		console.error(err)
		vscode.window.showErrorMessage(err.message)
	}
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand('renpyWarp.warp', main)
	)
}

// This method is called when your extension is deactivated
function deactivate() {}

module.exports = {
	activate,
	deactivate,
}
