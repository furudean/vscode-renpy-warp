const vscode = require('vscode')
const path = require('path')
const child_process = require('child_process')

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
 */
function relative_to_game_root(filename, haystack = null) {
	const workspace_root = vscode.workspace.workspaceFolders[0].uri.fsPath

	if (haystack) {
		haystack = path.resolve(haystack, '..')
	} else {
		haystack = path.dirname(filename)
	}

	if (path.basename(haystack) === 'game') {
		return {
			filename: filename.replace(haystack + '/', ''),
			game_root: haystack,
		}
	}

	if (haystack === workspace_root) {
		vscode.window.showErrorMessage('Unable to find "game" folder')
		return null
	}

	return relative_to_game_root(filename, haystack)
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	// The command has been defined in the package.json file
	// Now provide the implementation of the command with  registerCommand
	// The commandId parameter must match the command field in package.json
	let disposable = vscode.commands.registerCommand(
		'renpy-warp.warp',
		async function () {
			const active_editor = vscode.window.activeTextEditor
			const sdk_path = vscode.workspace
				.getConfiguration('renpy-warp')
				.get('sdkPath')

			if (!active_editor) {
				return
			}

			// is renpy file
			if (active_editor.document.languageId !== 'renpy') {
				vscode.window.showErrorMessage('Not a Renpy file')
				return
			}

			const line = active_editor.selection.active.line + 1
			const current_file = active_editor.document.fileName
			const { filename, game_root } = relative_to_game_root(current_file)

			const cmd = `${sdk_path}/renpy.sh ${escape_shell_args(
				game_root
			)} --warp ${escape_shell_args(filename + ':' + line)}`

			try {
				console.log(cmd)
				await exec_shell(cmd)
			} catch (err) {
				vscode.window.showErrorMessage(err.message)
			}
		}
	)

	context.subscriptions.push(disposable)
}

// This method is called when your extension is deactivated
function deactivate() {}

module.exports = {
	activate,
	deactivate,
}
