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
import { prompt_install_rpe, get_rpe_source, get_checksum } from './rpe'
import path from 'upath'
import { realpath } from 'node:fs/promises'
import { get_config, set_config } from './config'
import { createServer, IncomingMessage, Server } from 'node:http'
import { find_projects_in_workspaces } from './path'
import p_locate from 'p-locate'

const logger = get_logger()

const PORTS = Object.freeze([
	40111, 40112, 40113, 40114, 40115, 40116, 40117, 40118, 40119, 40120,
])

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
	private socket_server: WebSocketServer | undefined
	private http_server: Server | undefined
	private message_handler: MessageHandler

	private pm: ProcessManager
	private status_bar: StatusBar

	public socket_server_status: 'starting' | 'running' | 'stopped' = 'stopped'
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

	public async start(): Promise<typeof this.socket_server> {
		if (this.socket_server_status !== 'stopped') return

		const port = await this.get_socket_port()

		return new Promise((resolve, reject) => {
			const http_server = createServer()
			this.http_server = http_server
			const wss = new WebSocketServer({ noServer: true })
			this.socket_server = wss

			http_server.on('close', () => {
				this.http_server = undefined
			})

			function on_socket_error(err) {
				console.error(err)
			}

			http_server.on('upgrade', function upgrade(request, socket, head) {
				socket.on('error', on_socket_error)

				// This function is not defined on purpose. Implement it with your own logic.
				authenticate(request, function next(err, client) {
					if (err || !client) {
						socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
						socket.destroy()
						return
					}

					socket.removeListener('error', on_socket_error)

					wss.handleUpgrade(request, socket, head, function done(ws) {
						wss.emit('connection', ws, request, client)
					})
				})
			})

			let server_has_listened = false

			wss.on('listening', () => {
				server_has_listened = true
				logger.info(`socket server listening on :${port}`)
				this.status_bar.notify(
					`$(server-process) Socket server listening on :${port}`
				)
				this.status_bar.update(() => ({
					socket_server_status: 'running',
				}))
				this.socket_server_status = 'running'
				vscode.commands.executeCommand(
					'setContext',
					'renpyWarp.socketServerRunning',
					true
				)
				resolve(wss)
			})

			wss.on('connection', this.handle_connection)

			wss.on('close', () => {
				logger.info('renpy socket server closed')
				this.status_bar.update(() => ({
					socket_server_status: 'stopped',
					processes: new Map(),
				}))
				this.socket_server_status = 'stopped'
				this.status_bar.notify(
					`$(server-process) Socket server closed on :${port}`
				)
				this.pm.clear()

				vscode.commands.executeCommand(
					'setContext',
					'renpyWarp.socketServerRunning',
					false
				)
				this.socket_server = undefined
				reject()
			})

			function handle_error(error: unknown) {
				logger.error('socket server error:', error)

				if (!server_has_listened) {
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
					wss.close()
					reject()
				}
			}
			wss.on('error', handle_error)
			wss.on('wsClientError', handle_error)

			this.socket_server_status = 'starting'
			this.status_bar.update(() => ({
				socket_server_status: 'starting',
			}))

			http_server.listen(port)
		})
	}

	public close() {
		if (this.socket_server) {
			logger.info('stopping socket server')
			this.socket_server.close()
		}
	}

	private async get_socket_port(): Promise<number> {
		const port = await get_port({ port: PORTS })

		if (!PORTS.includes(port)) {
			throw new Error('exhausted all available ports')
		}

		return port
	}

	private async handle_connection(socket: WebSocket, req: IncomingMessage) {
		logger.debug(
			`socket server ${
				this.socket_server?.options.port
			} received a connection request with headers ${JSON.stringify(
				req.headers
			)}`
		)

		const socket_version = req.headers['warp-version']
		const socket_checksum = req.headers['warp-checksum']
		const socket_pid = Number(req.headers['pid'])
		const socket_nonce = req.headers['warp-nonce']
			? Number(req.headers['warp-nonce'])
			: undefined
		const socket_project_root = req.headers['warp-project-root'] as string

		if (this.ackd_processes.has(socket_pid)) {
			logger.debug(`ignoring connection request from pid ${socket_pid}`)
			socket.close()
			return
		}

		// TODO memory cache
		const rpe_checksum = await get_rpe_source(this.context).then(
			get_checksum
		)

		const project_roots = await find_projects_in_workspaces()

		const socket_project_root_realpath = await realpath(socket_project_root)
		const is_same_path = await p_locate(project_roots, async (project) => {
			logger.debug(await realpath(project), socket_project_root_realpath)
			return (
				path.relative(
					await realpath(project),
					socket_project_root_realpath
				) === ''
			)
		})
		if (is_same_path) {
			logger.info(
				`rejecting connection to socket because socket root '${socket_project_root}' does not match expected '${project_roots[0]}'` // TODO: iterate
			)
			socket?.close()

			return
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

			socket.close()
			return
		}

		let rpp: ManagedProcess | UnmanagedProcess

		if (socket_nonce !== undefined && this.pm.get(socket_nonce)) {
			rpp = this.pm.get(socket_nonce) as ManagedProcess

			if (!rpp) {
				logger.warn(
					`rejecting connection to socket because ${socket_nonce} is not registered`
				)
				socket.close()
				return
			}

			if (rpp instanceof ManagedProcess === false) {
				throw new Error('expected ManagedProcess')
			}

			logger.info(
				`socket server discovered managed process ${rpp.pid} with nonce ${socket_nonce}`
			)

			if (rpp.socket) {
				logger.warn('closing existing socket')
				rpp.socket.close(4000, 'connection replaced')
			}

			rpp.socket = socket
		} else {
			const pid = Number(req.headers['pid'])

			logger.info(`socket server discovered unmanaged process ${pid}`)

			if (this.pm.get(pid)) {
				logger.info('has existing process, reusing it')
				rpp = this.pm.get(pid) as UnmanagedProcess
				rpp.socket?.close(4000, 'connection replaced') // close existing socket
				rpp.socket = socket
			} else {
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
						socket.close()
						return
					}
					if (picked === 'Always ignore') {
						await set_config(
							'autoConnectExternalProcesses',
							'Never connect'
						)
					}
				} else if (auto_connect_setting === 'Never connect') {
					socket.close()
					return
				}

				logger.info('creating new unmanaged process')
				rpp = new UnmanagedProcess({
					pid,
					project_root: project_roots[0], // TODO: iterate
					socket,
				})

				rpp.on('exit', () => {
					logger.info(`external process ${pid} exited`)
					this.status_bar.delete_process(pid)
					this.status_bar.notify(
						`$(info) External process ${pid} exited`
					)
				})

				this.pm.add(pid, rpp)
				this.status_bar.set_process(pid, 'idle')

				if (
					!this.context.globalState.get(
						'hideExternalProcessConnected'
					)
				) {
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
		}

		socket.on('message', async (data) => {
			logger.debug(`websocket (${rpp.pid}) <`, data.toString())
			const message = JSON.parse(data.toString())

			rpp.emit('socketMessage', message)
			await this.message_handler(rpp, message)
		})

		socket.on('close', () => {
			logger.info(`websocket connection closed (pid ${rpp.pid})`)
			rpp.socket = undefined
		})

		socket.on('error', (error) => {
			logger.error(`websocket error (pid ${rpp.pid})`, error)
		})
	}
}
