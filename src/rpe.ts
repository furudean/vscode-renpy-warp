import * as vscode from 'vscode'

import path from 'upath'
import { get_renpy_sh, get_version } from './sh'
import { version as pkg_version } from '../package.json'
import semver from 'semver'
import { get_config } from './util'
import { logger } from './logger'
import { WebSocketServer } from 'ws'
import fs from 'node:fs/promises'
import AdmZip from 'adm-zip'
import { ProcessManager, RenpyProcess } from './process'
import pidtree from 'pidtree'

let wss: WebSocketServer | undefined

export async function install_rpe({
	game_root,
	context,
}: {
	game_root: string
	context: vscode.ExtensionContext
}): Promise<void> {
	const renpy_sh = await get_renpy_sh()

	if (!renpy_sh)
		throw new Error('failed to get renpy.sh while installing rpe')

	const version = get_version(renpy_sh)
	const supports_rpe_py = semver.gte(version.semver, '8.3.0')

	const files = await vscode.workspace
		.findFiles('**/renpy_warp_*.rpe*')
		.then((files) => files.map((f) => f.fsPath))

	for (const file of files) {
		await fs.unlink(file)
		logger.info('deleted old rpe at', file)
	}

	const rpe_source_path = path.join(
		context.extensionPath,
		'dist/',
		'renpy_warp.rpe.py'
	)

	const rpe_source_code = await fs.readFile(rpe_source_path)
	/** @type {string} */
	let file_path: string

	if (supports_rpe_py) {
		file_path = path.join(
			game_root,
			'game/', // TODO: https://github.com/renpy/renpy/issues/5614
			`renpy_warp_${pkg_version}.rpe.py`
		)
		await fs.writeFile(file_path, rpe_source_code)
		logger.info('wrote rpe to', file_path)
	} else {
		file_path = path.join(
			game_root,
			'game/',
			`renpy_warp_${pkg_version}.rpe`
		)
		const zip = new AdmZip()
		zip.addFile('autorun.py', rpe_source_code)
		await fs.writeFile(file_path, zip.toBuffer())
	}

	logger.info('wrote rpe to', file_path)
}

export async function has_any_rpe(): Promise<boolean> {
	return vscode.workspace
		.findFiles('**/renpy_warp_*.rpe*')
		.then((files) => files.length > 0)
}

export async function has_current_rpe(renpy_sh: string): Promise<boolean> {
	const files = await vscode.workspace
		.findFiles('**/renpy_warp_*.rpe*')
		.then((files) => files.map((f) => f.fsPath))

	const renpy_version = get_version(renpy_sh)
	const supports_rpe_py = semver.gte(renpy_version.semver, '8.3.0')

	for (const file of files) {
		const basename = path.basename(file)

		// find mismatched feature support
		if (!supports_rpe_py && basename.endsWith('.rpe.py')) return false
		if (supports_rpe_py && basename.endsWith('.rpe')) return false

		const version = basename.match(
			/renpy_warp_(?<version>.+)\.rpe(?:\.py)?/
		)?.groups?.version

		if (version === pkg_version) {
			return true
		}
	}

	return false
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

		/** @type {NodeJS.Timeout} */
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
			for (const pid of pm.processes.keys()) {
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
