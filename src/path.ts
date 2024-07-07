import path from 'upath'
import untildify from 'untildify'

/**
 * @param {string} str
 * @returns {string}
 */
export function resolve_path(str: string): string {
	return path.resolve(untildify(str))
}
