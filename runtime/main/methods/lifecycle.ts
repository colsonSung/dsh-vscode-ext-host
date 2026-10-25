/*---------------------------------------------------------------------------------------------
 *  A-class main-thread service — `lifecycle`.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  THE THREE NAMES THE PLAN MENTIONS, AND WHERE THEY REALLY LIVE
 *  -----------------------------------------------------------
 *  The plan for this class listed `$onDidSetContext`, `$shutdown` and `$setLogLevel` as
 *  "lifecycle" methods. None of the three is a main-thread method in the VS Code protocol
 *  this project vendors (commit `1184ad4d`):
 *
 *  | name               | where it really is                                                        |
 *  |--------------------|---------------------------------------------------------------------------|
 *  | `$onDidSetContext` | **does not exist**. `vscode.setContext(key, value)` is an API command       |
 *  |                    | (`_setContext`, `vendor/src/vs/workbench/api/common/extHostApiCommands.ts:532`) |
 *  |                    | that reaches the main side as `MainThreadCommands.$executeCommand`. It is |
 *  |                    | implemented in `commands.ts`.                                             |
 *  | `$shutdown`        | **does not exist** as a protocol method. VS Code stops the extension host   |
 *  |                    | by closing the RPC socket; DSH does the same.                            |
 *  | `$setLogLevel`     | lives on `ExtHostLogLevelServiceShape`                                     |
 *  |                    | (`extHost.protocol.ts:3537`) — the EXTENSION HOST implements it and the    |
 *  |                    | MAIN side calls it. It is therefore a main→client call, not a handler.    |
 *
 *  This module therefore owns the one main-side method that IS a lifecycle verb —
 *  `MainThreadExtensionService.$activateExtension` — and it hosts the small helpers the
 *  runtime owner needs for the rest of the lifecycle.
 *
 *  THE CHANNEL SPLIT
 *  -----------------
 *  `MainThreadExtensionService` is shared with `extensions.ts`, which owns the DESCRIPTION
 *  half of it (`$getExtension` and the activation notifications). The registry merges the
 *  services of one channel method by method, and the two modules define DISJOINT method
 *  sets, so the order in `SERVICES` does not matter.
 *--------------------------------------------------------------------------------------------*/

import type { ExtHostContext } from '../host-context.js';
import { log, toExtensionIdentifier } from './support.js';

/** The context keys an extension set through `vscode.setContext`. */
const contextKeys = new Map<string, unknown>();

/** The log level the extension host was told about, or `undefined`. */
let currentLogLevel: number | undefined;

/**
 * Store one VS Code context key.
 *
 * `vscode.setContext(key, value)` exists so that a `when` clause can read the key. DSH has
 * no `when` clauses and no keybinding context, so the value is only KEPT, for the Extensions
 * page and for diagnostics.
 *
 * @param key - the context key.
 * @param value - the value.
 */
export function setContextKey(key: string, value: unknown): void {
	if (typeof key !== 'string' || key.length === 0) { return }
	contextKeys.set(key, value)
}

/**
 * Read the context keys an extension set.
 *
 * @returns the keys and their values.
 */
export function contextKeySnapshot(): Record<string, unknown> {
	return Object.fromEntries(contextKeys)
}

/**
 * Tell the extension host that the log level changed.
 *
 * `ExtHostLogLevelServiceShape.$setLogLevel` is implemented by the EXTENSION HOST
 * (`extHostLoggerService.ts:26`), so the main side CALLS it. DSH ships the level in the init
 * payload (`init-data.ts:193`); this helper is for a level that changes while the host runs.
 *
 * @param host - the extension host handle.
 * @param level - the VS Code `LogLevel` (1 = Error … 5 = Trace).
 * @returns whether the ext host accepted it.
 */
export async function setExtensionHostLogLevel(host: ExtHostContext, level: number): Promise<boolean> {
	currentLogLevel = level
	try {
		await host.call('ExtHostLogLevelServiceShape', '$setLogLevel', level)
		return true
	} catch (error) {
		host.log(`the extension host refused the log level: ${String((error as any)?.message ?? error)}`)
		return false
	}
}

/**
 * The log level the extension host was told about.
 *
 * @returns the level, or `undefined`.
 */
export function extensionHostLogLevel(): number | undefined {
	return currentLogLevel
}

/**
 * The handlers for one main-thread service.
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle (for client→main calls).
 * @returns a map of VS Code protocol method name to handler.
 */
export default function createLifecycleMethods(ctx: any, host: ExtHostContext): Record<string, (...args: any[]) => any> {
	/**
	 * The protocol id of an extension identifier on the wire.
	 *
	 * @param id - the identifier.
	 * @returns the protocol id, `publisher.name`.
	 */
	function identifierValue(id: unknown): string {
		if (typeof id === 'string') { return id }
		const value = (id as any)?.value
		if (typeof value === 'string') { return value }
		const plain = (id as any)?.id
		if (typeof plain === 'string') { return plain }
		return String(id)
	}

	return {
		/**
		 * Activate one extension.
		 *
		 * The main side is the side that can start an extension, so the request is forwarded
		 * to the ext host's own activator (`ExtHostExtensionServiceShape.$activate`,
		 * `extHost.protocol.ts`).
		 *
		 * The `reason` is an `ExtensionActivationReason`
		 * (`vendor/src/vs/workbench/services/extensions/common/extensions.ts:345`):
		 * `{ startup, extensionId, activationEvent }`. When the ext host does not send one,
		 * a synthetic reason is built so that the ext host's activator always has one.
		 *
		 * @param extensionId - the protocol id.
		 * @param reason - the activation reason.
		 */
		async '$activateExtension'(extensionId: unknown, reason: unknown): Promise<void> {
			const id = identifierValue(extensionId)
			if (!id) { return }
			try {
				await host.call(
					'ExtHostExtensionService',
					'$activate',
					toExtensionIdentifier(id),
					reason ?? { startup: false, extensionId: toExtensionIdentifier(id), activationEvent: '' },
				)
			} catch (error) {
				log(ctx, 'warn', '[dsh-vscode] an extension could not be activated', {
					id,
					reason: String((error as any)?.message ?? error),
				})
			}
		},
	}
}
