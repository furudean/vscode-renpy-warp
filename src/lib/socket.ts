import * as vscode from 'vscode'

import { get_logger } from './logger'
import { WebSocketServer } from 'ws'
import {
	AnyProcess,
	ManagedProcess,
	ProcessManager,
	UnmanagedProcess,
} from './process'
import get_port from 'get-port'
import { StatusBar } from './status_bar'
import { prompt_install_rpe, get_rpe_source, get_checksum } from './rpe'
import { FollowCursor, sync_editor_with_renpy } from './follow_cursor'
import { find_project_root } from './sh'
import path from 'upath'
import { realpath } from 'node:fs/promises'

const logger = get_logger()

const PORTS = Object.freeze([
	40111, 40112, 40113, 40114, 40115, 40116, 40117, 40118, 40119, 40120,
])

export async function get_socket_port(): Promise<number> {
	const port = await get_port({ port: PORTS })

	if (!PORTS.includes(port)) {
		throw new Error('exhausted all available ports')
	}

	return port
}

type MaybePromise<T> = T | Promise<T>

export interface SocketMessage {
	type: string
	[key: string]: any
}

export type MessageHandler = (
	process: AnyProcess,
	data: SocketMessage
) => MaybePromise<void>

export async function start_websocket_server({
	port,
	project_root,
	message_handler,
	pm,
	status_bar,
	context,
}: {
	port: number
	project_root: string
	message_handler: MessageHandler
	pm: ProcessManager
	status_bar: StatusBar
	context: vscode.ExtensionContext
}): Promise<WebSocketServer> {
	return new Promise(async (resolve, reject) => {
		let has_listened = false

		status_bar.update(() => ({
			socket_server_status: 'starting',
		}))

		const rpe_checksum = await get_rpe_source(context).then(get_checksum)
		const server = new WebSocketServer({ port })

		server.on('listening', () => {
			has_listened = true
			logger.info(`socket server listening on :${port}`)
			status_bar.notify(
				`$(server-process) Socket server listening on :${port}`
			)
			resolve(server)
		})

		const handle_error = (error: any) => {
			logger.error('socket server error:', error)

			if (!has_listened) {
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
				server.close()
				reject()
			}
		}

		server.on('error', handle_error)
		server.on('wsClientError', handle_error)

		server.on('close', () => {
			logger.debug('renpy socket server closed')
			status_bar.notify(
				`$(server-process) Socket server closed on :${port}`
			)
			reject()
		})

		const ack_bad_process = new Set<number>()

		server.on('connection', async (socket, req) => {
			logger.debug(
				`socket server ${port} received a connection request with headers ${JSON.stringify(
					req.headers
				)}`
			)

			const socket_version = req.headers['warp-version']
			const socket_checksum = req.headers['warp-checksum']
			const socket_pid = Number(req.headers['pid'])
			const socket_nonce = req.headers['warp-nonce']
				? Number(req.headers['warp-nonce'])
				: undefined

			if (socket_checksum !== rpe_checksum) {
				logger.debug(
					`rpe checksum ${socket_version} does not match expected ${rpe_checksum}`
				)

				if (ack_bad_process.has(socket_pid)) return

				const picked = await vscode.window.showErrorMessage(
					`Ren'Py extension checksum mismatch: ${socket_checksum} != ${rpe_checksum}. This may be due to outdated extensions. Would you like to update them?`,
					'Update',
					"Don't Update"
				)

				if (picked === 'Update') {
					await prompt_install_rpe(
						context,
						"Ren'Py extensions were updated. Please restart the game to connect."
					)
				}

				ack_bad_process.add(socket_pid)
				socket.close()
				return
			}

			let rpp: ManagedProcess | UnmanagedProcess

			if (socket_nonce !== undefined && pm.get(socket_nonce)) {
				rpp = pm.get(socket_nonce) as ManagedProcess

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
					rpp.socket.close()
				}

				rpp.socket = socket
			} else {
				const pid = Number(req.headers['pid'])
				const socket_project_root = req.headers[
					'warp-project-root'
				] as string

				logger.info(`socket server discovered unmanaged process ${pid}`)

				const project_root_realpath = await realpath(project_root)
				const socket_project_root_realpath = await realpath(
					socket_project_root
				)

				// check if they're the same
				if (
					path.relative(
						project_root_realpath,
						socket_project_root_realpath
					) !== ''
				) {
					logger.info(
						`rejecting connection to socket because socket root '${socket_project_root}' does not match expected '${project_root}'`
					)
					socket?.close()

					return
				}

				if (pm.get(pid)) {
					logger.info('has existing process, reusing it')
					rpp = pm.get(pid) as UnmanagedProcess
				} else {
					logger.info('creating new unmanaged process')
					rpp = new UnmanagedProcess({ pid, project_root, socket })

					rpp.on('exit', () => {
						logger.info(`external process ${pid} exited`)
						status_bar.delete_process(pid)
						status_bar.notify(
							`$(info) External process ${pid} exited`
						)
					})

					pm.add(pid, rpp)
					status_bar.set_process(pid, 'idle')
					vscode.window.showInformationMessage(
						"Connected to external Ren'Py process"
					)
				}
			}

			socket.on('message', async (data) => {
				logger.debug(`websocket (${rpp.pid}) <`, data.toString())
				const message = JSON.parse(data.toString())

				await message_handler(rpp, message)
			})

			socket.on('close', () => {
				logger.info(`websocket connection closed (pid ${rpp.pid})`)
				rpp.socket = undefined
			})

			socket.on('error', (error) => {
				logger.error(`websocket error (pid ${rpp.pid})`, error)
			})
		})
	})
}

let socket_server: WebSocketServer | undefined

export async function ensure_socket_server({
	pm,
	status_bar,
	follow_cursor,
	context,
}: {
	pm: ProcessManager
	status_bar: StatusBar
	follow_cursor: FollowCursor
	context: vscode.ExtensionContext
}): Promise<true | undefined> {
	if (socket_server !== undefined) {
		logger.info('socket server already running')
		return
	}

	stop_socket_server(pm, status_bar)

	const file_path = await vscode.workspace
		.findFiles('**/game/**/*.rpy', null, 1)
		.then((files) => (files.length ? files[0].fsPath : null))
	if (!file_path) {
		logger.error('no renpy file in workspace')
		return
	}

	const project_root = find_project_root(file_path)
	if (!project_root) {
		logger.error('no renpy project in workspace')
		return
	}
	const port = await get_socket_port()

	status_bar.update(() => ({
		socket_server_status: 'starting',
	}))

	socket_server = await start_websocket_server({
		port,
		pm,
		status_bar,
		project_root,
		context,
		async message_handler(process, message) {
			if (message.type === 'current_line') {
				logger.debug(
					`current line reported as ${message.relative_path}:${message.line}`
				)
				if (follow_cursor.active_process === process) {
					await sync_editor_with_renpy({
						path: message.path,
						relative_path: message.relative_path,
						line: message.line - 1,
					})
				}
			} else {
				logger.warn('unhandled message:', message)
			}
		},
	})

	status_bar.update(() => ({
		socket_server_status: 'running',
	}))

	socket_server.on('close', () => {
		socket_server = undefined
		status_bar.update(() => ({
			socket_server_status: 'stopped',
		}))
	})

	context.subscriptions.push({
		dispose() {
			socket_server?.close()
		},
	})

	return true
}

export function stop_socket_server(
	pm: ProcessManager,
	status_bar: StatusBar
): void {
	logger.info('stopping socket server')
	pm.clear()
	status_bar.update(() => ({ processes: new Map() }))
	socket_server?.close()
}
