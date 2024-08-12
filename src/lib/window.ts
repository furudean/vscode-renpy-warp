import { windowManager } from 'node-window-manager'
import pidtree from 'pidtree'
import { get_logger } from './logger'

const logger = get_logger()

export async function focus_window(pid: number) {
	// windows creates subprocesses for each window, so we need to find
	// the subprocess associated with the parent process we created
	const pids = [pid, ...(await pidtree(pid))]
	const matching_windows = windowManager
		.getWindows()
		.filter((win) => pids.includes(win.processId))

	logger.debug('matching windows:', matching_windows)

	if (!matching_windows) {
		logger.warn('no matching window found', windowManager.getWindows())
		return
	}

	const has_accessibility = windowManager.requestAccessibility()

	if (has_accessibility) {
		matching_windows.forEach((win) => {
			// bring all windows to top. windows creates many
			// subprocesses and figuring out the right one is not straightforward
			win.bringToTop()
		})
	} else {
		vscode.window.showInformationMessage(
			"Accessibility permissions have been requested. These are used to focus the Ren'Py window. You may need to restart Visual Studio Code for this to take effect.",
			'OK'
		)
	}
}
