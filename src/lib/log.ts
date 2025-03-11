import { FileHandle, mkdir, open } from 'fs/promises'
import * as vscode from 'vscode'
import { paths } from './path'
import path from 'upath'

let logger: vscode.LogOutputChannel

export function get_logger(): vscode.LogOutputChannel {
	if (!logger) {
		logger = vscode.window.createOutputChannel(
			"Ren'Py Launch and Sync - Extension",
			{
				log: true,
			}
		)
	}
	return logger
}

export async function get_log_file(filename: string): Promise<{
	file_handle: FileHandle
	log_file: string
}> {
	const log_file = path.join(paths.log, filename)
	await mkdir(paths.log, { recursive: true })
	const file_handle = await open(log_file, 'w+')
	logger.info('logging to', log_file)

	return { file_handle, log_file }
}
