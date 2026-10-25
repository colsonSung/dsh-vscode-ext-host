/*---------------------------------------------------------------------------------------------
 *  A-class main-thread service — `storage`.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  Protocol shape: `MainThreadStorageShape`
 *  (`vendor/src/vs/workbench/api/common/extHost.protocol.ts:863`).
 *
 *      $initializeExtensionStorage(shared, extensionId): Promise<string | undefined>
 *      $setValue(shared, extensionId, value): Promise<void>
 *      $registerExtensionStorageKeysToSync(extension, keys): void
 *
 *  WHO OWNS THE STORAGE
 *  ---------------------
 *  The MAIN side owns it. The ext host asks for the stored value and hands the new one over
 *  (`extHostStorage.ts:39-58`); the answer of `$initializeExtensionStorage` is a STRING that
 *  the ext host JSON-parses (`extHostStorage.ts:44-47`). A `undefined` answer means "there
 *  is no stored value" and the ext host falls back to the caller's default.
 *
 *  WHERE DSH KEEPS IT
 *  ------------------
 *  `shared = true` is the extension's `globalState`, `shared = false` is its
 *  `workspaceState`. The init payload already publishes the two homes
 *  (`IEnvironment.globalStorageHome` / `workspaceStorageHome`,
 *  `packages/dsh-vscode-protocol/src/vscode/init-data.ts:169-170`):
 *
 *      <profile>/global-storage
 *      <profile>/workspace-storage
 *
 *  so the extension's storage lands exactly where `ExtensionContext.globalStorageUri` and
 *  `ExtensionContext.storageUri` point. One file per extension and per scope:
 *  `<home>/<publisher>.<name>.json`.
 *
 *  The alternative — `ctx.storageDomain` — needs a `defineDomain` spec, which is a
 *  package-level declaration (`@deepseek-ai/dsh-storage-domain`). A VSIX extension is not a
 *  DSH plugin, so it has no such declaration; the file keeps the feature working without a
 *  new bundle dependency.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExtHostContext } from '../host-context.js';
import { log } from './support.js';

/**
 * The handlers for one main-thread service.
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle (for client→main calls).
 * @returns a map of VS Code protocol method name to handler.
 */
export default function createStorageMethods(ctx: any, host: ExtHostContext): Record<string, (...args: any[]) => any> {
	/**
	 * The file one extension's storage lives in.
	 *
	 * @param shared - whether the value is the extension's global state.
	 * @param extensionId - the protocol id, `publisher.name`.
	 * @returns the absolute path.
	 */
	function storagePath(shared: boolean, extensionId: string): string {
		const home = shared
			? join(host.profileDir, 'global-storage')
			: join(host.profileDir, 'workspace-storage')
		return join(home, `${sanitize(extensionId)}.json`)
	}

	/**
	 * Make an extension id safe as a file name.
	 *
	 * @param id - the protocol id.
	 * @returns the safe name.
	 */
	function sanitize(id: string): string {
		return String(id ?? '').replace(/[^A-Za-z0-9._-]+/g, '_')
	}

	return {
		/**
		 * Read one extension's stored state.
		 *
		 * @param shared - whether the value is the extension's global state.
		 * @param extensionId - the protocol id.
		 * @returns the stored JSON text, or `undefined` when there is none.
		 */
		async '$initializeExtensionStorage'(shared: boolean, extensionId: string): Promise<string | undefined> {
			const path = storagePath(!!shared, String(extensionId))
			try {
				if (!existsSync(path)) { return undefined }
				return readFileSync(path, 'utf8')
			} catch (error) {
				log(ctx, 'warn', '[dsh-vscode] an extension storage could not be read', {
					extensionId,
					reason: String((error as any)?.message ?? error),
				})
				return undefined
			}
		},

		/**
		 * Write one extension's stored state.
		 *
		 * @param shared - whether the value is the extension's global state.
		 * @param extensionId - the protocol id.
		 * @param value - the value.
		 */
		async '$setValue'(shared: boolean, extensionId: string, value: unknown): Promise<void> {
			const path = storagePath(!!shared, String(extensionId))
			try {
				mkdirSync(join(path, '..'), { recursive: true })
				writeFileSync(path, JSON.stringify(value ?? null), 'utf8')
			} catch (error) {
				log(ctx, 'warn', '[dsh-vscode] an extension storage could not be written', {
					extensionId,
					reason: String((error as any)?.message ?? error),
				})
				throw error
			}
		},

		/**
		 * Note which keys the extension wants to synchronise.
		 *
		 * DSH has no settings synchronisation; the request is accepted and dropped.
		 *
		 * @param extension - the extension and its version.
		 * @param keys - the keys.
		 */
		'$registerExtensionStorageKeysToSync'(extension: unknown, keys: readonly string[]): void {
			host.log(
				`MainThreadStorage.$registerExtensionStorageKeysToSync(${Array.isArray(keys) ? keys.length : 0} keys) — ` +
				'DeepSeek Harness has no settings synchronisation',
			)
		},
	}
}
