import { homedir } from 'node:os'
import { get_config } from './config'
import { path_is_sdk, resolve_path } from './path'
import * as vscode from 'vscode'
import { glob } from 'glob'
import path from 'upath'
import untildify from 'untildify'
import tildify from 'tildify'
import { get_executable, get_version } from './sh'

const PathAction = Symbol('PathAction')
const FilePickerAction = Symbol('SystemFilePickerAction')

interface SdkQuickPickItem extends vscode.QuickPickItem {
	action?: typeof PathAction | typeof FilePickerAction
	fs_path?: string
}

export async function find_user_sdks(): Promise<Record<string, string[]>> {
	const sdks_dirs = get_config('sdksDirectories') as string[]

	const groups: Record<string, string[]> = {}

	for (const dir of sdks_dirs) {
		const found = (
			await glob(`${untildify(dir)}/**/renpy.py`, { absolute: true })
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

export async function prompt_sdk_quick_pick(
	context: vscode.ExtensionContext
): Promise<string | void> {
	const current_sdk_path = get_config('sdkPath') as string | undefined

	const sdks = await find_user_sdks()

	function not_current_filter(item: SdkQuickPickItem): boolean {
		return item?.fs_path !== current_sdk_path
	}

	const options: SdkQuickPickItem[] = []

	if (current_sdk_path) {
		options.push(
			{
				label: 'current',
				kind: vscode.QuickPickItemKind.Separator,
			},
			{
				label: current_sdk_path,
				iconPath: new vscode.ThemeIcon('star'),
				action: PathAction,
				fs_path: current_sdk_path,
			}
		)
	}

	const recent_sdks = get_recent_sdks(context)
	if (recent_sdks && recent_sdks.length > 0) {
		for (const path of recent_sdks) {
			const item: SdkQuickPickItem = {
				label: tildify(path),
				iconPath: new vscode.ThemeIcon('history'),
				action: PathAction,
				fs_path: path,
			}

			if (not_current_filter(item)) {
				options.push(item)
			}
		}
	}

	for (const [dir, paths] of Object.entries(sdks)) {
		options.push({
			label: `in ${dir}`,
			kind: vscode.QuickPickItemKind.Separator,
		})

		for (const p of paths) {
			const item: SdkQuickPickItem = {
				label: path.relative(resolve_path(dir), p),
				iconPath: new vscode.ThemeIcon('file-directory'),
				action: PathAction,
				fs_path: p,
			}

			if (not_current_filter(item)) {
				options.push(item)
			}
		}
	}

	options.push(
		{
			label: '',
			kind: vscode.QuickPickItemKind.Separator,
		},
		{
			label: '$(search) Select with system dialog',
			action: FilePickerAction,
		}
	)

	const selection = await vscode.window.showQuickPick(options, {
		title: "Pick Ren'Py SDK",
		placeHolder: "Select a Ren'Py SDK",
		matchOnDescription: true,
	})

	if (!selection) return

	if (selection.action === FilePickerAction) {
		return await prompt_sdk_file_picker()
	}
	if (selection.action === PathAction) {
		if (selection.fs_path) {
			const resolved_path = resolve_path(selection.fs_path)
			if (await path_is_sdk(resolved_path)) {
				await update_recent_sdks(resolved_path, context)
				return selection.fs_path
			}
		}
		vscode.window.showErrorMessage(
			`Path "${selection.fs_path}" is not a valid Ren'Py SDK`
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
