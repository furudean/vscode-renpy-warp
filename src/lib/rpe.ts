import * as vscode from 'vscode'

import path from 'upath'
import { get_executable, get_version } from './sh'
import { version as pkg_version } from '../../package.json'
import semver from 'semver'
import { get_logger } from './log'
import fs from 'node:fs/promises'
import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { find_projects_in_workspaces, mkdir_exist_ok } from './path'
import { get_user_ignore_pattern, show_file } from './config'
import { prompt_not_rpy8_invalid_configuration } from './onboard'
import memoize from 'memoize'
import { get_sdk_path } from './sdk'

const RPE_FILE_PATTERN =
	/renpy_warp_(?<version>\d+\.\d+\.\d+)(?:_(?<checksum>[a-z0-9]+))?\.rpe(?:\.py)?/
const logger = get_logger()

async function _get_rpe_source(extensionPath: string): Promise<Buffer> {
	const rpe_source_path = path.join(
		extensionPath,
		'dist/',
		'renpy_warp.rpe.py'
	)
	return await fs.readFile(rpe_source_path)
}
export const get_rpe_source = memoize(_get_rpe_source)

function get_checksum(data: Buffer): string {
	const hash = createHash('md5').update(data)

	return hash.digest('hex').slice(0, 8) // yeah, i know
}

async function _get_rpe_checksum(extensionPath: string): Promise<string> {
	return get_rpe_source(extensionPath).then(get_checksum)
}
export const get_rpe_checksum = memoize(_get_rpe_checksum)

export async function list_rpes(
	project_root: string | vscode.Uri
): Promise<string[]> {
	const pattern = new vscode.RelativePattern(
		project_root,
		'**/game/**/renpy_warp_*.{rpe,rpe.py}'
	)
	const files = await vscode.workspace
		.findFiles(pattern, await get_user_ignore_pattern())
		.then((files) => files.map((f) => f.fsPath))

	return files
}

export async function install_rpe({
	executable,
	project_root,
	context,
}: {
	executable: string[]
	project_root: string
	context: vscode.ExtensionContext
}): Promise<string | undefined> {
	const version = get_version(executable)

	if (!semver.satisfies(version.semver, '>=8')) {
		logger.error(
			`Ren'Py version must be 8.0.0 or newer to use extensions (is ${version.semver})`
		)
		return undefined
	}

	await uninstall_rpes(project_root)

	const rpe_source = await get_rpe_source(context.extensionPath)
	const file_base = `renpy_warp_${pkg_version}_${get_checksum(rpe_source)}`

	const supports_rpe_py = semver.gte(version.semver, '8.3.0')
	let file_path: string

	if (supports_rpe_py) {
		file_path = path.join(project_root, 'game/')

		if (semver.gte(version.semver, '8.4.0')) {
			file_path = path.join(file_path, 'libs/')
			await mkdir_exist_ok(file_path)
		}

		file_path = path.join(file_path, `${file_base}.rpe.py`)

		await fs.writeFile(file_path, rpe_source)
	} else {
		file_path = path.join(project_root, 'game/', `${file_base}.rpe`)
		const zip = new AdmZip()
		zip.addFile('autorun.py', rpe_source)
		await fs.writeFile(file_path, zip.toBuffer())
	}

	logger.info('wrote rpe to', file_path)

	return file_path
}

export async function update_existing_rpes(context: vscode.ExtensionContext) {
	const projects = await find_projects_in_workspaces()

	if (!projects) return

	const sdk_path = await get_sdk_path(false)
	if (!sdk_path) return

	const executable = await get_executable(sdk_path)
	if (!executable) return

	for (const project of projects) {
		const any_rpe = (await list_rpes(project)).length > 0

		if (!any_rpe) {
			logger.info('no rpe found in', project)
			continue
		}

		const current_rpe = await has_current_rpe({
			executable,
			sdk_path,
			context,
			project_root: project,
		})

		if (!current_rpe) {
			logger.info('updating existing rpe in', project)
			await prompt_install_rpe({
				executable,
				project: project,
				context,
			})
		} else {
			logger.info(`rpe in ${project} is up to date`)
		}
	}
}

export async function uninstall_rpes(
	project_root: string | vscode.Uri
): Promise<void> {
	const rpes = await list_rpes(project_root)

	await Promise.all(rpes.map((rpe) => fs.unlink(rpe)))
	logger.info('uninstalled rpes:', rpes)
}

export async function has_current_rpe({
	executable,
	context,
	project_root,
}: {
	executable: string[]
	sdk_path: string
	context: vscode.ExtensionContext
	project_root: string
}): Promise<string | false> {
	const files = await list_rpes(project_root)
	logger.debug('check rpe:', files)

	const rpe_source = await get_rpe_source(context.extensionPath)
	const checksum = get_checksum(rpe_source)

	const renpy_version = get_version(executable)
	logger.debug('renpy version (semver):', renpy_version.semver)

	if (semver.satisfies(renpy_version.semver, '<8.2.0')) return false

	const supports_rpe_py = semver.gte(renpy_version.semver, '8.3.0')
	const supports_libs = semver.gte(renpy_version.semver, '8.4.0')
	logger.debug('supports rpe.py:', supports_rpe_py)
	logger.debug('supports libs:', supports_libs)

	for (const file of files) {
		if (!file.includes(project_root)) continue
		const basename = path.basename(file)
		const dirname = path.dirname(file)
		logger.debug('basename:', basename)

		// find mismatched feature support
		if (!supports_rpe_py && basename.endsWith('.rpe.py')) return false
		if (supports_rpe_py && basename.endsWith('.rpe')) return false
		if (!supports_libs && dirname.endsWith('libs')) return false
		if (supports_libs && !dirname.endsWith('libs')) return false

		const match = basename.match(RPE_FILE_PATTERN)?.groups
		logger.debug('match:', match)

		if (match?.checksum === checksum) {
			logger.debug('has current rpe')
			return file
		}
	}

	return false
}

export async function prompt_install_rpe({
	project,
	executable,
	context,
	message = "Ren'Py extensions were {installed/updated} in {installed_path}",
	force = false,
}: {
	project: string
	executable: string[]
	context: vscode.ExtensionContext
	message?: string
	force?: boolean
}): Promise<string | undefined> {
	const version = get_version(executable)

	if (!semver.satisfies(version.semver, '>=8.2.0')) {
		await prompt_not_rpy8_invalid_configuration(version.semver)
		return
	}

	const any_rpe = (await list_rpes(project)).length > 0

	const installed_path = await install_rpe({
		project_root: project,
		context,
		executable,
	})
	if (!installed_path) return

	const relative_root =
		vscode.workspace.getWorkspaceFolder(vscode.Uri.file(installed_path))
			?.uri.fsPath ?? project

	const fmt_message = message
		.replaceAll('{installed/updated}', any_rpe ? 'updated' : 'installed')
		.replaceAll(
			'{installed_path}',
			path.dirname(path.relative(relative_root, installed_path))
		)

	if (!context.globalState.get('hideRpeInstallUpdateMessage') || force) {
		const options = ['OK']

		if (installed_path.endsWith('.rpe.py')) {
			// since .rpe binaries are not human readable, vscode doesn't have
			// a built-in way to view them. so we only offer this option for
			// .rpe.py files.
			options.push('Reveal')
		}

		if (!force) {
			options.push("Don't show again")
		}

		vscode.window
			.showInformationMessage(fmt_message, ...options)
			.then(async (selection) => {
				if (selection === 'Reveal') {
					await show_file(installed_path)
				}
				if (selection === "Don't show again") {
					await context.globalState.update(
						'hideRpeInstallUpdateMessage',
						true
					)
				}
			})
	}

	return installed_path
}
