import * as vscode from "vscode"

import { ProcessManager } from "./lib/process/manager"
import { FollowCursorService } from "./lib/follow_cursor"
import { get_logger } from "./lib/log"
import { get_config, get_configuration_object, set_config } from "./lib/config"
import { StatusBar } from "./lib/status_bar"
import { get_message_handler, WarpSocketService } from "./lib/socket"
import { register_commands } from "./lib/commands"
import { update_existing_rpes } from "./lib/rpe"
import { register_handlers } from "./lib/handlers"
import { DecorationService } from "./lib/decoration"
import { AnyProcess } from "./lib/process"

const logger = get_logger()

export function activate(context: vscode.ExtensionContext) {
	// migrate settings from version<=1.5.0 where renpyExtensionsEnabled was a boolean
	const conf = get_configuration_object()
	if (
		typeof conf.inspect("renpyExtensionsEnabled")?.globalValue === "boolean"
	) {
		set_config("renpyExtensionsEnabled", undefined, false)
	}
	if (
		typeof conf.inspect("renpyExtensionsEnabled")?.workspaceValue === "boolean"
	) {
		set_config("renpyExtensionsEnabled", undefined, true)
	}

	const status_bar = new StatusBar()
	const follow_cursor = new FollowCursorService({ status_bar })
	const pm = new ProcessManager()
	const ds = new DecorationService({ context })
	const wss = new WarpSocketService({
		message_handler: get_message_handler(follow_cursor),
		pm,
		status_bar,
		context
	})

	context.subscriptions.push(pm, follow_cursor, status_bar, ds)

	let pm_init = false
	pm.on("exit", () => {
		vscode.commands.executeCommand(
			"setContext",
			"renpyWarp.runningProcesses",
			pm.length
		)

		if (pm.length === 0) {
			pm_init = false
		}
		if (
			follow_cursor.enabled &&
			get_config("renpyExtensionsEnabled") === "Enabled"
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
	pm.on("attach", async (rpp: AnyProcess) => {
		vscode.commands.executeCommand(
			"setContext",
			"renpyWarp.runningProcesses",
			pm.length
		)

		ds.track(rpp)

		if (
			(get_config("renpyExtensionsEnabled") === "Enabled" &&
				get_config("followCursorOnLaunch") &&
				!pm_init) ||
			follow_cursor.enabled // follow cursor is already active, replace it
		) {
			logger.info("enabling follow cursor for new process")
			await follow_cursor.set(rpp)

			if (pm.length > 1) {
				status_bar.notify(`$(debug-line-by-line) Now following pid ${rpp.pid}`)
			}
		}

		pm_init = true
	})

	register_commands(context, pm, status_bar, follow_cursor, wss)
	register_handlers(context, pm, wss)

	if (
		get_config("renpyExtensionsEnabled") === "Enabled" &&
		get_config("sdkPath")
	) {
		update_existing_rpes(context).catch((error) => {
			logger.error(error)
			vscode.window
				.showErrorMessage(
					"Failed to install/update RPE on startup",
					"Logs",
					"OK"
				)
				.then((selection) => {
					if (selection === "Logs") {
						logger.show()
					}
				})
		})

		if (get_config("autoStartSocketServer")) {
			wss.start().catch((error) => {
				logger.error("failed to start socket server:", error)
			})
		}
	}
}

export function deactivate() {
	logger.dispose()
}
