const vscode = require('vscode')
const path = require('upath')
const child_process = require('node:child_process')
const os = require('node:os')
const fs = require('node:fs/promises')
const untildify = require('untildify')
const { quoteForShell } = require('puka')
const chokidar = require('chokidar')

/** @type {vscode.LogOutputChannel} */
let logger

/** @type {vscode.StatusBarItem} */
let status_bar

class ExecPyTimeoutError extends Error {
	/**
	 * @param {string} [message]
	 */
	constructor(message) {
		super(message)
		this.name = 'ExecPyTimeoutError'
	}
}

class ProcessManager {
	constructor() {
		/** @type {Set<child_process.ChildProcess>} */
		this.processes = new Set()
	}

	/** @param {child_process.ChildProcess} process */
	add(process) {
		this.processes.add(process)
		this.update_status_bar()

		process.on('exit', () => {
			this.processes.delete(process)
			this.update_status_bar()
		})
	}

	kill_all() {
		for (const process of this.processes) {
			process.kill(9) // SIGKILL, bypasses "are you sure" dialog
		}
	}

	update_status_bar() {
		status_bar.show()
		if (this.length >= 1) {
			status_bar.text = `$(debug-stop) Quit Ren'Py`
			status_bar.command = 'renpyWarp.killAll'
		} else {
			status_bar.text = `$(play) Launch project`
			status_bar.command = 'renpyWarp.launch'
		}
	}

	get length() {
		return this.processes.size
	}
}

const pm = new ProcessManager()

/**
 * @param {string} key
 * @returns {any}
 */
function get_config(key) {
	return vscode.workspace.getConfiguration('renpyWarp').get(key)
}

/**
 * @param {string} game_root
 * @returns {Promise<'Replace' | 'New Window'>}
 */
async function determine_strategy(game_root) {
	return get_config('strategy') === 'Auto'
		? (await supports_exec_py(game_root))
			? 'Replace'
			: 'New Window'
		: get_config('strategy')
}

/**
 * @param {string} str
 * @returns {string}
 */
function parse_path(str) {
	return path.resolve(untildify(str))
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
 * @returns {Promise<string | undefined>}
 */
async function get_renpy_sh() {
	const is_windows = os.platform() === 'win32'

	/** @type {string} */
	const sdk_path_setting = get_config('sdkPath')

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
					'renpyWarp.sdkPath'
				)
			})
		return
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
		vscode.window
			.showErrorMessage(
				`Invalid Ren'Py SDK path: ${err.sdk_path}`,
				'Open Settings'
			)
			.then((selection) => {
				if (!selection) return
				vscode.commands.executeCommand(
					'workbench.action.openSettings',
					'renpyWarp.strategy'
				)
			})
		return
	}

	/** @type {string} */
	const editor_setting = get_config('editor')

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
		vscode.window
			.showErrorMessage(
				`Invalid Ren'Py editor path: '${err.editor_path}'`,
				'Open Settings'
			)
			.then((selection) => {
				if (!selection) return

				vscode.commands.executeCommand(
					'workbench.action.openSettings',
					'renpyWarp.editor'
				)
			})
		return
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
 * Executes a Python script.
 * @param {string} script - python script to execute
 * @param {string} game_root - path to the game root
 *
 * @returns {Promise<void>}
 */
async function exec_py(script, game_root) {
	const exec_path = path.join(game_root, 'exec.py')
	const exec_prelude =
		"# This file is created by Ren'Py Warp to Line and can safely be deleted\n"

	return new Promise(async (resolve, reject) => {
		const watcher = chokidar.watch(game_root)

		watcher.on('unlink', async (path) => {
			if (!path.endsWith('exec.py')) return
			// file was consumed by ren'py
			logger.info('exec.py executed successfully')
			await watcher.close()
			resolve()
		})

		logger.info(`writing exec.py: "${script}"`)
		await fs.writeFile(exec_path, exec_prelude + script)

		setTimeout(async () => {
			await watcher.close()
			const exec_py_file = await fs.stat(exec_path)

			if (!exec_py_file.isFile()) {
				// file has been consumed, probably executed ren'py
				logger.warn(
					'exec.py seemingly consumed, but watcher did not see file deletion'
				)
				resolve()
			} else {
				// seemingly not executed at all
				logger.error('exec.py timed out')
				try {
					await fs.unlink(exec_path) // delete the unconsumed file
				} catch (err) {}
				reject(new ExecPyTimeoutError())
			}
		}, 500)
	})
}

/**
 * determine if the current version of ren'py supports exec.py.
 *
 * an instance of ren'py must be running for this to work
 *
 * @returns {Promise<boolean>}
 */
async function supports_exec_py(game_root) {
	// write an exec file that does nothing and see if it executes, which
	// means the current version of ren'py supports exec.py

	if (!pm.length) {
		throw new Error('no renpy process running to test exec.py support')
	}

	try {
		await exec_py('', game_root)
		logger.info('exec.py probably supported')
		return true
	} catch (err) {
		if (err instanceof ExecPyTimeoutError) {
			logger.info('exec.py not supported')
			return false
		}

		throw err
	}
}

/**
 * @typedef {Object} Options
 * @property {'line' | 'file' | 'launch'} mode
 * @property {vscode.Uri} uri
 */

/**
 * starts renpy.sh with the appropriate arguments. resolves with the child
 * process if ren'py starts successfully
 *
 * if exec.py is supported, it will be used to warp to the line instead of
 * opening a new instance. in this case no child process is returned.
 *
 * @param {Partial<Options>} options
 * @returns {Promise<child_process.ChildProcess | undefined>}
 */
async function launch_renpy({ mode, uri } = {}) {
	const active_editor = vscode.window.activeTextEditor

	// deduce what is the current file for this context
	const renpy_file_in_workspace = await vscode.workspace
		.findFiles('**/game/**/*.rpy', null, 1)
		.then((files) => (files.length ? files[0].fsPath : null))
	const uri_path = uri && uri.fsPath
	const active_file = active_editor && active_editor.document.fileName

	const current_file =
		mode === 'launch' ? renpy_file_in_workspace : uri_path || active_file
	logger.info('current file:', current_file)

	if (!current_file) {
		vscode.window.showErrorMessage("No Ren'Py project in workspace")
		return
	}

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

	const line_number =
		mode === 'line'
			? vscode.window.activeTextEditor.selection.active.line + 1
			: 1

	if (
		pm.length &&
		['line', 'file'].includes(mode) &&
		(await determine_strategy(game_root)) === 'Replace'
	) {
		await exec_py(
			`renpy.warp_to_line('${filename_relative}:${line_number}')`,
			game_root
		).catch(() => {
			vscode.window
				.showErrorMessage(
					"Failed to warp inside active window. Your Ren'Py version may not support this feature. You may want to change the strategy in settings.",
					'Open Settings'
				)
				.then((selection) => {
					if (!selection) return
					vscode.commands.executeCommand(
						'workbench.action.openSettings',
						'renpyWarp.strategy'
					)
				})
		})
		return
	}

	const renpy_sh = await get_renpy_sh()

	/** @type {string} */
	let cmd

	if (mode === 'launch') {
		cmd = renpy_sh + ' ' + make_cmd([game_root])
	} else {
		cmd =
			renpy_sh +
			' ' +
			make_cmd([
				game_root,
				'--warp',
				`${filename_relative}:${line_number}`,
			])
	}

	logger.info('executing subshell:', cmd)

	const this_process = child_process.exec(cmd)
	pm.add(this_process)
	logger.info('created process', this_process.pid)

	this_process.stderr.on('data', (data) => {
		console.error('process stderr:', data)
	})
	this_process.stdout.on('data', (data) => {
		logger.info('process stdout:', data)
	})
	this_process.on('exit', (code) => {
		logger.info(`process ${this_process.pid} exited with code`, code)

		if (code === 0 || code === null) return // null if sigkill, usually intentional

		vscode.window
			.showErrorMessage(
				"Ren'Py process exited with errors",
				'Reopen',
				'Logs'
			)
			.then((selected) => {
				if (selected === 'Reopen') launch_renpy({ mode, uri })
				else if (selected === 'Logs') logger.show()
			})
	})

	return this_process
}

/**
 * @param {string} message
 * @param {(options: Partial<Options>) => Promise<child_process.ChildProcess>} run
 * @returns {(options: Partial<Options>) => void}
 */
function associate_progress_notification(message, run) {
	return (...args) => {
		vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: message,
			},
			async () => {
				await run(...args)
			}
		)
	}
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	logger = vscode.window.createOutputChannel("Ren'Py Warp to Line", {
		log: true,
	})

	status_bar = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		0
	)
	pm.update_status_bar()

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'renpyWarp.warpToLine',
			associate_progress_notification('Warping to line...', (...args) =>
				launch_renpy({ mode: 'line', ...args })
			)
		),
		vscode.commands.registerCommand(
			'renpyWarp.warpToFile',
			associate_progress_notification('Warping to file...', (...args) =>
				launch_renpy({ mode: 'file', ...args })
			)
		),
		vscode.commands.registerCommand(
			'renpyWarp.launch',
			associate_progress_notification("Launching Ren'Py...", (...args) =>
				launch_renpy({ mode: 'launch', ...args })
			)
		),
		vscode.commands.registerCommand('renpyWarp.killAll', () =>
			pm.kill_all()
		),
		logger,
		status_bar
	)
}

function deactivate() {
	pm.kill_all()
}

module.exports = {
	activate,
	deactivate,
}
