/*---------------------------------------------------------------------------------------------
 *  Webview family — shared helpers.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  WHAT THIS MODULE IS
 *  -------------------
 *  The VS Code webview surface is a main-thread family of four channels:
 *
 *      MainThreadWebviewPanels   a panel (a webview in a container)
 *      MainThreadWebviews        the content of a webview (HTML, options, messages)
 *      MainThreadWebviewViews    a webview hosted in a view container
 *      MainThreadCustomEditors   a custom editor bound to a file
 *
 *  DSH has no editor, no tab system and no view containers, so this module does NOT
 *  reproduce VS Code's model. It implements the part that is actually useful in DSH:
 *
 *      a webview is a DOCUMENT the extension produced, addressed by a handle.
 *
 *  The extension produces that document through exactly two protocol calls
 *  (`MainThreadWebviewPanels.$createWebviewPanel` and `MainThreadWebviews.$setHtml`),
 *  and DSH keeps the produced document so that a client can render it.
 *
 *  THE BRIDGE
 *  ----------
 *  The protocol state lives HERE, on the main side, because only the main side can call
 *  back into the extension host (`host.call`). The DSH-facing webview surface — the HTTP
 *  routes the browser half reads — lives in a SEPARATE bundle
 *  (`vscode-ext-host/webview-surface`). The two halves meet at ONE Cordis service:
 *
 *      ctx.provide('vscodeWebviewSurface', surface)     <- the webview-surface bundle
 *      ctx.get('vscodeWebviewSurface')                  <- here
 *
 *  A Cordis service lives in the ROOT store, so a sibling plugin CAN read it
 *  (`cordis/src/reflect.ts`: `provide()` writes `this.store[key]` and `get()` reads
 *  `this.store[key]` for the isolate symbol, which every non-isolating scope shares).
 *
 *  When the surface bundle is NOT installed, every method here degrades to the
 *  type-correct empty value. Nothing throws: a throw inside `activate()` would fail the
 *  extension's activation and take the whole extension host with it
 *  (`vscode-extension-support/mainthread-aclass.md` §2.13).
 *--------------------------------------------------------------------------------------------*/

import type { ExtHostContext } from '../host-context.js';
import { service } from './support.js';

/** The name of the Cordis service the webview-surface bundle provides. */
export const SURFACE_SERVICE = 'vscodeWebviewSurface';

/** The route prefix the webview HTTP surface is mounted under. */
export const SURFACE_ROUTE = '/vscode-ext-host/webview';

/**
 * One webview the extension produced.
 *
 * The handle is the extension host's own identifier for the webview; it is the key every
 * protocol call carries, so it is the key DSH stores the document under.
 */
export interface WebviewPanel {
	/** The extension host's handle for this webview. */
	readonly handle: string;
	/** The `viewType` the webview was created with. */
	readonly viewType: string;
	/** The `publisher.name` id of the extension that owns it. */
	readonly extensionId: string;
	/** The title the extension gave the panel. */
	title: string;
	/** The HTML the extension produced, once `$setHtml` arrived. */
	html?: string;
	/** The content options the extension set. */
	options?: unknown;
	/** When the panel was first seen. */
	readonly createdAt: number;
}

/** One custom editor an extension registered. */
export interface CustomEditorProvider {
	/** The `viewType` of the editor. */
	readonly viewType: string;
	/** The `publisher.name` id of the extension that registered it. */
	readonly extensionId: string;
	/** Whether it is a binary (`custom`) or a text editor. */
	readonly kind: 'custom' | 'text';
	/** The file name patterns the editor claims. */
	readonly patterns: string[];
	/** The display name from `contributes.customEditors`. */
	readonly displayName?: string;
}

/**
 * The panels the extensions produced, by handle.
 *
 * Module level on purpose: the extension host process is replaced on a crash, and the
 * documents the extensions produced must survive that replacement — they belong to the
 * client, not to the child process.
 */
const panels = new Map<string, WebviewPanel>();

/**
 * The custom editors the extensions registered, by view type.
 */
const providers = new Map<string, CustomEditorProvider>();

/**
 * The messages the extensions sent to their webviews, per handle.
 *
 * The client polls them; DSH has no push channel from the Host to an iframe.
 */
const outboundMessages = new Map<string, Array<{ value: string; buffers: unknown[] }>>();

/**
 * The bridge the webview-surface bundle asks the main side for.
 *
 * Everything that needs the extension host lives behind this interface, because only the
 * main side holds `host.call`.
 */
export interface WebviewHostBridge {
	/** The extensions the host loaded. */
	extensions(): Array<{
		/** `publisher.name`. */
		extensionId: string;
		/** The absolute path of the extension's `extension/` subtree. */
		extensionPath: string;
		/** The extension's own `package.json`. */
		manifest: any;
	}>;
	/**
	 * Resolve the custom editor for a file: activate the extension, open the custom
	 * document and ask the extension to fill the webview.
	 *
	 * `viewType` names the editor the caller wants — VS Code's `openWith` picks one
	 * editor instead of the best match — and is the best match when it is omitted.
	 */
	resolveCustomEditor(path: string, title: string, viewType?: string): Promise<{ handle: string; viewType: string; extensionId: string } | undefined>;
	/** Deliver a message the webview sent to its extension. */
	postFromWebview(handle: string, json: string, buffers: unknown[]): Promise<void>;
	/** Dispose a webview the extension owns. */
	disposeWebview(handle: string): void;
}

/**
 * The surface service, when the webview-surface bundle is installed.
 *
 * @param ctx - the DSH Host plugin context.
 * @returns the surface, or `undefined` when the bundle is absent.
 */
export function surfaceOf(ctx: any): any {
	return service(ctx, SURFACE_SERVICE);
}

/**
 * Remember a webview, or return the one already remembered.
 *
 * A panel is first seen either through `$createWebviewPanel` (an extension calling
 * `vscode.window.createWebviewPanel`) or, for a CUSTOM EDITOR, only through `$setHtml` —
 * the custom editor path creates the panel inside the extension host and never announces it
 * (`vendor/src/vs/workbench/api/common/extHostCustomEditors.ts:296-302` calls
 * `createNewWebviewPanel`, which does NOT notify the main side; only
 * `ExtHostWebviewPanels.createWebviewPanel` does, at
 * `vendor/src/vs/workbench/api/common/extHostWebviewPanels.ts:217`).
 *
 * @param handle - the extension host's handle.
 * @param viewType - the webview's view type, when known.
 * @param extensionId - the owning extension, when known.
 * @param title - the panel's title, when known.
 * @returns the panel record.
 */
export function rememberPanel(handle: string, viewType?: string, extensionId?: string, title?: string): WebviewPanel {
	const existing = panels.get(handle);
	if (existing !== undefined) {
		if (title !== undefined && existing.title !== title) {
			existing.title = title;
		}
		return existing;
	}
	const panel: WebviewPanel = {
		handle,
		viewType: viewType ?? '',
		extensionId: extensionId ?? '',
		title: title ?? '',
		createdAt: Date.now(),
	};
	panels.set(handle, panel);
	return panel;
}

/**
 * The panel for a handle.
 *
 * @param handle - the extension host's handle.
 * @returns the panel, or `undefined`.
 */
export function panelFor(handle: string): WebviewPanel | undefined {
	return panels.get(handle);
}

/**
 * Every panel, newest last.
 *
 * @returns the panels.
 */
export function allPanels(): WebviewPanel[] {
	return [...panels.values()];
}

/**
 * Forget a panel and its queued messages.
 *
 * @param handle - the extension host's handle.
 */
export function forgetPanel(handle: string): void {
	panels.delete(handle);
	outboundMessages.delete(handle);
}

/**
 * Record a custom editor provider.
 *
 * @param provider - the provider.
 */
export function rememberProvider(provider: CustomEditorProvider): void {
	providers.set(provider.viewType, provider);
}

/**
 * Forget a custom editor provider.
 *
 * @param viewType - the provider's view type.
 */
export function forgetProvider(viewType: string): void {
	providers.delete(viewType);
}

/**
 * The custom editors the extensions registered.
 *
 * @returns the providers.
 */
export function allProviders(): CustomEditorProvider[] {
	return [...providers.values()];
}

/**
 * The kind of a registered custom editor.
 *
 * @param viewType - the editor's view type.
 * @returns `custom`, `text`, or `undefined` when the extension did not register it (yet).
 */
export function providerKindOf(viewType: string): 'custom' | 'text' | undefined {
	return providers.get(viewType)?.kind;
}

/**
 * Queue a message the extension sent to its webview.
 *
 * @param handle - the webview's handle.
 * @param value - the JSON serialized message.
 * @param buffers - the binary buffers that went with it.
 */
export function queueOutbound(handle: string, value: string, buffers: unknown[]): void {
	const queue = outboundMessages.get(handle) ?? [];
	queue.push({ value, buffers });
	outboundMessages.set(handle, queue);
}

/**
 * Take the queued messages of a webview.
 *
 * The queue is drained, so a client that polls twice does not see the same message twice.
 *
 * @param handle - the webview's handle.
 * @returns the messages.
 */
export function drainOutbound(handle: string): Array<{ value: string; buffers: unknown[] }> {
	const queue = outboundMessages.get(handle) ?? [];
	outboundMessages.delete(handle);
	return queue;
}

/**
 * Turn a glob into a regular expression.
 *
 * VS Code's `filenamePattern` selectors are globs. DSH supports the subset a file name
 * selector actually uses: `*`, `?` and `**`.
 *
 * @param pattern - the glob.
 * @returns the regular expression source.
 */
export function globToRegExpSource(pattern: string): string {
	let source = '';
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index];
		if (character === '*') {
			if (pattern[index + 1] === '*') {
				index += 1;
				// `**/` must also match zero directories.
				if (pattern[index + 1] === '/') {
					index += 1;
					source += '(?:.*/)?';
				} else {
					source += '.*';
				}
			} else {
				source += '[^/]*';
			}
			continue;
		}
		if (character === '?') {
			source += '[^/]';
			continue;
		}
		if (character === '{') {
			const close = pattern.indexOf('}', index);
			if (close > index) {
				const alternatives = pattern
					.slice(index + 1, close)
					.split(',')
					.map((alternative) => globToRegExpSource(alternative));
				source += `(?:${alternatives.join('|')})`;
				index = close;
				continue;
			}
		}
		source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	}
	return source;
}

/**
 * Expand the brace form of a `filenamePattern`.
 *
 * VS Code's selectors may carry several patterns in one: `{*.csv,*.tsv,*.xls}`.
 * Without this, the braces are matched LITERALLY, so such an editor claims
 * nothing at all — and the extension looks broken while it is only spelled
 * differently.
 *
 * @param pattern - the glob.
 * @returns the patterns the brace form stands for.
 */
export function expandBraces(pattern: string): string[] {
	const open = pattern.indexOf('{');
	if (open < 0) {
		return [pattern];
	}
	const close = pattern.indexOf('}', open);
	if (close < 0) {
		return [pattern];
	}
	const prefix = pattern.slice(0, open);
	const suffix = pattern.slice(close + 1);
	const expanded: string[] = [];
	for (const alternative of pattern.slice(open + 1, close).split(',')) {
		expanded.push(...expandBraces(prefix + alternative + suffix));
	}
	return expanded;
}

/**
 * Whether a file name matches a `filenamePattern` selector.
 *
 * @param fileName - the file name (not the path).
 * @param pattern - the glob.
 * @returns whether it matches.
 */
export function matchesPattern(fileName: string, pattern: string): boolean {
	try {
		return new RegExp(`^${globToRegExpSource(pattern)}$`).test(fileName);
	} catch {
		return false;
	}
}

/**
 * The file suffixes a `filenamePattern` selector claims.
 *
 * `*.drawio` claims `.drawio`; `*.drawio.svg` claims `.drawio.svg`.
 *
 * @param pattern - the glob.
 * @returns the suffixes, longest first.
 */
export function suffixesOf(pattern: string): string[] {
	const suffixes: string[] = [];
	for (const expanded of expandBraces(pattern)) {
		const star = expanded.indexOf('*');
		if (star < 0) {
			continue;
		}
		const suffix = expanded.slice(star + 1).replace(/^\*\*\/?/, '');
		if (suffix.length === 0 || suffix.includes('*') || suffix.includes('?')) {
			continue;
		}
		suffixes.push(suffix.toLowerCase());
	}
	return suffixes;
}

/**
 * The custom editor that claims a file, according to the manifests.
 *
 * The manifests are the source of truth BEFORE the extension is activated — a file can be
 * opened before the extension ever ran, and VS Code itself decides which editor to use from
 * `contributes.customEditors` alone.
 *
 * The selection follows VS Code's rules: a `default` priority beats an `option` one, and a
 * longer suffix beats a shorter one.
 *
 * @param extensions - the loaded extensions.
 * @param filePath - the absolute path of the file.
 * @returns the claim, or `undefined` when no extension claims the file.
 */
export function claimCustomEditor(
	extensions: Array<{ extensionId: string; manifest: any }>,
	filePath: string,
	requestedViewType?: string,
): { viewType: string; extensionId: string; displayName?: string; priority: string } | undefined {
	const fileName = filePath.slice(filePath.lastIndexOf('/') + 1).toLowerCase();
	let best: { viewType: string; extensionId: string; displayName?: string; priority: string; score: number } | undefined;
	for (const extension of extensions) {
		const editors = extension.manifest?.contributes?.customEditors ?? [];
		for (const editor of editors) {
			const viewType = typeof editor?.viewType === 'string' ? editor.viewType : '';
			if (viewType.length === 0) {
				continue;
			}
			// The caller named the editor (VS Code's `openWith`): it wins over the
			// best match, as long as it claims the file at all.
			const requested = requestedViewType !== undefined && requestedViewType.length > 0;
			if (requested && viewType !== requestedViewType) {
				continue;
			}
			const priority = typeof editor?.priority === 'string' ? editor.priority : 'default';
			const selectors = Array.isArray(editor?.selector) ? editor.selector : [];
			for (const selector of selectors) {
				const pattern = typeof selector?.filenamePattern === 'string' ? selector.filenamePattern : '';
				if (pattern.length === 0 || !matchesPattern(fileName, pattern.toLowerCase())) {
					continue;
				}
				// `default` beats `option`; inside one priority the longer suffix wins.
				// A REQUESTED editor wins over both.
				const suffixLength = suffixesOf(pattern.toLowerCase())[0]?.length ?? 0;
				const score = (requested ? 10_000 : 0) + (priority === 'default' ? 1000 : 0) + suffixLength;
				if (best === undefined || score > best.score) {
					best = {
						viewType,
						extensionId: extension.extensionId,
						displayName: typeof editor?.displayName === 'string' ? editor.displayName : undefined,
						priority,
						score,
					};
				}
			}
		}
	}
	if (best === undefined) {
		return undefined;
	}
	return { viewType: best.viewType, extensionId: best.extensionId, displayName: best.displayName, priority: best.priority };
}

/**
 * The bridge the webview-surface bundle installed, if any.
 *
 * Module level: the bridge holds `host.call`, which dies with the child process, so the
 * bridge is re-installed every time the extension host starts.
 */
let hostBridge: WebviewHostBridge | undefined;

/**
 * Install the bridge the webview-surface bundle asks the main side through.
 *
 * @param bridge - the bridge.
 */
export function setHostBridge(bridge: WebviewHostBridge): void {
	hostBridge = bridge;
}

/**
 * The installed bridge.
 *
 * @returns the bridge, or `undefined` when the extension host is not running.
 */
export function getHostBridge(): WebviewHostBridge | undefined {
	return hostBridge;
}

/**
 * Forget the bridge (the extension host stopped).
 */
export function clearHostBridge(): void {
	hostBridge = undefined;
}
