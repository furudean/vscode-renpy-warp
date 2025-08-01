import { homedir } from 'node:os'
import { get_config } from './config'
import { path_exists, resolve_path } from './path'
import * as vscode from 'vscode'
import path from 'upath'
import untildify from 'untildify'
import tildify from 'tildify'
import { get_executable, get_version } from './sh'
import { get_logger } from './log'

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

async function create_quick_pick_item(
	sdk_path: string
): Promise<SdkQuickPickItem | undefined> {
	const executable = await get_executable(untildify(sdk_path))
	if (!executable) return undefined

	return {
		label: get_version(executable)?.semver,
		description: tildify(sdk_path),
		// iconPath: new vscode.ThemeIcon('history'),
		action: PathAction,
		path: sdk_path,
	}
}

export async function prompt_sdk_quick_pick(
	context: vscode.ExtensionContext
): Promise<string | void> {
	const current_sdk_path = get_config('sdkPath') as string | undefined

	function not_current_filter(item: SdkQuickPickItem): boolean {
		return item?.path !== current_sdk_path
	}

	const options: SdkQuickPickItem[] = [
		{
			label: '$(plus) Install new SDK...',
			action: InstallSdkAction,
		},
		// {
		// 	label: '',
		// 	kind: vscode.QuickPickItemKind.Separator,
		// },
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

	if (selection.action === FilePickerAction) {
		return await prompt_sdk_file_picker()
	}
	if (selection.action === PathAction) {
		if (selection.path) {
			if (await path_is_sdk(selection.path)) {
				return selection.path
			}
		}
		vscode.window.showErrorMessage(
			`Path "${selection.path}" is not a valid Ren'Py SDK`
		)
		return
	}

	throw new Error('Unexpected selection state')
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
