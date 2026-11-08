/*---------------------------------------------------------------------------------------------
 *  Tree views — the `MainThreadTreeViews` channel.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  WHAT A TREE VIEW IS, IN VS CODE
 *  -------------------------------
 *  An extension registers a `TreeDataProvider` for a view id; the workbench renders the
 *  tree and calls BACK into the extension host (`ExtHostTreeViews.$getChildren`) whenever a
 *  row expands. The provider is lazy: nothing is fetched until a row is opened.
 *
 *  WHAT DSH DOES
 *  -------------
 *  DSH has no view container, so the right-Sidebar VS Code page asks for one view by id.
 *  This module records the registration and the labels the extension sets, and the Host
 *  service exposes the lazy children call. Rendering is the browser half's job.
 *
 *  The channel is registered LATER than the host's own core, so these handlers replace the
 *  type-correct empty values the stub table would otherwise answer with.
 *--------------------------------------------------------------------------------------------*/

import type { ExtHostContext, MainThreadMethodFactory } from '../host-context.js';

/**
 * The handlers for the `MainThreadTreeViews` channel.
 *
 * @param _ctx - the DSH Host plugin context (unused: a tree view is host-process state).
 * @param host - the extension host handle.
 * @returns a map of VS Code protocol method name to handler.
 */
export const createTreeViewsMethods: MainThreadMethodFactory = (_ctx: any, host: ExtHostContext) => ({
	/**
	 * An extension registered a tree data provider.
	 *
	 * The registration is the ONLY thing the provider gives upfront: no rows exist until
	 * DSH asks for them.
	 *
	 * @param viewId - the contributed view id.
	 * @param options - the provider options (`treeDataProvider`, `showCollapseAll`).
	 */
	'$registerTreeViewDataProvider'(viewId: string, options: unknown): void {
		host.registerTreeView(viewId, options);
		host.log(`MainThreadTreeViews.$registerTreeViewDataProvider("${viewId}")`);
	},

	/**
	 * The view is gone: the extension disposed the provider or the extension unloaded.
	 *
	 * @param viewId - the contributed view id.
	 */
	'$disposeTree'(viewId: string): void {
		host.disposeTreeView(viewId);
		host.log(`MainThreadTreeViews.$disposeTree("${viewId}")`);
	},

	/**
	 * The provider asked the workbench to reload one view.
	 *
	 * DSH has no push channel into the browser, so the revision is bumped and the page
	 * notices it on its next poll.
	 *
	 * @param viewId - the contributed view id.
	 */
	'$refresh'(viewId: string): void {
		host.refreshTreeView(viewId);
	},

	/**
	 * The view's title changed.
	 *
	 * @param viewId - the contributed view id.
	 * @param title - the new title.
	 */
	'$setTitle'(viewId: string, title: string): void {
		host.setTreeViewTitle(viewId, title);
	},

	/**
	 * The view's message changed (the line a tree shows when it has nothing to list).
	 *
	 * @param viewId - the contributed view id.
	 * @param message - the message.
	 */
	'$setMessage'(viewId: string, message: unknown): void {
		host.setTreeViewMessage(viewId, message);
	},

	/**
	 * The view's badge changed. DSH records it and draws nothing: there is no badge slot.
	 *
	 * @param viewId - the contributed view id.
	 * @param badge - the badge.
	 */
	'$setBadge'(viewId: string, badge: unknown): void {
		host.setTreeViewBadge(viewId, badge);
	},

	/**
	 * The extension asked for one more element in the view. DSH has no incremental
	 * append, so the request is recorded as a refresh instead of silently doing nothing.
	 *
	 * @param viewId - the contributed view id.
	 */
	'$refreshTree'(viewId: string): void {
		host.refreshTreeView(viewId);
	},
});
