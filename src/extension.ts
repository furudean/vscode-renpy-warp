import * as vscode from 'vscode'
import path from 'upath'
import child_process from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs/promises'
import untildify from 'untildify'
import p_throttle from 'p-throttle'
import pidtree from 'pidtree'
import { WebSocket, WebSocketServer } from 'ws'
import AdmZip from 'adm-zip'
import semver from 'semver'
import { windowManager } from 'node-window-manager'

import { version as pkg_version } from '../package.json'
import { quoteForShell } from 'puka'
const IS_WINDOWS = os.platform() === 'win32'

type MaybePromise<T> = T | Promise<T>

let wss: WebSocketServer | undefined
let pm: ProcessManager

let logger: vscode.LogOutputChannel
let process_out_channel: vscode.OutputChannel
let instance_status_bar: vscode.StatusBarItem
let follow_cursor_status_bar: vscode.StatusBarItem

let is_follow_cursor = false

/** @type {string | undefined} */
let last_warp_spec: string | undefined = undefined

/** @type {string} */
let rpe_source_path: string

interface SocketMessage {
	type: string
	[key: string]: any
}

class RenpyProcess {
	cmd: string
	message_handler: (data: SocketMessage) => MaybePromise<void>
	game_root: string
	process: child_process.ChildProcess
	socket?: WebSocket = undefined
	/**
	 * The Ren'Py pid might be different from the pid of the process we
	 * created. This happens on Windows where the actual Ren'Py process is
	 * a child process of the process we created.
	 */
	renpy_pid?: number

	constructor({
		cmd,
		message_handler,
		game_root,
	}: {
		cmd: string
		message_handler: (data: SocketMessage) => MaybePromise<void>
		game_root: string
	}) {
		this.cmd = cmd
		this.message_handler = message_handler
		this.game_root = game_root

		logger.info('executing subshell:', cmd)
		this.process = child_process.exec(cmd)

		this.process.stdout!.on('data', process_out_channel.append)
		this.process.stderr!.on('data', process_out_channel.append)
		this.process.on('exit', (code) => {
			logger.info(`process ${this.process.pid} exited with code ${code}`)
		})

		logger.info('created process', this.process.pid)
	}

	async wait_for_socket(): Promise<void> {
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

	async ipc(message: SocketMessage): Promise<void> {
		if (!this.socket) {
			logger.info('no socket, waiting for connection...')
			await ensure_websocket_server()
			await this.wait_for_socket()
		}

		return new Promise((resolve, reject) => {
			const serialized = JSON.stringify(message)

			const timeout = setTimeout(() => {
				reject(new Error('ipc timed out'))
			}, 1000)
			this.socket!.send(serialized, (err) => {
				logger.debug('websocket >', serialized)

				clearInterval(timeout)
				if (err) {
					reject(err)
				} else {
					resolve()
				}
			})
		})
	}

	/**
	 * @param {number} line
	 * 1-indexed line number
	 */
	async warp_to_line(file: string, line: number) {
		return this.ipc({
			type: 'warp_to_line',
			file,
			line,
		})
	}
}

class ProcessManager {
	processes: Map<number, RenpyProcess>
	constructor() {
		this.processes = new Map()

		this.update_status_bar()
	}

	/** @param {RenpyProcess} process */
	async add(process: RenpyProcess) {
		if (!process.process.pid) throw new Error('no pid in process')

		this.processes.set(process.process.pid, process)
		this.update_status_bar()

		process.process.on('exit', (code) => {
			if (!process.process.pid) throw new Error('no pid in process')

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
	get(pid: number): RenpyProcess | undefined {
		return this.processes.get(pid)
	}

	/**
	 * @param {number} index
	 * @returns {RenpyProcess | undefined}
	 */
	at(index: number): RenpyProcess | undefined {
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
function get_config(key: string): any {
	return vscode.workspace.getConfiguration('renpyWarp').get(key)
}

/**
 * @param {string} str
 * @returns {string}
 */
function resolve_path(str: string): string {
	return path.resolve(untildify(str))
}

/**
 * @example
 * // on unix
 * env_string({ FOO: 'bar', BAZ: 'qux' })
 * // "FOO='bar' BAZ='qux'"
 *
 * // on windows
 * env_string({ FOO: 'bar', BAZ: 'qux' })
 * // 'set "FOO=bar" && set "BAZ=qux"'
 */
function env_string(entries: Record<string, string>): string {
	return Object.entries(entries)
		.map(([key, value]) =>
			IS_WINDOWS ? `set "${key}=${value}"` : `${key}='${value}'`
		)
		.join(IS_WINDOWS ? ' && ' : ' ')
}

function make_cmd(cmds: string[]): string {
	return cmds
		.filter(Boolean)
		.map((i) => ' ' + quoteForShell(i))
		.join('')
		.trim()
}

function find_game_root(
	filename: string,
	haystack: string | null = null,
	depth: number = 1
): string | null {
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
 */
async function get_sdk_path(): Promise<string | undefined> {
	/** @type {string} */
	const sdk_path_setting: string = get_config('sdkPath')

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
					'@ext:PaisleySoftworks.renpyWarp'
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
					'@ext:PaisleySoftworks.renpyWarp'
				)
			})
		return
	}

	return parsed_path
}

async function get_renpy_sh(
	environment: Record<string, string | number | boolean> = {}
): Promise<string | undefined> {
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
					'@ext:PaisleySoftworks.renpyWarp'
				)
			})
		return
	}

	/** @type {string} */
	const editor_setting: string = get_config('editor')

	/** @type {string} */
	let editor: string

	if (path.isAbsolute(editor_setting)) {
		editor = resolve_path(editor_setting)
	} else {
		// relative path to launcher
		editor = path.resolve(sdk_path, editor_setting)
	}

	try {
		await fs.access(editor)
	} catch (err: any) {
		vscode.window
			.showErrorMessage(
				`Invalid Ren'Py editor path: '${err.editor_path}'`,
				'Open Settings'
			)
			.then((selection) => {
				if (!selection) return

				vscode.commands.executeCommand(
					'workbench.action.openSettings',
					'@ext:PaisleySoftworks.renpyWarp'
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
async function install_rpe(game_root: string): Promise<void> {
	const renpy_sh = await get_renpy_sh()

	if (!renpy_sh)
		throw new Error('failed to get renpy.sh while installing rpe')

	const version = get_version(renpy_sh)
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
	let file_path: string

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

async function has_any_rpe(): Promise<boolean> {
	return vscode.workspace
		.findFiles('**/renpy_warp_*.rpe*')
		.then((files) => files.length > 0)
}

async function has_current_rpe(renpy_sh: string): Promise<boolean> {
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
		)?.groups?.version

		if (version === pkg_version) {
			return true
		}
	}

	return false
}

/**
 * @param renpy_sh
 * base renpy.sh command
 */
function get_version(renpy_sh: string) {
	const RENPY_VERSION_REGEX =
		/^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:\.(?<rest>.*))?$/

	const version_string = child_process
		.execSync(renpy_sh + ' --version')
		.toString('utf-8')
		.trim()
		.replace("Ren'Py ", '')

	const { major, minor, patch, rest } =
		RENPY_VERSION_REGEX.exec(version_string)?.groups ?? {}

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
async function focus_window(pid: number) {
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
async function ensure_websocket_server(): Promise<void> {
	if (wss) {
		logger.debug('socket server already running')
		return
	}

	return new Promise(async (resolve, reject) => {
		let has_listened = false
		const port = get_config('webSocketsPort')
		wss = new WebSocketServer({ port })

		/** @type {NodeJS.Timeout} */
		let close_timeout: NodeJS.Timeout | undefined = undefined

		wss.on('listening', () => {
			has_listened = true
			logger.info('socket server listening on port', wss!.options.port)
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
			let process: RenpyProcess | undefined

			const renpy_pid = Number(req.headers['pid'])
			for (const pid of pm.processes.keys()) {
				// the process might be a child of the process we created
				const pid_tree = await pidtree(pid, { root: true })
				logger.debug('pid tree:', pid_tree)
				if (pid_tree.includes(renpy_pid)) {
					logger.info(
						`matched new connection from ${pid} to launched process ${renpy_pid}`
					)
					process = pm.get(pid)

					if (!process) {
						logger.warn('process not found in process manager')
						return
					}

					if (process.socket) {
						logger.info('closing existing socket')
						process.socket.close()
					}

					process.socket = ws
					process.renpy_pid = renpy_pid

					break
				}
			}

			if (!process) {
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

				await process.message_handler(message)
			})

			ws.on('close', () => {
				logger.info(
					'websocket connection closed to pid',
					process.process.pid
				)
				process.socket = undefined

				clearTimeout(close_timeout)
				close_timeout = setTimeout(() => {
					if (wss?.clients.size === 0) {
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

interface SyncEditorWithRenpyOptions {
	/** absolute path to the file */
	path: string
	/** path relative from the game folder (e.g. `script.rpy`) */
	relative_path: string
	/** 0-indexed line number */
	line: number
}

async function sync_editor_with_renpy({
	path,
	relative_path,
	line,
}: SyncEditorWithRenpyOptions): Promise<void> {
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

	if (!editor) {
		logger.warn('no active text editor')
		return
	}

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

interface LaunchRenpyOptions {
	/**
	 * fs path representing the current editor. selects the file to warp to. if
	 * null, simply open ren'py and detect the project root
	 */
	file?: string
	/** zero-indexed line number. if set, warp to line will be attempted */
	line?: number
}

/**
 * starts or warps depending on arguments and settings specified for the
 * extension
 *
 * if strategy is `Update Window`, no new window is opened and the current one
 * is updated instead.
 *
 * @returns
 * resolves with the child process if a new instance was opened, otherwise
 * undefined
 */
async function launch_renpy({ file, line }: LaunchRenpyOptions = {}): Promise<
	RenpyProcess | undefined
> {
	logger.info('launch_renpy:', { file, line })

	if (!file) {
		file = await vscode.workspace
			.findFiles('**/game/**/*.rpy', null, 1)
			.then((files) => (files.length ? files[0].fsPath : undefined))
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
		line !== undefined &&
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

		const rpp = pm.at(0) as RenpyProcess

		await rpp.warp_to_line(filename_relative, line + 1)

		if (get_config('focusWindowOnWarp') && rpp.process?.pid) {
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
		let cmd: string

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

function associate_progress_notification<T>(
	message: string,
	run: (...args: any[]) => Promise<T>
): (...args: any[]) => Promise<T> {
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
					} catch (err: any) {
						logger.error(err)
						resolve(err)
					}
				}
			)
		})
	}
}

async function warp_renpy_to_cursor() {
	if (pm.length !== 1) {
		logger.info('needs exactly one instance to follow... got', pm.length)

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
	const filename_relative = path.relative(path.join(game_root, 'game/'), file)

	const warp_spec = `${filename_relative}:${line + 1}`

	if (warp_spec === last_warp_spec) return // no change
	last_warp_spec = warp_spec

	const rp = pm.at(0)

	if (!rp) {
		logger.warn('no renpy process found')
		return
	}

	await rp.warp_to_line(filename_relative, line + 1)
	logger.info('warped to', warp_spec)
}

export function activate(context: vscode.ExtensionContext) {
	/** @type {vscode.Disposable} */
	let text_editor_handle: vscode.Disposable

	rpe_source_path = path.join(
		context.extensionPath,
		'dist/',
		'renpy_warp.rpe.py'
	)

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

	const warp_renpy_to_cursor_throttled = throttle(warp_renpy_to_cursor)

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
						file: vscode.window.activeTextEditor?.document.uri
							.fsPath,
						line: vscode.window.activeTextEditor?.selection.active
							.line,
					})
			)
		),

		vscode.commands.registerCommand(
			'renpyWarp.warpToFile',
			associate_progress_notification(
				'Warping to file...',
				/** @param {vscode.Uri} uri */
				async (uri: vscode.Uri) => {
					const fs_path = uri
						? uri.fsPath
						: vscode.window.activeTextEditor?.document.uri.fsPath

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

					let process: RenpyProcess | undefined

					if (pm.length === 0) {
						const launch = associate_progress_notification(
							"Launching Ren'Py...",
							async () => await launch_renpy()
						)

						try {
							process = await launch()
						} catch (err: any) {
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

					if (!process) throw new Error('no process found')

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
									await warp_renpy_to_cursor_throttled()
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
						await warp_renpy_to_cursor_throttled()
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

export function deactivate() {
	pm.kill_all()
	wss?.close()
}
