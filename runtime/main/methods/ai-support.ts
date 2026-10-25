/*---------------------------------------------------------------------------------------------
 *  D-class (AI) main-thread services — shared helpers.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  Everything in here is *defensive* on purpose: the extension-host handle (`host`) is owned by
 *  another module and its exact shape is still moving. Every helper degrades to a type-correct
 *  empty value instead of throwing, because a wrong-shaped answer crashes the whole extension host
 *  (see `spike/src/main-host.ts` PATCH #5 and `spike/src/stub-returns.ts`).
 *
 *  Protocol-shape authority: `vendor/src/vs/workbench/api/common/extHost.protocol.ts`.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * One resolved VS Code extension, as produced by the profile resolver.
 *
 * Mirrors `ResolvedExtension` (`runtime/main/host-context.ts:24`). The two ids differ on
 * purpose: `id` is `publisher.name@version` (the store / DSH facing id) and `extensionId` is
 * `publisher.name` (the id the VS Code *protocol* uses).
 */
export interface AiExtensionRecord {
	/** `publisher.name@version` — the store-facing id. */
	readonly id: string
	/** `publisher.name` — the protocol-facing id. */
	readonly extensionId?: string
	readonly publisher: string
	readonly name: string
	readonly version: string
	/** absolute path of the `extension/` subtree */
	readonly extensionPath: string
	readonly enabled?: boolean
	/** the raw `package.json` */
	readonly manifest: any
}

/**
 * The extension-host handle the main-thread services are handed.
 *
 * Direction (see `exthost-spike.md` §5.3): DSH is the *main* side, so DSH implements
 * `MainThread*Shape` and calls *into* the extension host through `ExtHost*Shape` method names.
 *
 * The real handle is `ExtHostContext` (`runtime/main/host-context.ts:91`); the optional members
 * below keep this module usable before the runtime wiring lands.
 */
export interface AiHostBridge {
	/** main → client: invoke one `ExtHost*` channel method. */
	call?<T = any>(channel: string, method: string, ...args: any[]): Promise<T>
	/** main → client: the raw `ExtHost*` proxy object. */
	getProxy?(channel: string): Record<string, (...args: any[]) => Promise<any>>
	/** the resolved extension list (manifest included). */
	extensions?: readonly AiExtensionRecord[]
	/** write one line into the profile's extension-host log. */
	log?(message: string): void
}

/**
 * The protocol-facing extension id.
 *
 * `publisher.name`, never `publisher.name@version`: the VS Code protocol keys its registry by
 * the version-less id, and the extension host's `ExtensionIdentifier` carries the same value.
 * @param extension - the resolved extension.
 * @returns the protocol extension id.
 */
export function protocolExtensionId(extension: AiExtensionRecord): string {
	return extension.extensionId ?? extension.id
}

/** `ExtHostContext` channel keys this package talks to. */
export const EXT_HOST_CHANNEL = {
	languageModelTools: 'ExtHostLanguageModelTools',
	languageModels: 'ExtHostLanguageModels',
	chatAgents: 'ExtHostChatAgents2',
	chatSessions: 'ExtHostChatSessions',
	mcp: 'ExtHostMcp',
	extensionService: 'ExtHostExtensionService',
} as const

/**
 * Call one `ExtHost*` method, tolerating every shape the host handle may take.
 *
 * Returns `undefined` when the host cannot perform the call — never throws. The caller decides
 * what a missing capability means (usually: "not supported here", surfaced as a tool error or an
 * empty protocol value).
 * @param host - the extension-host handle.
 * @param channel - an `ExtHostContext` key, e.g. `ExtHostLanguageModelTools`.
 * @param method - the protocol method name, `$`-prefixed and unchanged.
 * @param args - the protocol arguments; a trailing cancellation token must be last.
 * @returns the method result, or `undefined` when the channel/method is unavailable.
 */
export async function hostCall<T = any>(
	host: AiHostBridge | undefined,
	channel: string,
	method: string,
	...args: any[]
): Promise<T | undefined> {
	if (!host) { return undefined }
	try {
		if (typeof host.call === 'function') {
			return await host.call<T>(channel, method, ...args)
		}
		if (typeof host.getProxy === 'function') {
			const proxy = host.getProxy(channel)
			const fn = proxy?.[method]
			if (typeof fn === 'function') {
				return await fn.apply(proxy, args)
			}
		}
	} catch (error) {
		// A failed *client* call is a real error for the caller (e.g. an extension throwing inside
		// `invoke`), but a missing channel must not take the whole main-thread service down.
		if (isMissingChannelError(error)) {
			return undefined
		}
		throw error
	}
	return undefined
}

/** Detect "this channel/method does not exist" errors coming from the RPC layer. */
function isMissingChannelError(error: unknown): boolean {
	const message = String((error as any)?.message ?? error)
	return /Unknown actor|Unknown method|No such method/i.test(message)
}

/**
 * Read the resolved extension list off the host handle.
 *
 * Several field names are probed because the handle is still being built by the runtime owner;
 * the first array-shaped candidate wins.
 * @param host - the extension-host handle.
 * @returns the resolved extensions, or an empty list.
 */
export function resolveExtensionRecords(host: AiHostBridge | undefined): AiExtensionRecord[] {
	const candidates = [
		host?.extensions,
		(host as any)?.resolvedExtensions,
		(host as any)?.profileExtensions,
	]
	for (const candidate of candidates) {
		if (Array.isArray(candidate)) {
			return candidate.filter((entry): entry is AiExtensionRecord => !!entry && typeof entry === 'object')
		}
	}
	return []
}

/**
 * The wire shape of an `ExtensionIdentifier` over RPC.
 *
 * `ExtensionIdentifier` is a CLASS with `value` + `_lower` own properties and no `toJSON`, so a
 * plain `{ id }` would arrive as `{ id: undefined }` upstream (same trap as
 * `toExtId()` in the spike, `spike/src/main-host.ts:138`).
 * @param id - the extension identifier value.
 * @returns the class-shaped plain object the ext host expects.
 */
export function toExtensionIdentifier(id: string): { value: string; _lower: string } {
	return { value: id, _lower: id.toLowerCase() }
}

/**
 * Build a `UriComponents` for an absolute file path.
 *
 * `URI.revive()` on the ext-host side needs `scheme` + `path`; on POSIX the path *is* the
 * filesystem path.
 * @param filePath - an absolute path.
 * @returns the `UriComponents` plain object.
 */
export function toFileUriComponents(filePath: string): { scheme: string; path: string } {
	return { scheme: 'file', path: filePath }
}

/**
 * Read a file that an extension contributes (relative to its `extension/` subtree).
 * @param extension - the resolved extension.
 * @param relativePath - the manifest-relative path, e.g. `./skills/foo/SKILL.md`.
 * @returns the file text, or `undefined` when it cannot be read.
 */
export function readContributedFile(extension: AiExtensionRecord, relativePath: string): string | undefined {
	const base = extension.extensionPath
	if (!base || !relativePath) { return undefined }
	const cleaned = relativePath.replace(/^\.\//, '')
	const absolute = isAbsolute(cleaned) ? cleaned : resolve(join(base, cleaned))
	try {
		return readFileSync(absolute, 'utf8')
	} catch {
		return undefined
	}
}

/**
 * Split a Markdown file into YAML-ish frontmatter and body.
 *
 * A deliberately small parser: the Agent Skills specification only requires `name` and
 * `description` scalars, and VS Code's own skill loader accepts the same shape. Anything more
 * exotic is preserved verbatim inside the metadata object.
 * @param text - the raw file text.
 * @returns the parsed frontmatter and the remaining body.
 */
export function parseFrontmatter(text: string): { frontmatter: Record<string, any>; body: string } {
	const match = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
	if (!match) {
		return { frontmatter: {}, body: text }
	}
	const frontmatter: Record<string, any> = {}
	for (const line of match[1].split(/\r?\n/)) {
		const separator = line.indexOf(':')
		if (separator <= 0) { continue }
		const key = line.slice(0, separator).trim()
		if (!key) { continue }
		let value = line.slice(separator + 1).trim()
		if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2)
			|| (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
			value = value.slice(1, -1)
		}
		frontmatter[key] = value
	}
	return { frontmatter, body: text.slice(match[0].length) }
}

/**
 * Sanitize a string into the character class VS Code allows for tool / reference names.
 *
 * VS Code enforces `^(?!copilot_|vscode_)[\w-]+$` on `contributes.languageModelTools[].name`
 * and `^[\w-]+$` on `toolReferenceName` (see `vscode-extension-research/vscode-extension-system.md`
 * §C10.1). DSH does not enforce a character set, but keeping the same class avoids surprises
 * with providers that mirror OpenAI's tool-name rules.
 * @param value - the raw name.
 * @returns the sanitized name.
 */
export function sanitizeName(value: string): string {
	return value.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '')
}

/**
 * Build a DSH-unique tool name for one VS Code tool id.
 *
 * Naming strategy (see the report §"命名映射策略"):
 *  1. the VS Code id is used verbatim when it is free in the DSH registry;
 *  2. otherwise it is prefixed with `vsix_<publisher>_`;
 *  3. a numeric suffix disambiguates the remaining (pathological) collisions.
 * @param vscodeId - the VS Code tool id (`contributes.languageModelTools[].name`).
 * @param publisher - the extension publisher, used for the fallback prefix.
 * @param taken - the names already used.
 * @returns the DSH-side tool name.
 */
export function resolveDshToolName(vscodeId: string, publisher: string, taken: ReadonlySet<string>): string {
	const base = sanitizeName(vscodeId) || 'tool'
	if (!taken.has(base)) { return base }
	const publisherPart = sanitizeName(publisher) || 'ext'
	const prefixed = `vsix_${publisherPart}_${base}`
	if (!taken.has(prefixed)) { return prefixed }
	let counter = 2
	while (taken.has(`${prefixed}_${counter}`)) { counter++ }
	return `${prefixed}_${counter}`
}

/**
 * Build a cancellation token the VS Code RPC layer accepts.
 *
 * `CancellationToken.isCancellationToken()` (`vendor/src/vs/base/common/cancellation.ts:35`)
 * duck-types: `isCancellationRequested: boolean` + `onCancellationRequested: function` is enough,
 * so the runtime does not have to bundle the vendored cancellation module. The RPC layer pops the
 * trailing token off the argument list and rebuilds a real one on the callee side
 * (`vendor/src/vs/workbench/services/extensions/common/rpcProtocol.ts:466`).
 * @param signal - the DSH-side abort signal.
 * @returns a cancellation token suitable as the last RPC argument.
 */
export function toVsCancellationToken(signal?: AbortSignal): {
	isCancellationRequested: boolean
	onCancellationRequested: (listener: () => void) => { dispose(): void }
} {
	const listeners = new Set<() => void>()
	let aborted = signal?.aborted ?? false
	if (signal) {
		const onAbort = () => {
			aborted = true
			for (const listener of [...listeners]) {
				try { listener() } catch { /* a listener must not break cancellation */ }
			}
		}
		signal.addEventListener('abort', onAbort, { once: true })
	}
	return {
		get isCancellationRequested() { return aborted },
		onCancellationRequested(listener: () => void): { dispose(): void } {
			if (aborted) {
				try { listener() } catch { /* ignore */ }
				return { dispose() { } }
			}
			listeners.add(listener)
			return {
				dispose() { listeners.delete(listener) },
			}
		},
	}
}

/**
 * Log one line into the profile's extension-host log.
 *
 * `host.log()` writes into `<profile>/logs/…` (the same place the extension's own output
 * lands), which is the right place for main-thread diagnostics.
 * @param host - the extension-host handle.
 * @param message - the message.
 */
export function hostLog(host: AiHostBridge | undefined, message: string): void {
	try {
		host?.log?.(message)
	} catch { /* logging must never break a protocol call */ }
}

/**
 * Log a message through the DSH plugin logger when one is available.
 * @param ctx - the DSH Host plugin context.
 * @param level - the log level.
 * @param message - the message.
 * @param extra - structured extra data.
 */
export function log(ctx: any, level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void {
	const logger = ctx?.logger
	if (!logger) { return }
	try {
		const fn = (logger as any)[level] ?? (logger as any).log
		if (typeof fn === 'function') {
			fn.call(logger, extra ? `${message} ${JSON.stringify(extra)}` : message)
		}
	} catch { /* logging must never break a protocol call */ }
}
