import * as vscode from 'vscode'

import { get_logger } from './logger'
import { WebSocketServer } from 'ws'
import { ProcessManager, RenpyProcess } from './process'
import get_port from 'get-port'
import { get_config } from './util'

const servers = new Map<number, WebSocketServer>()
const logger = get_logger()

export async function get_open_port() {
	return await get_port({ port: get_config('socketPorts') })
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
		const wss = new WebSocketServer({ port })

		servers.set(port, wss)

		let close_timeout: NodeJS.Timeout | undefined = undefined

		wss.on('listening', () => {
			has_listened = true
			logger.info(`socket server listening on :${port}`)
			resolve()
		})

		wss.on('error', (error) => {
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
				reject()
			}
		})

		wss.on('close', () => {
			servers.delete(port)
			reject()
		})

		wss.on('connection', async (ws, req) => {
			clearTimeout(close_timeout)

			const pid = Number(req.headers['pid'])
			const rpp = await pm.find_tracked(pid)

			if (!rpp) throw new Error('no process found for pid ' + pid)

			logger.info(
				`found new connection from process ${pid} (child process ${rpp.process.pid})`
			)

			if (rpp.socket) {
				logger.warn('closing existing socket')
				rpp.socket.close()
			}

			rpp.socket = ws

			ws.on('message', async (data) => {
				logger.debug('websocket <', data.toString())
				const message = JSON.parse(data.toString())

				await rpp.message_handler(message)
			})

			ws.on('close', () => {
				logger.info(
					'websocket connection closed to pid',
					rpp.process.pid
				)
				rpp.socket = undefined

				close_timeout = setTimeout(() => {
					logger.debug(
						'closing socket server if no clients connected'
					)
					if (wss.clients.size === 0) {
						logger.debug(
							`closing socket server :${port} as nobody was connected for 10 seconds`
						)
						wss.close()
					}
				}, 10 * 1000)
			})
		})
	})
}
