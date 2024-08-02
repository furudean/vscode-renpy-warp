import * as vscode from 'vscode'
import child_process, { ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import { get_logger } from './logger'
import pidtree from 'pidtree'
import { windowManager } from 'node-window-manager'

const logger = get_logger()

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

interface RenpyProcessOptions {
	process?: ChildProcess
	pid?: number
	message_handler: (
		process: RenpyProcess,
		data: SocketMessage
	) => MaybePromise<void>
	game_root: string
}

export class RenpyProcess {
	process?: child_process.ChildProcess
	pid: number
	game_root: string
	message_handler: (
		process: RenpyProcess,
		data: SocketMessage
	) => MaybePromise<void>
	socket?: WebSocket = undefined
	dead: boolean = false
	output_channel?: vscode.OutputChannel

	constructor({
		process,
		pid,
		message_handler,
		game_root,
	}: RenpyProcessOptions) {
		this.process = process
		this.pid = (process?.pid ?? pid) as number
		this.message_handler = message_handler
		this.game_root = game_root

		if (this.process) {
			this.output_channel = vscode.window.createOutputChannel(
				`Ren'Py Launch and Sync - Process Output (${this.process.pid})`
			)

			this.process.stdout!.on('data', (data: string) =>
				this.output_channel!.append(data)
			)
			this.process.stderr!.on('data', (data: string) =>
				this.output_channel!.append(data)
			)

			this.output_channel.appendLine(
				`process ${this.process.pid} started`
			)

			this.process.on('exit', (code) => {
				this.dead = true
				logger.info(`process ${this.pid} exited with code ${code}`)
				this.output_channel!.appendLine(
					`process ${this.pid} exited with code ${code}`
				)
			})
		}
	}

	async wait_for_socket(timeout_ms: number): Promise<void> {
		if (this.socket) return

		logger.info('waiting for socket connection from renpy window...')

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				clearInterval(interval)
				reject(new Error('timed out waiting for socket'))
			}, timeout_ms)

			const interval = setInterval(() => {
				if (this.socket || this.dead) {
					clearTimeout(timeout)
					clearInterval(interval)

					this.socket
						? resolve()
						: reject(
								new Error(
									'process died before socket connected'
								)
						  )
				}
			}, 50)
		})
	}

	kill() {
		process.kill(this.pid, 9) // SIGKILL, bypasses "are you sure" dialog
	}

	dispose() {
		this.output_channel?.dispose()
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

	/**
	 * await this promise to ensure the process has reloaded and is ready to
	 * receive IPC
	 */
	async set_autoreload() {
		await this.ipc({
			type: 'set_autoreload',
		})
	}
}

export class ProcessManager {
	private processes = new Map<number, RenpyProcess>()

	/** Runs on process exit, after process has been removed */
	private exit_handler: (process: RenpyProcess) => MaybePromise<void>

	constructor({
		exit_handler,
	}: {
		exit_handler: typeof ProcessManager.prototype.exit_handler
	}) {
		this.exit_handler = exit_handler
	}

	[Symbol.iterator]() {
		return this.processes.values()
	}

	async add(id: number, process: RenpyProcess) {
		if (!process.pid) throw new Error('no pid in process')

		this.processes.set(id, process)

		process.process!.on('exit', (code) => {
			if (!process.pid) throw new Error('no pid in process')

			this.processes.delete(id)

			if (code) {
				vscode.window
					.showErrorMessage(
						"Ren'Py process exited with errors",
						'OK',
						'Logs'
					)
					.then((selected) => {
						if (selected === 'Logs') process.output_channel?.show()
					})
			}

			this.exit_handler(process)
		})
	}

	get(id: number): RenpyProcess | undefined {
		return this.processes.get(id)
	}

	at(index: number): RenpyProcess | undefined {
		return Array.from(this).at(index)
	}

	kill_all() {
		for (const { kill } of this) {
			kill()
		}
	}

	dispose() {
		this.kill_all()

		for (const { dispose } of this) {
			dispose()
		}
	}

	get length() {
		return this.processes.size
	}
}
