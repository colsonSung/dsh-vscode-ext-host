/*---------------------------------------------------------------------------------------------
 *  A-class main-thread service — `uri`.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  Protocol shape: `MainThreadUrlsShape`
 *  (`vendor/src/vs/workbench/api/common/extHost.protocol.ts`).
 *
 *      $registerUriHandler(handle, extensionId, extensionDisplayName): Promise<void>
 *      $unregisterUriHandler(handle): Promise<void>
 *      $createAppUri(uri): Promise<UriComponents>
 *
 *  THERE IS NO `$parse` / `$revive`
 *  ---------------------------------
 *  The plan for this class listed `$parse` and `$revive`. The VS Code protocol has NEITHER:
 *  a URI is revived IN-PROCESS, on the extension-host side, by `URI.revive()`
 *  (`vendor/src/vs/base/common/uri.ts`) out of the plain `{ scheme, path, … }` members the
 *  marshaller produced. The main side never sees a "parse" call.
 *
 *  What the main side DOES have is `MainThreadUrls`, whose three methods are about URI
 *  HANDLERS and about building a URI that opens the application.
 *
 *  THE URI SCHEME
 *  --------------
 *  DSH registers its own scheme: `brand.json` — `urlProtocol: "dsh"`. `vscode.env.uriScheme`
 *  therefore reads `dsh` (the init payload fills it from the same brand,
 *  `packages/dsh-vscode-protocol/src/vscode/init-data.ts:168`), and `$createAppUri` builds
 *  URIs in that scheme.
 *--------------------------------------------------------------------------------------------*/

import { PRODUCT_BRAND } from '../../../packages/dsh-vscode-protocol/src/vscode/brand.js';
import type { ExtHostContext } from '../host-context.js';
import { log, type VsUri } from './support.js';

/**
 * The handlers for one main-thread service.
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle (for client→main calls).
 * @returns a map of VS Code protocol method name to handler.
 */
export default function createUriMethods(ctx: any, host: ExtHostContext): Record<string, (...args: any[]) => any> {
	/** The URI handlers the extensions registered, by handle. */
	const handlers = new Map<number, { extensionId: string; displayName: string }>()

	return {
		/**
		 * Note that an extension handles a URI scheme.
		 *
		 * DSH has no URI-handler ROUTER — nothing in the Web GUI or the CLI opens a
		 * `dsh://` link — so the registration is remembered and dropped. The extension
		 * believes it succeeded, which is what keeps `registerUriHandler` from failing an
		 * extension's `activate()`.
		 *
		 * @param handle - the handle the extension got.
		 * @param extensionId - the protocol id of the extension.
		 * @param extensionDisplayName - the display name of the extension.
		 */
		async '$registerUriHandler'(handle: number, extensionId: unknown, extensionDisplayName: string): Promise<void> {
			const id = typeof extensionId === 'string'
				? extensionId
				: String((extensionId as any)?.value ?? (extensionId as any)?.id ?? '')
			handlers.set(handle, { extensionId: id, displayName: extensionDisplayName })
			host.log(`MainThreadUrls.$registerUriHandler(${handle}) for ${id} — DSH has no URI router, the handler is dropped`)
		},

		/**
		 * Note that an extension stopped handling a URI scheme.
		 *
		 * @param handle - the handle the extension got.
		 */
		async '$unregisterUriHandler'(handle: number): Promise<void> {
			handlers.delete(handle)
		},

		/**
		 * Build a URI that opens the application.
		 *
		 * The answer is a URI in DSH's own scheme (`dsh://`), with the original path, query
		 * and fragment preserved so that it still names the same resource.
		 *
		 * @param uri - the URI components.
		 * @returns the URI in the application's scheme.
		 */
		async '$createAppUri'(uri: VsUri): Promise<VsUri> {
			if (!uri || typeof uri !== 'object') { return uri }
			try {
				const path = typeof uri.path === 'string' ? uri.path : ''
				return {
					scheme: PRODUCT_BRAND.urlProtocol,
					authority: uri.authority,
					path: path.startsWith('/') ? path : `/${path}`,
					query: uri.query,
					fragment: uri.fragment,
				}
			} catch (error) {
				log(ctx, 'warn', '[dsh-vscode] an application URI could not be built', {
					reason: String((error as any)?.message ?? error),
				})
				return uri
			}
		},
	}
}
