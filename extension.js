const vscode = require('vscode')
const path = require('upath')
const child_process = require('node:child_process')
const os = require('node:os')
const fs = require('node:fs/promises')
const untildify = require('untildify')
const { quoteForShell } = require('puka')
const p_throttle = require('p-throttle')
const tmp = require('tmp-promise')
const { windowManager } = require('node-window-manager')
const { promisify } = require('util')
const pidtree = promisify(require('pidtree'))

const IS_WINDOWS = os.platform() === 'win32'

const RENPY_VERSION_REGEX =
	/^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:\.(?<rest>.*))?$/

const EDITOR_SYNC_SCRIPT = `
def say_current_line(event, interact=True, **kwargs):
	import re
	import os

	if not interact:
		return

	if event == "begin":
		filename, line = renpy.get_filename_line()
		filename_without_game = re.sub(r"^game/", "", filename)

		filename_abs_path = os.path.join(config.gamedir, filename_without_game)
		print(f"RENPY_WARP_CURRENT_LINE:{filename_abs_path}:{filename_without_game}:{line}")

config.all_character_callbacks.append(say_current_line)
`

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
	/**
	 * @param {{ stdout_callback?: ((data: string) => void) }} options
	 */
	constructor({ stdout_callback }) {
		/** @type {Set<child_process.ChildProcess>} */
		this.processes = new Set()
		this.stdout_callback = stdout_callback || (() => {})

		this.update_status_bar()
	}

	/** @param {child_process.ChildProcess} process */
	add(process) {
		this.processes.add(process)
		this.update_status_bar()

		process.stdout.on('data', (data) => {
			process_out_channel.append(data)
			this.stdout_callback(data)
		})
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
 * @param {boolean} is_supports_exec_py
 * @returns {'New Window' | 'Replace Window' | 'Update Window'}
 */
function determine_strategy(is_supports_exec_py) {
	return get_config('strategy') === 'Auto'
		? is_supports_exec_py
			? 'Update Window'
			: 'New Window'
		: get_config('strategy')
}

/**
 * @param {string} str
 * @returns {string}
 */
function resolve_path(str) {
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
 * Returns the path to the Ren'Py SDK as specified in the settings
 *
 * @returns {Promise<string | undefined>}
 */
async function get_sdk_path() {
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

	const parsed_path = resolve_path(sdk_path_setting)

	try {
		await fs.access(parsed_path)
	} catch (err) {
		logger.warn('invalid sdk path:', err)
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

	return parsed_path
}

/**
 * @returns {Promise<string | undefined>}
 */
async function get_renpy_sh() {
	const sdk_path = await get_sdk_path()

	if (!sdk_path) return

	// on windows, we call python.exe and pass renpy.py as an argument
	// on all other systems, we call renpy.sh directly
	// https://www.renpy.org/doc/html/cli.html#command-line-interface
	const executable_name = IS_WINDOWS
		? 'lib/py3-windows-x86_64/python.exe'
		: 'renpy.sh'

	const executable = path.join(sdk_path, executable_name)

	try {
		await fs.access(executable)
	} catch (err) {
		logger.warn('invalid renpy.sh path:', err)
		vscode.window
			.showErrorMessage(
				`Invalid Ren'Py SDK path: ${sdk_path}`,
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
		editor = resolve_path(editor_setting)
	} else {
		// relative path to launcher
		editor = path.resolve(sdk_path, editor_setting)
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

	if (IS_WINDOWS) {
		const win_renpy_path = path.join(sdk_path, 'renpy.py')
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
 * rejects with `ExecPyTimeoutError` if ren'py does not read the file in a
 * reasonable time
 *
 * @param {string} script
 * the script to write to `exec.py`
 *
 * @param {string} game_root
 * path to the game root
 *
 * @param {number} [timeout_ms]
 * time in milliseconds to wait for ren'py to read the file
 *
 * @returns {Promise<void>}
 */
function exec_py(script, game_root, timeout_ms = 5000) {
	const process = pm.at(0)
	const exec_path = path.join(game_root, 'exec.py')

	const signature = 'executing script at ' + Date.now()
	const exec_prelude =
		"# This file is created by Ren'Py Launch and Sync and can safely be deleted\n#\n\n" +
		`print('${signature}')\n`

	return new Promise(async (resolve, reject) => {
		const tmp_file = await tmp.file()

		// write the script file atomically, as is recommended by ren'py
		await fs.writeFile(tmp_file.path, exec_prelude + script + '\n')

		/** @param {string} data */
		function listener(data) {
			if (!data.includes(signature)) return
			process.stdout.removeListener('data', listener)
			resolve()
		}

		process.stdout.on('data', listener)

		logger.info(`writing exec.py: "${script}"`)
		await fs.rename(tmp_file.path, exec_path)

		setTimeout(() => {
			process.stdout.removeListener('data', listener)
			reject(new ExecPyTimeoutError())
		}, timeout_ms)
		tmp_file.cleanup()
	})
}

/**
 * @param {string} renpy_sh
 * base renpy.sh command
 */
function get_version(renpy_sh) {
	return child_process
		.execSync(renpy_sh + ' --version')
		.toString('utf-8')
		.trim()
		.replace("Ren'Py ", '')
}

/**
 * @param {number} pid
 */
async function focus_window(pid) {
	// windows creates subprocesses for each window, so we need to find
	// the subprocess associated with the parent process we created
	const pids = [pid, ...(await pidtree(pid))]
	const matching_windows = windowManager
		.getWindows()
		.filter((win) => pids.includes(win.processId))

	logger.info('matching windows:', matching_windows)

	if (!matching_windows) {
		logger.error('no matching window found', windowManager.getWindows())
		return
	}

	const has_accessibility = windowManager.requestAccessibility()

	if (has_accessibility) {
		matching_windows.forEach((win) => {
			// bring all windows to top. windows creates many
			// subprocesses and figuring out the right one is not straightforward
			win.bringToTop()
		})
	} else {
		vscode.window.showInformationMessage(
			"Accessibility permissions have been requested. These are used to focus the Ren'Py window. You may need to restart Visual Studio Code for this to take effect."
		)
	}
}

/**
 * determine if the current version of ren'py supports exec.py
 *
 * @param {string} renpy_sh
 * base renpy.sh command
 *
 * @returns {boolean}
 */
function supports_exec_py(renpy_sh) {
	const version = get_version(renpy_sh)

	logger.info("ren'py version:", version)

	const { major, minor } = RENPY_VERSION_REGEX.exec(version).groups

	return Number(major) >= 8 && Number(minor) >= 3
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
	const filename_relative = path.relative(path.join(game_root, 'game/'), file)
	logger.debug('game root:', game_root)

	if (!game_root) {
		vscode.window.showErrorMessage(
			'Unable to find "game" folder in parent directory. Not a Ren\'Py project?'
		)
		logger.info(`cannot find game root in ${file}`)
		return
	}

	const renpy_sh = await get_renpy_sh()
	if (!renpy_sh) return

	const is_supports_exec_py = supports_exec_py(renpy_sh)

	// warp in existing ren'py window
	if (
		pm.length &&
		Number.isInteger(line) &&
		determine_strategy(is_supports_exec_py) === 'Update Window'
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
						'Failed to warp inside active window. You may want to change the strategy in settings.',
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

		if (get_config('focusWindowOnWarp')) {
			await focus_window(pm.at(0).pid)
		}

		return
	}

	// open new ren'py window

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

	if (is_supports_exec_py) {
		logger.info('using exec.py for accurate progress bar')
		try {
			await exec_py('', game_root, 10000)
			logger.info('clear progress bar')
		} catch (err) {
			if (err instanceof ExecPyTimeoutError) {
				logger.warn(
					'exec.py not read by renpy in time for progress bar'
				)
				await fs.unlink(path.join(game_root, 'exec.py'))
			} else {
				throw err
			}
		}
	} else {
		logger.info('using early progress bar')
	}

	const launch_script = get_config('launchScript').trim()

	if (is_supports_exec_py) {
		if (launch_script) {
			logger.info('executing launch script:', launch_script)
			await exec_py(launch_script, game_root)
		}

		await exec_py(EDITOR_SYNC_SCRIPT, game_root)
	}

	return this_process
}

/**
 * @template T
 * @param {string} message
 * @param {(...args: any[]) => Promise<T>} run
 * @returns {(...args: any[]) => Promise<T>}
 */
function associate_progress_notification(message, run) {
	return function (...args) {
		return new Promise((resolve, reject) => {
			vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: message,
				},
				async () => {
					try {
						const result = await run(...args)
						resolve(result)
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

	/**
	 * This function is called whenever Ren'Py outputs a line to stdout. A
	 * special script is injected into Ren'Py that will output this spec.
	 *
	 * @param {string} renpy_stdout
	 */
	async function sync_editor_with_renpy(renpy_stdout) {
		if (
			is_follow_cursor &&
			renpy_stdout.startsWith('RENPY_WARP_CURRENT_LINE:') &&
			["Ren'Py updates Visual Studio Code", 'Update both'].includes(
				get_config('followCursorMode')
			)
		) {
			const [, abs_path, game_path, line] = renpy_stdout.trim().split(':')
			const zero_indexed_line = Number(line) - 1

			// prevent feedback loop with warp to cursor
			//
			// TODO: this will still happen if renpy warps to a different line
			// than the one requested.
			last_warp_spec = `${game_path}:${line}`

			const doc = await vscode.workspace.openTextDocument(abs_path)
			await vscode.window.showTextDocument(doc)
			const editor = vscode.window.activeTextEditor

			// if the cursor is already on the correct line, don't munge it
			if (editor.selection.start.line === zero_indexed_line) return

			const end_of_line =
				editor.document.lineAt(zero_indexed_line).range.end.character
			const pos = new vscode.Position(zero_indexed_line, end_of_line)
			const selection = new vscode.Selection(pos, pos)

			editor.selection = selection
			editor.revealRange(selection)
		}
	}

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
		"When enabled, keep editor cursor and Ren'Py in sync"

	pm = new ProcessManager({
		stdout_callback: sync_editor_with_renpy,
	})

	const throttle = p_throttle({
		limit: 1,
		// renpy only reads exec.py every 100ms. but writing the file more
		// frequently is more responsive
		interval: get_config('followCursorExecInterval'),
	})

	const warp_renpy_to_cursor = throttle(async () => {
		if (pm.length !== 1) {
			logger.info(
				'needs exactly one instance to follow... got',
				pm.length
			)

			await vscode.commands.executeCommand('renpyWarp.toggleFollowCursor')
			return
		}

		const editor = vscode.window.activeTextEditor

		if (!editor) return

		const language_id = editor.document.languageId
		const file = editor.document.uri.fsPath
		const line = editor.selection.active.line

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
				/** @param {vscode.Uri} uri */
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
					const renpy_sh = await get_renpy_sh()
					if (!renpy_sh) return

					if (!supports_exec_py(renpy_sh)) {
						vscode.window.showErrorMessage(
							`Ren'Py version must be 8.3.0 or newer to follow cursor (Current is ${get_version(
								renpy_sh
							)})`
						)
						return
					}

					if (pm.length > 1) {
						vscode.window.showErrorMessage(
							"Multiple Ren'Py instances running. Cannot follow cursor."
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

					if (pm.length === 0) {
						const launch = associate_progress_notification(
							"Launching Ren'Py...",
							async () => await launch_renpy()
						)

						try {
							await launch()
						} catch (err) {
							logger.error(err)
							vscode.commands.executeCommand(
								'renpyWarp.toggleFollowCursor'
							)
							return
						}
					}

					text_editor_handle =
						vscode.window.onDidChangeTextEditorSelection(
							async (event) => {
								if (
									[
										"Visual Studio Code updates Ren'Py",
										'Update both',
									].includes(
										get_config('followCursorMode')
									) &&
									event.kind !==
										vscode.TextEditorSelectionChangeKind
											.Command
								) {
									await warp_renpy_to_cursor()
								}
							}
						)
					context.subscriptions.push(text_editor_handle)

					if (
						[
							"Visual Studio Code updates Ren'Py",
							'Update both',
						].includes(get_config('followCursorMode'))
					) {
						await warp_renpy_to_cursor()
					}
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
