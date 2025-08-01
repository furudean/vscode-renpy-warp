import { homedir } from 'node:os'
import { get_config } from './config'
import { path_exists, resolve_path } from './path'
import * as vscode from 'vscode'
import path, { basename, dirname } from 'upath'
import untildify from 'untildify'
import tildify from 'tildify'
import { get_executable, get_version } from './sh'
import { get_logger } from './log'
import {
	download_sdk,
	find_sdk_in_directory,
	list_downloaded_sdks,
	list_remote_sdks,
	semver_compare,
} from './download'
import p_map from 'p-map'

export const logger = get_logger()

const PathAction = Symbol('PathAction')
const FilePickerAction = Symbol('SystemFilePickerAction')
const InstallSdkAction = Symbol('InstallSdkAction')

interface SdkQuickPickItem extends vscode.QuickPickItem {
	action?:
		| typeof PathAction
		| typeof FilePickerAction
		| typeof InstallSdkAction
	path?: string
}

interface DownloadSdkQuickPickItem extends vscode.QuickPickItem {
	url: URL
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

function create_quick_pick_item(sdk_path: string): SdkQuickPickItem {
	return {
		label: basename(sdk_path),
		// description: tildify(sdk_path),
		iconPath: new vscode.ThemeIcon('cloud-download'),
		action: PathAction,
		path: sdk_path,
		buttons: [
			{
				iconPath: new vscode.ThemeIcon('trash'),
				tooltip: 'Uninstall SDK',
			},
		],
	}
}

export async function prompt_sdk_quick_pick(
	context: vscode.ExtensionContext
): Promise<string | void> {
	const current_sdk_path = get_config('sdkPath') as string | undefined
	const downloaded_sdks = await list_downloaded_sdks(context)

	const options: SdkQuickPickItem[] = [
		...downloaded_sdks
			.sort((a, b) => semver_compare(basename(a), basename(b)))
			.map(create_quick_pick_item),
		{
			label: '',
			kind: vscode.QuickPickItemKind.Separator,
		},
		{
			label: '$(plus) Download new SDK...',
			action: InstallSdkAction,
		},
		{
			label: '$(file-directory) Enter SDK path...',
			action: FilePickerAction,
		},
	]

	const selection = await vscode.window.showQuickPick(options, {
		title: "Select Ren'Py SDK",
		placeHolder: `Selected SDK: ${
			current_sdk_path ? tildify(current_sdk_path) : 'None'
		}`,
		matchOnDescription: true,
	})

	if (!selection) return

	switch (selection.action) {
		case InstallSdkAction:
			return await prompt_install_sdk_picker(context)

		case FilePickerAction:
			return await prompt_sdk_file_picker()

		case PathAction:
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
async function prompt_install_sdk_picker(
	context: vscode.ExtensionContext
): Promise<string | void> {
	const quick_pick = vscode.window.createQuickPick<DownloadSdkQuickPickItem>()
	quick_pick.title = "Install Ren'Py SDK"
	quick_pick.placeholder = 'Loading available SDK versions...'
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

	const mapped_sdks = remote_sdks.map((sdk, n) => ({
		label: sdk.name,
		description: sdk.url,
		url: sdk.url,
		detail: n === 0 ? 'Newest version' : undefined,
		iconPath: n === 0 ? new vscode.ThemeIcon('star') : undefined,
	}))

	const quick_pick_items: DownloadSdkQuickPickItem[] = [
		mapped_sdks[0],
		{
			label: '',
			kind: vscode.QuickPickItemKind.Separator,
		},
		...mapped_sdks.slice(1),
	]

	quick_pick.items = quick_pick_items
	quick_pick.placeholder = 'Select an SDK version to install'
	quick_pick.busy = false

	return new Promise<string | void>((resolve, reject) => {
		quick_pick.onDidAccept(async () => {
			try {
				const selection = quick_pick.selectedItems[0]
				quick_pick.hide()

				if (!selection) {
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
