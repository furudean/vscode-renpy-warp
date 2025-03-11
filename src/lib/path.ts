import * as vscode from 'vscode'
import path from 'upath'
import untildify from 'untildify'
import fs from 'node:fs/promises'
import { get_logger } from './log'
import { get_config } from './config'
import env_paths from 'env-paths'
import { name as pkg_name } from '../../package.json'
import sortPaths from 'sort-paths'

const logger = get_logger()

export const paths = env_paths(pkg_name, { suffix: '' })

/**
 * @param {string} str
 * @returns {string}
 */
export function resolve_path(str: string): string {
	return path.resolve(untildify(str))
}

export async function path_exists(path: string): Promise<boolean> {
	try {
		await fs.access(path, fs.constants.F_OK)
		return true
	} catch {
		return false
	}
}

export async function path_is_sdk(absolute_path: string): Promise<boolean> {
	return await path_exists(path.join(absolute_path, 'renpy.py'))
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

export async function find_projects_in_workspaces(): Promise<string[]>
export async function find_projects_in_workspaces(
	groups: boolean
): Promise<Map<string, string[]>>
export async function find_projects_in_workspaces(
	groups = false
): Promise<string[] | Map<string, string[]>> {
	const workspace_games = new Map<string, string[]>()

	for (const workspace of vscode.workspace.workspaceFolders ?? []) {
		const pattern = new vscode.RelativePattern(
			workspace,
			'**/game/**/*.rpy'
		)
		const files = await vscode.workspace.findFiles(pattern)
		logger.trace(`files in workspace: ${files.map((file) => file.fsPath)}`)

		const games = new Set<string>()

		for (const file of files) {
			const relative = path.relative(workspace.uri.fsPath, file.fsPath)
			const parts = relative.split(path.sep)

			for (const [i, part] of Array.from(parts.entries()).reverse()) {
				if (part === 'game') {
					const full_path = path.join(
						workspace.uri.fsPath,
						...parts.slice(0, i)
					)
					games.add(full_path)
				}
			}
		}

		if (games.size > 0) {
			workspace_games.set(
				workspace.uri.fsPath,
				sortPaths(Array.from(games), path.sep)
			)
		}
	}

	if (groups) {
		return workspace_games
	} else {
		return Array.from(workspace_games.values()).flat()
	}
}

interface WorkspaceQuickPick extends vscode.QuickPickItem {
	value?: string
}

export async function prompt_projects_in_workspaces(
	silent = false
): Promise<string | undefined> {
	const workspaces = await find_projects_in_workspaces(true)

	if (workspaces.size === 0) {
		if (!silent)
			vscode.window.showErrorMessage(
				"No Ren'Py project in workspace. Workspace must contain a directory 'game' with .rpy files",
				'OK'
			)
		return
	}

	// short circuit if there is only one project
	if (Array.from(workspaces.values()).flat().length === 1) {
		return Array.from(workspaces.values()).flat()[0]
	}

	const options: WorkspaceQuickPick[] = []

	for (const [workspace, games] of workspaces.entries()) {
		options.push(
			{
				label: workspace,
				kind: vscode.QuickPickItemKind.Separator,
			},
			...games.map((game) => ({
				label: '$(folder) ' + path.basename(game),
				description:
					path.basename(game) === path.relative(workspace, game)
						? undefined
						: path.relative(workspace, path.resolve(game, '..')),
				value: game,
			}))
		)
	}

	const selection = await vscode.window.showQuickPick(options, {
		title: 'Which project should be started?',
		placeHolder: 'Select a project',
		matchOnDescription: true,
	})

	return selection?.value
}
