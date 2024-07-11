import * as vscode from 'vscode'

import path from 'upath'
import { get_renpy_sh, get_version } from './sh'
import { version as pkg_version } from '../../package.json'
import semver from 'semver'
import { get_logger } from './logger'
import fs from 'node:fs/promises'
import AdmZip from 'adm-zip'
import { glob } from 'glob'
import { get_sdk_path } from './path'

const logger = get_logger()

export async function list_rpes(): Promise<string[]> {
	const [rpe, rpe_in_sdk] = await Promise.all([
		vscode.workspace
			.findFiles(`**/game/**/renpy_warp_*.rpe`)
			.then((files) => files.map((f) => f.fsPath)),
		glob('renpy_warp_*.rpe.py', {
			cwd: await get_sdk_path(),
			absolute: true,
		}),
	])

	return [...rpe, ...rpe_in_sdk]
}

export async function install_rpe({
	renpy_sh,
	game_root,
	context,
}: {
	renpy_sh: string
	game_root: string
	context: vscode.ExtensionContext
}): Promise<string> {
	const version = get_version(renpy_sh)
	const supports_rpe_py = semver.gte(version.semver, '8.3.0')
	const sdk_path = await get_sdk_path()

	await uninstall_rpes()

	const rpe_source_path = path.join(
		context.extensionPath,
		'dist/',
		'renpy_warp.rpe.py'
	)
	const rpe_source_code = await fs.readFile(rpe_source_path)
	let file_path: string

	if (supports_rpe_py) {
		file_path = path.join(sdk_path, `renpy_warp_${pkg_version}.rpe.py`)
		await fs.writeFile(file_path, rpe_source_code)
	} else {
		file_path = path.join(
			game_root,
			'game/',
			`renpy_warp_${pkg_version}.rpe`
		)
		const zip = new AdmZip()
		zip.addFile('autorun.py', rpe_source_code)
		await fs.writeFile(file_path, zip.toBuffer())
	}

	logger.info('wrote rpe to', file_path)

	return file_path
}

export async function uninstall_rpes(): Promise<void> {
	const rpes = await list_rpes()

	await Promise.all(rpes.map((rpe) => fs.unlink(rpe)))
	logger.info('uninstalled rpes:', rpes)
}

export async function has_any_rpe(): Promise<boolean> {
	return (await list_rpes()).length > 0
}

export async function has_current_rpe(renpy_sh: string): Promise<boolean> {
	const files = await list_rpes()
	logger.debug('check rpe:', files)

	const renpy_version = get_version(renpy_sh)
	const supports_rpe_py = semver.gte(renpy_version.semver, '8.3.0')

	for (const file of files) {
		const basename = path.basename(file)

		// find mismatched feature support
		if (!supports_rpe_py && basename.endsWith('.rpe.py')) return false
		if (supports_rpe_py && basename.endsWith('.rpe')) return false

		const file_version = basename.match(
			/renpy_warp_(?<version>.+)\.rpe(?:\.py)?/
		)?.groups?.version

		if (file_version === pkg_version) {
			return true
		}
	}

	return false
}
