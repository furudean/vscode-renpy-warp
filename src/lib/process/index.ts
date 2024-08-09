import * as vscode from 'vscode'
import child_process, { ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import { get_logger } from '../logger'
import { ProcessManager } from './manager'
import { EventEmitter } from 'node:events'
import tree_kill from 'tree-kill'

const logger = get_logger()

type MaybePromise<T> = T | Promise<T>

export interface SocketMessage {
	type: string
	[key: string]: any
}

function process_is_running(pid: number): boolean {
	try {
		return process.kill(pid, 0)
	} catch (error: any) {
		return error.code === 'EPERM'
	}
}

interface UnmanagedProcessOptions {
	pid: number
	game_root: string
	message_handler: (
		process: AnyProcess,
		data: SocketMessage
	) => MaybePromise<void>
}

export class UnmanagedProcess {
	pid: number
	game_root: string
	socket?: WebSocket
	message_handler: UnmanagedProcessOptions['message_handler']
	dead: boolean = false

	private emitter = new EventEmitter()
	private emit = this.emitter.emit.bind(this.emitter)
	on = this.emitter.on.bind(this.emitter)
	off = this.emitter.off.bind(this.emitter)
	once = this.emitter.once.bind(this.emitter)

	private check_alive_interval?: NodeJS.Timeout

	constructor({ pid, game_root, message_handler }: UnmanagedProcessOptions) {
		logger.info('created unmanaged process', { pid, game_root })
		this.pid = pid
		this.game_root = game_root
		this.message_handler = message_handler

		this.check_alive_interval = setInterval(async () => {
			if (process_is_running(this.pid)) return

			clearInterval(this.check_alive_interval)
			this.dead = true
			this.emit('exit')
		}, 500)
	}

	dispose() {
		clearInterval(this.check_alive_interval)
		this.emitter.removeAllListeners()
	}

	kill() {
		// SIGKILL bypasses "are you sure" dialog
		tree_kill(this.pid, 'SIGKILL', (error) => {
			if (error) {
				logger.error('failed to kill process', error)
			} else {
				// TODO: emit exit event, but not duplicate
			}
		})
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

					if (this.socket) {
						resolve()
					} else {
						reject(
							new Error('process died before socket connected')
						)
					}
				}
			}, 50)
		})
	}

	async ipc(message: SocketMessage): Promise<void> {
		if (
			this.socket === undefined ||
			this.socket?.readyState !== WebSocket.OPEN
		) {
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

interface ManagedProcessOptions extends UnmanagedProcessOptions {
	process: ChildProcess
}

export class ManagedProcess extends UnmanagedProcess {
	private process: child_process.ChildProcess
	output_channel?: vscode.OutputChannel
	exit_code?: number | null

	constructor({
		process,
		message_handler,
		game_root,
	}: ManagedProcessOptions) {
		super({
			pid: process.pid!,
			message_handler,
			game_root,
		})

		this.process = process
		this.message_handler = message_handler
		this.game_root = game_root

		this.output_channel = vscode.window.createOutputChannel(
			`Ren'Py Launch and Sync - Process Output (${this.process.pid})`
		)

		this.process.stdout!.on('data', (data: string) =>
			this.output_channel!.append(data)
		)
		this.process.stderr!.on('data', (data: string) =>
			this.output_channel!.append(data)
		)

		this.output_channel.appendLine(`process ${this.process.pid} started`)

		this.process.on('exit', (code) => {
			this.exit_code = code
			logger.info(`process ${this.pid} exited with code ${code}`)
			this.output_channel!.appendLine(
				`process ${this.pid} exited with code ${code}`
			)
		})
	}
}

export type AnyProcess = ManagedProcess | UnmanagedProcess

export { ProcessManager }
