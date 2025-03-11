import * as vscode from 'vscode'
import { get_config } from './config'
import { get_logger } from './log'

const logger = get_logger()

export class StatusBar {
	private instance_bar: vscode.StatusBarItem
	private follow_cursor_bar: vscode.StatusBarItem
	private notification_bar: vscode.StatusBarItem
	private subscriptions: vscode.Disposable[] = []

	private message_timeout: NodeJS.Timeout | undefined

	private state = {
		socket_server_status: 'stopped' as 'running' | 'stopped',
		processes: new Map<unknown, 'starting' | 'idle'>(),
		is_follow_cursor: false,
		message: undefined as string | undefined,
		message_level: undefined as number | undefined,
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

		this.notification_bar = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
			10_000
		)

		const update_status_bar_on_config_update =
			vscode.workspace.onDidChangeConfiguration(() => {
				this.update_status_bar()
			})

		this.subscriptions.push(
			this.instance_bar,
			this.follow_cursor_bar,
			this.notification_bar,
			update_status_bar_on_config_update
		)

		this.update_status_bar()
	}

	set_process(id: unknown, state: 'starting' | 'idle'): void {
		this.state.processes.set(id, state)
		this.update_status_bar()
	}

	delete_process(id: unknown): void {
		this.state.processes.delete(id)
		this.update_status_bar()
	}

	private get starting_processes(): number {
		return Array.from(this.state.processes.values()).filter(
			(v) => v === 'starting'
		).length
	}

	private get idle_processes(): number {
		return Array.from(this.state.processes.values()).filter(
			(v) => v === 'idle'
		).length
	}

	update(fn: (state: typeof this.state) => Partial<typeof this.state>) {
		const incoming_state = fn(this.state)
		this.state = { ...this.state, ...incoming_state }

		if (incoming_state.message) {
			clearTimeout(this.message_timeout)

			this.message_timeout = setTimeout(() => {
				this.update(() => ({ message: undefined }))
			}, 5000)
		}

		logger.debug('status bar state:', {
			...this.state,
			processes: undefined,
			starting_processes: this.starting_processes,
			idle_processes: this.idle_processes,
		})

		this.update_status_bar()
	}

	notify(message: string, level = 0) {
		if (level >= (this.state.message_level ?? -1)) {
			this.update(() => ({ message, message_level: level }))
		}
	}

	private update_status_bar() {
		if (this.state.message) {
			this.notification_bar.text = this.state.message
			this.notification_bar.show()
		} else {
			this.notification_bar.hide()
		}

		this.instance_bar.show()

		if (!get_config('sdkPath')) {
			this.instance_bar.text = "$(gear) Set Ren'Py SDK path"
			this.instance_bar.command = 'renpyWarp.setSdkPath'
			this.instance_bar.tooltip = "Set path to Ren'Py SDK"
			this.instance_bar.backgroundColor = new vscode.ThemeColor(
				'statusBarItem.warningBackground'
			)
			this.instance_bar.color = new vscode.ThemeColor(
				'statusBarItem.warningForeground'
			)
			this.follow_cursor_bar.hide()
			return
		} else {
			this.instance_bar.backgroundColor = undefined
			this.instance_bar.color = undefined
		}

		const extensions_enabled =
			get_config('renpyExtensionsEnabled') === 'Enabled'

		if (this.idle_processes > 0 && extensions_enabled) {
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
				"When enabled, keep editor cursor and Ren'Py dialogue in sync"
			this.follow_cursor_bar.color = undefined
			this.follow_cursor_bar.backgroundColor = undefined
		}

		if (
			this.state.socket_server_status === 'stopped' &&
			extensions_enabled
		) {
			this.instance_bar.text = "$(plug) Start Ren'Py socket server"
			this.instance_bar.command = 'renpyWarp.startSocketServer'
			this.instance_bar.tooltip = "Start Ren'Py WebSocket server"
		} else if (this.starting_processes > 0) {
			this.instance_bar.text = `$(loading~spin) Starting Ren'Py...`
			this.instance_bar.command = undefined
			this.instance_bar.tooltip = undefined
		} else if (this.idle_processes > 0) {
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
		for (const subscription of this.subscriptions) {
			subscription.dispose()
		}
	}
}
