/*---------------------------------------------------------------------------------------------
 *  A-class main-thread service — `env`.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  THERE IS NO `$getEnv`
 *  ----------------------
 *  The VS Code protocol has NO `$getEnv` method: `grep '\$getEnv' extHost.protocol.ts` finds
 *  nothing. `vscode.env.*` is NOT a main-thread service at all — the extension host reads it
 *  from the INIT PAYLOAD:
 *
 *      IExtensionHostInitData.environment: IEnvironment
 *      (`vendor/src/vs/workbench/services/extensions/common/extensionHostProtocol.ts:37`, `:63`)
 *
 *  and the block is built by
 *  `packages/dsh-vscode-protocol/src/vscode/init-data.ts:161-171`, which fills it from the
 *  brand (`packages/dsh-vscode-protocol/brand.json`):
 *
 *      appName            "DeepSeek Harness"   <- vscode.env.appName
 *      appUriScheme       "dsh"                 <- vscode.env.uriScheme
 *      globalStorageHome  <profile>/global-storage
 *      workspaceStorageHome <profile>/workspace-storage
 *
 *  The spike measured the same value: the probe extension read "DeepSeek Harness" out of
 *  `vscode.env.appName`.
 *
 *  WHAT IS LEFT FOR THE MAIN SIDE
 *  -------------------------------
 *  Exactly ONE protocol method exposes the application's URI scheme to an extension:
 *  `MainThreadExtensionService.$asBrowserUri` (`extHost.protocol.ts:2090`). The ext host
 *  revives the answer into a `URI` (`extensionHostMain.ts:215`), so the DSH answer has to be
 *  a `UriComponents`.
 *
 *  This module therefore owns `$asBrowserUri`, and it also exports
 *  `dshEnvironmentFacts()` so that the runtime owner (and the report) can read the very
 *  environment block the extension host was given, instead of repeating the brand table.
 *--------------------------------------------------------------------------------------------*/

import { PRODUCT_BRAND } from '../../../packages/dsh-vscode-protocol/src/vscode/brand.js';
import type { ExtHostContext } from '../host-context.js';
import { log, type VsUri } from './support.js';

/**
 * The environment block DSH publishes to the extension host.
 *
 * The shape mirrors `IEnvironment`
 * (`vendor/src/vs/workbench/services/extensions/common/extensionHostProtocol.ts:63-80`).
 *
 * @param profileDir - the profile directory.
 * @returns the environment facts.
 */
export function dshEnvironmentFacts(profileDir: string): Record<string, unknown> {
	return {
		isExtensionDevelopmentDebug: false,
		appName: PRODUCT_BRAND.nameShort,
		appHost: 'desktop',
		appRoot: { scheme: 'file', path: profileDir },
		appLanguage: 'en',
		isExtensionTelemetryLoggingOnly: false,
		appUriScheme: PRODUCT_BRAND.urlProtocol,
		globalStorageHome: { scheme: 'file', path: `${profileDir}/global-storage` },
		workspaceStorageHome: { scheme: 'file', path: `${profileDir}/workspace-storage` },
	}
}

/**
 * The handlers for one main-thread service.
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle (for client→main calls).
 * @returns a map of VS Code protocol method name to handler.
 */
export default function createEnvMethods(ctx: any, host: ExtHostContext): Record<string, (...args: any[]) => any> {
	return {
		/**
		 * Turn a URI into one the application can open.
		 *
		 * VS Code uses this to make a resource openable in a browser. DSH has no browser
		 * surface; the closest equivalent is the application's own URI scheme, which DSH
		 * registers (`brand.json` — `urlProtocol: "dsh"`). The path, the query and the
		 * fragment are preserved so that the URI still names the same resource.
		 *
		 * @param uri - the URI components.
		 * @returns the URI in the application's scheme.
		 */
		async '$asBrowserUri'(uri: VsUri): Promise<VsUri> {
			if (!uri || typeof uri !== 'object') { return uri }
			try {
				if (uri.scheme === PRODUCT_BRAND.urlProtocol) { return uri }
				return {
					scheme: PRODUCT_BRAND.urlProtocol,
					authority: uri.authority,
					path: uri.path ?? '',
					query: uri.query,
					fragment: uri.fragment,
				}
			} catch (error) {
				log(ctx, 'warn', '[dsh-vscode] a URI could not be converted', {
					reason: String((error as any)?.message ?? error),
				})
				return uri
			}
		},
	}
}
