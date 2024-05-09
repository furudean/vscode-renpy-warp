const vscode = require('vscode')
const path = require('upath')
const child_process = require('node:child_process')
const os = require('node:os')
const fs = require('node:fs/promises')
const untildify = require('untildify')
const { quoteForShell } = require('puka')
const p_throttle = require('p-throttle')
const tmp = require('tmp-promise')

/** @type {ProcessManager} */
let pm

/** @type {vscode.LogOutputChannel} */
let logger

/** @type {vscode.OutputChannel} */
let process_out_channel

/** @type {vscode.StatusBarItem} */
let instance_status_bar

/** @type {vscode.StatusBarItem} */
let follow_cursor_status_bar

let is_follow_cursor = false

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

		this.update_status_bar()
	}

	/** @param {child_process.ChildProcess} process */
	add(process) {
		this.processes.add(process)
		this.update_status_bar()

		process.stdout.on('data', process_out_channel.append)
		process.stderr.on('data', process_out_channel.append)
		process.on('exit', (code) => {
			this.processes.delete(process)
			this.update_status_bar()

			logger.info(`process ${process.pid} exited with code ${code}`)

			if (code) {
				vscode.window
					.showErrorMessage(
						"Ren'Py process exited with errors",
						'Logs'
					)
					.then((selected) => {
						if (selected === 'Logs') process_out_channel.show()
					})
			}
		})

		if (this.length > 1 && is_follow_cursor) {
			vscode.commands.executeCommand('renpyWarp.toggleFollowCursor')
			vscode.window.showInformationMessage(
				"Follow cursor was disabled because multiple Ren'Py instances are running"
			)
		}
	}

	/**
	 * @param {number} index
	 * @returns {child_process.ChildProcess | undefined}
	 */
	at(index) {
		return Array.from(this.processes)[index]
	}

	kill_all() {
		for (const process of this.processes) {
			process.kill(9) // SIGKILL, bypasses "are you sure" dialog
		}

		this.update_status_bar()
	}

	update_status_bar() {
		instance_status_bar.show()

		if (this.length) {
			instance_status_bar.text = `$(debug-stop) Quit Ren'Py`
			instance_status_bar.command = 'renpyWarp.killAll'
			instance_status_bar.tooltip = "Kill all running Ren'Py instances"

			follow_cursor_status_bar.show()
		} else {
			instance_status_bar.text = `$(play) Launch Project`
			instance_status_bar.command = 'renpyWarp.launch'
			instance_status_bar.tooltip = "Launch new Ren'Py instance"

			follow_cursor_status_bar.hide()

			if (is_follow_cursor) {
				vscode.commands.executeCommand('renpyWarp.toggleFollowCursor')
			}
		}
	}

	get length() {
		return this.processes.size
	}
}

/**
 * @param {string} key
 * @returns {any}
 */
function get_config(key) {
	return vscode.workspace.getConfiguration('renpyWarp').get(key)
}

/**
 * @param {string} game_root
 * @returns {Promise<'New Window' | 'Replace Window' | 'Update Window'>}
 */
async function determine_strategy(game_root) {
	return get_config('strategy') === 'Auto'
		? (await supports_exec_py(game_root))
			? 'Update Window'
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
					'@ext:PaisleySoftworks.renpyWarp sdkPath'
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
				`Invalid Ren'Py SDK path: ${sdk_path_setting}`,
				'Open Settings'
			)
			.then((selection) => {
				if (!selection) return
				vscode.commands.executeCommand(
					'workbench.action.openSettings',
					'@ext:PaisleySoftworks.renpyWarp sdkPath'
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
					'@ext:PaisleySoftworks.renpyWarp editor'
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
 * writes a script to `exec.py` in the game root and waits for ren'py to read it
 *
 * rejects with `ExecPyTimeoutError` if ren'py does not read the file within
 * 500ms
 *
 * @param {string} script
 * the script to write to `exec.py`
 *
 * @param {string} game_root
 * path to the game root
 *
 * @returns {Promise<void>}
 */
function exec_py(script, game_root) {
	const exec_path = path.join(game_root, 'exec.py')

	const signature = 'executing script at ' + Date.now()
	const exec_prelude =
		"# This file is created by Ren'Py Launch and Sync and can safely be deleted\n#\n\n" +
		`print('${signature}')\n`

	return new Promise(async (resolve, reject) => {
		const tmp_file = await tmp.file()

		// write the script file atomically, as is recommended by ren'py
		await fs.writeFile(tmp_file.path, exec_prelude + script + '\n')

		pm.at(0).stdout.once('data', (data) => {
			if (data.includes(signature)) {
				resolve()
			}
		})

		logger.info(`writing exec.py: "${script}"`)
		await fs.rename(tmp_file.path, exec_path)

		setTimeout(() => {
			reject(new ExecPyTimeoutError())
		}, 500)
		tmp_file.cleanup()
	})
}

/**
 * determine if the current version of ren'py supports exec.py.
 *
 * an instance of ren'py must be running for this to work
 *
 * @param {string} game_root
 * @returns {Promise<boolean>}
 */
async function supports_exec_py(game_root) {
	if (!pm.length) {
		throw new Error('no renpy process running to test exec.py support')
	}

	try {
		// write an exec file that does nothing to see if ren'py reads it
		await exec_py('', game_root)
		logger.info('exec.py is supported')
		return true
	} catch (err) {
		if (err instanceof ExecPyTimeoutError) {
			logger.info('exec.py not supported')
			return false
		} else {
			throw err
		}
	}
}

/**
 * starts or warps depending on arguments and settings specified for the
 * extension
 *
 * if strategy is `Update Window`, no new window is opened and the current one
 * is updated instead.
 *
 * @param {object} [options]
 * @param {string} [options.file]
 * fs path representing the current editor. selects the file to warp to. if
 * null, simply open ren'py and detect the project root
 * @param {number} [options.line]
 * zero-indexed line number. if set, warp to line will be attempted
 *
 * @returns {Promise<child_process.ChildProcess | undefined>}
 * resolves with the child process if a new instance was opened, otherwise
 * undefined
 */
async function launch_renpy({ file, line } = {}) {
	logger.info('launch_renpy:', { file, line })

	if (!file) {
		file = await vscode.workspace
			.findFiles('**/game/**/*.rpy', null, 1)
			.then((files) => (files.length ? files[0].fsPath : null))
	}

	if (!file) {
		vscode.window.showErrorMessage("No Ren'Py project in workspace")
		return
	}

	const game_root = find_game_root(file)
	logger.debug('game root:', game_root)

	if (!game_root) {
		vscode.window.showErrorMessage(
			'Unable to find "game" folder in parent directory. Not a Ren\'Py project?'
		)
		logger.info(`cannot find game root in ${file}`)
		return
	}

	const filename_relative = path.relative(path.join(game_root, 'game/'), file)

	// warp in existing ren'py window
	if (
		pm.length &&
		line &&
		(await determine_strategy(game_root)) === 'Update Window'
	) {
		if (pm.length > 1) {
			vscode.window.showErrorMessage(
				"Multiple Ren'Py instances running. Cannot warp inside open Ren'Py window."
			)
			return
		}

		try {
			await exec_py(
				`renpy.warp_to_line('${filename_relative}:${line + 1}')`,
				game_root
			)
		} catch (err) {
			if (err instanceof ExecPyTimeoutError) {
				vscode.window
					.showErrorMessage(
						"Failed to warp inside active window. Your Ren'Py version may not support this feature. You may want to change the strategy in settings.",
						'Open Settings'
					)
					.then((selection) => {
						if (!selection) return
						vscode.commands.executeCommand(
							'workbench.action.openSettings',
							'@ext:PaisleySoftworks.renpyWarp strategy'
						)
					})
				return
			} else {
				throw err
			}
		}

		return
	}

	// open new ren'py window
	const renpy_sh = await get_renpy_sh()

	if (!renpy_sh) return

	/** @type {string} */
	let cmd

	if (line === undefined) {
		cmd = renpy_sh + ' ' + make_cmd([game_root])
	} else {
		cmd =
			renpy_sh +
			' ' +
			make_cmd([game_root, '--warp', `${filename_relative}:${line + 1}`])
	}

	logger.info('executing subshell:', cmd)

	const this_process = child_process.exec(cmd)
	logger.info('created process', this_process.pid)

	if (get_config('strategy') === 'Replace Window') pm.kill_all()

	pm.add(this_process)

	return this_process
}

/**
 * @param {string} message
 * @param {(uri: vscode.Uri | undefined) => Awaited<any>} run
 * @returns {(uri: vscode.Uri | undefined) => Promise<void>}
 */
function associate_progress_notification(message, run) {
	return function (uri) {
		return new Promise((resolve, reject) => {
			vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: message,
				},
				async () => {
					try {
						await run(uri)
						resolve()
					} catch (err) {
						logger.error(err)
						logger.show()
						reject(err)
					}
				}
			)
		})
	}
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	/** @type {vscode.Disposable} */
	let text_editor_handle

	/** @type {string | undefined} */
	let last_warp_spec

	logger = vscode.window.createOutputChannel(
		"Ren'Py Launch and Sync - Extension",
		{
			log: true,
		}
	)

	process_out_channel = vscode.window.createOutputChannel(
		"Ren'Py Launch and Sync - Process Output"
	)

	instance_status_bar = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		0
	)

	follow_cursor_status_bar = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		0
	)

	follow_cursor_status_bar.text = '$(pin) Follow Cursor'
	follow_cursor_status_bar.command = 'renpyWarp.toggleFollowCursor'
	follow_cursor_status_bar.tooltip =
		"When enabled, Ren'Py will continuously warp to the line being edited"

	pm = new ProcessManager()

	const throttle = p_throttle({
		limit: 1,
		// renpy only reads exec.py every 100ms. but writing the file more
		// frequently is more responsive
		interval: get_config('followCursorExecInterval'),
	})

	const follow_cursor = throttle(async () => {
		if (pm.length !== 1) {
			logger.info(
				'needs exactly one instance to follow... got',
				pm.length
			)

			await vscode.commands.executeCommand('renpyWarp.toggleFollowCursor')
			return
		}

		if (!vscode.window.activeTextEditor) return

		const language_id = vscode.window.activeTextEditor.document.languageId
		const file = vscode.window.activeTextEditor.document.uri.fsPath
		const line = vscode.window.activeTextEditor.selection.active.line

		if (language_id !== 'renpy') return

		const game_root = find_game_root(file)
		const filename_relative = path.relative(
			path.join(game_root, 'game/'),
			file
		)

		const warp_spec = `${filename_relative}:${line + 1}`

		if (warp_spec === last_warp_spec) return // no change
		last_warp_spec = warp_spec

		try {
			await exec_py(`renpy.warp_to_line('${warp_spec}')`, game_root)
			logger.info('warped to', warp_spec)
		} catch (err) {
			if (err instanceof ExecPyTimeoutError) {
				// this will happen if the user switches files too quickly, as the
				// old file is replaced before its consumed by renpy
				logger.debug('failed to warp:', err)
			} else {
				throw err
			}
		}
	})

	context.subscriptions.push(
		logger,
		process_out_channel,
		instance_status_bar,
		follow_cursor_status_bar,

		vscode.commands.registerCommand(
			'renpyWarp.warpToLine',
			associate_progress_notification(
				'Warping to line...',
				async () =>
					await launch_renpy({
						file: vscode.window.activeTextEditor.document.uri
							.fsPath,
						line: vscode.window.activeTextEditor.selection.active
							.line,
					})
			)
		),

		vscode.commands.registerCommand(
			'renpyWarp.warpToFile',
			associate_progress_notification(
				'Warping to file...',
				async (uri) => {
					const fs_path = uri
						? uri.fsPath
						: vscode.window.activeTextEditor.document.uri.fsPath

					await launch_renpy({
						file: fs_path,
						line: 0,
					})
				}
			)
		),

		vscode.commands.registerCommand(
			'renpyWarp.launch',
			associate_progress_notification(
				"Launching Ren'Py...",
				async () => await launch_renpy()
			)
		),

		vscode.commands.registerCommand('renpyWarp.killAll', () =>
			pm.kill_all()
		),

		vscode.commands.registerCommand(
			'renpyWarp.toggleFollowCursor',
			async () => {
				if (!is_follow_cursor) {
					if (pm.length === 0) {
						vscode.window.showErrorMessage(
							"No Ren'Py instances running. Cannot follow cursor."
						)
						return
					}

					if (pm.length > 1) {
						vscode.window.showErrorMessage(
							"Multiple Ren'Py instances running. Cannot follow cursor."
						)
						return
					}

					const game_root = find_game_root(
						vscode.window.activeTextEditor
							? vscode.window.activeTextEditor.document.uri.fsPath
							: await vscode.workspace
									.findFiles('**/game/**/*.rpy', null, 1)
									.then((files) =>
										files.length ? files[0].fsPath : null
									)
					)

					if (!game_root) {
						vscode.window.showErrorMessage(
							"Unable to find game root. Not a Ren'Py project?"
						)
						return
					}
					if (!(await supports_exec_py(game_root))) {
						vscode.window.showErrorMessage(
							"Your Ren'Py version does not support following cursor. Ren'Py version must be 8.3.0 or nightly."
						)
						return
					}

					is_follow_cursor = true
					follow_cursor_status_bar.text = '$(pinned) Following Cursor'
					follow_cursor_status_bar.color = new vscode.ThemeColor(
						'statusBarItem.warningForeground'
					)
					follow_cursor_status_bar.backgroundColor =
						new vscode.ThemeColor('statusBarItem.warningBackground')

					text_editor_handle =
						vscode.window.onDidChangeTextEditorSelection(
							follow_cursor
						)
					context.subscriptions.push(text_editor_handle)

					follow_cursor()
				} else {
					is_follow_cursor = false
					follow_cursor_status_bar.text = '$(pin) Follow Cursor'
					follow_cursor_status_bar.backgroundColor = undefined
					follow_cursor_status_bar.color = undefined
					text_editor_handle.dispose()
				}
			}
		)
	)
}

function deactivate() {
	pm.kill_all()
}

module.exports = {
	activate,
	deactivate,
}
