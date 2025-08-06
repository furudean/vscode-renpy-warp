import { JSDOM } from 'jsdom'
import { getApi, FileDownloader } from '@microsoft/vscode-file-downloader-api'
import { ExtensionContext } from 'vscode'
import * as vscode from 'vscode'
import { parse as semver_parse } from 'semver'
import { get_logger } from './log'
import p_filter from 'p-filter'
import { path_is_sdk } from './sdk'
import { cp, mkdir, readdir, rm, rmdir } from 'node:fs/promises'
import path from 'upath'
import { basename } from 'node:path'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import extract from 'extract-zip'

const logger = get_logger()

export interface RemoteSdk {
	name: string
	url: URL
}

async function parse_nginx_directory(url: string | URL): Promise<URL[]> {
	const request = await fetch(url)
	const text = await request.text()

	const { document } = new JSDOM(text).window

	const anchors = Array.from(document.querySelectorAll('a').values())

	return anchors.map((a) => new URL(a.href, url)).slice(1) // first anchor is the parent directory link
}

function fix_broken_semver(name: string): string {
	// 4.0
	if (name.match(/^\d+\.\d+$/)) {
		return `${name}.0` // add patch version if missing
	}
	// 5.1.4a
	if (name.match(/^\d+\.\d+\.\d+[a-z]$/)) {
		return `${name.slice(0, -1)}--${name.slice(-1)}` // convert 5.1.4a to 5.1.4-a
	}
	// 6.99.14.1 6.99.14.2 etc
	if (name.match(/^\d+\.\d+\.\d+(\.\d+)?$/)) {
		return `${name.split('.').slice(0, 3).join('.')}--${name
			.split('.')
			.slice(3)
			.join('.')}` // 6.99.14--1
	}

	return name
}

export function semver_compare(a: string, b: string): number {
	const semver_a = semver_parse(fix_broken_semver(a))
	const semver_b = semver_parse(fix_broken_semver(b))

	if (semver_a && semver_b) {
		return semver_b.compare(semver_a) // both are valid semvers, compare them (reversed for descending order)
	} else if (semver_a) {
		return -1 // a is a valid semver, b is not
	}
	if (semver_b) {
		return 1 // b is a valid semver, a is not
	}

	return a.localeCompare(b) // neither are valid semvers, compare by name
}

function sort_remote_sdks(a: RemoteSdk, b: RemoteSdk): number {
	return semver_compare(a.name, b.name)
}

export async function list_remote_sdks(): Promise<RemoteSdk[]> {
	const urls = await parse_nginx_directory('https://renpy.org/dl/')
	return (
		urls
			.map((url) => ({
				name: decodeURIComponent(url.pathname.split('/')[2]),
				url: url,
			}))
			// .filter((sdk) => semver_parse(sdk.name))
			.sort(sort_remote_sdks)
	)
}

export async function find_sdk_in_directory(
	directory: string | URL
): Promise<URL> {
	const dir = await parse_nginx_directory(directory)

	const sdk = dir.find((url) => url.pathname.endsWith('-sdk.zip'))

	if (!sdk) {
		throw new Error(
			`No SDK found in directory ${directory}. Please check the URL or directory path.`
		)
	}

	return sdk
}

export async function get_sum_for_sdk(url: URL): Promise<string | undefined> {
	const sums_url = new URL('./checksums.txt', url.href)

	const head = await fetch(sums_url, { method: 'HEAD' })

	if (head.status === 404) return undefined

	if (!head.ok) {
		throw new Error(
			`failed to fetch sums.txt from ${sums_url}: ${
				head.status
			} ${await head.text()}`
		)
	}

	const response = await fetch(sums_url)
	const file_text = await response.text()

	const md5_section = file_text.split('# md5')[1]?.split('# sha1')[0]
	if (!md5_section) throw new Error(`no md5 section found in ${sums_url}`)

	const checksum_pattern = /^([a-fA-F0-9]+)\s+renpy-[\d.]+-sdk\.zip$/m
	const match = md5_section.match(checksum_pattern)
	if (!match)
		throw new Error(`no checksum found for renpy-sdk in ${sums_url}`)

	return match[1]
}

function get_md5_hash(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash('md5')
		const stream = createReadStream(path)
		stream.on('error', reject)
		stream.on('data', (chunk) => hash.update(chunk))
		stream.on('end', () => resolve(hash.digest('hex')))
	})
}

export async function download_sdk(
	sdk_url: string | URL,
	sdk_name: string,
	context: ExtensionContext,
	validate = true
): Promise<string | undefined> {
	const file_downloader: FileDownloader = await getApi()

	if (typeof sdk_url === 'string') {
		sdk_url = new URL(sdk_url)
	}

	try {
		return await vscode.window.withProgress(
			{
				title: `Downloading and installing Ren'Py ${sdk_name}`,
				location: vscode.ProgressLocation.Notification,
				cancellable: true,
			},
			async (progress, cancelation_token) => {
				const file = await file_downloader.downloadFile(
					vscode.Uri.parse(sdk_url.href),
					sdk_name + '.zip',
					context,
					cancelation_token,
					(downloaded, total) => {
						if (!total) return
						progress.report({
							increment: (downloaded / total) * 100,
						})
					},
					{ timeoutInMs: 5 * 60 * 1000 }
				)

				if (validate) {
					progress.report({
						message: 'Validating checksum',
						increment: -1000,
					})
					const sum = await get_sum_for_sdk(sdk_url)

					if (sum) {
						const hash = await get_md5_hash(file.fsPath)

						if (hash !== sum)
							throw new Error(
								`checksum mismatch for ${file.fsPath}: expected ${sum}, got ${hash}`
							)
					} else {
						logger.warn('no checksum found, skipping validation')
					}
				}

				progress.report({
					message: 'Extracting archive',
					increment: -1000,
				})
				const sdk_path = await unpack_sdk_archive(file.fsPath, sdk_name)

				return sdk_path
			}
		)
	} catch (error) {
		if (error instanceof vscode.CancellationError) {
			return undefined
		}

		logger.error(`failed to download SDK from ${sdk_url.href}:`, error)
		vscode.window
			.showErrorMessage(
				`Failed to download SDK from ${sdk_url.href}`,
				'OK',
				'See logs'
			)
			.then((selection) => {
				if (selection === 'See logs') logger.show()
			})
	}
}

async function unpack_sdk_archive(archive_path: string, sdk_name: string) {
	const root = path.dirname(archive_path)
	const zip_path = path.join(root, sdk_name + '_tmp')

	// clean up any previous incomplete extraction
	await rm(zip_path, { recursive: true, force: true })
	await mkdir(zip_path, { recursive: true })

	await extract(archive_path, { dir: zip_path, defaultFileMode: 0o744 })

	const files = await readdir(zip_path, { withFileTypes: true })
	if (files.length !== 1 || !files[0].isDirectory()) {
		throw new Error(
			`expected single directory in ${zip_path}, found ${files.length}`
		)
	}

	const sdk_folder_path = path.join(zip_path, files[0].name)
	const final_path = path.join(root, sdk_name)
	await rm(final_path, { recursive: true, force: true })
	await cp(sdk_folder_path, final_path, {
		recursive: true,
		force: true,
	})
	await rm(zip_path, { recursive: true, force: true })
	await rm(archive_path)
	return final_path
}

export async function list_downloaded_sdks(
	context: ExtensionContext
): Promise<string[]> {
	const file_downloader: FileDownloader = await getApi()
	const sdk_uris = await file_downloader.listDownloadedItems(context)
	const sdk_paths = sdk_uris.map((uri) => uri.fsPath)

	return p_filter(sdk_paths, path_is_sdk)
}

export async function uninstall_sdk(
	sdk_path: string,
	context: ExtensionContext
): Promise<void> {
	const file_downloader: FileDownloader = await getApi()
	const sdk_uris = await file_downloader.listDownloadedItems(context)
	const sdk_uri = sdk_uris.find((uri) => uri.fsPath === sdk_path)

	if (!sdk_uri) {
		throw new Error(`SDK not found at path: ${sdk_path}`)
	}

	try {
		await rmdir(sdk_uri.fsPath, { recursive: true })
		vscode.window.showInformationMessage(
			`Ren'Py SDK at ${basename(sdk_path)} uninstalled`
		)
	} catch (error) {
		logger.error(`Failed to uninstall SDK at ${sdk_path}:`, error)
		vscode.window.showErrorMessage(
			`Failed to uninstall SDK at ${sdk_path}: ${
				error instanceof Error ? error.message : 'Unknown error'
			}`
		)
	}
}
