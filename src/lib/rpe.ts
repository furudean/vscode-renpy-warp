import * as vscode from 'vscode'

import path from 'upath'
import { get_version } from './sh'
import { version as pkg_version } from '../../package.json'
import semver from 'semver'
import { get_logger } from './logger'
import fs from 'node:fs/promises'
import AdmZip from 'adm-zip'
import { glob } from 'glob'
import { createHash } from 'node:crypto'

const RPE_FILE_PATTERN =
	/renpy_warp_(?<version>\d+\.\d+\.\d+)(?:_(?<checksum>[a-z0-9]+))?\.rpe(?:\.py)?/
const logger = get_logger()

function get_checksum(data: Buffer): string {
	const hash = createHash('md5').update(data)

	return hash.digest('hex').slice(0, 8) // yeah, i know
}

async function get_rpe_source(
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
	executable: string
	project_root: string
	context: vscode.ExtensionContext
}): Promise<string> {
	const version = get_version(executable)
	const supports_rpe_py = semver.gte(version.semver, '8.3.0')

	await uninstall_rpes(sdk_path)

	const rpe_source = await get_rpe_source(context)
	const file_base = `renpy_warp_${pkg_version}_${get_checksum(rpe_source)}`

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
	executable: string
	sdk_path: string
	context: vscode.ExtensionContext
}): Promise<boolean> {
	const files = await list_rpes(sdk_path)
	logger.debug('check rpe:', files)

	const rpe_source = await get_rpe_source(context)
	const checksum = get_checksum(rpe_source)

	const renpy_version = get_version(executable)
	logger.debug('renpy version (semver):', renpy_version.semver)

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
			return true
		}
	}

	return false
}
