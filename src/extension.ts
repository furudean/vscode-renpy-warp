import * as vscode from 'vscode'

import { ProcessManager } from './lib/process/manager'
import { FollowCursor } from './lib/follow_cursor'
import { get_logger } from './lib/logger'
import { get_config, get_configuration_object, set_config } from './lib/config'
import { StatusBar } from './lib/status_bar'
import { ensure_socket_server } from './lib/socket'
import { AnyProcess } from './lib/process'
import { register_commmands } from './lib/commands'
import { prompt_install_rpe } from './lib/rpe'
import { register_handlers } from './lib/handlers'

const logger = get_logger()

export function activate(context: vscode.ExtensionContext) {
	// migrate settings from version<=1.5.0 where renpyExtensionsEnabled was a boolean
	const conf = get_configuration_object()
	if (
		typeof conf.inspect('renpyExtensionsEnabled')?.globalValue === 'boolean'
	) {
		set_config('renpyExtensionsEnabled', undefined, false)
	}
	if (
		typeof conf.inspect('renpyExtensionsEnabled')?.workspaceValue ===
		'boolean'
	) {
		set_config('renpyExtensionsEnabled', undefined, true)
	}

	const status_bar = new StatusBar()
	const follow_cursor = new FollowCursor({ status_bar })
	const pm = new ProcessManager()
	context.subscriptions.push(pm, follow_cursor, status_bar)

	let pm_init = false
	pm.on('exit', () => {
		if (pm.length === 0) {
			pm_init = false
		}
		if (
			follow_cursor.active_process &&
			get_config('renpyExtensionsEnabled') === 'Enabled'
		) {
			const most_recent = pm.at(-1)

			if (most_recent) {
				follow_cursor.set(most_recent)
				status_bar.notify(
					`$(debug-line-by-line) Now following pid ${most_recent.pid}`
				)
			}
		}
	})
	pm.on('attach', async (rpp: AnyProcess) => {
		if (
			(get_config('renpyExtensionsEnabled') === 'Enabled' &&
				get_config('followCursorOnLaunch') &&
				!pm_init) ||
			follow_cursor.active_process // follow cursor is already active, replace it
		) {
			logger.info('enabling follow cursor for new process')
			await follow_cursor.set(rpp)

			if (pm.length > 1) {
				status_bar.notify(
					`$(debug-line-by-line) Now following pid ${rpp.pid}`
				)
			}
		}

		pm_init = true
	})

	register_commmands(context, pm, status_bar, follow_cursor)
	register_handlers(context, pm, status_bar, follow_cursor)

	if (get_config('renpyExtensionsEnabled') === 'Enabled') {
		prompt_install_rpe(context).catch((error) => {
			logger.error(error)
			vscode.window
				.showErrorMessage('Failed to install RPE', 'Logs', 'OK')
				.then((selection) => {
					if (selection === 'Logs') {
						logger.show()
					}
				})
		})

		if (get_config('autoStartSocketServer')) {
			ensure_socket_server({
				pm,
				status_bar,
				follow_cursor,
				context,
			}).catch((error) => {
				logger.error('failed to start socket server:', error)
			})
		}
	}
}

export function deactivate() {
	logger.dispose()
}
