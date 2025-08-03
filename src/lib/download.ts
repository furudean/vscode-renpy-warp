import { JSDOM } from 'jsdom'
import { getApi, FileDownloader } from '@microsoft/vscode-file-downloader-api'
import { ExtensionContext } from 'vscode'
import * as vscode from 'vscode'
import { parse as semver_parse } from 'semver'
import { get_logger } from './log'
import p_filter from 'p-filter'
import { path_is_sdk } from './sdk'
import { cp, readdir, rm, rmdir } from 'node:fs/promises'
import path from 'upath'
import { basename } from 'node:path'

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

async function shallow(p: string): Promise<void> {
	const files = await readdir(p, { withFileTypes: true })

	if (files.length !== 1 || !files[0].isDirectory()) {
		throw new Error(
			`expected single directory in ${p}, found ${files.length}`
		)
	}

	const file = files[0]
	const dir = path.join(file.parentPath, file.name)
	await cp(dir, p, {
		recursive: true,
		force: true,
	})
	await rm(dir, { recursive: true })
}

export async function download_sdk(
	url: string | URL,
	name: string,
	context: ExtensionContext
): Promise<vscode.Uri | undefined> {
	const file_downloader: FileDownloader = await getApi()

	if (typeof url === 'string') {
		url = new URL(url)
	}

	try {
		return vscode.window.withProgress(
			{
				title: `Downloading and installing Ren'Py ${name}`,
				location: vscode.ProgressLocation.Notification,
				cancellable: true,
			},
			async (progress, cancelation_token) => {
				const file = await file_downloader.downloadFile(
					vscode.Uri.parse(url.href),
					name,
					context,
					cancelation_token,
					(downloaded, total) => {
						if (!total) return
						progress.report({
							increment: (downloaded / total) * 100,
						})
					},
					{ timeoutInMs: 5 * 60 * 1000, shouldUnzip: true }
				)
				progress.report({ message: 'Finalizing...', increment: -1 })
				await shallow(file.fsPath)
				return file
			}
		)
	} catch (error) {
		if (error instanceof vscode.CancellationError) {
			return undefined
		}

		logger.error(`failed to download SDK from ${url.href}:`, error)
		vscode.window
			.showErrorMessage(
				`Failed to download SDK from ${url.href}`,
				'OK',
				'See logs'
			)
			.then((selection) => {
				if (selection === 'See logs') logger.show()
			})
	}
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

export async function downloads_location(
	context: ExtensionContext
): Promise<string> {
	const file_downloader: FileDownloader = await getApi()
	const downloads_dir = await file_downloader.listDownloadedItems(context)
	if (downloads_dir.length === 0) {
		throw new Error('No downloaded items found in the context.')
	}
	return path.resolve(downloads_dir[0].fsPath, '..')
}
