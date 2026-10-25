/*---------------------------------------------------------------------------------------------
 *  Webview family — the document half of a TEXT custom editor.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  WHY THIS EXISTS
 *  ---------------
 *  A custom editor comes in two kinds (the protocol calls them `Custom` and `Text`):
 *
 *      Custom  the extension owns the document. It opens it itself
 *               (`provider.openCustomDocument`), usually by reading the file through
 *               `workspace.fs.readFile`. The main side only has to hand it a URI.
 *
 *      Text    the extension edits the TEXT of a document the editor already opened. The
 *               extension host's `resolveCustomEditor` asks its own document store for the
 *               document — SYNCHRONOUSLY:
 *
 *                   const document = this._extHostDocuments.getDocument(revivedResource);
 *
 *               (`vendor/src/vs/workbench/api/common/extHostCustomEditors.ts:308`). When the
 *               document is not open, `getDocument` THROWS
 *               ("Unable to retrieve document from URI ..."), and the custom editor never
 *               resolves.
 *
 *  DSH has no editor and therefore never opens a document on its own. So for a TEXT custom
 *  editor the main side has to open the document itself, over the protocol:
 *
 *      main -> ext host   MainThreadDocuments.$tryOpenDocument(uri, options)
 *
 *  The main side reads the file and pushes it into the extension host as a document delta
 *  (`ExtHostDocumentsAndEditors.$acceptDocumentsAndEditorsDelta`), which is exactly what
 *  VS Code's own main side does when an editor opens a file.
 *
 *  THE OTHER TWO METHODS OF THE CHANNEL
 *  ----------------------------------
 *  `$tryCreateDocument` and `$trySaveDocument` stay with the editor family: DSH has no
 *  untitled documents and no document to save. This module only overrides `$tryOpenDocument`.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';

import type { ExtHostContext, MainThreadMethodFactory } from '../host-context.js';
import { service } from './support.js';

/**
 * The URI components of a file.
 */
interface FileUri {
	readonly scheme?: string;
	readonly path?: string;
	readonly fsPath?: string;
}

/**
 * The absolute path of a `file:` URI.
 *
 * @param uri - the URI components.
 * @returns the absolute path, or `undefined` when the URI is not a file URI.
 */
function pathOf(uri: FileUri | undefined): string | undefined {
	if (uri === undefined || uri.scheme !== 'file') {
		return undefined;
	}
	if (typeof uri.fsPath === 'string' && uri.fsPath.length > 0) {
		return uri.fsPath;
	}
	return typeof uri.path === 'string' ? uri.path : undefined;
}

/**
 * Read a file as text.
 *
 * DSH's `ctx.fs` is the authority when it is available; the Host's own filesystem is the
 * fallback, so the method also works in a profile without a file service (the offline
 * verification harness runs without one).
 *
 * @param ctx - the DSH Host plugin context.
 * @param absolutePath - the absolute path of the file.
 * @returns the text of the file.
 */
async function readText(ctx: any, absolutePath: string): Promise<string> {
	const filesystem = service(ctx, 'fs');
	// `ctx.fs` takes an FsTarget, not a path string: a raw string makes the
	// service read `target.path`, which is undefined, and Node then refuses the
	// call with "The \"path\" argument must be of type string...".
	if (filesystem !== undefined && typeof filesystem.readText === 'function') {
		const target = typeof filesystem.resolve === 'function'
			? await filesystem.resolve(absolutePath)
			: absolutePath;
		return await filesystem.readText(target);
	}
	return readFileSync(absolutePath, 'utf8');
}

/**
 * Open a file as a document in the extension host.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @param uri - the URI of the file.
 * @param options - the open options.
 * @returns the canonical URI, or `undefined` when the document could not be opened.
 */
export async function openTextDocument(
	ctx: any,
	host: ExtHostContext,
	uri: FileUri,
	options?: { encoding?: string },
): Promise<FileUri | undefined> {
	const absolutePath = pathOf(uri);
	if (absolutePath === undefined) {
		host.log(`$tryOpenDocument refused a "${uri?.scheme ?? 'unknown'}" URI: only file URIs can be opened`);
		return undefined;
	}
	try {
		const text = await readText(ctx, absolutePath);
		const eol = text.includes('\r\n') ? '\r\n' : '\n';
		const lines = text.split(/\r\n|\r|\n/);
		await host.call('ExtHostDocumentsAndEditors', '$acceptDocumentsAndEditorsDelta', {
			removedDocuments: [],
			removedEditors: [],
			addedEditors: [],
			addedDocuments: [
				{
					uri: { scheme: 'file', path: absolutePath },
					versionId: 1,
					lines,
					EOL: eol,
					languageId: 'plaintext',
					isDirty: false,
					encoding: options?.encoding ?? 'utf8',
				},
			],
			newActiveEditor: null,
		});
		return { scheme: 'file', path: absolutePath };
	} catch (error) {
		// The extension host refuses a SECOND document for the same URI, and it keeps the
		// one that is already open. Opening the same file again is not an error: the
		// document the editor needs is open.
		if (/already exists/i.test((error as Error).message)) {
			return { scheme: 'file', path: absolutePath };
		}
		host.log(`ERROR the document "${absolutePath}" could not be opened: ${(error as Error).message}`);
		return undefined;
	}
}

/**
 * The handlers for the document half of a text custom editor.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @returns a map of VS Code protocol method name to handler.
 */
export const createCustomEditorDocumentsMethods: MainThreadMethodFactory = (ctx: any, host: ExtHostContext) => ({
	/**
	 * Open a document in the extension host.
	 *
	 * The extension host answers with the canonical URI of the document it opened.
	 */
	'$tryOpenDocument'(uri: FileUri, options?: { encoding?: string }): Promise<FileUri | undefined> {
		return openTextDocument(ctx, host, uri, options);
	},
});

export default createCustomEditorDocumentsMethods;
