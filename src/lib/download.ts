import { getApi, FileDownloader } from "@microsoft/vscode-file-downloader-api"
import { ExtensionContext } from "vscode"
import * as vscode from "vscode"
import { get_logger } from "./log"
import p_filter from "p-filter"
import { path_is_sdk } from "./sdk"
import { cp, mkdir, readdir, rm, rmdir } from "node:fs/promises"
import path from "upath"
import { basename } from "node:path"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import extract from "extract-zip"
import { get_sum_for_sdk } from "./api"

const logger = get_logger()

function get_md5_hash(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("md5")
		const stream = createReadStream(path)
		stream.on("error", reject)
		stream.on("data", (chunk) => hash.update(chunk))
		stream.on("end", () => resolve(hash.digest("hex")))
	})
}

export async function download_sdk(
	sdk_url: string | URL,
	sdk_name: string,
	context: ExtensionContext,
	validate = true
): Promise<string | undefined> {
	const file_downloader: FileDownloader = await getApi()

	if (typeof sdk_url === "string") {
		sdk_url = new URL(sdk_url)
	}

	try {
		return await vscode.window.withProgress(
			{
				title: `Downloading and installing Ren'Py ${sdk_name}`,
				location: vscode.ProgressLocation.Notification,
				cancellable: true
			},
			async (progress, cancelation_token) => {
				const file = await file_downloader.downloadFile(
					vscode.Uri.parse(sdk_url.href),
					sdk_name + ".zip",
					context,
					cancelation_token,
					(downloaded, total) => {
						if (!total) return
						progress.report({
							increment: (downloaded / total) * 100
						})
					},
					{ timeoutInMs: 5 * 60 * 1000 }
				)

				if (validate) {
					progress.report({
						message: "Validating checksum",
						increment: -1000
					})
					const sum = await get_sum_for_sdk(sdk_url)

					if (sum) {
						const hash = await get_md5_hash(file.fsPath)

						if (hash !== sum)
							throw new Error(
								`checksum mismatch for ${file.fsPath}: expected ${sum}, got ${hash}`
							)
					} else {
						logger.warn("no checksum found, skipping validation")
					}
				}

				progress.report({
					message: "Extracting archive",
					increment: -1000
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
				"OK",
				"See logs"
			)
			.then((selection) => {
				if (selection === "See logs") logger.show()
			})
	}
}

async function unpack_sdk_archive(archive_path: string, sdk_name: string) {
	const root = path.dirname(archive_path)
	const zip_path = path.join(root, sdk_name + "_tmp")

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
		force: true
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
				error instanceof Error ? error.message : "Unknown error"
			}`
		)
	}
}
