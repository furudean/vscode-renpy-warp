import * as vscode from 'vscode'

import { get_logger } from './logger'
import WebSocket, { WebSocketServer } from 'ws'
import {
	AnyProcess,
	ManagedProcess,
	ProcessManager,
	UnmanagedProcess,
} from './process'
import get_port from 'get-port'
import { StatusBar } from './status_bar'
import { prompt_install_rpe, get_rpe_checksum } from './rpe'
import path from 'upath'
import { realpath } from 'node:fs/promises'
import { get_config, set_config } from './config'
import { createServer, IncomingMessage } from 'node:http'
import { find_projects_in_workspaces } from './path'

const logger = get_logger()

type MaybePromise<T> = T | Promise<T>

export interface SocketMessage {
	type: string
	[key: string]: unknown
}

export interface CurrentLineSocketMessage extends SocketMessage {
	type: 'current_line'
	line: number
	path: string
	relative_path: string
}

export interface ListLabelsSocketMessage extends SocketMessage {
	type: 'list_labels'
	labels: string[]
}

export type MessageHandler = (
	process: AnyProcess,
	data: SocketMessage
) => MaybePromise<void>

export class WarpSocketService {
	private context: vscode.ExtensionContext
	private socket_server?: WebSocketServer
	private message_handler: MessageHandler

	private pm: ProcessManager
	private status_bar: StatusBar

	public readonly ports = Object.freeze([
		40111, 40112, 40113, 40114, 40115, 40116, 40117, 40118, 40119, 40120,
	])

	public ackd_processes = new Set<number>()

	constructor({
		message_handler,
		context,
		pm,
		status_bar,
	}: {
		message_handler: MessageHandler
		context: vscode.ExtensionContext
		pm: ProcessManager
		status_bar: StatusBar
	}) {
		this.context = context
		this.pm = pm
		this.status_bar = status_bar
		this.message_handler = message_handler
	}

	public async start(): Promise<void> {
		if (this.socket_server) return

		const socket_server = new WebSocketServer({ noServer: true })
		this.socket_server = socket_server
		const http_server = createServer()
		const port = await this.get_socket_port()

		socket_server.on('close', () => {
			logger.info('socket server closed')

			this.socket_server = undefined
			this.status_bar.notify(
				`$(server-process) Socket server :${port} closed`
			)

			this.pm.clear()
			this.status_bar.update(() => ({
				socket_server_status: 'stopped',
				processes: new Map(),
			}))
			vscode.commands.executeCommand(
				'setContext',
				'renpyWarp.socketServerRunning',
				false
			)
			http_server.close()
		})

		http_server.on('upgrade', (request, socket, head) => {
			logger.debug(
				`socket server ${port} received a connection request with headers ${JSON.stringify(
					request.headers
				)}`
			)
			socket.on('error', logger.error)

			this.handle_handshake(request)
				.then((request_ok) => {
					if (!request_ok) {
						socket.destroy()
						return
					}

					const pid = Number(request.headers['pid'])
					const nonce = request.headers['warp-nonce']
						? Number(request.headers['warp-nonce'])
						: undefined
					const project_root = request.headers[
						'warp-project-root'
					] as string

					socket_server.handleUpgrade(
						request,
						socket,
						head,
						function done(ws) {
							socket_server.emit('connection', {
								ws,
								pid,
								nonce,
								project_root,
							})
						}
					)
				})
				.catch(logger.error)
		})

		socket_server.on('connection', this.handle_socket_connection.bind(this))

		function handle_error(error: unknown) {
			logger.error('socket server error:', error)

			vscode.window
				.showErrorMessage(
					'Failed to start websockets server.',
					'Logs',
					'OK'
				)
				.then((selection) => {
					if (selection === 'Logs') {
						logger.show()
					}
				})
			socket_server.close()
		}
		http_server.on('error', handle_error)
		socket_server.on('wsClientError', handle_error)

		http_server.listen(port, undefined, undefined, () => {
			logger.info(`socket server listening on :${port}`)
			this.status_bar.notify(
				`$(server-process) Socket server listening on :${port}`
			)
			this.status_bar.update(() => ({
				socket_server_status: 'running',
			}))
			vscode.commands.executeCommand(
				'setContext',
				'renpyWarp.socketServerRunning',
				true
			)
		})
	}

	public close() {
		if (this.socket_server) {
			logger.info('stopping socket server')
			this.socket_server.close()
		}
	}

	private async get_socket_port(): Promise<number> {
		const port = await get_port({ port: this.ports })

		if (!this.ports.includes(port)) {
			throw new Error('exhausted all available ports')
		}

		return port
	}

	private is_managed_process(nonce?: number) {
		return nonce && this.pm.get(nonce)
	}

	private handle_socket_connection({
		ws,
		pid,
		nonce,
		project_root,
	}: {
		ws: WebSocket
		pid: number
		nonce: number
		project_root: string
	}) {
		let rpp: ManagedProcess | UnmanagedProcess

		if (this.is_managed_process(nonce)) {
			rpp = this.handle_managed_process(nonce)
			rpp.socket = ws
		} else {
			rpp = this.handle_unmanaged_process({
				pid,
				project_root,
				ws,
			})
			rpp.socket = ws
		}

		ws.on('message', async (data) => {
			logger.debug(`websocket (${rpp.pid}) <`, data.toString())
			const message = JSON.parse(data.toString())

			rpp.emit('socketMessage', message)
			await this.message_handler(rpp, message)
		})

		ws.on('close', () => {
			logger.info(`websocket connection closed (pid ${rpp.pid})`)
			rpp.socket = undefined
		})

		ws.on('error', (error) => {
			logger.error(`websocket error (pid ${rpp.pid})`, error)
		})
	}

	private async handle_handshake(req: IncomingMessage): Promise<boolean> {
		const socket_version = req.headers['warp-version']
		const socket_checksum = req.headers['warp-checksum']
		const socket_nonce = req.headers['warp-nonce']
			? Number(req.headers['warp-nonce'])
			: undefined
		const socket_pid = Number(req.headers['pid'])
		const socket_project_root = req.headers['warp-project-root'] as string

		if (this.ackd_processes.has(socket_pid)) {
			logger.debug(
				`ignoring connection request from pid ${socket_pid} as its in ack list`
			)
			return false
		}

		const [rpe_checksum, project_roots] = await Promise.all([
			get_rpe_checksum(this.context.extensionPath),
			find_projects_in_workspaces(),
		])

		const socket_project_root_realpath = await realpath(socket_project_root)
		const matches_any_root = await Promise.any(
			project_roots.map(async (project_root) => {
				const project_root_realpath = await realpath(project_root)
				return (
					path.relative(
						project_root_realpath,
						socket_project_root_realpath
					) === ''
				)
			})
		)

		if (!matches_any_root) {
			logger.info(
				`rejecting connection to socket because socket root '${socket_project_root}' does not match any ${project_roots
					.map((s) => `'${s}'`)
					.join(', ')}`
			)
			return false
		}

		if (socket_checksum !== rpe_checksum) {
			this.ackd_processes.add(socket_pid)

			logger.info(
				`rpe checksum ${socket_version} does not match expected ${rpe_checksum}`
			)

			if (socket_checksum === undefined) {
				vscode.window.showErrorMessage(
					`Ren'Py extension reported no checksum. Ren'Py might have misbehaved.`,
					'Oh no'
				)
			} else {
				const picked = await vscode.window.showErrorMessage(
					`RPE in running Ren'Py process does not match extension. It may be out of date. Update?`,
					'Update',
					"Don't Update"
				)

				if (picked === 'Update') {
					await prompt_install_rpe(
						this.context,
						"Ren'Py extensions were updated. Please restart the game to connect.",
						true
					)
				}
			}

			return false
		}

		if (!this.is_managed_process(socket_nonce)) {
			const auto_connect_setting = get_config(
				'autoConnectExternalProcesses'
			) as string

			if (auto_connect_setting === 'Ask') {
				const picked = await vscode.window.showInformationMessage(
					`A Ren'Py process wants to connect to this window`,
					'Connect',
					'Ignore',
					'Always connect',
					'Always ignore'
				)

				this.ackd_processes.add(socket_pid)

				if (picked === 'Always connect') {
					await set_config(
						'autoConnectExternalProcesses',
						'Always connect'
					)
				}
				if (['Ignore', undefined].includes(picked)) {
					return false
				}
				if (picked === 'Always ignore') {
					await set_config(
						'autoConnectExternalProcesses',
						'Never connect'
					)
				}
			} else if (auto_connect_setting === 'Never connect') {
				return false
			}
		}

		return true
	}

	private handle_unmanaged_process({
		pid,
		project_root,
		ws,
	}: {
		pid: number
		project_root: string
		ws: WebSocket
	}): UnmanagedProcess {
		let rpp: UnmanagedProcess

		if (this.pm.get(pid)) {
			logger.info('has existing process, reusing it')
			rpp = this.pm.get(pid) as UnmanagedProcess
			rpp.socket?.close(4000, 'connection replaced') // close existing socket
			rpp.socket = ws
		} else {
			logger.info('creating new unmanaged process')
			rpp = new UnmanagedProcess({
				pid,
				project_root,
				socket: ws,
			})

			rpp.on('exit', () => {
				logger.info(`external process ${pid} exited`)
				this.status_bar.delete_process(pid)
				this.status_bar.notify(`$(info) External process ${pid} exited`)
			})

			this.pm.add(pid, rpp)
			this.status_bar.set_process(pid, 'idle')

			if (!this.context.globalState.get('hideExternalProcessConnected')) {
				vscode.window
					.showInformationMessage(
						"Connected to external Ren'Py process",
						'OK',
						"Don't show again"
					)
					.then((selection) => {
						if (selection === "Don't show again") {
							this.context.globalState.update(
								'hideExternalProcessConnected',
								true
							)
						}
					})
			} else {
				this.status_bar.notify(
					`$(info) Connected to external process ${pid}`
				)
			}
		}
		return rpp
	}

	private handle_managed_process(nonce: number): ManagedProcess {
		const rpp = this.pm.get(nonce) as ManagedProcess | undefined

		if (!(rpp instanceof ManagedProcess)) {
			throw new Error('expected ManagedProcess')
		}

		logger.info(
			`socket server discovered managed process ${rpp.pid} with nonce ${nonce}`
		)

		if (rpp.socket) {
			logger.warn('closing existing socket')
			rpp.socket.close(4000, 'connection replaced')
		}

		return rpp
	}
}
