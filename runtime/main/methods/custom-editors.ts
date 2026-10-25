/*---------------------------------------------------------------------------------------------
 *  Webview family — the `MainThreadCustomEditors` channel.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  WHAT THIS CHANNEL DOES IN VS CODE
 *  ---------------------------------
 *  A custom editor binds a FILE to a webview. The extension declares the binding in
 *  `contributes.customEditors` (a view type plus the file name patterns it claims) and
 *  registers a provider for it. When the user opens a claimed file, VS Code activates the
 *  extension and asks it to fill a webview.
 *
 *  WHAT DSH DOES
 *  -------------
 *  DSH has no editor and no tab system, so there is no "open the editor" step. What DSH can
 *  do — and what an extension actually needs — is:
 *
 *      1. know WHICH custom editor claims a file  (from the manifests, no activation needed)
 *      2. activate that extension
 *      3. ask the extension to open the custom document and fill a webview
 *      4. keep the webview's HTML so that a client can render it
 *
 *  Steps 1-3 happen in {@link resolveCustomEditorFor}; step 4 is the webview family's job.
 *
 *  THE CUSTOM EDITOR FLOW, AS THE PROTOCOL ACTUALLY WORKS
 *  ------------------------------------------------------
 *  The main side owns the flow, the extension host owns the provider:
 *
 *      main  -> ext host   ExtHostCustomEditors.$createCustomDocument(resource, viewType, backupId, untitledDocumentData, token)
 *                           (only for a BINARY custom editor; a text one opens the document)
 *      main  -> ext host   ExtHostCustomEditors.$resolveCustomEditor(resource, handle, viewType, initData, position, token)
 *      ext host -> extension   provider.resolveCustomEditor(document, panel, token)
 *      extension -> ext host   panel.webview.html = ...  ==>  MainThreadWebviews.$setHtml(handle, html)
 *
 *  (`vendor/src/vs/workbench/api/common/extHostCustomEditors.ts:276-313` — the ext host creates
 *  the webview and the panel itself and then calls the extension's provider.)
 *
 *  IMPORTANT: the custom editor path NEVER calls `MainThreadWebviewPanels.$createWebviewPanel`.
 *  Only `vscode.window.createWebviewPanel` does
 *  (`vendor/src/vs/workbench/api/common/extHostWebviewPanels.ts:217`). So the webview family
 *  has to be able to learn about a panel from `$setHtml` alone — see `rememberPanel`.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../vendor/src/vs/base/common/cancellation.js';
import { SerializableObjectWithBuffers } from '../../../vendor/src/vs/workbench/services/extensions/common/proxyIdentifier.js';

import type { ExtHostContext, MainThreadMethodFactory } from '../host-context.js';
import { openTextDocument } from './custom-editor-documents.js';
import {
	claimCustomEditor,
	forgetProvider,
	getHostBridge,
	providerKindOf,
	rememberPanel,
	rememberProvider,
	setHostBridge,
	surfaceOf,
	type WebviewHostBridge,
} from './webview-support.js';

/**
 * The view column DSH uses for every webview.
 *
 * `EditorGroupColumn.Active` is 1 (`vendor/src/vs/workbench/api/common/extHost.protocol.ts`).
 * DSH has no editor groups, so the value only has to be a legal one.
 */
const ACTIVE_COLUMN = 1;

/**
 * The handle counter.
 *
 * The main side owns the handle of a custom editor's webview (VS Code's `CustomEditorInput`
 * owns it there too), so DSH has to mint one. The prefix keeps DSH's handles apart from the
 * extension host's own (`ExtHostWebviewPanels.newHandle()`).
 */
let handleCounter = 0;

/**
 * Mint a handle for a webview DSH opened.
 *
 * @returns the handle.
 */
function newHandle(): string {
	handleCounter += 1;
	return `dsh-wv-${handleCounter}-${Date.now().toString(36)}`;
}

/**
 * The URI of a file, as the extension host expects it.
 *
 * The extension host revives it with `URI.revive()`, which needs `scheme` and `path`.
 *
 * @param absolutePath - the absolute path of the file.
 * @returns the URI components.
 */
function fileUri(absolutePath: string): { scheme: string; path: string } {
	return { scheme: 'file', path: absolutePath };
}

/**
 * The bridge the webview-surface bundle asks the main side through.
 *
 * It is installed every time the extension host starts, because it holds `host.call`, which
 * dies with the child process.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 */
function installBridge(ctx: any, host: ExtHostContext): void {
	const bridge: WebviewHostBridge = {
		extensions: () => host.extensions.map((extension) => ({
			extensionId: extension.extensionId,
			extensionPath: extension.extensionPath,
			manifest: extension.manifest,
		})),
		resolveCustomEditor: async (path: string, title: string, viewType?: string) =>
			await resolveCustomEditorFor(ctx, host, path, title, viewType),
		postFromWebview: async (handle: string, json: string, buffers: unknown[]) => {
			// The buffers travel as a `SerializableObjectWithBuffers`, not as a plain array:
			// the RPC layer recognises that class and carries the binary parts out of band
			// (`vendor/src/vs/workbench/services/extensions/common/rpcProtocol.ts:740-742`).
			// A plain array arrives as `undefined` and the extension host throws
			// "Cannot read properties of undefined (reading 'map')".
			await host.call('ExtHostWebviews', '$onMessage', handle, json, new SerializableObjectWithBuffers(buffers ?? []));
		},
		disposeWebview: (handle: string) => {
			rememberPanel(handle);
		},
	};
	setHostBridge(bridge);
	// The webview-surface bundle reads the bridge through the service, so it can resolve a
	// custom editor and hand a webview's messages back to the extension.
	const surface = surfaceOf(ctx);
	surface?.setBridge?.(bridge);
}

/**
 * Resolve the custom editor that claims a file and ask the extension to fill a webview.
 *
 * The extension is activated first: VS Code derives the `onCustomEditor:<viewType>` activation
 * event from `contributes.customEditors` (the implicit activation events of VS Code 1.74 and
 * later), and DSH derives the same event in `deriveEvents()`
 * (`runtime/main/main-host.ts:1010-1012`).
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @param path - the absolute path of the file.
 * @param title - the title the panel should carry.
 * @param viewType - the editor the caller wants; the best match when it is omitted.
 * @returns the panel's identity, or `undefined` when no extension claims the file.
 */
export async function resolveCustomEditorFor(
	ctx: any,
	host: ExtHostContext,
	path: string,
	title: string,
	viewType?: string,
): Promise<{ handle: string; viewType: string; extensionId: string } | undefined> {
	const bridge = getHostBridge();
	const extensions = bridge?.extensions() ?? host.extensions.map((extension) => ({
		extensionId: extension.extensionId,
		extensionPath: extension.extensionPath,
		manifest: extension.manifest,
	}));
	const claim = claimCustomEditor(extensions, path, viewType);
	if (claim === undefined) {
		return undefined;
	}

	// 1. Activate the extension that owns the editor.
	try {
		await host.call('ExtHostExtensionService', '$activateByEvent', `onCustomEditor:${claim.viewType}`, 0);
	} catch (error) {
		host.log(`ERROR the activation event "onCustomEditor:${claim.viewType}" failed: ${(error as Error).message}`);
		return undefined;
	}

	const handle = newHandle();
	const resource = fileUri(path);
	const initData = {
		title,
		contentOptions: {
			enableScripts: true,
			enableForms: true,
			enableCommandUris: true,
			localResourceRoots: [fileUri(extensionPathOf(extensions, claim.extensionId) ?? '')],
		},
		options: {
			enableFindWidget: false,
			retainContextWhenHidden: false,
		},
		active: true,
	};

	// 2. The document the editor works on.
	//    A BINARY custom editor owns its document: the extension opens it itself
	//    (`provider.openCustomDocument`). A TEXT custom editor edits a document the editor
	//    already opened — and DSH has no editor, so the main side opens it here.
	const kind = providerKindOf(claim.viewType);
	if (kind === 'text') {
		const opened = await openTextDocument(ctx, host, resource);
		if (opened === undefined) {
			return undefined;
		}
	} else {
		try {
			await host.call(
				'ExtHostCustomEditors',
				'$createCustomDocument',
				resource,
				claim.viewType,
				undefined,
				undefined,
				CancellationToken.None,
			);
		} catch (error) {
			// The extension host refuses a SECOND document for the same view type and
			// resource — and that is not a failure: the document is open already. The
			// desktop app opens the file with the very editor the person chose, and the
			// preview then asks for the SAME editor again. The editor is resolved
			// against the document that is already there.
			if (/already exists/i.test((error as Error).message)) {
				host.log(`the custom document for "${claim.viewType}" was open already`);
			} else {
				host.log(`ERROR the custom document for "${claim.viewType}" could not be opened: ${(error as Error).message}`);
				return undefined;
			}
		}
	}

	// 3. Let the extension fill the webview.
	try {
		await host.call(
			'ExtHostCustomEditors',
			'$resolveCustomEditor',
			resource,
			handle,
			claim.viewType,
			initData,
			ACTIVE_COLUMN,
			CancellationToken.None,
		);
	} catch (error) {
		host.log(`ERROR the custom editor "${claim.viewType}" could not resolve: ${(error as Error).message}`);
		return undefined;
	}

	rememberPanel(handle, claim.viewType, claim.extensionId, title);
	return { handle, viewType: claim.viewType, extensionId: claim.extensionId };
}

/**
 * The extension directory of an extension.
 *
 * @param extensions - the loaded extensions.
 * @param extensionId - the `publisher.name` id.
 * @returns the absolute path of the extension's `extension/` subtree.
 */
function extensionPathOf(
	extensions: Array<{ extensionId: string; extensionPath: string }>,
	extensionId: string,
): string | undefined {
	return extensions.find((extension) => extension.extensionId === extensionId)?.extensionPath;
}

/**
 * The handlers for the `MainThreadCustomEditors` channel.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @returns a map of VS Code protocol method name to handler.
 */
export const createCustomEditorsMethods: MainThreadMethodFactory = (ctx: any, host: ExtHostContext) => {
	installBridge(ctx, host);

	return {
		/**
		 * A binary custom editor was registered.
		 *
		 * The registration is kept so that DSH knows the view type exists and which
		 * extension owns it. The FILE SELECTOR is not taken from here: it is in the
		 * manifest's `contributes.customEditors`, and the manifest is authoritative even
		 * before the extension is activated.
		 */
		'$registerCustomEditorProvider'(
			extension: { id: { value: string; _lower: string }; location: unknown },
			viewType: string,
			options: unknown,
			capabilities: unknown,
			supportsMultipleEditorsPerDocument: boolean,
			serializeBuffersForPostMessage: boolean,
		): void {
			rememberProvider({
				viewType,
				extensionId: extension?.id?.value ?? '',
				kind: 'custom',
				patterns: [],
				displayName: undefined,
			});
			host.log(`registered the custom editor "${viewType}" (${extension?.id?.value ?? 'unknown extension'})`);
		},

		/**
		 * A text custom editor was registered.
		 */
		'$registerTextEditorProvider'(
			extension: { id: { value: string; _lower: string }; location: unknown },
			viewType: string,
			options: unknown,
			capabilities: unknown,
			serializeBuffersForPostMessage: boolean,
		): void {
			rememberProvider({
				viewType,
				extensionId: extension?.id?.value ?? '',
				kind: 'text',
				patterns: [],
				displayName: undefined,
			});
			host.log(`registered the text custom editor "${viewType}" (${extension?.id?.value ?? 'unknown extension'})`);
		},

		/**
		 * A custom editor was unregistered.
		 */
		'$unregisterEditorProvider'(viewType: string): void {
			forgetProvider(viewType);
			host.log(`unregistered the custom editor "${viewType}"`);
		},

		/**
		 * The extension edited the document through the webview.
		 *
		 * DSH has no document model, so there is nothing to apply the edit to. The event
		 * is recorded, not dropped silently.
		 */
		'$onDidEdit'(resource: unknown, viewType: string, editId: number, label: string | undefined): void {
			host.log(`the custom editor "${viewType}" reported edit ${editId}${label === undefined ? '' : ` (${label})`} on ${JSON.stringify(resource)}`);
		},

		/**
		 * The extension changed the document's content.
		 */
		'$onContentChange'(resource: unknown, viewType: string): void {
			host.log(`the custom editor "${viewType}" reported a content change on ${JSON.stringify(resource)}`);
		},

		/**
		 * The selection inside a text custom editor changed.
		 */
		'$onDidChangeCustomTextEditorSelection'(handle: string, selection: unknown): void {
			host.log(`the selection of the webview "${handle}" changed`);
		},
	};
};

export default createCustomEditorsMethods;
