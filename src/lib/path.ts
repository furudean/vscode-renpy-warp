import * as vscode from "vscode"
import path from "upath"
import untildify from "untildify"
import fs from "node:fs/promises"
import { get_logger } from "./log"
import { get_user_ignore_pattern } from "./config"
import env_paths from "env-paths"
import { name as pkg_name } from "../../package.json"
import sortPaths from "sort-paths"

const logger = get_logger()

export const paths = env_paths(pkg_name, { suffix: "" })

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

export async function mkdir_exist_ok(file_path: string): Promise<void> {
	try {
		await fs.mkdir(file_path)
	} catch (e) {
		if (
			typeof e === "object" &&
			e !== null &&
			"code" in e &&
			e.code !== "EEXIST"
		) {
			throw e
		}
	}
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
		const pattern = new vscode.RelativePattern(workspace, "**/game/**/*.rpy")
		const files = await vscode.workspace.findFiles(
			pattern,
			await get_user_ignore_pattern()
		)
		const dirs = new Set(files.map((file) => path.dirname(file.fsPath)))
		logger.trace(`dirs in workspace: ${[...dirs.values()]}`)

		const games = new Set<string>()

		for (const dir of dirs) {
			const relative = path.relative(workspace.uri.fsPath, dir)
			const parts = relative.split(path.sep)

			for (const [i, part] of Array.from(parts.entries()).reverse()) {
				if (part === "game") {
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
	context: vscode.ExtensionContext,
	silent = false
): Promise<string | undefined> {
	const workspaces = await find_projects_in_workspaces(true)

	if (workspaces.size === 0) {
		if (!silent)
			vscode.window.showErrorMessage(
				"No Ren'Py project in workspace. Workspace must contain a directory 'game' with .rpy files",
				"OK"
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
				kind: vscode.QuickPickItemKind.Separator
			},
			...games.map((game) => ({
				label: "$(folder) " + path.basename(game),
				description:
					path.basename(game) === path.relative(workspace, game)
						? undefined
						: path.relative(workspace, path.resolve(game, "..")),
				value: game
			}))
		)
	}

	const selection = await vscode.window.showQuickPick(options, {
		title: "Which project should be started?",
		placeHolder: "Select a project",
		matchOnDescription: true
	})

	return selection?.value
}
