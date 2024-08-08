import * as vscode from 'vscode'
import { AnyProcess, ManagedProcess } from '.'
import find_process from 'find-process'

type MaybePromise<T> = T | Promise<T>

export class ProcessManager {
	private processes = new Map<number, AnyProcess>()

	/** Runs on process exit, after process has been removed */
	private exit_handler: (process: AnyProcess) => MaybePromise<void>

	private intervals = new Set<NodeJS.Timeout>()

	constructor({
		exit_handler,
	}: {
		exit_handler: typeof ProcessManager.prototype.exit_handler
	}) {
		this.exit_handler = exit_handler
	}

	[Symbol.iterator]() {
		return this.processes.values()
	}

	get length() {
		return this.processes.size
	}

	async add(id: number, process: AnyProcess) {
		this.processes.set(id, process)

		if (process instanceof ManagedProcess) {
			process.process!.on('exit', (code) => {
				if (!process.pid) throw new Error('no pid in process')

				this.processes.delete(id)

				if (code) {
					vscode.window
						.showErrorMessage(
							"Ren'Py process exited with errors",
							'OK',
							'Logs'
						)
						.then((selected) => {
							if (selected === 'Logs')
								process.output_channel?.show()
						})
				}

				this.exit_handler(process)
			})
		} else {
			const check_interval = setInterval(async () => {
				const found = await find_process('pid', process.pid)

				if (found.length === 0) {
					this.processes.delete(id)
					this.exit_handler(process)
					clearInterval(check_interval)
				}
			}, 1000)
			this.intervals.add(check_interval)
		}
	}

	get(id: number): AnyProcess | undefined {
		return this.processes.get(id)
	}

	at(index: number): AnyProcess | undefined {
		return Array.from(this).at(index)
	}

	kill_all() {
		for (const { kill } of this) {
			kill()
		}
	}

	dispose() {
		// this.kill_all()

		for (const interval of this.intervals) {
			clearInterval(interval)
		}

		for (const { dispose } of this) {
			dispose()
		}
	}
}
