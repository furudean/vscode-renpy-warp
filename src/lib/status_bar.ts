import * as vscode from 'vscode'
import { get_config } from './util'
import { get_logger } from './logger'

const logger = get_logger()

export class StatusBar {
	private instance_bar: vscode.StatusBarItem
	private follow_cursor_bar: vscode.StatusBarItem

	private state = {
		starting_processes: 0,
		running_processes: 0,
		is_follow_cursor: false,
	}

	constructor() {
		this.instance_bar = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			0
		)

		this.follow_cursor_bar = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			0
		)

		this.update_status_bar()
	}

	update(fn: (state: typeof this.state) => Partial<typeof this.state>) {
		this.state = { ...this.state, ...fn(this.state) }

		if (this.state.starting_processes < 0) {
			logger.error('starting_processes underflow')
			this.state.starting_processes = 0
		}

		if (this.state.running_processes < 0) {
			logger.error('running_processes underflow')
			this.state.running_processes = 0
		}

		logger.debug('status bar state:', this.state)

		this.update_status_bar()
	}

	private update_status_bar() {
		this.instance_bar.show()

		if (this.state.starting_processes > 0) {
			this.instance_bar.text = `$(loading~spin) Starting Ren'Py...`
			this.instance_bar.command = undefined
			this.instance_bar.tooltip = undefined

			this.follow_cursor_bar.hide()

			return
		}

		if (
			this.state.running_processes == 1 &&
			get_config('renpyExtensionsEnabled') === 'Enabled'
		) {
			this.follow_cursor_bar.show()
		} else {
			this.follow_cursor_bar.hide()
		}

		if (this.state.is_follow_cursor) {
			this.follow_cursor_bar.text = '$(pinned) Following Cursor'
			this.follow_cursor_bar.color = new vscode.ThemeColor(
				'statusBarItem.warningForeground'
			)
			this.follow_cursor_bar.backgroundColor = new vscode.ThemeColor(
				'statusBarItem.warningBackground'
			)
		} else {
			this.follow_cursor_bar.text = '$(pin) Follow Cursor'
			this.follow_cursor_bar.command = 'renpyWarp.toggleFollowCursor'
			this.follow_cursor_bar.tooltip =
				"When enabled, keep editor cursor and Ren'Py in sync"
			this.follow_cursor_bar.color = undefined
			this.follow_cursor_bar.backgroundColor = undefined
		}

		if (this.state.running_processes > 0) {
			this.instance_bar.text = `$(debug-stop) Quit Ren'Py`
			this.instance_bar.command = 'renpyWarp.killAll'
			this.instance_bar.tooltip = "Kill all running Ren'Py instances"
		} else {
			this.instance_bar.text = `$(play) Launch Project`
			this.instance_bar.command = 'renpyWarp.launch'
			this.instance_bar.tooltip = "Launch new Ren'Py instance"
		}
	}

	dispose() {
		this.instance_bar.dispose()
		this.follow_cursor_bar.dispose()
	}
}
