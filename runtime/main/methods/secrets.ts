/*---------------------------------------------------------------------------------------------
 *  A-class main-thread service — `secrets`.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  Protocol shape: `MainThreadSecretStateShape`
 *  (`vendor/src/vs/workbench/api/common/extHost.protocol.ts:243`).
 *
 *      $getPassword(extensionId, key): Promise<string | undefined>
 *      $setPassword(extensionId, key, value): Promise<void>
 *      $deletePassword(extensionId, key): Promise<void>
 *      $getKeys(extensionId): Promise<string[]>
 *
 *  THE KEY ENCODING
 *  ----------------
 *  A VS Code secret key is an arbitrary string (`"my api key"`). DSH's `CredentialRef` must
 *  match `/^[A-Za-z_][A-Za-z0-9_]*$/` — a POSIX shell identifier
 *  (`@deepseek-ai/dsh-credentials/lib/index.js:13`) — so the key cannot be used verbatim.
 *
 *  DSH encodes it as:
 *
 *      DSH_VSCODE_<publisher>_<name>_<sha256(key) first 16 hex chars>
 *
 *  The hash keeps two keys of the same extension apart even when their sanitized forms
 *  collide, and the encoding is STABLE: the same key always maps onto the same reference, so
 *  a value stored by one extension-host session is found by the next one.
 *
 *  `$getKeys` has no equivalent on the DSH side: `ctx.credentials` can list RECORDS
 *  (`listRecords()`), but the records are DSH's own, and the extension's original keys are
 *  not recoverable from the hash. The answer is therefore the empty list.
 *--------------------------------------------------------------------------------------------*/

import type { ExtHostContext } from '../host-context.js';
import { credentialRefFor, log, service } from './support.js';

/**
 * The handlers for one main-thread service.
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle (for client→main calls).
 * @returns a map of VS Code protocol method name to handler.
 */
export default function createSecretsMethods(ctx: any, host: ExtHostContext): Record<string, (...args: any[]) => any> {
	/**
	 * The DSH credential service, or `undefined`.
	 *
	 * @returns the service.
	 */
	function credentials(): any {
		return service(ctx, 'credentials')
	}

	/**
	 * The DSH credential reference that holds one extension secret.
	 *
	 * @param extensionId - the protocol id, `publisher.name`.
	 * @param key - the VS Code secret key.
	 * @returns the reference.
	 */
	function refFor(extensionId: string, key: string): string {
		return credentialRefFor(extensionId, key).ref
	}

	return {
		/**
		 * Read one secret.
		 *
		 * @param extensionId - the protocol id.
		 * @param key - the VS Code secret key.
		 * @returns the value, or `undefined` when there is none.
		 */
		async '$getPassword'(extensionId: string, key: string): Promise<string | undefined> {
			const store = credentials()
			if (!store?.resolve) {
				log(ctx, 'warn', '[dsh-vscode] the credential service is unavailable; the extension secret cannot be read')
				return undefined
			}
			try {
				const resolved = await store.resolve(refFor(String(extensionId), String(key)))
				const value = (resolved as any)?.value
				return typeof value === 'string' ? value : undefined
			} catch (error) {
				log(ctx, 'warn', '[dsh-vscode] an extension secret could not be read', {
					extensionId,
					reason: String((error as any)?.message ?? error),
				})
				return undefined
			}
		},

		/**
		 * Write one secret.
		 *
		 * @param extensionId - the protocol id.
		 * @param key - the VS Code secret key.
		 * @param value - the value.
		 */
		async '$setPassword'(extensionId: string, key: string, value: string): Promise<void> {
			const store = credentials()
			if (!store?.set) {
				throw new Error('NotSupported: the credential service is unavailable, the extension secret cannot be stored')
			}
			try {
				await store.set(refFor(String(extensionId), String(key)), String(value))
			} catch (error) {
				log(ctx, 'warn', '[dsh-vscode] an extension secret could not be written', {
					extensionId,
					reason: String((error as any)?.message ?? error),
				})
				throw error
			}
		},

		/**
		 * Remove one secret.
		 *
		 * @param extensionId - the protocol id.
		 * @param key - the VS Code secret key.
		 */
		async '$deletePassword'(extensionId: string, key: string): Promise<void> {
			const store = credentials()
			if (!store?.unset) {
				throw new Error('NotSupported: the credential service is unavailable, the extension secret cannot be removed')
			}
			try {
				await store.unset(refFor(String(extensionId), String(key)))
			} catch (error) {
				log(ctx, 'warn', '[dsh-vscode] an extension secret could not be removed', {
					extensionId,
					reason: String((error as any)?.message ?? error),
				})
				throw error
			}
		},

		/**
		 * List the secrets of one extension.
		 *
		 * The DSH credential store lists its own RECORDS, and the extension's original keys
		 * are not recoverable from the hash the reference is built from. The answer is the
		 * empty list, which is the type-correct empty value.
		 *
		 * @returns `[]`.
		 */
		async '$getKeys'(): Promise<string[]> {
			return []
		},
	}
}
