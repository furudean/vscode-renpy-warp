import * as vscode from 'vscode'
import semver from 'semver'
import { get_version } from './sh'
import { set_config, set_config_exclusive } from './config'

/**
 * Prompts the user to configure RPE extensions preferences and sets it.
 *
 * Throws an error if the user cancels the prompt.
 */
export async function prompt_configure_extensions(
	executable: string
): Promise<void> {
	const selection_map: Record<string, () => Promise<void>> = {
		'Always use extensions (recommended)': async () => {
			await set_config_exclusive('renpyExtensionsEnabled', 'Enabled')
		},
		'Use extensions only in this project': async () => {
			await set_config('renpyExtensionsEnabled', 'Enabled', true)
		},
		'Disable extensions only in this project': async () => {
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
	const supports_rpe_py = semver.gte(renpy_version.semver, '8.3.0')
	const desination = supports_rpe_py ? 'SDK' : 'project'

	const selection = await vscode.window.showQuickPick(
		Object.keys(selection_map),
		{
			ignoreFocusOut: true,
			title: `Ren'Py and VSCode can be synchronized by installing an extension in your Ren'Py ${desination}`,
			placeHolder: 'How should extensions be installed?',
		}
	)

	if (!selection) throw new Error('user cancelled')

	await selection_map[selection]()
}
