import { JSDOM } from "jsdom"
import { SemVer, parse as semver_parse } from "semver"

export interface RemoteSdk {
	name: string
	url: URL
	semver: SemVer | null
}

export interface Channel {
	channel: string
	description: string
	pretty_version: string
	split_version: [number, number, number]
	timestamp: number
	url: string
}

export interface Channels {
	releases: Channel[]
}

async function fetch_and_parse_nginx_directory(
	url: string | URL
): Promise<URL[]> {
	const request = await fetch(url)
	const text = await request.text()

	const { document } = new JSDOM(text).window

	const anchors = Array.from(document.querySelectorAll("a").values())

	return anchors.map((a) => new URL(a.href, url)).slice(1) // first anchor is the parent directory link
}

function fix_broken_semver(name: string): string {
	// 4.0
	if (name.match(/^\d+\.\d+$/)) {
		return `${name}.0` // add patch version if missing
	}
	// 5.1.4a
	if (name.match(/^\d+\.\d+\.\d+[a-z]$/)) {
		return `${name.slice(0, -1)}--${name.slice(-1)}` // convert 5.1.4a to 5.1.4-a
	}
	// 6.99.14.1 6.99.14.2 etc
	if (name.match(/^\d+\.\d+\.\d+(\.\d+)?$/)) {
		return `${name.split(".").slice(0, 3).join(".")}--${name
			.split(".")
			.slice(3)
			.join(".")}` // 6.99.14--1
	}

	return name
}

export function semver_compare(a: string, b: string): number {
	const semver_a = semver_parse(fix_broken_semver(a))
	const semver_b = semver_parse(fix_broken_semver(b))

	if (semver_a && semver_b) {
		return semver_b.compare(semver_a) // both are valid semvers, compare them (reversed for descending order)
	} else if (semver_a) {
		return -1 // a is a valid semver, b is not
	}
	if (semver_b) {
		return 1 // b is a valid semver, a is not
	}

	return a.localeCompare(b) // neither are valid semvers, compare by name
}

export async function fetch_sdk_channels(url: string): Promise<Channels> {
	const request = await fetch(url)

	const channels = (await request.json()) as Channels

	return channels
}

export function sort_remote_sdks(a: RemoteSdk, b: RemoteSdk): number {
	return semver_compare(a.name, b.name)
}

export async function list_remote_sdks(): Promise<RemoteSdk[]> {
	const urls = await fetch_and_parse_nginx_directory("https://renpy.org/dl/")

	const sdks = urls
		.map((url) => {
			const version = decodeURIComponent(url.pathname.split("/")[2])
			return {
				name: version,
				url: url,
				semver: semver_parse(fix_broken_semver(version))
			}
		})
		.sort(sort_remote_sdks)

	return sdks
}

export async function find_sdk_in_directory(
	directory: string | URL
): Promise<URL> {
	const dir = await fetch_and_parse_nginx_directory(directory)

	const sdk = dir.find((url) => url.pathname.endsWith("-sdk.zip"))

	if (!sdk) {
		throw new Error(
			`No SDK found in directory ${directory}. Please check the URL or directory path.`
		)
	}

	return sdk
}

export async function get_sum_for_sdk(url: URL): Promise<string | undefined> {
	const sums_url = new URL("./checksums.txt", url.href)

	const head = await fetch(sums_url, { method: "HEAD" })

	if (head.status === 404) return undefined

	if (!head.ok) {
		throw new Error(
			`failed to fetch sums.txt from ${sums_url}: ${
				head.status
			} ${await head.text()}`
		)
	}

	const response = await fetch(sums_url)
	const file_text = await response.text()

	const md5_section = file_text.split("# md5")[1]?.split("# sha1")[0]
	if (!md5_section) throw new Error(`no md5 section found in ${sums_url}`)

	const checksum_pattern = /^([a-fA-F0-9]+)\s+renpy-[\d.]+-sdk\.zip$/m
	const match = md5_section.match(checksum_pattern)
	if (!match) throw new Error(`no checksum found for renpy-sdk in ${sums_url}`)

	return match[1]
}
