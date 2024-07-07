import * as vscode from 'vscode'
import child_process from 'node:child_process'
import { WebSocket } from 'ws'
import { FollowCursor } from './follow_cursor'
import { get_config } from './util'
import { ensure_websocket_server } from './rpe'
import { logger } from './logger'
import { find_game_root } from './sh'
import path from 'upath'
import pidtree from 'pidtree'
import { windowManager } from 'node-window-manager'

type MaybePromise<T> = T | Promise<T>

export interface SocketMessage {
	type: string
	[key: string]: any
}

/**
 * @param {number} pid
 */
export async function focus_window(pid: number) {
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

export class RenpyProcess {
	output_channel: vscode.OutputChannel
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
	renpy_pid?: number = undefined
	pm: ProcessManager

	constructor({
		cmd,
		message_handler,
		game_root,
		context,
		pm,
	}: {
		cmd: string
		message_handler: (data: SocketMessage) => MaybePromise<void>
		game_root: string
		context: vscode.ExtensionContext
		pm: ProcessManager
	}) {
		this.cmd = cmd
		this.message_handler = message_handler
		this.game_root = game_root
		this.pm = pm

		logger.info('executing subshell:', cmd)
		this.process = child_process.exec(cmd)

		this.output_channel = vscode.window.createOutputChannel(
			`Ren'Py Launch and Sync - Process (${this.process.pid})`
		)
		context.subscriptions.push(this.output_channel)

		this.process.stdout!.on('data', this.output_channel.append)
		this.process.stderr!.on('data', this.output_channel.append)
		this.process.on('exit', (code) => {
			logger.info(`process ${this.process.pid} exited with code ${code}`)
			this.output_channel.appendLine(`process exited with code ${code}`)
		})

		logger.info('created process', this.process.pid)
	}

	async wait_for_socket(): Promise<void> {
		if (this.socket) return

		logger.info('waiting for socket connection from renpy window...')

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
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
					clearTimeout(timeout)
					clearInterval(interval)
					resolve()
				}
			}, 10)
		})
	}

	async ipc(message: SocketMessage): Promise<void> {
		if (!this.socket) {
			logger.info('no socket, waiting for connection...')
			await ensure_websocket_server({ pm: this.pm })
			await this.wait_for_socket()
		}

		return new Promise((resolve, reject) => {
			const serialized = JSON.stringify(message)

			const timeout = setTimeout(() => {
				reject(new Error('ipc timed out'))
			}, 1000)
			this.socket!.send(serialized, (err) => {
				logger.debug('websocket >', serialized)

				clearTimeout(timeout)
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

export class ProcessManager {
	processes: Map<number, RenpyProcess>
	instance_status_bar: vscode.StatusBarItem
	follow_cursor: FollowCursor

	constructor({ follow_cursor }: { follow_cursor: FollowCursor }) {
		this.processes = new Map()
		this.follow_cursor = follow_cursor

		this.instance_status_bar = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			0
		)

		this.update_status_bar()
	}

	static create() {}

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
						if (selected === 'Logs') process.output_channel.show()
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
		this.instance_status_bar.show()

		if (this.length === 1 && get_config('renpyExtensionsEnabled')) {
			this.follow_cursor.status_bar.show()
		} else {
			this.follow_cursor.status_bar.hide()
		}

		if (this.length) {
			this.instance_status_bar.text = `$(debug-stop) Quit Ren'Py`
			this.instance_status_bar.command = 'renpyWarp.killAll'
			this.instance_status_bar.tooltip =
				"Kill all running Ren'Py instances"
		} else {
			this.instance_status_bar.text = `$(play) Launch Project`
			this.instance_status_bar.command = 'renpyWarp.launch'
			this.instance_status_bar.tooltip = "Launch new Ren'Py instance"

			if (this.follow_cursor.active) {
				this.follow_cursor.disable()
			}
		}
	}

	get length() {
		return this.processes.size
	}

	async warp_renpy_to_cursor() {
		if (this.length !== 1) {
			throw new Error(
				`needs exactly one instance to follow... got ${this.length}`
			)
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

		// TODO: WTF?
		// if (warp_spec === last_warp_spec) return // no change
		// last_warp_spec = warp_spec

		const rp = this.at(0)

		if (!rp) {
			logger.warn('no renpy process found')
			return
		}

		await rp.warp_to_line(filename_relative, line + 1)
		logger.info('warped to', warp_spec)
	}
}
