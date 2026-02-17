// https://www.renpy.org/doc/html/label.html#special-labels
export const RENPY_SPECIAL_LABELS = [
	// 'start',
	"quit",
	"after_load",
	"splashscreen",
	"before_main_menu",
	// 'main_menu',
	"after_warp",
	"hide_windows"
]

export function is_special_label(label: string) {
	return (
		label.startsWith("_") ||
		label.endsWith("_screen") ||
		RENPY_SPECIAL_LABELS.includes(label)
	)
}
