import { homedir } from 'node:os'
import { get_config, set_config, set_config_exclusive } from './config'
import { path_exists, resolve_path } from './path'
import * as vscode from 'vscode'
import path, { basename } from 'upath'
import tildify from 'tildify'
import { get_logger } from './log'
import {
	download_sdk,
	find_sdk_in_directory,
	list_downloaded_sdks,
	list_remote_sdks,
	semver_compare,
	uninstall_sdk,
	RemoteSdk,
} from './download'
import { SemVer } from 'semver'
import open from 'open'
import { get_executable, get_version } from './sh'

export const logger = get_logger()

enum SdkAction {
	Path = 'Path',
	ShowDirectory = 'ShowDirectory',
	FilePicker = 'SystemFilePicker',
	InstallSdk = 'InstallSdk',
}

interface SdkQuickPickItem extends vscode.QuickPickItem {
	action?: SdkAction
	path?: string
}

interface DownloadSdkQuickPickItem extends vscode.QuickPickItem {
	url?: URL
	installed_uri?: vscode.Uri
}

export async function path_is_sdk(sdk_path: string): Promise<boolean> {
	return await path_exists(path.join(sdk_path, 'renpy.py'))
}

/**
 * Returns the path to the Ren'Py SDK as specified in the settings. Prompts the
 * user to set the path if it is not set.
 */
export async function get_sdk_path(): Promise<string | undefined> {
	let sdk_path_setting = get_config('sdkPath') as string

	logger.debug('raw sdk path:', sdk_path_setting)

	if (!sdk_path_setting.trim()) {
		const selection = await vscode.window.showInformationMessage(
			"Please set a Ren'Py SDK path to continue",
			'Set SDK Path',
			'Cancel'
		)
		if (selection === 'Set SDK Path') {
			sdk_path_setting = await vscode.commands.executeCommand(
				'renpyWarp.setSdkPath'
			)
		}
		if (!sdk_path_setting) return
	}

	return resolve_path(sdk_path_setting)
}

export async function prompt_sdk_quick_pick(
	context: vscode.ExtensionContext
): Promise<string | void> {
	const current_sdk_path = await get_sdk_path()

	function create_quick_pick_item(
		sdk_path: string,
		label?: string
	): SdkQuickPickItem {
		const buttons: vscode.QuickInputButton[] = [
			{
				iconPath: new vscode.ThemeIcon('folder'),
				tooltip: 'Show directory',
			},
		]

		if (!label) {
			buttons.push({
				iconPath: new vscode.ThemeIcon('trash'),
				tooltip: 'Delete',
			})
		}

		return {
			label: label ?? basename(sdk_path),
			// description: tildify(sdk_path),
			iconPath:
				sdk_path === current_sdk_path
					? new vscode.ThemeIcon('check')
					: new vscode.ThemeIcon('blank'),
			action: SdkAction.Path,
			path: sdk_path,
			description:
				sdk_path === current_sdk_path ? '(selected)' : undefined,
			buttons,
		}
	}

	const options: SdkQuickPickItem[] = [
		{
			label: '$(plus) Download SDK version...',
			action: SdkAction.InstallSdk,
		},
		{
			label: '$(file-directory) Enter SDK path...',
			action: SdkAction.FilePicker,
		},
	]

	const quick_pick = vscode.window.createQuickPick<SdkQuickPickItem>()
	quick_pick.title = "Select Ren'Py SDK"
	quick_pick.placeholder = "Select a Ren'Py SDK to use"
	quick_pick.items = options
	quick_pick.ignoreFocusOut = true
	quick_pick.busy = true

	quick_pick.onDidTriggerItemButton(async (e) => {
		if (!e.item.path) throw new Error('item path is undefined')
		switch (e.button.tooltip) {
			case 'Show directory': {
				await open(e.item.path)
				break
			}
			case 'Delete':
				await uninstall_sdk(e.item.path, context)
				if (e.item.path === current_sdk_path) {
					await set_config_exclusive('sdkPath', undefined, true)
				}
				quick_pick.items = quick_pick.items.filter(
					(i) => i.path !== e.item.path
				)
				break
			default:
				throw new Error(
					`unexpected button tooltip: ${e.button.tooltip}`
				)
		}
	})

	quick_pick.show()

	const selection_promise = new Promise<SdkQuickPickItem | undefined>(
		(resolve) => {
			quick_pick.onDidAccept(() => {
				resolve(quick_pick.selectedItems[0])
				quick_pick.hide()
			})

			quick_pick.onDidHide(() => {
				resolve(undefined)
			})
		}
	)

	const downloaded_sdks = await list_downloaded_sdks(context)
	const current_sdk_is_managed_by_extension = current_sdk_path
		? downloaded_sdks.includes(current_sdk_path)
		: false

	quick_pick.items = [
		...downloaded_sdks
			.sort((a, b) => {
				if (a === current_sdk_path) return -1
				if (b === current_sdk_path) return 1
				return semver_compare(basename(a), basename(b))
			})
			.map((sdk_path) => create_quick_pick_item(sdk_path)),
		{
			label: '',
			kind: vscode.QuickPickItemKind.Separator,
		},
		...quick_pick.items,
	]

	if (current_sdk_path && !current_sdk_is_managed_by_extension) {
		let label = tildify(current_sdk_path)
		const executable = await get_executable(current_sdk_path)

		if (executable) {
			const version = get_version(executable)?.semver

			if (version) {
				label += ` (${version})`
			}
		}

		quick_pick.items = [
			create_quick_pick_item(current_sdk_path, label),
			{
				label: '',
				kind: vscode.QuickPickItemKind.Separator,
			},
			...quick_pick.items,
		]
	}

	quick_pick.busy = false

	const selection = await selection_promise

	if (!selection) return

	switch (selection.action) {
		case SdkAction.InstallSdk:
			return await prompt_install_sdk_picker(context)

		case SdkAction.FilePicker:
			return await prompt_sdk_file_picker()

		case SdkAction.Path:
			if (selection.path) {
				if (await path_is_sdk(selection.path)) {
					return selection.path
				}
			}
			vscode.window.showErrorMessage(
				`Path "${selection.path}" is not a valid Ren'Py SDK`
			)
			return

		default:
			throw new Error('Unexpected selection state')
	}
}

export async function prompt_sdk_file_picker(): Promise<string | undefined> {
	const input_path = await vscode.window.showOpenDialog({
		title: "Set Ren'Py SDK directory",
		openLabel: 'Select SDK',
		defaultUri: vscode.Uri.file(
			resolve_path((get_config('sdkPath') as string) || homedir())
		),
		canSelectFolders: true,
		canSelectFiles: false,
		canSelectMany: false,
	})
	if (typeof input_path === 'undefined' || input_path.length === 0) return

	const fs_path = input_path[0].fsPath
	const is_sdk = await path_is_sdk(fs_path)

	if (!is_sdk) {
		const err_selection = await vscode.window.showErrorMessage(
			"Path is not a Ren'Py SDK",
			'Reselect'
		)
		if (err_selection) return prompt_sdk_file_picker()

		return
	}

	return tildify(fs_path)
}

export async function prompt_install_sdk_picker(
	context: vscode.ExtensionContext
): Promise<string | void> {
	const quick_pick = vscode.window.createQuickPick<DownloadSdkQuickPickItem>()
	quick_pick.title = "Install Ren'Py SDK"
	quick_pick.placeholder = 'Loading remote SDK versions...'
	quick_pick.busy = true

	quick_pick.show()

	// Load remote SDKs in the background
	const remote_sdks = await list_remote_sdks()

	if (remote_sdks.length === 0) {
		vscode.window.showErrorMessage(
			'No remote SDKs found. Please check your internet connection.'
		)
		return
	}

	const recommended_sdks = [remote_sdks[0]]
	const downloaded = (await list_downloaded_sdks(context)).map((sdk) =>
		basename(sdk)
	)

	quick_pick.items = [
		{
			label: 'Recommended for new projects',
			kind: vscode.QuickPickItemKind.Separator,
		},
		...recommended_sdks.map((sdk) => ({
			label: sdk.name,
			description: sdk.url.hostname + sdk.url.pathname,
			url: sdk.url,
			iconPath: downloaded.includes(sdk.name)
				? new vscode.ThemeIcon('check')
				: new vscode.ThemeIcon('blank'),
		})),
		{
			label: 'All versions',
			kind: vscode.QuickPickItemKind.Separator,
		},
		...remote_sdks
			.filter((sdk) => !recommended_sdks.includes(sdk))
			.map((sdk) => ({
				label: sdk.name,
				description: sdk.url.hostname + sdk.url.pathname,
				url: sdk.url,
				iconPath: downloaded.includes(sdk.name)
					? new vscode.ThemeIcon('check')
					: new vscode.ThemeIcon('blank'),
			})),
	]
	quick_pick.placeholder = 'Select an SDK version to install'
	quick_pick.busy = false

	return new Promise<string | void>((resolve, reject) => {
		quick_pick.onDidAccept(async () => {
			try {
				const selection = quick_pick.selectedItems[0]
				quick_pick.hide()

				if (!selection || !selection.url) {
					resolve(undefined)
					return
				}

				const sdk_url = await find_sdk_in_directory(selection.url)
				const file = await download_sdk(
					sdk_url,
					selection.label,
					context
				)

				if (!file) return resolve(undefined)

				await set_config('sdkPath', file.fsPath, true)

				vscode.window.showInformationMessage(
					`Ren'Py ${selection.label} installed and set as current SDK`
				)

				return prompt_sdk_quick_pick(context)
			} catch (error) {
				logger.error('Error during SDK installation:', error)
				vscode.window.showErrorMessage(
					`Failed to install SDK: ${
						error instanceof Error ? error.message : 'Unknown error'
					}`
				)
				reject(error)
			}
		})

		quick_pick.onDidHide(() => {
			resolve(undefined)
		})
	})
}
