import * as vscode from 'vscode'

import path from 'upath'
import { find_project_root, get_executable, get_version } from './sh'
import { version as pkg_version } from '../../package.json'
import semver from 'semver'
import { get_logger } from './logger'
import fs from 'node:fs/promises'
import AdmZip from 'adm-zip'
import { glob } from 'glob'
import { createHash } from 'node:crypto'
import { get_sdk_path } from './path'
import { show_file } from './config'
import { prompt_not_rpy8_invalid_configuration } from './onboard'

const RPE_FILE_PATTERN =
	/renpy_warp_(?<version>\d+\.\d+\.\d+)(?:_(?<checksum>[a-z0-9]+))?\.rpe(?:\.py)?/
const logger = get_logger()

export function get_checksum(data: Buffer): string {
	const hash = createHash('md5').update(data)

	return hash.digest('hex').slice(0, 8) // yeah, i know
}

export async function get_rpe_source(
	context: vscode.ExtensionContext
): Promise<Buffer> {
	const rpe_source_path = path.join(
		context.extensionPath,
		'dist/',
		'renpy_warp.rpe.py'
	)
	return await fs.readFile(rpe_source_path)
}

export async function list_rpes(sdk_path: string): Promise<string[]> {
	return await Promise.all([
		vscode.workspace
			.findFiles(`**/game/renpy_warp_*.{rpe,rpe.py}`)
			.then((files) => files.map((f) => f.fsPath)),
		glob('renpy_warp_*.rpe.py', {
			cwd: sdk_path,
			absolute: true,
		}),
	]).then((result) => result.flat())
}

export async function install_rpe({
	sdk_path,
	executable,
	project_root,
	context,
}: {
	sdk_path: string
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

	await uninstall_rpes(sdk_path)

	const rpe_source = await get_rpe_source(context)
	const file_base = `renpy_warp_${pkg_version}_${get_checksum(rpe_source)}`

	const supports_rpe_py = semver.gte(version.semver, '8.3.0')
	let file_path: string

	if (supports_rpe_py) {
		file_path = path.join(project_root, 'game/', `${file_base}.rpe.py`)
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

export async function uninstall_rpes(sdk_path: string): Promise<void> {
	const rpes = await list_rpes(sdk_path)

	await Promise.all(rpes.map((rpe) => fs.unlink(rpe)))
	logger.info('uninstalled rpes:', rpes)
}

export async function has_current_rpe({
	executable,
	sdk_path,
	context,
}: {
	executable: string[]
	sdk_path: string
	context: vscode.ExtensionContext
}): Promise<string | false> {
	const files = await list_rpes(sdk_path)
	logger.debug('check rpe:', files)

	const rpe_source = await get_rpe_source(context)
	const checksum = get_checksum(rpe_source)

	const renpy_version = get_version(executable)
	logger.debug('renpy version (semver):', renpy_version.semver)

	if (semver.satisfies(renpy_version.semver, '<8')) return false

	const supports_rpe_py = semver.gte(renpy_version.semver, '8.3.0')
	logger.debug('supports rpe.py:', supports_rpe_py)

	for (const file of files) {
		const basename = path.basename(file)
		logger.debug('basename:', basename)

		// find mismatched feature support
		if (!supports_rpe_py && basename.endsWith('.rpe.py')) return false
		if (supports_rpe_py && basename.endsWith('.rpe')) return false

		const match = basename.match(RPE_FILE_PATTERN)?.groups
		logger.debug('match:', match)

		if (match?.checksum === checksum) {
			logger.debug('has current rpe')
			return file
		}
	}

	return false
}

export async function prompt_install_rpe(
	context: vscode.ExtensionContext,
	message = "Ren'Py extensions were {installed/updated} at {installed_path}",
	force = false,
	silent_error = false
): Promise<string | undefined> {
	const file_path = await vscode.workspace
		.findFiles('**/game/**/*.rpy', null, 1)
		.then((files) => (files.length ? files[0].fsPath : null))

	if (!file_path) {
		if (!silent_error) {
			vscode.window.showErrorMessage(
				"Install RPE error: No Ren'Py project in workspace",
				'OK'
			)
		}
		return
	}

	const project_root = find_project_root(file_path)

	if (!project_root) {
		vscode.window.showErrorMessage(
			'Unable to find "game" folder in parent directory. Not a Ren\'Py project?',
			'OK'
		)
		return
	}

	const sdk_path = await get_sdk_path()
	if (!sdk_path) return

	const executable = await get_executable(sdk_path, true)
	if (!executable) return

	const current_rpe = await has_current_rpe({
		executable,
		sdk_path,
		context,
	})

	if (current_rpe && !force) {
		logger.info('rpe already up to date')
		return current_rpe
	}

	const version = get_version(executable)

	if (!semver.satisfies(version.semver, '>=8')) {
		await prompt_not_rpy8_invalid_configuration(version.semver)
		return
	}

	const installed_path = await install_rpe({
		sdk_path,
		project_root,
		context,
		executable,
	})
	if (!installed_path) return

	const any_rpe = (await list_rpes(sdk_path)).length === 0

	const fmt_message = message
		.replaceAll('{installed/updated}', any_rpe ? 'installed' : 'updated')
		.replaceAll(
			'{installed_path}',
			path.relative(
				vscode.workspace.workspaceFolders?.[0].uri.fsPath ??
					project_root,
				installed_path
			)
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
