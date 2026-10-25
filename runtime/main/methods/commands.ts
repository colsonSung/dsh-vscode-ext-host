/*---------------------------------------------------------------------------------------------
 *  A-class main-thread service — `commands`.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  Protocol shape: `MainThreadCommandsShape`
 *  (`vendor/src/vs/workbench/api/common/extHost.protocol.ts:137`).
 *
 *  DIRECTION (this is the part that is easy to get wrong)
 *  ------------------------------------------------------
 *  `MainThreadCommandsShape` is implemented by the MAIN side, and the ext host calls it:
 *
 *    - `$registerCommand(id)`   the ext host tells main "this command id exists"
 *                                (`vendor/src/vs/workbench/api/common/extHostCommands.ts:161`).
 *    - `$unregisterCommand(id)` the ext host tells main "it is gone" (`:167`).
 *    - `$fireCommandActivationEvent(id)` the ext host tells main "I fired the activation
 *                                event for this id" (`:185`).
 *    - `$executeCommand(id, args, retry)` the ext host asks main to run a command it does
 *                                NOT own itself (`:217`).
 *    - `$getCommands()` the ext host asks main for the whole command universe
 *                                (`extHostCommands.ts:327`).
 *
 *  The REVERSE direction — main asking the ext host to run a command an extension
 *  contributed — is `ExtHostCommandsShape.$executeContributedCommand`
 *  (`extHost.protocol.ts:2471`), which this module calls through `host.call`.
 *
 *  THE TWO NAMING WORLDS
 *  ---------------------
 *  A VS Code command id is `publisher.extension.action`: mixed case, dots. A DSH command
 *  name must match `/^[a-z][a-z0-9_-]*$/u`
 *  (`@deepseek-ai/dsh-commands/lib/index.js:78`, enforced at `:150`).
 *
 *  The mapping is `dshCommandName()` (see `support.ts`): lower-case, dots and other
 *  punctuation become `-`. It is NOT reversible, so this module keeps its own
 *  id -> name table; nothing ever tries to invert it.
 *--------------------------------------------------------------------------------------------*/

import type { ExtHostContext } from '../host-context.js';
import { setContextKey } from './lifecycle.js';
import { dshCommandName, hostCall, log, service } from './support.js';

/** The ext-host channel that runs a command an extension contributed. */
const EXT_HOST_CHANNEL_COMMANDS = 'ExtHostCommands';

/** The ext-host channel that activates an extension. */
const EXT_HOST_CHANNEL_EXTENSION_SERVICE = 'ExtHostExtensionService';

/**
 * The prefix of the DSH command definition's `definitionId`.
 *
 * `definitionId` is DSH's "stable, plugin-namespaced identity for adapters, independent of
 * display copy and execution commandId" (`@deepseek-ai/dsh-commands/lib/types`). The DSH
 * command NAME is a lossy slug of the VS Code command id, so the original id is kept here —
 * namespaced, so it cannot collide with another plugin's definition ids.
 */
const DSH_COMMAND_DEFINITION_PREFIX = 'vscode-ext-host/';

/** One command an extension registered. */
interface ContributedCommand {
	/** The VS Code command id, `publisher.extension.action`. */
	readonly id: string
	/** The DSH command name the id maps onto. */
	readonly dshName: string
	/** The disposer `ctx.commands.register` returned. */
	dispose?: () => void
}

/**
 * The handlers for one main-thread service.
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle (for client→main calls).
 * @returns a map of VS Code protocol method name to handler.
 */
export default function createCommandsMethods(ctx: any, host: ExtHostContext): Record<string, (...args: any[]) => any> {
	/** VS Code command id → the record for it. */
	const contributed = new Map<string, ContributedCommand>();
	/** DSH command name → the VS Code command id it stands for. */
	const byDshName = new Map<string, string>();

	/**
	 * The agent whose turn is currently running, if any.
	 *
	 * A DSH command needs an owning agent: `ctx.commands.execute(agent, ...)` writes the
	 * command's lifecycle into `agent.session` (`@deepseek-ai/dsh-commands/lib/index.js:334`).
	 * An extension that calls a DSH command from inside a tool call runs inside some agent's
	 * turn, and `ctx.agents.currentInitiator()` is that agent.
	 */
	function currentAgent(): any {
		const agents = service(ctx, 'agents')
		try {
			return agents?.currentInitiator?.()
		} catch {
			return undefined
		}
	}

	/**
	 * Unwrap the argument list of an `$executeCommand` call.
	 *
	 * The ext host sends a plain array unless one of the arguments is a buffer, in which case
	 * it wraps the array in a `SerializableObjectWithBuffers`
	 * (`vendor/src/vs/workbench/api/common/extHostCommands.ts:216`). The RPC layer rebuilds
	 * that wrapper on the receiving side (`rpcProtocol.ts:692`), so the main side sees an
	 * object with a `value` member.
	 *
	 * @param args - the raw second argument of the call.
	 * @returns the argument list.
	 */
	function argumentList(args: unknown): unknown[] {
		if (Array.isArray(args)) { return args }
		const wrapped = args as { value?: unknown } | undefined
		if (wrapped && Array.isArray(wrapped.value)) { return wrapped.value }
		return []
	}

	/**
	 * Run a command an extension contributed, inside the extension host.
	 *
	 * @param id - the VS Code command id.
	 * @param args - the command arguments.
	 * @returns whatever the extension's handler returned.
	 */
	async function runContributed(id: string, args: unknown[]): Promise<unknown> {
		return await hostCall<any>(host as any, EXT_HOST_CHANNEL_COMMANDS, '$executeContributedCommand', id, ...args)
	}

	/**
	 * The command title an extension declared for one of its commands.
	 *
	 * `contributes.commands[]` holds `{ command, title, category }`; the title is what a user
	 * sees in VS Code's command palette. DSH's command registry has ONE description field,
	 * so the declared title is the best text DSH can show — falling back to the command id
	 * when the extension declared nothing.
	 *
	 * @param id - the VS Code command id.
	 * @returns the description.
	 */
	function describeCommand(id: string): string {
		for (const extension of host.extensions ?? []) {
			const contributed = (extension as any)?.manifest?.contributes?.commands
			if (!Array.isArray(contributed)) { continue }
			for (const entry of contributed) {
				if (entry?.command !== id) { continue }
				const title = typeof entry.title === 'string' ? entry.title.trim() : ''
				const category = typeof entry.category === 'string' ? entry.category.trim() : ''
				if (title && category) { return `${category}: ${title}` }
				if (title) { return title }
			}
		}
		return `VS Code extension command: ${id}`
	}

	/**
	 * Register one extension-contributed command with DSH's command registry.
	 *
	 * The DSH command is a THIN PROXY: it takes the slash-command line, turns it into the
	 * extension's argument list and calls into the extension host. That way the command is
	 * reachable from a DSH session (a user types `/publisher-extension-action`) and from the
	 * model (through the `commands` surface), not only from inside the extension.
	 *
	 * The DSH command NAME is a lossy slug of the VS Code id (see `dshCommandName`), so the
	 * ORIGINAL id is kept in the definition's `definitionId` — DSH's own "stable,
	 * plugin-namespaced identity for adapters, independent of display copy and execution
	 * commandId" (`@deepseek-ai/dsh-commands/lib/types`). An adapter that needs the real
	 * VS Code id reads it from there instead of trying to invert the slug.
	 *
	 * @param id - the VS Code command id.
	 */
	function publishToDsh(id: string): void {
		const registry = service(ctx, 'commands')
		if (!registry?.register) {
			log(ctx, 'warn', '[dsh-vscode] the DSH command registry is unavailable; extension commands stay extension-only')
			return
		}
		const dshName = dshCommandName(id)
		const definition = {
			name: dshName,
			description: describeCommand(id),
			definitionId: `${DSH_COMMAND_DEFINITION_PREFIX}${id}`,
			handler: async (invocation: any) => {
				const args = decodeCommandInput(invocation?.rawInput)
				try {
					const value = await runContributed(id, args)
					return { kind: 'success', text: describeResult(value) }
				} catch (error) {
					return { kind: 'error', text: `the command "${id}" failed: ${String((error as any)?.message ?? error)}` }
				}
			},
		}
		try {
			const dispose = registry.register(definition)
			const record = contributed.get(id) ?? { id, dshName }
			record.dispose = typeof dispose === 'function' ? dispose : undefined
			contributed.set(id, record)
			byDshName.set(dshName, id)
		} catch (error) {
			// A duplicate DSH name means another extension (or a DSH-native command) already
			// owns it. The command stays reachable through `$executeCommand`, which resolves
			// the VS Code id directly.
			log(ctx, 'warn', '[dsh-vscode] the DSH command name is taken; the command stays extension-only', {
				id,
				dshName,
				reason: String((error as any)?.message ?? error),
			})
			contributed.set(id, { id, dshName })
			byDshName.set(dshName, id)
		}
	}

	/**
	 * Turn a slash-command line into the argument list of a VS Code command.
	 *
	 * A DSH command carries ONE string. The convention is: an empty line means "no
	 * arguments"; a line that parses as a JSON array is spread as the argument list; any
	 * other line is passed as a single string argument. An extension command that takes no
	 * arguments therefore behaves exactly as in VS Code.
	 *
	 * @param rawInput - the slash-command input.
	 * @returns the argument list.
	 */
	function decodeCommandInput(rawInput: unknown): unknown[] {
		if (typeof rawInput !== 'string' || rawInput.trim().length === 0) { return [] }
		const text = rawInput.trim()
		if (text.startsWith('[')) {
			try {
				const parsed = JSON.parse(text)
				if (Array.isArray(parsed)) { return parsed }
			} catch { /* not JSON after all */ }
		}
		return [rawInput]
	}

	/**
	 * Render a command result as the text a DSH command returns.
	 *
	 * @param value - whatever the extension's handler returned.
	 * @returns the text.
	 */
	function describeResult(value: unknown): string {
		if (value === undefined || value === null) { return 'done' }
		if (typeof value === 'string') { return value }
		try {
			return JSON.stringify(value)
		} catch {
			return String(value)
		}
	}

	// -------------------------------------------------------------------------
	// the protocol methods
	// -------------------------------------------------------------------------

	return {
		/**
		 * Note that an extension registered a command.
		 *
		 * The ext host calls this as soon as the extension's `activate()` runs
		 * (`extHostCommands.ts:161`). DSH answers by publishing the command into its own
		 * command registry, so a DSH session can run it.
		 *
		 * @param id - the VS Code command id.
		 */
		'$registerCommand'(id: string): void {
			if (typeof id !== 'string' || id.length === 0) { return }
			if (contributed.has(id)) { return }
			// The host's own command table keeps the callback, so the Extensions page and the
			// model tool can list and run the command without the extension host's help.
			try {
				host.commands?.set?.(id, async (...args: any[]) => await runContributed(id, args))
			} catch { /* the handle is read-only in some builds */ }
			publishToDsh(id)
		},

		/**
		 * Note that an extension disposed a command.
		 *
		 * @param id - the VS Code command id.
		 */
		'$unregisterCommand'(id: string): void {
			const record = contributed.get(id)
			if (!record) { return }
			try {
				record.dispose?.()
			} catch { /* a disposer must not break the protocol */ }
			contributed.delete(id)
			byDshName.delete(record.dshName)
		},

		/**
		 * Activate the extension that owns a command.
		 *
		 * The ext host fires the activation event locally and tells main about it
		 * (`extHostCommands.ts:185`); main is the side that can actually start the
		 * extension, so the activation is requested here.
		 *
		 * @param id - the VS Code command id.
		 */
		async '$fireCommandActivationEvent'(id: string): Promise<void> {
			if (typeof id !== 'string' || id.length === 0) { return }
			await hostCall(
				host as any,
				EXT_HOST_CHANNEL_EXTENSION_SERVICE,
				'$activateByEvent',
				`onCommand:${id}`,
				0 /* ActivationKind.Normal */,
			)
		},

		/**
		 * Run a command on behalf of the extension host.
		 *
		 * Four cases, in order:
		 *   1. the id is one of VS Code's own API commands (`_setContext`, …) — handled here;
		 *   2. the id is a command an extension contributed — run it in the extension host;
		 *   3. the id is a DSH command — run it through `ctx.commands`;
		 *   4. the id is unknown here — ask the ext host to retry, which makes it look the
		 *      command up in its OWN registry (`extHostCommands.ts:220-224`).
		 *
		 * @param id - the command id.
		 * @param args - the arguments, possibly wrapped in `SerializableObjectWithBuffers`.
		 * @param retry - whether the ext host allows a retry.
		 * @returns the command's result.
		 */
		async '$executeCommand'(id: string, args: unknown, retry: boolean): Promise<unknown> {
			const list = argumentList(args)

			// 1. VS Code's own API commands. `vscode.setContext` reaches the main side as the
			//    workbench command `_setContext` (`extHostApiCommands.ts:532`).
			if (id === '_setContext') {
				return setContext(list)
			}

			// 2. A command an extension contributed. The ext host only asks the main side for
			//    commands it does not own, so this is the rare path — but when it happens the
			//    extension host is the one that has to run it.
			if (contributed.has(id)) {
				return await runContributed(id, list)
			}

			// 3. A DSH command. A DSH command name is already a valid VS Code command id, so
			//    the id itself is tried first; the mapped name is the fallback.
			const registry = service(ctx, 'commands')
			const agent = currentAgent()
			if (registry?.execute && agent) {
				const dshName = registry.find?.(agent, id) ? id : dshCommandName(id)
				if (registry.find?.(agent, dshName)) {
					const line = `/${dshName}${list.length > 0 ? ` ${encodeCommandInput(list)}` : ''}`
					const outcome = await registry.execute(agent, line, [], new AbortController().signal)
					return (outcome as any)?.value
				}
			}

			// 4. Unknown on this side. The ext host may still own it — ask it to retry, which
			//    makes it look the command up in its OWN registry
			//    (`vendor/src/vs/workbench/api/common/extHostCommands.ts:220-224`).
			if (retry) {
				throw new Error('$executeCommand:retry')
			}
			return undefined
		},

		/**
		 * List the commands the extension host may call.
		 *
		 * The ext host asks for the whole universe (`extHostCommands.ts:327`); VS Code
		 * filters the `_`-prefixed ones out when the caller asks for it. DSH answers with
		 * the extension-contributed VS Code ids plus the DSH command names this module
		 * published, so an extension can discover both.
		 *
		 * @returns the command ids.
		 */
		async '$getCommands'(): Promise<string[]> {
			const ids = new Set<string>()
			for (const record of contributed.values()) { ids.add(record.id) }
			const registry = service(ctx, 'commands')
			const agent = currentAgent()
			if (registry?.list && agent) {
				try {
					for (const descriptor of registry.list(agent) ?? []) {
						if (descriptor?.name) { ids.add(descriptor.name) }
					}
				} catch { /* an unreadable registry just means fewer commands are listed */ }
			}
			return [...ids]
		},
	}

	/**
	 * Store one VS Code context key.
	 *
	 * `vscode.setContext(key, value)` exists so that a `when` clause can read the key. DSH
	 * has no `when` clauses and no keybinding context, so the value is only KEPT, for the
	 * Extensions page and for diagnostics.
	 *
	 * @param list - the `[key, value]` pair.
	 * @returns nothing.
	 */
	function setContext(list: unknown[]): undefined {
		const key = typeof list[0] === 'string' ? list[0] : undefined
		if (!key) { return undefined }
		setContextKey(key, list[1])
		return undefined
	}
}

/**
 * Encode an argument list back into the slash-command input.
 *
 * @param list - the arguments.
 * @returns the text.
 */
function encodeCommandInput(list: unknown[]): string {
	try {
		return JSON.stringify(list)
	} catch {
		return ''
	}
}
