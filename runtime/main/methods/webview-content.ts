/*---------------------------------------------------------------------------------------------
 *  Webview family — the `MainThreadWebviews` channel.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  THE THREE CALLS THAT MATTER
 *  ---------------------------
 *  `MainThreadWebviews` carries exactly three methods, and together they are the whole
 *  webview CONTENT:
 *
 *      $setHtml(handle, value)          the extension's HTML
 *      $setOptions(handle, options)     the content options (scripts, local roots)
 *      $postMessage(handle, value, ...)  a message to the webview
 *
 *  The handle is the extension host's identifier for the webview. It is the only key both
 *  sides agree on, so it is DSH's key too.
 *
 *  WHO CALLS WHAT
 *  --------------
 *  All three are called BY the extension host (they are main-thread methods). The direction
 *  of the MESSAGES is the opposite: a message the webview sends to its extension travels
 *  `ExtHostWebviews.$onMessage`, which is a CLIENT-side method — the webview-surface bundle
 *  reaches it through the bridge.
 *
 *  THE HTML IS REWRITTED ON THE SURFACE
 *  ------------------------------------
 *  `$setHtml` hands the HTML over untouched; the webview-surface bundle rewrites the
 *  `webview.asWebviewUri(...)` URLs, because only the surface knows the URL its own
 *  resource route is mounted at.
 *--------------------------------------------------------------------------------------------*/

import type { ExtHostContext, MainThreadMethodFactory } from '../host-context.js';
import { queueOutbound, rememberPanel, surfaceOf } from './webview-support.js';

/**
 * The handlers for the `MainThreadWebviews` channel.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @returns a map of VS Code protocol method name to handler.
 */
export const createWebviewsMethods: MainThreadMethodFactory = (ctx: any, host: ExtHostContext) => ({
	/**
	 * The extension produced the webview's HTML.
	 *
	 * For a CUSTOM EDITOR this is the ONLY notification the main side gets: the custom editor
	 * path creates the panel inside the extension host and never announces it
	 * (`vendor/src/vs/workbench/api/common/extHostWebviewPanels.ts:217` is the only
	 * `$createWebviewPanel` call site, and it belongs to `vscode.window.createWebviewPanel`).
	 * So the panel is remembered HERE when it is not known yet.
	 */
	'$setHtml'(handle: string, value: string): void {
		rememberPanel(handle);
		const surface = surfaceOf(ctx);
		surface?.setHtml?.(handle, value);
		host.log(`the webview "${handle}" produced ${value.length} characters of HTML`);
	},

	/**
	 * The extension changed the webview's content options.
	 */
	'$setOptions'(handle: string, options: unknown): void {
		rememberPanel(handle);
		const surface = surfaceOf(ctx);
		surface?.setOptions?.(handle, options);
	},

	/**
	 * The extension sent a message to its webview.
	 *
	 * The value is already JSON serialized by the extension host
	 * (`vendor/src/vs/workbench/api/common/extHostWebview.ts:135-137`), so it is queued as it
	 * is. DSH has no push channel from the Host to an iframe, so the client polls.
	 */
	'$postMessage'(handle: string, value: string, ...buffers: unknown[]): Promise<boolean> {
		rememberPanel(handle);
		queueOutbound(handle, value, buffers);
		const surface = surfaceOf(ctx);
		surface?.queueMessage?.(handle, value, buffers);
		return Promise.resolve(true);
	},
});

export default createWebviewsMethods;
