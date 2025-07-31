import { homedir } from 'node:os'
import { get_config } from './config'
import { path_is_sdk, resolve_path } from './path'
import * as vscode from 'vscode'
import { glob } from 'glob'
import path from 'upath'
import untildify from 'untildify'
import tildify from 'tildify'

const PathAction = Symbol('PathAction')
const FilePickerAction = Symbol('SystemFilePickerAction')

interface SdkQuickPickItem extends vscode.QuickPickItem {
	action?: typeof PathAction | typeof FilePickerAction
	path?: string
}

export async function find_user_sdks(): Promise<Record<string, string[]>> {
	const sdks_dirs = get_config('sdksDirectories') as string[]

	const groups: Record<string, string[]> = {}

	for (const dir of sdks_dirs) {
		const found = (
			await glob(`${untildify(dir)}/*/renpy.py`, { absolute: true })
		).map(path.dirname)

		groups[dir] = found
	}

	return groups
}

function get_recent_sdks(context: vscode.ExtensionContext): string[] {
	return context.globalState.get('recentSdks') ?? []
}

async function update_recent_sdks(
	sdk_path: string,
	context: vscode.ExtensionContext
): Promise<void> {
	const recent_sdks = get_recent_sdks(context).filter(
		(path) => path !== sdk_path
	)
	const updated_sdks = [sdk_path, ...recent_sdks].slice(0, 5)
	context.globalState.update('recentSdks', updated_sdks)
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
		fs_path: sdk_path,
	}
}

export async function prompt_sdk_quick_pick(
	context: vscode.ExtensionContext
): Promise<string | void> {
	const current_sdk_path = get_config('sdkPath') as string | undefined

	const sdks = await find_user_sdks()

	function not_current_filter(item: SdkQuickPickItem): boolean {
		return item?.path !== current_sdk_path
	}

	const options: SdkQuickPickItem[] = []

	if (current_sdk_path) {
		options.push(
			// {
			// 	label: 'current',
			// 	kind: vscode.QuickPickItemKind.Separator,
			// },
			// {
			// 	label: current_sdk_path,
			// 	iconPath: new vscode.ThemeIcon('star'),
			// 	action: PathAction,
			// 	fs_path: current_sdk_path,
			// },
			{
				label: '',
				kind: vscode.QuickPickItemKind.Separator,
			},
			{
				label: '$(file-directory) Enter interpreter path...',
				action: FilePickerAction,
			}
		)
	}

	const recent_sdks = get_recent_sdks(context)
	if (recent_sdks && recent_sdks.length > 0) {
		for (const path of recent_sdks) {
			const executable = await get_executable(path)

			if (!executable) continue

			const item = await create_quick_pick_item(path)

			if (!item && not_current_filter(item)) {
				options.push(item)
			}
		}
	}

	for (const [dir, paths] of Object.entries(sdks)) {
		// options.push({
		// 	label: `in ${dir}`,
		// 	kind: vscode.QuickPickItemKind.Separator,
		// })

		for (const p of paths) {
			const item = await create_quick_pick_item(p)

			if (item !== undefined && not_current_filter(item)) {
				options.push(item)
			}
		}
	}

	const selection = await vscode.window.showQuickPick(options, {
		title: "Select Ren'Py SDK",
		placeHolder: `Selected SDK: ${tildify(current_sdk_path)}`,
		matchOnDescription: true,
	})

	if (!selection) return

	if (selection.action === FilePickerAction) {
		return await prompt_sdk_file_picker()
	}
	if (selection.action === PathAction) {
		if (selection.path) {
			if (await path_is_sdk(selection.path)) {
				await update_recent_sdks(selection.path, context)
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
