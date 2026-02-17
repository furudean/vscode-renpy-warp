import globals from "globals"
import eslint from "@eslint/js"
import tseslint from "typescript-eslint"
import eslintConfigPrettier from "eslint-config-prettier/flat"

export default [
	{ files: ["**/*.{js,mjs,cjs,ts}"] },
	{ ignores: ["out", "dist", ".vscode-test"] },
	{ languageOptions: { globals: { ...globals.browser, ...globals.node } } },
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			...eslintConfigPrettier.rules,
			"@typescript-eslint/no-require-imports": "off"
		}
	}
]
