/*---------------------------------------------------------------------------------------------
 *  DSH `dsh-vscode-protocol` — the DSH -> VS Code channel mapping.
 *
 *  DSH-authored glue (MIT). The channel tables themselves are Microsoft's, vendored verbatim.
 *
 *  THE ONE RULE
 *  ------------
 *  The channel names and the method names are VS Code's OWN, byte for byte:
 *
 *    - a channel is addressed by its key in `MainContext` / `ExtHostContext`
 *      (`'MainThreadCommands'`, `'ExtHostCommands'`, ...);
 *    - a method keeps its `$` prefix and its exact spelling
 *      (`'$registerCommand'`, `'$executeCommand'`, ...).
 *
 *  Renaming or abbreviating either of them breaks the contract with the vendored extension
 *  host: it looks the actor up by `ProxyIdentifier` and the method up by string, so
 *  `'$registercommand'` is simply "Unknown method".
 *
 *  The mapping layer below adds the DSH-side capability verdict for every channel, so the
 *  host can answer "what can DSH actually do for this service" without hard-coding a second
 *  list somewhere else.
 *--------------------------------------------------------------------------------------------*/

// The tables are imported AND re-exported: a bare `export { X } from '...'` creates no local
// binding, so the helpers below would read an undefined identifier.
import { ExtHostContext, MainContext } from '../../../../vendor/src/vs/workbench/api/common/extHost.protocol.js';

export { MainContext, ExtHostContext };

/** How well DSH supports one main-thread service. */
export type DshCapability =
	/** DSH implements the method with a real behaviour. */
	| 'implemented'
	/** DSH answers with a type-correct empty value; the call is accepted and dropped. */
	| 'stubbed'
	/** DSH has no counterpart for the service at all. */
	| 'unsupported';

/**
 * The DSH verdict per main-thread service.
 *
 * The keys are the `MainContext` KEY NAMES (not the proxy identifiers' `sid`), because the
 * `sid` of a few channels differs from its key (for example `MainThreadLanguageModelTools`
 * has the sid `MainThreadChatSkills`).
 */
export const DSH_MAIN_THREAD_CAPABILITY: Readonly<Record<string, DshCapability>> = {
	MainThreadCommands: 'implemented',
	MainThreadExtensionService: 'implemented',
	MainThreadConsole: 'implemented',
	MainThreadLogger: 'implemented',
	MainThreadStorage: 'implemented',
	MainThreadTelemetry: 'implemented',
	MainThreadMessageService: 'stubbed',
	MainThreadWindow: 'stubbed',
	MainThreadConfiguration: 'stubbed',
	MainThreadErrors: 'stubbed',
	MainThreadOutputService: 'stubbed',
	MainThreadFileSystem: 'stubbed',
	MainThreadLanguageModelTools: 'stubbed',
	MainThreadLanguageFeatures: 'stubbed',
	MainThreadCustomEditors: 'stubbed',
	MainThreadStatusBar: 'stubbed',
	MainThreadDocuments: 'stubbed',
	MainThreadTextEditors: 'stubbed',
	MainThreadTask: 'unsupported',
	MainThreadTerminalService: 'unsupported',
	MainThreadSCM: 'unsupported',
	MainThreadDebugService: 'unsupported',
	MainThreadNotebook: 'unsupported',
	MainThreadNotebookDocuments: 'unsupported',
	MainThreadNotebookEditors: 'unsupported',
	MainThreadNotebookKernels: 'unsupported',
	MainThreadNotebookRenderers: 'unsupported',
	MainThreadSearch: 'unsupported',
	MainThreadTesting: 'unsupported',
	MainThreadTimeline: 'unsupported',
	MainThreadWebviews: 'unsupported',
	MainThreadWebviewPanels: 'unsupported',
	MainThreadWebviewViews: 'unsupported',
	MainThreadSecretState: 'unsupported',
	MainThreadQuickOpen: 'unsupported',
	MainThreadDialogs: 'unsupported',
};

/** Every main-thread channel name, in the order VS Code declares them. */
export function mainThreadChannelNames(): string[] {
	return Object.keys(MainContext);
}

/** Every extension-host channel name, in the order VS Code declares them. */
export function extHostChannelNames(): string[] {
	return Object.keys(ExtHostContext);
}

/** Whether a name is one of VS Code's main-thread channels. */
export function isMainThreadChannel(name: string): boolean {
	return Object.hasOwn(MainContext, name);
}

/** Whether a name is one of VS Code's extension-host channels. */
export function isExtHostChannel(name: string): boolean {
	return Object.hasOwn(ExtHostContext, name);
}

/** The DSH verdict for one main-thread channel. */
export function mainThreadCapability(channel: string): DshCapability {
	return DSH_MAIN_THREAD_CAPABILITY[channel] ?? 'stubbed';
}
