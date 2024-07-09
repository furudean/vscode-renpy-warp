import * as vscode from 'vscode'
import child_process from 'node:child_process'
import { WebSocket } from 'ws'
import { FollowCursor } from './follow_cursor'
import { get_config } from './util'
import { get_logger } from './logger'
import pidtree from 'pidtree'
import { windowManager } from 'node-window-manager'

const logger = get_logger()

let output_channel: vscode.OutputChannel | undefined

type MaybePromise<T> = T | Promise<T>

export interface SocketMessage {
	type: string
	[key: string]: any
}

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
	private pm: ProcessManager

	cmd: string
	message_handler: (data: SocketMessage) => MaybePromise<void>
	game_root: string
	socket_port: number
	process: child_process.ChildProcess
	socket?: WebSocket = undefined
	dead: boolean = false

	constructor({
		cmd,
		message_handler,
		game_root,
		socket_port,
		pm,
		context,
	}: {
		cmd: string
		message_handler: (data: SocketMessage) => MaybePromise<void>
		game_root: string
		socket_port: number
		pm: ProcessManager
		context: vscode.ExtensionContext
	}) {
		this.cmd = cmd
		this.message_handler = message_handler
		this.game_root = game_root
		this.socket_port = socket_port
		this.pm = pm

		logger.info('executing subshell:', cmd)
		this.process = child_process.exec(cmd)

		if (!output_channel) {
			output_channel = vscode.window.createOutputChannel(
				`Ren'Py Launch and Sync - Process Output`
			)
			context.subscriptions.push(output_channel)
		}

		output_channel.appendLine(`process ${this.process.pid} started`)

		this.process.stdout!.on('data', (data: string) =>
			output_channel!.appendLine(
				`[${this.process.pid} out] ${data.trim()}`
			)
		)
		this.process.stderr!.on('data', (data) =>
			output_channel!.appendLine(
				`[${this.process.pid} err] ${data.trim()}`
			)
		)
		this.process.on('exit', (code) => {
			this.dead = true
			logger.info(`process ${this.process.pid} exited with code ${code}`)
			output_channel!.appendLine(
				`process ${this.process.pid} exited with code ${code}`
			)
		})

		logger.info('created process', this.process.pid)
	}

	async wait_for_socket(): Promise<void> {
		if (this.socket) return

		logger.info('waiting for socket connection from renpy window...')

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error('timed out waiting for socket'))
				if (!this.dead) {
					vscode.window
						.showErrorMessage(
							"Timed out trying to connect to Ren'Py window. Is the socket client running?",
							'Logs',
							'OK'
						)
						.then((selection) => {
							if (selection === 'Logs') logger.show()
						})
					this.kill()
				}
			}, 10_000)

			const interval = setInterval(() => {
				if (this.socket) {
					clearTimeout(timeout)
					clearInterval(interval)
					resolve()
				}
			}, 50)
		})
	}

	kill() {
		this.process.kill()
	}

	async ipc(message: SocketMessage): Promise<void> {
		if (!this.socket || this.socket?.readyState !== WebSocket.OPEN) {
			throw new Error('no socket connection')
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
	 * @param line
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
	private processes: Map<number, RenpyProcess>
	instance_status_bar: vscode.StatusBarItem
	follow_cursor: FollowCursor
	show_loading: boolean = false

	constructor({ follow_cursor }: { follow_cursor: FollowCursor }) {
		this.processes = new Map()
		this.follow_cursor = follow_cursor

		this.instance_status_bar = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			0
		)

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
						if (selected === 'Logs') output_channel!.show()
					})
			}
		})
	}

	get(pid: number): RenpyProcess | undefined {
		return this.processes.get(pid)
	}

	at(index: number): RenpyProcess | undefined {
		return Array.from(this.processes.values())[index]
	}

	async find_tracked(candidate: number): Promise<RenpyProcess | undefined> {
		if (this.processes.has(candidate)) return this.processes.get(candidate)

		for (const pid of this.pids) {
			// the process might be a child of the process we created
			const child_pids = await pidtree(pid)
			logger.debug(`child pids for ${pid}: ${JSON.stringify(child_pids)}`)

			if (child_pids.includes(pid)) {
				const rpp = this.get(pid)

				if (rpp) return rpp
			}
		}
		return
	}

	kill_all() {
		for (const { process: process } of this.processes.values()) {
			process.kill(9) // SIGKILL, bypasses "are you sure" dialog
		}
	}

	update_status_bar() {
		this.instance_status_bar.show()

		if (this.show_loading) {
			this.instance_status_bar.text = `$(loading~spin) Loading...`
			this.instance_status_bar.command = undefined
			this.instance_status_bar.tooltip = undefined

			this.follow_cursor.status_bar.hide()

			return
		}

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

	get pids(): number[] {
		return [...this.processes.keys()]
	}
}
