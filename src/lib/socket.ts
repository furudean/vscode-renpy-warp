import * as vscode from 'vscode'

import { get_config } from './util'
import { get_logger } from './logger'
import { WebSocketServer } from 'ws'
import { ProcessManager, RenpyProcess } from './process'
import pidtree from 'pidtree'
import get_port from 'get-port'

const logger = get_logger()

let wss: WebSocketServer | undefined

export async function get_open_port() {
	return await get_port({ port: get_port.makeRange(40111, 40121) })
}

export async function ensure_websocket_server({
	pm,
}: {
	pm: ProcessManager
}): Promise<void> {
	if (wss) {
		logger.debug('socket server already running')
		return
	}

	return new Promise(async (resolve, reject) => {
		let has_listened = false
		const port = get_config('webSocketsPort')
		wss = new WebSocketServer({ port })

		let close_timeout: NodeJS.Timeout | undefined = undefined

		wss.on('listening', () => {
			has_listened = true
			logger.info('socket server listening on port', wss!.options.port)
			resolve()
		})

		wss.on('error', (...args) => {
			logger.error('socket server error:', ...args)

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
			}
			wss = undefined
			reject()
		})

		wss.on('close', () => {
			wss = undefined
			reject()
		})

		wss.on('connection', async (ws, req) => {
			let process: RenpyProcess | undefined

			const renpy_pid = Number(req.headers['pid'])
			for (const pid of pm.pids) {
				// the process might be a child of the process we created
				const pid_tree = await pidtree(pid, { root: true })
				logger.debug('pid tree:', pid_tree)
				if (pid_tree.includes(renpy_pid)) {
					logger.info(
						`matched new connection from ${pid} to launched process ${renpy_pid}`
					)
					process = pm.get(pid)

					if (!process) {
						logger.warn('process not found in process manager')
						return
					}

					if (process.socket) {
						logger.info('closing existing socket')
						process.socket.close()
					}

					process.socket = ws
					process.renpy_pid = renpy_pid

					break
				}
			}

			if (!process) {
				logger.warn(
					'unknown process tried to connect to socket server',
					renpy_pid
				)
				ws.close()
				return
			}

			clearTimeout(close_timeout)

			ws.on('message', async (data) => {
				logger.debug('websocket <', data.toString())
				const message = JSON.parse(data.toString())

				await process.message_handler(message)
			})

			ws.on('close', () => {
				logger.info(
					'websocket connection closed to pid',
					process.process.pid
				)
				process.socket = undefined

				clearTimeout(close_timeout)
				close_timeout = setTimeout(() => {
					if (wss?.clients.size === 0) {
						logger.info(
							'closing socket server as no clients remain'
						)
						wss.close()
						wss = undefined
					}
				}, 10 * 1000)
			})
		})
	})
}
