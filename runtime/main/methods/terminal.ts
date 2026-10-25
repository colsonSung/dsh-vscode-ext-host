/*---------------------------------------------------------------------------------------------
 *  A-class main-thread service — `terminal`.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  Protocol shape: `MainThreadTerminalServiceShape`
 *  (`vendor/src/vs/workbench/api/common/extHost.protocol.ts:690`).
 *
 *  WHAT DSH'S TERMINAL IS, AND WHAT IT IS NOT
 *  -------------------------------------------
 *  DSH's terminal service (`@deepseek-ai/dsh-terminal`, `ctx.terminals`) is an IN-PROCESS
 *  registry of replaceable PTY backends and of EXACT-AGENT sessions:
 *
 *      registerBackend(backend)          listBackends()
 *      spawn(owner: Agent, request, signal?)          startSend(owner, id, request)
 *      read(owner, id, request?)                       signal(owner, id, signal)
 *      kill(owner, id, reason?)                        list(owner)
 *
 *  Two consequences, and they are the whole story of this module:
 *
 *    1. every terminal operation needs an OWNING AGENT. VS Code's terminals are owned by the
 *       UI, not by an agent. DSH's are the other way round. The agent that is driving the
 *       current turn (`ctx.agents.currentInitiator()`) is the closest match, and it is only
 *       there while a turn runs.
 *    2. DSH has NO `Pseudoterminal`: an extension cannot implement the terminal process
 *       itself. `ctx.terminals` only starts a real PTY through a registered backend.
 *
 *  WHAT IS IMPLEMENTED
 *  -------------------
 *  - `$createTerminal` starts a real PTY when an agent is available, and THROWS
 *    `NotSupported` when there is none. The protocol method is a write, and the spike's rule
 *    is that a write which cannot work throws rather than pretending.
 *  - `$sendText` and `$dispose` forward to the owning agent's session.
 *  - `$show` / `$hide` are accepted and dropped: DSH has a terminal, but no terminal PANEL
 *    the extension can ask to be shown. **[inferred]** the terminal still runs.
 *  - every registration method (`$registerProcessSupport`, `$registerProfileProvider`,
 *    `$registerCompletionProvider`, `$registerQuickFixProvider`) is accepted and dropped —
 *    they are registration calls, and throwing inside `activate()` would break the extension.
 *  - the process-support notifications (`$sendProcessData`, `$sendProcessReady`,
 *    `$sendProcessProperty`, `$sendProcessExit`) are dropped: they only apply to a
 *    `Pseudoterminal`, which DSH does not have.
 *--------------------------------------------------------------------------------------------*/

import type { ExtHostContext } from '../host-context.js';
import { log, notSupported, service } from './support.js';

/**
 * The handlers for one main-thread service.
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle (for client→main calls).
 * @returns a map of VS Code protocol method name to handler.
 */
export default function createTerminalMethods(ctx: any, host: ExtHostContext): Record<string, (...args: any[]) => any> {
	/** The ext-host terminal id → the DSH terminal session id. */
	const sessions = new Map<string, string>()

	/**
	 * The DSH terminal service, or `undefined`.
	 *
	 * @returns the service.
	 */
	function terminals(): any {
		return service(ctx, 'terminals')
	}

	/**
	 * The agent that owns a terminal.
	 *
	 * @returns the agent, or `undefined` when no turn is running.
	 */
	function owner(): any {
		const agents = service(ctx, 'agents')
		try {
			return agents?.currentInitiator?.()
		} catch {
			return undefined
		}
	}

	return {
		/**
		 * Start a terminal.
		 *
		 * @param extHostTerminalId - the id the extension host knows the terminal by.
		 * @param config - the `TerminalLaunchConfig`.
		 */
		async '$createTerminal'(extHostTerminalId: string, config: any): Promise<void> {
			const registry = terminals()
			const agent = owner()
			if (!registry?.spawn || !agent) {
				throw notSupported(
					'creating a terminal',
					'DeepSeek Harness terminals are owned by an agent, and no agent is driving a turn right now',
				)
			}
			try {
				const result = await registry.spawn(agent, {
					type: typeof config?.name === 'string' ? config.name : 'shell',
					name: typeof config?.name === 'string' ? config.name : undefined,
					cwd: typeof config?.cwd === 'string' ? config.cwd : undefined,
				})
				const sessionId = (result as any)?.id ?? (result as any)?.sessionId
				if (typeof sessionId === 'string') {
					sessions.set(String(extHostTerminalId), sessionId)
				}
			} catch (error) {
				log(ctx, 'warn', '[dsh-vscode] a terminal could not be started', {
					id: extHostTerminalId,
					reason: String((error as any)?.message ?? error),
				})
				throw error
			}
		},

		/**
		 * Send text to a terminal.
		 *
		 * @param id - the ext-host terminal id.
		 * @param text - the text.
		 * @param shouldExecute - whether the text is submitted.
		 */
		async '$sendText'(id: unknown, text: string, shouldExecute: boolean): Promise<void> {
			const registry = terminals()
			const agent = owner()
			const sessionId = sessions.get(String((id as any)?.value ?? id))
			if (!registry?.startSend || !agent || !sessionId) {
				throw notSupported('sending text to a terminal', 'the terminal does not belong to a running agent')
			}
			await registry.startSend(agent, sessionId, {
				text: String(text ?? ''),
				submit: shouldExecute !== false,
			})
		},

		/**
		 * Dispose a terminal.
		 *
		 * @param id - the ext-host terminal id.
		 */
		async '$dispose'(id: unknown): Promise<void> {
			const registry = terminals()
			const agent = owner()
			const key = String((id as any)?.value ?? id)
			const sessionId = sessions.get(key)
			sessions.delete(key)
			if (!registry?.kill || !agent || !sessionId) { return }
			try {
				await registry.kill(agent, sessionId, 'the extension disposed the terminal')
			} catch { /* the terminal is gone either way */ }
		},

		/**
		 * Show a terminal.
		 *
		 * DSH has no terminal panel the extension can ask to be shown; the terminal keeps
		 * running.
		 *
		 * @param id - the ext-host terminal id.
		 */
		async '$show'(id: unknown): Promise<void> {
			host.log('MainThreadTerminalService.$show is ignored: DeepSeek Harness has no terminal panel')
		},

		/**
		 * Hide a terminal.
		 *
		 * @param id - the ext-host terminal id.
		 */
		async '$hide'(id: unknown): Promise<void> {
			host.log('MainThreadTerminalService.$hide is ignored: DeepSeek Harness has no terminal panel')
		},

		/**
		 * Note whether the extension implements the terminal process itself.
		 *
		 * DSH has no `Pseudoterminal`, so the answer does not change anything.
		 *
		 * @param isSupported - whether the extension implements the process.
		 */
		'$registerProcessSupport'(isSupported: boolean): void {
			host.log(`MainThreadTerminalService.$registerProcessSupport(${isSupported}) — DSH has no Pseudoterminal`)
		},

		/**
		 * Register a shell profile provider.
		 *
		 * @param id - the provider id.
		 * @param extensionIdentifier - the owning extension.
		 */
		'$registerProfileProvider'(id: string, extensionIdentifier: string): void {
			// DSH has no shell profiles; the registration is dropped.
		},

		/**
		 * Unregister a shell profile provider.
		 *
		 * @param id - the provider id.
		 */
		'$unregisterProfileProvider'(id: string): void {
			// DSH has no shell profiles; the registration is dropped.
		},

		/**
		 * Register a terminal completion provider.
		 *
		 * @param id - the provider id.
		 * @param extensionIdentifier - the owning extension.
		 * @param triggerCharacters - the trigger characters.
		 */
		'$registerCompletionProvider'(id: string, extensionIdentifier: string, ...triggerCharacters: string[]): void {
			// DSH's terminals have no completion provider; the registration is dropped.
		},

		/**
		 * Unregister a terminal completion provider.
		 *
		 * @param id - the provider id.
		 */
		'$unregisterCompletionProvider'(id: string): void {
			// DSH's terminals have no completion provider; the registration is dropped.
		},

		/**
		 * Register a terminal quick-fix provider.
		 *
		 * @param id - the provider id.
		 * @param extensionIdentifier - the owning extension.
		 */
		'$registerQuickFixProvider'(id: string, extensionIdentifier: string): void {
			// DSH's terminals have no quick-fix provider; the registration is dropped.
		},

		/**
		 * Unregister a terminal quick-fix provider.
		 *
		 * @param id - the provider id.
		 */
		'$unregisterQuickFixProvider'(id: string): void {
			// DSH's terminals have no quick-fix provider; the registration is dropped.
		},

		/**
		 * Contribute environment variables to the terminals.
		 *
		 * DSH's `ctx.shellEnv` collects trusted `DSH_*` variables only, so an extension's
		 * arbitrary variables are not contributed.
		 *
		 * @param extensionIdentifier - the owning extension.
		 * @param persistent - whether the contribution is persistent.
		 * @param collection - the variables.
		 * @param descriptionMap - the descriptions.
		 */
		'$setEnvironmentVariableCollection'(
			extensionIdentifier: string,
			persistent: boolean,
			collection: unknown,
			descriptionMap: unknown,
		): void {
			host.log(
				'MainThreadTerminalService.$setEnvironmentVariableCollection is ignored: ' +
				'DeepSeek Harness collects trusted DSH_* variables only',
			)
		},

		/**
		 * Start sending terminal data events.
		 */
		'$startSendingDataEvents'(): void {
			// No data events: DSH's terminals are polled, not pushed.
		},

		/**
		 * Stop sending terminal data events.
		 */
		'$stopSendingDataEvents'(): void {
			// No data events: DSH's terminals are polled, not pushed.
		},

		/**
		 * Start sending terminal command events.
		 */
		'$startSendingCommandEvents'(): void {
			// No command events.
		},

		/**
		 * Stop sending terminal command events.
		 */
		'$stopSendingCommandEvents'(): void {
			// No command events.
		},

		/**
		 * Start the link provider.
		 */
		'$startLinkProvider'(): void {
			// DSH has no terminal link provider.
		},

		/**
		 * Stop the link provider.
		 */
		'$stopLinkProvider'(): void {
			// DSH has no terminal link provider.
		},

		/**
		 * Receive the data of an extension-implemented terminal process.
		 *
		 * Only a `Pseudoterminal` produces these, and DSH has none.
		 *
		 * @param terminalId - the terminal id.
		 * @param data - the data.
		 */
		'$sendProcessData'(terminalId: number, data: string): void {
			// Only a Pseudoterminal produces these, and DSH has none.
		},

		/**
		 * Receive the "process ready" notification of an extension-implemented terminal.
		 *
		 * @param terminalId - the terminal id.
		 * @param pid - the process id.
		 * @param cwd - the working directory.
		 * @param windowsPty - the Windows PTY marker.
		 */
		'$sendProcessReady'(terminalId: number, pid: number, cwd: string, windowsPty: unknown): void {
			// Only a Pseudoterminal produces these, and DSH has none.
		},

		/**
		 * Receive a property change of an extension-implemented terminal.
		 *
		 * @param terminalId - the terminal id.
		 * @param property - the property.
		 */
		'$sendProcessProperty'(terminalId: number, property: unknown): void {
			// Only a Pseudoterminal produces these, and DSH has none.
		},

		/**
		 * Receive the exit of an extension-implemented terminal process.
		 *
		 * @param terminalId - the terminal id.
		 * @param exitCode - the exit code.
		 */
		'$sendProcessExit'(terminalId: number, exitCode: number | undefined): void {
			// Only a Pseudoterminal produces these, and DSH has none.
		},
	}
}
