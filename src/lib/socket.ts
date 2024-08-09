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

function handle_managed_process({
	nonce,
	socket,
	pm,
}: {
	nonce: number
	socket: WebSocket
	pm: ProcessManager
}): ManagedProcess | undefined {
	const rpp = pm.get(nonce)

	if (!rpp) {
		logger.warn(
			`rejecting connection to socket because ${nonce} is not registered`
		)
		socket.close()
		return
	}

	if (rpp instanceof ManagedProcess === false) {
		logger.warn(
			`rejecting connection to socket because ${rpp.pid} does not match nonce ${nonce}`
		)
		socket.close()
		return
	}

	logger.info(
		`socket server discovered managed process ${rpp.pid}, with nonce ${nonce}`
	)

	if (rpp.socket) {
		logger.warn('closing existing socket')
		rpp.socket.close()
	}

	rpp.socket = socket

	return rpp
}

function handle_unmanaged_process({
	process,
	expected_project_root,
	pm,
	status_bar,
}: {
	process: ConstructorParameters<typeof UnmanagedProcess>[0]
	expected_project_root: string
	pm: ProcessManager
	status_bar: StatusBar
}): UnmanagedProcess | undefined {
	logger.info(`socket server discovered unmanaged process ${process.pid}`)

	if (process.project_root !== expected_project_root) {
		// TODO: this does not work well on >=8.3.0 as renpy.config.gamedir is the launcher
		// directory instead of the project root
		logger.warn(
			`rejecting connection to socket because project root ${process.project_root} does not match expected ${expected_project_root}`
		)
		process.socket?.close()

		return
	}

	const rpp = new UnmanagedProcess(process)
	pm.add(process.pid, rpp)

	status_bar.set_process(process.pid, 'idle')

	rpp.on('exit', () => {
		status_bar.delete_process(process.pid)
	})

	status_bar.notify(`$(info) Discovered Ren'Py process ${process.pid}`)

	return rpp
}

export async function start_websocket_server({
	port,
	project_root,
	message_handler,
	pm,
	status_bar,
}: {
	port: number
	project_root: string
	message_handler: MessageHandler
	pm: ProcessManager
	status_bar: StatusBar
}): Promise<WebSocketServer> {
	return new Promise(async (resolve, reject) => {
		let has_listened = false
		const server = new WebSocketServer({ port })

		server.on('listening', () => {
			has_listened = true
			logger.info(`socket server listening on :${port}`)
			resolve(server)
		})

		server.on('error', (error) => {
			logger.error('socket server error:', error)

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
				server.close()
				reject()
			}
		})

		server.on('close', () => {
			logger.debug('renpy socket server closed')
			reject()
		})

		server.on('connection', async (socket, req) => {
			logger.debug(
				`socket server ${port} received a connection request with headers ${JSON.stringify(
					req.headers
				)}`
			)

			let rpp: ManagedProcess | UnmanagedProcess | undefined

			if (req.headers['is-managed'] === '1') {
				rpp = handle_managed_process({
					nonce: Number(req.headers['nonce']),
					socket,
					pm,
				}) as ManagedProcess
			} else {
				const pid = Number(req.headers['pid'])
				const socket_project_root = await realpath(
					req.headers['project-root'] as string
				)

				rpp = handle_unmanaged_process({
					process: { pid, project_root: socket_project_root, socket },
					expected_project_root: project_root,
					pm,
					status_bar,
				})

				if (!rpp) return
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
