import * as vscode from 'vscode'

import { get_logger } from './logger'
import { WebSocketServer } from 'ws'
import { ProcessManager } from './process'
import get_port from 'get-port'

const logger = get_logger()

const ports = [
	40111, 40112, 40113, 40114, 40115, 40116, 40117, 40118, 40119, 40120,
]

export async function get_open_port(): Promise<number> {
	const port = await get_port({ port: ports })

	if (!ports.includes(port)) {
		throw new Error('exhausted all available ports')
	}

	return port
}

export async function start_websocket_server({
	pm,
	port,
}: {
	pm: ProcessManager
	port: number
}): Promise<void> {
	return new Promise(async (resolve, reject) => {
		let has_listened = false
		const server = new WebSocketServer({ port })

		function process_exit_handler() {
			logger.info(`closing socket server :${port} as process exited`)
			server.close()
		}

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
			logger.debug(`renpy socket server closed  port: ${port}`)
			reject()
		})

		server.on('connection', async (socket, req) => {
			logger.trace(
				`renpy socket server ${port} received a connection request with nonce ${req.headers['nonce']}`
			)
			const nonce = Number(req.headers['nonce'])

			const rpp = pm.get(nonce)

			if (!rpp) {
				logger.warn(
					`Rejecting connection to socket because ${nonce} is not registered`
				)
				return
			}

			logger.info(
				`found new socket connection from process ${rpp.pid}, with nonce ${nonce}`
			)

			if (rpp.socket) {
				logger.warn('closing existing socket')
				rpp.socket.close()
			}

			rpp.socket = socket

			socket.on('message', async (data) => {
				logger.debug(`websocket (${rpp.pid}) <`, data.toString())
				const message = JSON.parse(data.toString())

				await rpp.message_handler(rpp, message)
			})

			socket.on('close', () => {
				logger.info(`websocket connection closed (pid ${rpp.pid})`)
				rpp.socket = undefined
			})

			socket.on('error', (error) => {
				logger.error(`websocket error (pid ${rpp.pid})`, error)
			})

			rpp.off('exit', process_exit_handler)
			rpp.on('exit', process_exit_handler)
		})
	})
}
