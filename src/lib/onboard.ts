import * as vscode from 'vscode'
import semver from 'semver'
import { get_version } from './sh'
import { set_config, set_config_exclusive } from './config'

/**
 * Prompts the user to configure RPE extensions preferences and sets it.
 *
 * Returns `false` if the user cancels the prompt.
 */
export async function prompt_configure_extensions(
	executable: string[]
): Promise<boolean | void> {
	const selection_map: Record<string, () => Promise<void>> = {
		'Always use extensions (recommended)': async () => {
			await set_config_exclusive('renpyExtensionsEnabled', 'Enabled')
		},
		'Use extensions in this project': async () => {
			await set_config('renpyExtensionsEnabled', 'Enabled', true)
		},
		'Disable extensions in project': async () => {
			await set_config('renpyExtensionsEnabled', 'Disabled', true)

			vscode.window.showInformationMessage(
				"Ren'Py extension features disabled for this project"
			)
		},
		'Never install extensions': async () => {
			await set_config_exclusive('renpyExtensionsEnabled', 'Disabled')

			vscode.window.showInformationMessage(
				"Ren'Py extension features disabled globally"
			)
		},
	}

	const renpy_version = get_version(executable)

	if (semver.satisfies(renpy_version.semver, '>=8.2.0')) {
		const selection = await vscode.window.showQuickPick(
			Object.keys(selection_map),
			{
				ignoreFocusOut: true,
				title: "Ren'Py and VSCode can be synchronized by installing an extension in your Ren'Py project",
				placeHolder: 'How should extensions be installed?',
			}
		)

		if (!selection) return false

		await selection_map[selection]()
	} else {
		vscode.window.showInformationMessage(
			`Extensions are only supported on Ren'Py 8.2.0 or higher (is ${renpy_version.semver})`,
			'OK'
		)
	}
}

export async function prompt_not_rpy8_invalid_configuration(
	version_str: string
) {
	const selection = await vscode.window.showWarningMessage(
		`Ren'Py version must be 8.2.0 or newer to use extensions (is ${version_str})`,
		'OK',
		'Disable for this project',
		'Update SDK Path'
	)

	if (selection === 'Update SDK Path') {
		vscode.commands.executeCommand('renpyWarp.setSdkPath')
		return
	}

	if (selection === 'Disable for this project') {
		await set_config_exclusive('renpyExtensionsEnabled', 'Disabled')
	}

	return
}
