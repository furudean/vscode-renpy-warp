import * as vscode from 'vscode'

import { get_logger } from './logger'
import { WebSocketServer } from 'ws'
import { ProcessManager } from './process'
import get_port from 'get-port'
import { get_config } from './util'

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
			reject()
		})

		server.on('connection', async (socket, req) => {
			const pid = Number(req.headers['pid'])
			const rpp = await pm.find_tracked(pid)

			if (!rpp) throw new Error('no process found for pid ' + pid)

			const ppid = rpp.process.pid

			logger.info(
				`found new socket connection from process ${pid}` +
					(ppid !== pid ? ` (parent ${ppid})` : '')
			)

			if (rpp.socket) {
				logger.warn('closing existing socket')
				rpp.socket.close()
			}

			rpp.socket = socket

			socket.on('message', async (data) => {
				logger.debug(`websocket (${ppid}) <`, data.toString())
				const message = JSON.parse(data.toString())

				await rpp.message_handler(rpp, message)
			})

			socket.on('close', () => {
				logger.info(`websocket connection closed (pid ${ppid})`)
				rpp.socket = undefined
			})

			socket.on('error', (error) => {
				logger.error(`websocket error (pid ${ppid})`, error)
			})

			rpp.process.off('exit', process_exit_handler)
			rpp.process.on('exit', process_exit_handler)
		})
	})
}
