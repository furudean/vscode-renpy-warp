import * as vscode from "vscode"
import { get_config, set_config, show_file } from "./config"
import { launch_renpy, launch_sdk } from "./launch"
import { prompt_configure_extensions } from "./onboard"
import { find_projects_in_workspaces } from "./path"
import {
	get_sdk_path,
	prompt_sdk_quick_pick,
	prompt_install_sdk_picker
} from "./sdk"
import { prompt_install_rpe, uninstall_rpes } from "./rpe"
import { get_executable } from "./sh"
import { WarpSocketService } from "./socket"
import { ProcessManager } from "./process"
import { StatusBar } from "./status_bar"
import { FollowCursorService, sync_editor_with_renpy } from "./follow_cursor"
import { get_logger } from "./log"
import { is_special_label } from "./label"
import path from "upath"

const logger = get_logger()

export function get_commands(
	context: vscode.ExtensionContext,
	pm: ProcessManager,
	status_bar: StatusBar,
	follow_cursor: FollowCursorService,
	wss: WarpSocketService
) {
	const commands: Record<
		string,
		(...args: unknown[]) => Promise<unknown> | unknown
	> = {
		"renpyWarp.launch": async () => {
			try {
				await launch_renpy({ context, pm, status_bar, wss })
			} catch (error: unknown) {
				logger.error(error as Error)
			}
		},

		"renpyWarp.warpToLine": async () => {
			const editor = vscode.window.activeTextEditor
			if (!editor) return

			try {
				await launch_renpy({
					intent: "Starting Ren'Py at line...",
					file: editor?.document.uri.fsPath,
					line: editor?.selection.active.line,
					context,
					pm,
					status_bar,
					wss
				})
			} catch (error: unknown) {
				logger.error(error as Error)
			}
		},

		"renpyWarp.warpToFile": async (uri: unknown) => {
			const fs_path =
				uri instanceof vscode.Uri
					? uri.fsPath
					: vscode.window.activeTextEditor?.document.uri.fsPath

			try {
				await launch_renpy({
					intent: "Starting Ren'Py at file...",
					file: fs_path,
					line: 0,
					context,
					pm,
					status_bar,
					wss
				})
			} catch (error: unknown) {
				logger.error(error as Error)
			}
		},

		"renpyWarp.jumpToLabel": async () => {
			if (get_config("renpyExtensionsEnabled") !== "Enabled") {
				vscode.window.showErrorMessage(
					"Ren'Py extensions must be enabled to use this feature",
					"OK"
				)
				return
			}

			let process = pm.at(-1)
			const new_process = process === undefined

			if (process === undefined) {
				process = await launch_renpy({
					pm,
					status_bar,
					wss,
					context,
					extra_environment: {
						RENPY_SKIP_SPLASHSCREEN: "1"
					}
				})
				if (process === undefined) return
			}

			const storage_key = `renpyWarp.jumpToLabel.${process.project_root}`

			const favorites: string[] = context.workspaceState.get(storage_key) ?? []

			async function save_favorites() {
				await context.workspaceState.update(storage_key, favorites)
			}

			const quick_pick = vscode.window.createQuickPick()
			quick_pick.placeholder = "Select a label to jump to"
			quick_pick.busy = true
			quick_pick.ignoreFocusOut = new_process // focus might be lost on new process
			quick_pick.keepScrollPosition = true

			function map_label(label: string): vscode.QuickPickItem {
				const is_favorite = favorites.includes(label)
				const fav_index = favorites.indexOf(label)
				const is_first = fav_index === 0
				const is_last = fav_index === favorites.length - 1

				const buttons: vscode.QuickInputButton[] = []

				if (is_favorite) {
					if (!is_first)
						buttons.push({
							iconPath: new vscode.ThemeIcon("arrow-up"),
							tooltip: "Move up"
						})
					if (!is_last)
						buttons.push({
							iconPath: new vscode.ThemeIcon("arrow-down"),
							tooltip: "Move down"
						})
					buttons.push({
						iconPath: new vscode.ThemeIcon("star-full"),
						tooltip: "Remove favorite"
					})
				} else {
					buttons.push({
						iconPath: new vscode.ThemeIcon("star"),
						tooltip: "Make favorite"
					})
				}

				return {
					label,
					iconPath:
						process?.current_label === label
							? new vscode.ThemeIcon("arrow-right")
							: new vscode.ThemeIcon("blank"),
					buttons
				}
			}

			function build_items(labels: string[]): vscode.QuickPickItem[] {
				const _labels = [...labels].sort()

				const fav_labels = favorites.filter((l) => _labels.includes(l))
				const other_labels = _labels.filter((l) => !favorites.includes(l))

				const items: vscode.QuickPickItem[] = []

				if (fav_labels.length > 0) {
					items.push({
						label: "Favorites",
						kind: vscode.QuickPickItemKind.Separator
					})
					items.push(...fav_labels.map(map_label))
				}

				if (other_labels.length > 0) {
					items.push({
						label: "",
						kind: vscode.QuickPickItemKind.Separator
					})
					items.push(...other_labels.map(map_label))
				}

				return items
			}

			let filtered_labels: string[] = []

			quick_pick.show()

			quick_pick.onDidTriggerItemButton(async (e) => {
				const label = e.item.label
				const fav_index = favorites.indexOf(label)
				const is_favorite = fav_index !== -1

				if (e.button.tooltip === "Move up" && fav_index > 0) {
					favorites.splice(fav_index, 1)
					favorites.splice(fav_index - 1, 0, label)
				} else if (
					e.button.tooltip === "Move down" &&
					fav_index < favorites.length - 1
				) {
					favorites.splice(fav_index, 1)
					favorites.splice(fav_index + 1, 0, label)
				} else if (is_favorite) {
					favorites.splice(fav_index, 1)
				} else {
					favorites.push(label)
				}

				await save_favorites()
				quick_pick.items = build_items(filtered_labels)
			})

			const promise = new Promise<string | void>((resolve) => {
				quick_pick.onDidAccept(async () => {
					const selection = quick_pick.selectedItems[0]

					if (selection === undefined || process.dead) {
						resolve()
						return
					}

					await process.jump_to_label(selection.label)

					status_bar.notify(
						`$(debug-line-by-line) Jumped to label '${selection.label}'`
					)
					resolve()
				})

				quick_pick.onDidHide(() => {
					resolve(undefined)
				})
			})

			promise.finally(() => {
				quick_pick.dispose()
			})
			;(async () => {
				try {
					await process.wait_for_socket(5000)
					await process.wait_for_labels(1000)

					if (process.labels !== undefined) {
						filtered_labels = process.labels
							.filter((label) => !is_special_label(label))
							.sort()

						quick_pick.items = build_items(filtered_labels)
					}
				} catch (e: unknown) {
					vscode.window.showWarningMessage("Failed to connect to Ren'Py: " + e)
					quick_pick.dispose()
				} finally {
					quick_pick.busy = false
				}
			})()

			return promise
		},

		"renpyWarp.toggleFollowCursor": async () => {
			if (follow_cursor.enabled) {
				follow_cursor.off()

				if (!pm.length) {
					status_bar.notify("$(pin) Follow Cursor: Off")
				}
			} else {
				const process = pm.at(-1)

				if (process) {
					const last_cursor = process?.last_cursor

					if (last_cursor !== undefined) {
						await sync_editor_with_renpy({
							line: last_cursor.line - 1,
							path: last_cursor.path,
							relative_path: last_cursor.relative_path,
							force: true
						})
					}
				} else {
					status_bar.notify("$(pinned) Follow Cursor: On")
					follow_cursor.enabled = true
					return
				}

				await follow_cursor.set(process)
			}
		},

		"renpyWarp.syncCursorPosition": async () => {
			const recent = pm.at(-1)
			const last_cursor = recent?.last_cursor

			if (last_cursor === undefined) {
				vscode.window.showInformationMessage(
					"Sync Cursor Position: No cursor reported from process yet",
					"OK"
				)
				return
			}
			await sync_editor_with_renpy({
				line: last_cursor.line - 1,
				path: last_cursor.path,
				relative_path: last_cursor.relative_path,
				force: true
			})
		},

		"renpyWarp.killAll": () => pm.kill_all(),

		"renpyWarp.installRpe": async () => {
			const sdk_path = await get_sdk_path()
			if (!sdk_path) return

			const executable = await get_executable(sdk_path)
			if (!executable) return

			const projects = await find_projects_in_workspaces()
			for (const project_root of projects) {
				await prompt_install_rpe({
					project: project_root,
					executable,
					context
				})
			}
		},

		"renpyWarp.uninstallRpe": async () => {
			const sdk_path = await get_sdk_path()
			if (!sdk_path) return

			for (const folder of vscode.workspace.workspaceFolders ?? []) {
				await uninstall_rpes(folder.uri)
			}
			vscode.window.showInformationMessage(
				"Ren'Py extensions were successfully uninstalled from the project"
			)
		},

		"renpyWarp.setSdkPath": async (): Promise<string | undefined> => {
			const fs_path = await prompt_sdk_quick_pick(context)

			if (!fs_path) return undefined
			await set_config("sdkPath", fs_path, true)

			return fs_path
		},

		"renpyWarp.downloadSdk": async () => {
			await prompt_install_sdk_picker(context)
		},

		"renpyWarp.setExtensionsPreference": async () => {
			const sdk_path = await get_sdk_path()
			if (!sdk_path) return

			const executable = await get_executable(sdk_path, true)
			if (!executable) return

			await prompt_configure_extensions(executable)
		},

		"renpyWarp.startSocketServer": async () => {
			if (get_config("renpyExtensionsEnabled") === "Enabled") {
				await wss.start()
			} else {
				vscode.window.showErrorMessage(
					"Ren'Py extensions must be enabled to use the socket server",
					"OK"
				)
			}
		},

		"renpyWarp.stopSocketServer": () => {
			wss.close()
		},

		"renpyWarp.resetSuppressedMessages": () => {
			context.globalState.update("hideExternalProcessConnected", false)
			context.globalState.update("hideRpeInstallUpdateMessage", false)
		},

		"renpyWarp.launchSDK": async () => {
			const sdk_path = await get_sdk_path()
			if (!sdk_path) return

			const executable = await get_executable(sdk_path, true)
			if (!executable) return

			await launch_sdk({ sdk_path, executable })
		},

		"renpyWarp.lint": async () => {
			try {
				const p = await launch_renpy({
					intent: "Linting project...",
					command: "lint",
					context,
					pm,
					status_bar,
					wss
				})

				if (p?.project_root) {
					// https://github.com/renpy/renpy/blob/8646cd3f39dd74a17d52d1b882697b24574078d9/launcher/game/distribute.rpy#L876-L878
					const project_name = path.basename(p.project_root)
					await show_file(
						path.join(await get_sdk_path(), "tmp", project_name, "lint.txt")
					)
				}
			} catch (error: unknown) {
				logger.error(error as Error)
				vscode.window
					.showErrorMessage(
						"Failed to lint project. Check the output for more details.",
						"OK",
						"Open Output"
					)
					.then((selection) => {
						if (selection === "Open Output") {
							logger.show()
						}
					})
			}
		},

		"renpyWarp.rmpersistent": async () => {
			try {
				await launch_renpy({
					intent: "Removing persistent data...",
					command: "rmpersistent",
					context,
					pm,
					status_bar,
					wss
				})
				vscode.window.showInformationMessage(
					"Persistent data was deleted",
					"OK"
				)
			} catch (error: unknown) {
				logger.error(error as Error)
				vscode.window
					.showErrorMessage(
						"Failed to delete persistent data. Check the output for more details.",
						"OK",
						"Open Output"
					)
					.then((selection) => {
						if (selection === "Open Output") {
							logger.show()
						}
					})
			}
		},
		"renpyWarp.resetWorkspaceState": async () => {
			const keys = context.workspaceState.keys()
			for (const key of keys) {
				await context.workspaceState.update(key, undefined)
			}
			vscode.window.showInformationMessage("Workspace state cleared", "OK")
		}
	}

	return commands
}

export function register_commands(
	context: vscode.ExtensionContext,
	pm: ProcessManager,
	status_bar: StatusBar,
	follow_cursor: FollowCursorService,
	wss: WarpSocketService
) {
	const commands = get_commands(context, pm, status_bar, follow_cursor, wss)

	for (const [name, handler] of Object.entries(commands)) {
		context.subscriptions.push(vscode.commands.registerCommand(name, handler))
	}
}
