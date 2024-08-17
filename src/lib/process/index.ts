import * as vscode from 'vscode'
import child_process, { ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import { get_logger } from '../logger'
import { ProcessManager } from './manager'
import { EventEmitter } from 'node:events'
import tree_kill from 'tree-kill'
import { SocketMessage } from '../socket'
import { process_finished } from '../sh'
import TailFile from '@logdna/tail-file'
import split2 from 'split2'

const logger = get_logger()

interface UnmanagedProcessOptions {
	pid: number
	project_root: string
	socket?: WebSocket
	monitor?: boolean
}

export class UnmanagedProcess {
	pid: number
	project_root: string
	socket?: WebSocket
	dead: boolean = false

	private emitter = new EventEmitter()
	emit = this.emitter.emit.bind(this.emitter)
	on = this.emitter.on.bind(this.emitter)
	off = this.emitter.off.bind(this.emitter)
	once = this.emitter.once.bind(this.emitter)

	private check_alive_interval?: NodeJS.Timeout

	constructor({
		pid,
		project_root,
		socket,
		monitor,
	}: UnmanagedProcessOptions) {
		monitor = monitor ?? true

		this.pid = pid
		this.project_root = project_root
		this.socket = socket

		if (monitor) {
			this.check_alive_interval = setInterval(async () => {
				if (await process_finished(this.pid)) {
					this.dead = true
					this.emit('exit')
					clearInterval(this.check_alive_interval)
				}
			}, 400)
		}

		this.on('exit', () => {
			logger.debug(`process ${this.pid} got exit event`)
		})
	}

	dispose() {
		this.socket?.close()
		clearInterval(this.check_alive_interval)
		this.emitter.removeAllListeners()
	}

	async kill(): Promise<void> {
		return new Promise((resolve, reject) => {
			// SIGKILL bypasses "are you sure" dialog
			tree_kill(this.pid, 'SIGKILL', (error) => {
				if (error) {
					reject(error)
				} else {
					if (this.dead) return
					this.dead = true
					this.emit('exit')
					clearInterval(this.check_alive_interval)
					resolve()
				}
			})
		})
	}

	get socket_ready(): boolean {
		return (
			this.socket !== undefined &&
			this.socket.readyState === WebSocket.OPEN
		)
	}

	async wait_for_socket(timeout_ms: number): Promise<void> {
		if (this.socket_ready) return

		logger.info('waiting for socket connection from renpy window...')

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				clearInterval(interval)
				reject(new Error('timed out waiting for socket'))
			}, timeout_ms)

			const interval = setInterval(() => {
				if (this.socket_ready || this.dead) {
					clearTimeout(timeout)
					clearInterval(interval)

					if (this.socket_ready) {
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

	/** Send a message to the Ren'Py process via WebSocket */
	private async ipc(message: SocketMessage): Promise<void> {
		await this.wait_for_socket(5000)

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
		return this.ipc({
			type: 'set_autoreload',
		})
	}
}

interface ManagedProcessOptions extends Omit<UnmanagedProcessOptions, 'pid'> {
	process: ChildProcess
	log_file: string
}

export class ManagedProcess extends UnmanagedProcess {
	private process: child_process.ChildProcess
	output_channel?: vscode.OutputChannel
	exit_code?: number | null

	constructor({ process, project_root, log_file }: ManagedProcessOptions) {
		super({
			pid: process.pid!,
			project_root,
			monitor: false,
		})

		this.process = process
		this.project_root = project_root

		this.output_channel = vscode.window.createOutputChannel(
			`Ren'Py Launch and Sync - Process Output (${this.process.pid})`
		)

		this.output_channel.appendLine(`process ${this.process.pid} started`)
		logger.info(`logging process ${this.pid} to ${log_file}`)

		const tail = new TailFile(log_file, {
			encoding: 'utf8',
		})
		tail.start()

		tail.pipe(split2()).on('data', (line: string) => {
			this.output_channel!.appendLine(line)
		})

		this.process.on('close', async (code) => {
			this.dead = true
			this.exit_code = code
			this.emit('exit')
			logger.info(`process ${this.pid} exited with code ${code}`)

			await tail.quit()
			this.output_channel?.appendLine(`process exited with code ${code}`)
		})
	}

	async kill(): Promise<void> {
		this.process.kill()
		this.emit('exit')
	}

	dispose(): void {
		super.dispose()
		this.process.unref()
		this.output_channel?.dispose()
	}
}

export type AnyProcess = ManagedProcess | UnmanagedProcess

export { ProcessManager }
