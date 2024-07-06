const vscode = require('vscode')
const path = require('upath')
const child_process = require('node:child_process')
const os = require('node:os')
const fs = require('node:fs/promises')
const untildify = require('untildify')
const { quoteForShell } = require('puka')
const p_throttle = require('p-throttle')
const pidtree = require('pidtree')
const ws = require('ws')
const AdmZip = require('adm-zip')
const semver = require('semver')
const { windowManager } = require('node-window-manager')

const pkg_version = require('./package.json').version
const IS_WINDOWS = os.platform() === 'win32'

/** @type {ws.WebSocketServer} */
let wss

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

/** @type {string | undefined} */
let last_warp_spec = undefined

/** @type {string} */
let rpe_source_path

class RenpyProcess {
	/**
	 * @param {object} options
	 * @param {string} options.cmd
	 * @param {(data: Record<string, any>) => void} options.message_handler
	 * @param {string} options.game_root
	 */
	constructor({ cmd, message_handler, game_root }) {
		/** @type {string} */
		this.cmd = cmd
		/** @type {child_process.ChildProcess} */
		this.process = undefined
		/** @type {ws.WebSocket} */
		this.socket = undefined
		/** @type {(data: any) => void | Promise<void>} */
		this.message_handler = message_handler
		/** @type {string} */
		this.game_root = game_root
		/** @type {number | undefined} */
		this.renpy_pid = undefined

		logger.info('executing subshell:', cmd)
		this.process = child_process.exec(cmd)

		this.process.stdout.on('data', process_out_channel.append)
		this.process.stderr.on('data', process_out_channel.append)
		this.process.on('exit', (code) => {
			logger.info(`process ${this.process.pid} exited with code ${code}`)
		})

		logger.info('created process', this.process.pid)
	}

	/**
	 * @returns {Promise<void>}
	 */
	async wait_for_socket() {
		if (this.socket) return

		logger.info('waiting for socket connection from renpy window...')

		return new Promise((resolve, reject) => {
			const t = setTimeout(() => {
				reject(new Error('timed out waiting for socket'))
				vscode.window
					.showErrorMessage(
						"Timed out trying to connect to Ren'Py window. Is the socket client running?",
						'Logs',
						'OK'
					)
					.then((selection) => {
						if (selection === 'Logs') logger.show()
					})
			}, 10000)

			const interval = setInterval(() => {
				if (this.socket) {
					clearTimeout(t)
					clearInterval(interval)
					resolve()
				}
			}, 10)
		})
	}

	/**
	 * @typedef {object} message
	 * @property {string} message.type
	 *
	 * @param {message & Record<string, any>} message
	 * @returns {Promise<void>}
	 */
	async ipc(message) {
		if (!this.socket) {
			logger.info('no socket, waiting for connection...')
			await ensure_websocket_server()
			await this.wait_for_socket()
		}

		return new Promise((resolve, reject) => {
			const serialized = JSON.stringify(message)

			const t = setTimeout(() => {
				reject(new Error('ipc timed out'))
			}, 1000)
			this.socket.send(serialized, (err) => {
				logger.debug('websocket >', serialized)

				clearInterval(t)
				if (err) {
					reject(err)
				} else {
					resolve()
				}
			})
		})
	}

	/**
	 * @param {string} file
	 * relative filename to
	 * @param {number} line
	 * 1-indexed line number
	 */
	async warp_to_line(file, line) {
		return this.ipc({
			type: 'warp_to_line',
			file,
			line,
		})
	}
}

class ProcessManager {
	constructor() {
		/** @type {Map<number, RenpyProcess>} */
		this.processes = new Map()

		this.update_status_bar()
	}

	/** @param {RenpyProcess} process */
	async add(process) {
		this.processes.set(process.process.pid, process)
		this.update_status_bar()

		process.process.on('exit', (code) => {
			this.processes.delete(process.process.pid)
			this.update_status_bar()

			if (code) {
				vscode.window
					.showErrorMessage(
						"Ren'Py process exited with errors",
						'OK',
						'Logs'
					)
					.then((selected) => {
						if (selected === 'Logs') process_out_channel.show()
					})
			}
		})
	}

	/**
	 * @param {number} pid
	 * @returns {RenpyProcess | undefined}
	 */
	get(pid) {
		return this.processes.get(pid)
	}

	/**
	 * @param {number} index
	 * @returns {RenpyProcess | undefined}
	 */
	at(index) {
		return Array.from(this.processes.values())[index]
	}

	kill_all() {
		for (const { process: process } of this.processes.values()) {
			process.kill(9) // SIGKILL, bypasses "are you sure" dialog
		}
	}

	update_status_bar() {
		instance_status_bar.show()

		if (this.length && get_config('renpyExtensionsEnabled')) {
			follow_cursor_status_bar.show()
		} else {
			follow_cursor_status_bar.hide()
		}

		if (this.length) {
			instance_status_bar.text = `$(debug-stop) Quit Ren'Py`
			instance_status_bar.command = 'renpyWarp.killAll'
			instance_status_bar.tooltip = "Kill all running Ren'Py instances"
		} else {
			instance_status_bar.text = `$(play) Launch Project`
			instance_status_bar.command = 'renpyWarp.launch'
			instance_status_bar.tooltip = "Launch new Ren'Py instance"

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
 * @param {string} str
 * @returns {string}
 */
function resolve_path(str) {
	return path.resolve(untildify(str))
}

/**
 * @param {Record<string, string>} entries
 * @returns {string}
 *
 * @example
 * // on unix
 * env_string({ FOO: 'bar', BAZ: 'qux' })
 * // "FOO='bar' BAZ='qux'"
 *
 * // on windows
 * env_string({ FOO: 'bar', BAZ: 'qux' })
 * // 'set "FOO=bar" && set "BAZ=qux"'
 */
function env_string(entries) {
	return Object.entries(entries)
		.map(([key, value]) =>
			IS_WINDOWS ? `set "${key}=${value}"` : `${key}='${value}'`
		)
		.join(IS_WINDOWS ? ' && ' : ' ')
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
 * @param {Record<string, string | number>} [environment]
 * @returns {Promise<string | undefined>}
 */
async function get_renpy_sh(environment = {}) {
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
			env_string({ ...environment, RENPY_EDIT_PY: editor }) +
			' && ' +
			make_cmd([executable, win_renpy_path])
		)
	} else {
		// RENPY_EDIT_PY=editor.edit.py renpy.sh
		return (
			env_string({ ...environment, RENPY_EDIT_PY: editor }) +
			' ' +
			make_cmd([executable])
		)
	}
}

/**
 * @param {string} game_root
 * @returns {Promise<void>}
 */
async function install_rpe(game_root) {
	const version = get_version(await get_renpy_sh())
	const supports_rpe_py = semver.gte(version.semver, '8.3.0')

	const files = await vscode.workspace
		.findFiles('**/renpy_warp_*.rpe*')
		.then((files) => files.map((f) => f.fsPath))

	for (const file of files) {
		await fs.unlink(file)
		logger.info('deleted old rpe at', file)
	}

	const rpe_source_code = await fs.readFile(rpe_source_path)
	/** @type {string} */
	let file_path

	if (supports_rpe_py) {
		file_path = path.join(
			game_root,
			'game/', // TODO: https://github.com/renpy/renpy/issues/5614
			`renpy_warp_${pkg_version}.rpe.py`
		)
		await fs.writeFile(file_path, rpe_source_code)
		logger.info('wrote rpe to', file_path)
	} else {
		file_path = path.join(
			game_root,
			'game/',
			`renpy_warp_${pkg_version}.rpe`
		)
		const zip = new AdmZip()
		zip.addFile('autorun.py', rpe_source_code)
		await fs.writeFile(file_path, zip.toBuffer())
	}

	logger.info('wrote rpe to', file_path)
}

/**
 * @returns {Promise<boolean>}
 */
async function has_any_rpe() {
	return vscode.workspace
		.findFiles('**/renpy_warp_*.rpe*')
		.then((files) => files.length > 0)
}

/**
 * @param {string} renpy_sh
 * @returns {Promise<boolean>}
 */
async function has_current_rpe(renpy_sh) {
	const files = await vscode.workspace
		.findFiles('**/renpy_warp_*.rpe*')
		.then((files) => files.map((f) => f.fsPath))

	const renpy_version = get_version(renpy_sh)
	const supports_rpe_py = semver.gte(renpy_version.semver, '8.3.0')

	for (const file of files) {
		const basename = path.basename(file)

		// find mismatched feature support
		if (!supports_rpe_py && basename.endsWith('.rpe.py')) return false
		if (supports_rpe_py && basename.endsWith('.rpe')) return false

		const version = basename.match(
			/renpy_warp_(?<version>.+)\.rpe(?:\.py)?/
		).groups.version

		if (version === pkg_version) {
			return true
		}
	}

	return false
}

/**
 * @param {string} renpy_sh
 * base renpy.sh command
 */
function get_version(renpy_sh) {
	const RENPY_VERSION_REGEX =
		/^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:\.(?<rest>.*))?$/

	const version_string = child_process
		.execSync(renpy_sh + ' --version')
		.toString('utf-8')
		.trim()
		.replace("Ren'Py ", '')

	const { major, minor, patch, rest } =
		RENPY_VERSION_REGEX.exec(version_string).groups

	return {
		semver: `${major}.${minor}.${patch}`,
		major: Number(major),
		minor: Number(minor),
		patch: Number(patch),
		rest,
	}
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

	logger.debug('matching windows:', matching_windows)

	if (!matching_windows) {
		logger.warn('no matching window found', windowManager.getWindows())
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
			"Accessibility permissions have been requested. These are used to focus the Ren'Py window. You may need to restart Visual Studio Code for this to take effect.",
			'OK'
		)
	}
}

/**
 * @returns {Promise<void>}
 */
async function ensure_websocket_server() {
	if (wss) {
		logger.debug('socket server already running')
		return
	}

	return new Promise(async (resolve, reject) => {
		let has_listened = false
		const port = get_config('webSocketsPort')
		wss = new ws.WebSocketServer({ port })

		/** @type {NodeJS.Timeout} */
		let close_timeout = undefined

		wss.on('listening', () => {
			has_listened = true
			logger.info('socket server listening on port', wss.options.port)
			resolve()
		})

		wss.on('error', (...args) => {
			logger.error('socket server error:', ...args)

			if (!has_listened) {
				vscode.window
					.showErrorMessage(
						`Failed to start websockets server. Is the port ${port} already in use?`,
						'Logs',
						'OK'
					)
					.then((selection) => {
						if (selection === 'Logs') {
							logger.show()
						}
					})
			}
			wss = undefined
			reject()
		})

		wss.on('close', () => {
			wss = undefined
			reject()
		})

		wss.on('connection', async (ws, req) => {
			/** @type {RenpyProcess | undefined} */
			let rp

			const renpy_pid = Number(req.headers['pid'])
			for (const pid of pm.processes.keys()) {
				// the process might be a child of the process we created
				const pid_tree = await pidtree(pid, { root: true })
				logger.debug('pid tree:', pid_tree)
				if (pid_tree.includes(renpy_pid)) {
					logger.info(
						`matched new connection from ${pid} to launched process ${renpy_pid}`
					)
					rp = pm.get(pid)
					rp.socket = ws
					rp.renpy_pid = renpy_pid
					break
				}
			}

			if (!rp) {
				logger.warn(
					'unknown process tried to connect to socket server',
					renpy_pid
				)
				ws.close()
				return
			}

			clearTimeout(close_timeout)

			ws.on('message', async (data) => {
				logger.debug('websocket <', data.toString())
				const message = JSON.parse(data.toString())

				await rp.message_handler(message)
			})

			ws.on('close', () => {
				logger.info(
					'websocket connection closed to pid',
					rp.process.pid
				)
				rp.socket = undefined

				clearTimeout(close_timeout)
				close_timeout = setTimeout(() => {
					if (wss.clients.size === 0) {
						logger.info(
							'closing socket server as no clients remain'
						)
						wss.close()
						wss = undefined
					}
				}, 30 * 1000)
			})
		})
	})
}

/**
 * @typedef {object} SyncEditorWithRenpyOptions
 *
 * @property {string} path
 * absolute path to the file
 *
 * @property {string} relative_path
 * path relative from the game folder (e.g. `script.rpy`)
 *
 * @property {number} line
 * 0-indexed line number
 */

/**
 * @param {SyncEditorWithRenpyOptions} arg0
 * @returns {Promise<void>}
 */
async function sync_editor_with_renpy({ path, relative_path, line }) {
	if (
		!["Ren'Py updates Visual Studio Code", 'Update both'].includes(
			get_config('followCursorMode')
		)
	)
		return

	// prevent feedback loop with warp to cursor
	//
	// TODO: this will still happen if renpy warps to a different line
	// than the one requested.
	last_warp_spec = `${relative_path}:${line}`

	const doc = await vscode.workspace.openTextDocument(path)
	await vscode.window.showTextDocument(doc)
	const editor = vscode.window.activeTextEditor

	// if the cursor is already on the correct line, don't munge it
	if (editor.selection.start.line !== line) {
		logger.debug(`syncing editor to ${relative_path}:${line}`)

		const end_of_line = editor.document.lineAt(line).range.end.character
		const pos = new vscode.Position(line, end_of_line)
		const selection = new vscode.Selection(pos, pos)

		editor.selection = selection
		editor.revealRange(selection)
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
 * @returns {Promise<RenpyProcess>}
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
		vscode.window.showErrorMessage("No Ren'Py project in workspace", 'OK')
		return
	}

	const game_root = find_game_root(file)
	const filename_relative = path.relative(path.join(game_root, 'game/'), file)
	logger.debug('game root:', game_root)

	if (!game_root) {
		vscode.window.showErrorMessage(
			'Unable to find "game" folder in parent directory. Not a Ren\'Py project?',
			'OK'
		)
		logger.info(`cannot find game root in ${file}`)
		return
	}

	const strategy = get_config('strategy')
	const extensions_enabled = get_config('renpyExtensionsEnabled')

	if (
		pm.length &&
		Number.isInteger(line) &&
		strategy === 'Update Window' &&
		extensions_enabled
	) {
		logger.info('warping in existing window')

		if (pm.length > 1) {
			vscode.window.showErrorMessage(
				"Multiple Ren'Py instances running. Cannot warp inside open Ren'Py window.",
				'OK'
			)
			return
		}

		const rpp = pm.at(0)

		await rpp.warp_to_line(filename_relative, line + 1)

		if (get_config('focusWindowOnWarp')) {
			logger.info('focusing window')
			await focus_window(rpp.process.pid)
		}

		return
	} else {
		logger.info("opening new ren'py window")

		const renpy_sh = await get_renpy_sh({
			WARP_WS_PORT: get_config('webSocketsPort'),
		})
		if (!renpy_sh) return

		/** @type {string} */
		let cmd

		if (line === undefined) {
			cmd = renpy_sh + ' ' + make_cmd([game_root])
		} else {
			cmd =
				renpy_sh +
				' ' +
				make_cmd([
					game_root,
					'--warp',
					`${filename_relative}:${line + 1}`,
				])
		}

		if (strategy === 'Replace Window') pm.kill_all()

		if (get_config('renpyExtensionsEnabled')) {
			if (!(await has_any_rpe())) {
				const selection = await vscode.window.showInformationMessage(
					`Ren'Py Launch and Sync can install a script in your Ren'Py project to synchronize the game and editor. Would you like to install it?`,
					'Yes, install',
					'No, do not install'
				)
				if (selection === 'Yes, install') {
					await install_rpe(game_root)
				} else {
					await vscode.workspace
						.getConfiguration('renpyWarp')
						.update('renpyExtensionsEnabled', false, true)

					vscode.window.showInformationMessage(
						'No RPE script will be installed. Keep in mind that some features may not work as expected.',
						'OK'
					)
				}
			} else if (!(await has_current_rpe(renpy_sh))) {
				await install_rpe(game_root)
				vscode.window.showInformationMessage(
					"Ren'Py extensions in this project have been updated.",
					'OK'
				)
			}
		}

		const rp = new RenpyProcess({
			cmd,
			game_root,
			async message_handler(message) {
				if (message.type === 'current_line') {
					logger.debug(
						`current line reported as ${message.line} in ${message.relative_path}`
					)
					if (!is_follow_cursor) return

					await sync_editor_with_renpy({
						path: message.path,
						relative_path: message.relative_path,
						line: message.line - 1,
					})
				} else {
					logger.warn('unhandled message:', message)
				}
			},
		})
		pm.add(rp)

		if (
			!is_follow_cursor &&
			get_config('followCursorOnLaunch') &&
			pm.length === 1 &&
			extensions_enabled
		) {
			logger.info('enabling follow cursor on launch')
			await vscode.commands.executeCommand('renpyWarp.toggleFollowCursor')
		}

		if (
			pm.length > 1 &&
			is_follow_cursor &&
			strategy !== 'Replace Window'
		) {
			await vscode.commands.executeCommand('renpyWarp.toggleFollowCursor')
			vscode.window.showInformationMessage(
				"Follow cursor was disabled because multiple Ren'Py instances are running",
				'OK'
			)
		}

		return rp
	}
}

/**
 * @template T
 * @param {string} message
 * @param {(...args: any[]) => Promise<T>} run
 * @returns {(...args: any[]) => Promise<T>}
 */
function associate_progress_notification(message, run) {
	return function (...args) {
		return new Promise((resolve) => {
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
						resolve(err)
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

	rpe_source_path = path.join(context.extensionPath, 'renpy_warp.rpe.py')

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

	pm = new ProcessManager()

	const throttle = p_throttle({
		limit: 1,
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

		const rp = pm.at(0)

		await rp.warp_to_line(filename_relative, line + 1)
		logger.info('warped to', warp_spec)
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
					if (!get_config('renpyExtensionsEnabled')) {
						vscode.window.showErrorMessage(
							"Follow cursor only works with Ren'Py extensions enabled.",
							'OK'
						)
						return
					}

					if (pm.length > 1) {
						vscode.window.showErrorMessage(
							"Multiple Ren'Py instances running. Cannot follow cursor.",
							'OK'
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

					/** @type {RenpyProcess} */
					let process

					if (pm.length === 0) {
						const launch = associate_progress_notification(
							"Launching Ren'Py...",
							async () => await launch_renpy()
						)

						try {
							process = await launch()
						} catch (err) {
							logger.error(err)
							await vscode.commands.executeCommand(
								'renpyWarp.toggleFollowCursor'
							)
							vscode.window
								.showErrorMessage(
									"Failed to launch Ren'Py.",
									'OK',
									'Logs'
								)
								.then((selection) => {
									if (selection === 'Logs') logger.show()
								})
							return
						}
					} else {
						process = pm.at(0)
					}

					// TODO: handle errors
					await ensure_websocket_server()
					await process.wait_for_socket()

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
		),

		vscode.commands.registerCommand('renpyWarp.installRpe', async () => {
			const file_path = await vscode.workspace
				.findFiles('**/game/**/*.rpy', null, 1)
				.then((files) => (files.length ? files[0].fsPath : null))

			if (!file_path) {
				vscode.window.showErrorMessage(
					"No Ren'Py project in workspace",
					'OK'
				)
				return
			}

			const game_root = find_game_root(file_path)

			if (!game_root) {
				vscode.window.showErrorMessage(
					'Unable to find "game" folder in parent directory. Not a Ren\'Py project?',
					'OK'
				)
				return
			}

			await vscode.workspace
				.getConfiguration('renpyWarp')
				.update('renpyExtensionsEnabled', true, true)

			await install_rpe(game_root)
		})
	)
}

function deactivate() {
	pm.kill_all()
}

module.exports = {
	activate,
	deactivate,
}
