import * as vscode from 'vscode'

import path from 'upath'
import { get_renpy_sh, get_version } from './sh'
import { version as pkg_version } from '../../package.json'
import semver from 'semver'
import { get_logger } from './logger'
import fs from 'node:fs/promises'
import AdmZip from 'adm-zip'

const logger = get_logger()

export async function install_rpe({
	game_root,
	context,
}: {
	game_root: string
	context: vscode.ExtensionContext
}): Promise<string> {
	const renpy_sh = await get_renpy_sh()

	if (!renpy_sh)
		throw new Error('failed to get renpy.sh while installing rpe')

	const version = get_version(renpy_sh)
	const supports_rpe_py = semver.gte(version.semver, '8.3.0')

	const files = await vscode.workspace
		.findFiles('**/renpy_warp_*.rpe*')
		.then((files) => files.map((f) => f.fsPath))

	for (const file of files) {
		await fs.unlink(file)
		logger.info('deleted old rpe at', file)
	}

	const rpe_source_path = path.join(
		context.extensionPath,
		'dist/',
		'renpy_warp.rpe.py'
	)

	const rpe_source_code = await fs.readFile(rpe_source_path)
	let file_path: string

	if (supports_rpe_py) {
		file_path = path.join(
			game_root,
			'game/', // TODO: https://github.com/renpy/renpy/issues/5614
			`renpy_warp_${pkg_version}.rpe.py`
		)
		await fs.writeFile(file_path, rpe_source_code)
		logger.info('wrote rpe to', file_path)
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

export async function has_any_rpe(): Promise<boolean> {
	return vscode.workspace
		.findFiles('**/renpy_warp_*.rpe*', undefined, 1)
		.then((files) => files.length > 0)
}

export async function has_current_rpe(renpy_sh: string): Promise<boolean> {
	const files = await vscode.workspace
		.findFiles('**/renpy_warp_*.rpe*')
		.then((files) => files.map((f) => f.fsPath))

	const renpy_version = get_version(renpy_sh)
	const supports_rpe_py = semver.gte(renpy_version.semver, '8.3.0')

	for (const file of files) {
		const basename = path.basename(file)

		// find mismatched feature support
		if (!supports_rpe_py && basename.endsWith('.rpe.py')) return false
		if (supports_rpe_py && basename.endsWith('.rpe')) return false

		const version = basename.match(
			/renpy_warp_(?<version>.+)\.rpe(?:\.py)?/
		)?.groups?.version

		if (version === pkg_version) {
			return true
		}
	}

	return false
}
