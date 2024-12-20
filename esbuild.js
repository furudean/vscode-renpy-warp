const { context } = require('esbuild')
const { copy } = require('esbuild-plugin-copy')

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

/** @type {import('esbuild').Plugin} */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started')
		})
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`)
				console.error(
					`    ${location.file}:${location.line}:${location.column}:`
				)
			})
			console.log('[watch] build finished')
		})
	},
}

async function main() {
	const ctx = await context({
		entryPoints: ['src/extension.ts'],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode', 'node-window-manager', 'extract-file-icon'],
		logLevel: 'silent',
		plugins: [
			copy({
				resolveFrom: 'cwd',
				assets: {
					from: ['./src/**/*.py', './src/**/*.svg'],
					to: ['./dist/'],
				},
				watch,
			}),
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	})
	if (watch) {
		await ctx.watch()
	} else {
		await ctx.rebuild()
		await ctx.dispose()
	}
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
