import * as vscode from 'vscode'
import semver from 'semver'
import { get_version } from './sh'
import { install_rpe } from './rpe'
import { set_config } from './util'

export async function prompt_configure_extensions({
	executable,
	sdk_path,
	game_root,
	context,
}: {
	executable: string
	sdk_path: string
	game_root: string
	context: vscode.ExtensionContext
}): Promise<string> {
	const renpy_version = get_version(executable)
	const supports_rpe_py = semver.gte(renpy_version.semver, '8.3.0')
	const desination = supports_rpe_py ? 'SDK' : 'project'

	const selection = await vscode.window.showQuickPick(
		[
			'Always install extensions (recommended)',
			'Use extensions in this project',
			'Do not use extensions',
			'Never install extensions',
			'Cancel',
		],
		{
			ignoreFocusOut: true,
			title: `Ren'Py and VSCode can be synchronized by installing an extension in your Ren'Py ${desination}. Would you like to install it?`,
			placeHolder: 'Choose an option',
		}
	)

	if (
		selection === 'Always install extensions (recommended)' ||
		selection === 'Use extensions in this project'
	) {
		await set_config(
			'renpyExtensionsEnabled',
			'Enabled',
			selection === 'Use extensions in this project'
		)
		const installed_path = await install_rpe({
			sdk_path,
			executable,
			game_root,
			context,
		})

		vscode.window
			.showInformationMessage(
				`Ren'Py Extensions were installed at ${installed_path}`,
				'OK',
				'Show'
			)
			.then((selection) => {
				if (selection === 'Show') {
					vscode.commands.executeCommand(
						'vscode.openFolder',
						vscode.Uri.file(installed_path)
					)
				}
			})
		return 'Enabled'
	} else if (
		selection === 'Do not use extensions in this project' ||
		selection === 'Never install extensions'
	) {
		await set_config(
			'renpyExtensionsEnabled',
			'Disabled',
			selection === 'Do not use extensions in this project'
		)

		vscode.window.showInformationMessage(
			`RPE features have been disabled in Keep in mind that some features are disabled without it.`,
			'OK'
		)

		return 'Enabled'
	} else {
		throw new Error('user cancelled')
	}
}
