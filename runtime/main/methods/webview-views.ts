/*---------------------------------------------------------------------------------------------
 *  Webview family — the `MainThreadWebviewViews` channel.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  WHAT A WEBVIEW VIEW IS, IN VS CODE
 *  ----------------------------------
 *  A webview view is a webview that lives in a VIEW CONTAINER (an activity bar slot, a
 *  sidebar, a panel). The extension registers a provider for a view type; when the user opens
 *  the view, VS Code resolves the view and the extension fills the webview.
 *
 *  WHAT DSH DOES
 *  -------------
 *  DSH has no view containers and no activity bar. The closest thing DSH has is the
 *  document preview surface — a keyed slot in the right sidebar — and that surface is
 *  FILE addressed, not view-type addressed.
 *
 *  So the registration is recorded (so that DSH knows the view type exists and who owns it)
 *  and nothing is rendered. The title, description and badge setters are recorded too.
 *
 *  This is the honest answer for now: a webview view extension loads, activates and
 *  registers its view; the view itself has no home in DSH yet. The report
 *  (`vscode-extension-support/webview-custom-editor.md`) lists this as an open gap.
 *--------------------------------------------------------------------------------------------*/

import type { ExtHostContext, MainThreadMethodFactory } from '../host-context.js';
import { rememberPanel, surfaceOf } from './webview-support.js';

/**
 * The handlers for the `MainThreadWebviewViews` channel.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @returns a map of VS Code protocol method name to handler.
 */
export const createWebviewViewsMethods: MainThreadMethodFactory = (ctx: any, host: ExtHostContext) => ({
	/**
	 * A webview view provider was registered.
	 */
	'$registerWebviewViewProvider'(
		extension: { id: { value: string; _lower: string }; location: unknown },
		viewType: string,
		options: { retainContextWhenHidden?: boolean; serializeBuffersForPostMessage: boolean },
	): void {
		const surface = surfaceOf(ctx);
		surface?.registerView?.(viewType, extension?.id?.value ?? '');
		host.log(`the extension "${extension?.id?.value ?? 'unknown'}" registered the webview view "${viewType}"`);
	},

	/**
	 * A webview view provider was unregistered.
	 */
	'$unregisterWebviewViewProvider'(viewType: string): void {
		const surface = surfaceOf(ctx);
		surface?.unregisterView?.(viewType);
		host.log(`the webview view "${viewType}" was unregistered`);
	},

	/**
	 * The extension set the view's title.
	 */
	'$setWebviewViewTitle'(handle: string, value: string | undefined): void {
		rememberPanel(handle);
		const surface = surfaceOf(ctx);
		surface?.setViewTitle?.(handle, value);
	},

	/**
	 * The extension set the view's description.
	 */
	'$setWebviewViewDescription'(handle: string, value: string | undefined): void {
		rememberPanel(handle);
		const surface = surfaceOf(ctx);
		surface?.setViewDescription?.(handle, value);
	},

	/**
	 * The extension set the view's badge.
	 */
	'$setWebviewViewBadge'(handle: string, badge: unknown): void {
		rememberPanel(handle);
		const surface = surfaceOf(ctx);
		surface?.setViewBadge?.(handle, badge);
	},

	/**
	 * The extension asked for its view to be shown.
	 *
	 * DSH has no view container to show it in, so the request is recorded.
	 */
	'$show'(handle: string, preserveFocus: boolean): void {
		rememberPanel(handle);
		const surface = surfaceOf(ctx);
		surface?.showView?.(handle);
	},
});

export default createWebviewViewsMethods;
