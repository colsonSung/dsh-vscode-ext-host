/*---------------------------------------------------------------------------------------------
 *  Webview family — the `MainThreadWebviewPanels` channel.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  WHAT A PANEL IS, IN VS CODE
 *  ---------------------------
 *  A webview panel is a webview in a container: an editor tab, a sidebar slot, a panel.
 *  VS Code tracks its visibility, its view state (active / visible / which group) and can
 *  serialize it across a restart.
 *
 *  WHAT DSH DOES
 *  -------------
 *  DSH has no editor groups, no tabs and no view state. A panel in DSH is therefore just a
 *  DOCUMENT the extension produced, and every call below is either "remember something" or
 *  "record that something happened".
 *
 *  The one call that really matters is `$createWebviewPanel`: it is the notification that
 *  tells DSH that a webview exists, with its view type, its owner and its title. For a
 *  CUSTOM EDITOR the panel is never announced this way (see `custom-editors.ts`), so the
 *  family also learns about a panel from `$setHtml`.
 *
 *  WHAT IS NOT SUPPORTED, AND WHY
 *  -------------------------------
 *  - `$registerSerializer` / `$unregisterSerializer`: a serializer makes a webview survive a
 *    window reload. DSH has no webview persistence at all, so there is nothing to restore.
 *  - the view state (`$onDidChangeWebviewPanelViewStates` on the client side): DSH renders one
 *    webview at a time, in one place.
 *--------------------------------------------------------------------------------------------*/

import type { ExtHostContext, MainThreadMethodFactory } from '../host-context.js';
import { forgetPanel, rememberPanel, surfaceOf } from './webview-support.js';

/**
 * The handlers for the `MainThreadWebviewPanels` channel.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @returns a map of VS Code protocol method name to handler.
 */
export const createWebviewPanelsMethods: MainThreadMethodFactory = (ctx: any, host: ExtHostContext) => ({
	/**
	 * A webview panel was created.
	 *
	 * This is the announcement of a webview: its handle, its view type, the extension that
	 * owns it and its title.
	 */
	'$createWebviewPanel'(
		extension: { id: { value: string; _lower: string }; location: unknown },
		handle: string,
		viewType: string,
		initData: { title: string; webviewOptions: unknown; panelOptions: unknown; serializeBuffersForPostMessage: boolean },
		showOptions: unknown,
	): void {
		const extensionId = extension?.id?.value ?? '';
		rememberPanel(handle, viewType, extensionId, initData?.title ?? '');
		const surface = surfaceOf(ctx);
		surface?.announcePanel?.(handle, viewType, extensionId, initData?.title ?? '');
		host.log(`the extension "${extensionId}" created the webview "${handle}" (${viewType})`);
	},

	/**
	 * A webview was disposed.
	 */
	'$disposeWebview'(handle: string): void {
		forgetPanel(handle);
		const surface = surfaceOf(ctx);
		surface?.disposePanel?.(handle);
		host.log(`the webview "${handle}" was disposed`);
	},

	/**
	 * The extension asked for its webview to be shown.
	 *
	 * DSH has no window to show it in: the webview surface renders it where the file is
	 * previewed. The request is recorded.
	 */
	'$reveal'(handle: string, showOptions: unknown): void {
		rememberPanel(handle);
		const surface = surfaceOf(ctx);
		surface?.revealPanel?.(handle);
	},

	/**
	 * The extension set the webview's title.
	 */
	'$setTitle'(handle: string, value: string): void {
		const panel = rememberPanel(handle);
		panel.title = value;
		const surface = surfaceOf(ctx);
		surface?.setPanelTitle?.(handle, value);
	},

	/**
	 * The extension set the webview's icon.
	 */
	'$setIconPath'(handle: string, value: unknown): void {
		rememberPanel(handle);
		const surface = surfaceOf(ctx);
		surface?.setPanelIcon?.(handle, value);
	},

	/**
	 * The extension registered a serializer for its view type.
	 *
	 * NOT SUPPORTED: a serializer lets a webview be restored after a window reload, and DSH
	 * keeps no webview state at all. The registration is recorded and ignored.
	 */
	'$registerSerializer'(viewType: string, options: { serializeBuffersForPostMessage: boolean }): void {
		host.log(`the serializer for "${viewType}" was registered; DSH does not persist webviews, so it is ignored`);
	},

	/**
	 * The extension unregistered a serializer.
	 */
	'$unregisterSerializer'(viewType: string): void {
		host.log(`the serializer for "${viewType}" was unregistered`);
	},
});

export default createWebviewPanelsMethods;
