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

const logger = get_logger()

const PORTS = Object.freeze([
	40111, 40112, 40113, 40114, 40115, 40116, 40117, 40118, 40119, 40120,
])

export async function get_open_port(): Promise<number> {
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

	logger.info(`found new managed process ${rpp.pid}, with nonce ${nonce}`)

	if (rpp.socket) {
		logger.warn('closing existing socket')
		rpp.socket.close()
	}

	rpp.socket = socket

	return rpp
}

function handle_unmanaged_process(
	process: ConstructorParameters<typeof UnmanagedProcess>[0],
	pm: ProcessManager
): UnmanagedProcess {
	logger.info(`found new unmanaged process ${process.pid}`)
	const rpp = new UnmanagedProcess(process)
	pm.add(process.pid, rpp)

	return rpp
}

export async function start_websocket_server({
	pm,
	port,
	message_handler,
}: {
	pm: ProcessManager
	port: number
	message_handler: MessageHandler
}): Promise<void> {
	return new Promise(async (resolve, reject) => {
		let has_listened = false
		const server = new WebSocketServer({ port })

		server.on('listening', () => {
			has_listened = true
			logger.info(`socket server listening on :${port}`)
			resolve()
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

			let rpp: ManagedProcess | UnmanagedProcess

			if (req.headers['is-managed'] === '1') {
				rpp = handle_managed_process({
					nonce: Number(req.headers['nonce']),
					socket,
					pm,
				}) as ManagedProcess
			} else {
				const pid = Number(req.headers['pid'])
				const project_root = req.headers['project-root'] as string

				rpp = handle_unmanaged_process(
					{ pid, project_root, socket },
					pm
				) as UnmanagedProcess
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
