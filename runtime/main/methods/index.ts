/*---------------------------------------------------------------------------------------------
 *  DSH S1 production — the main-thread METHOD REGISTRY.
 *
 *  DSH-authored (MIT).
 *
 *  This file is the registry. One entry per main-thread service; the service's own module
 *  lives next to it as `methods/<service>.ts` and default-exports a factory:
 *
 *      export default function createXxxMethods(ctx: any, host: any): Record<string, handler> {
 *          return {
 *              '$someMethod'(...args: any[]) { /* ... *\/ },
 *          };
 *      }
 *
 *  THE RULES
 *  ---------
 *  1. The method names are VS Code's OWN, byte for byte, `$` prefix included. The extension
 *     host looks a method up by string, so `'$registercommand'` is "Unknown method".
 *  2. The channel is the KEY NAME of `MainContext` (`'MainThreadCommands'`), not the proxy
 *     identifier's sid — a few channels have a different sid (`MainThreadLanguageModelTools`
 *     has the sid `MainThreadChatSkills`).
 *  3. The grouped export exists because 14 method names live on more than one channel
 *     (`$executeCommand`, `$reveal`, `$show`, `$postMessage`, `$dispose`, ...). A flat map
 *     cannot say which channel a handler belongs to.
 *  4. **LATER WINS.** The services are merged in the order of {@link SERVICES}; when two of
 *     them define the same method on the same channel, the later one wins. The table is
 *     therefore ordered from the most general fallback to the most specific implementation:
 *     the host's own core first, then the per-service modules.
 *
 *  The main side registers EVERY `MainThread*` channel; the handlers listed here override the
 *  type-correct stub for the methods they implement.
 *--------------------------------------------------------------------------------------------*/

import type { ExtHostContext, MainThreadMethodFactory, MainThreadMethods } from '../host-context.js';

import {
	createCommandsMethods as createHostCoreCommandsMethods,
	createConfigurationMethods as createHostCoreConfigurationMethods,
	createConsoleMethods,
	createErrorsMethods,
	createExtensionServiceMethods,
	createLoggerMethods,
	createMessageServiceMethods,
	createOutputServiceMethods,
	createStorageMethods as createHostCoreStorageMethods,
	createTelemetryMethods,
	createWindowMethods,
} from './host-core.js';

import createAiToolsMethods from './ai-tools.js';
import createAiModelsMethods from './ai-models.js';
import createAiMcpMethods from './ai-mcp.js';
import createAiChatAgentsMethods from './ai-chat-agents.js';
import createAiChatSessionsMethods from './ai-chat-sessions.js';

import createCommandsMethods from './commands.js';
import createConfigurationMethods from './configuration.js';
import createEnvMethods from './env.js';
import createExtensionsMethods from './extensions.js';
import createFileSystemMethods from './fileSystem.js';
import createLanguagesMethods from './languages.js';
import createLifecycleMethods from './lifecycle.js';
import createSecretsMethods from './secrets.js';
import createStorageMethods from './storage.js';
import createTerminalMethods from './terminal.js';
import createUriMethods from './uri.js';
import createWorkspaceMethods from './workspace.js';
import {
	createCustomEditorsMethods,
	createDecorationsMethods,
	createDiagnosticsMethods,
	createDocumentContentProvidersMethods,
	createDocumentDiffMethods,
	createDocumentsMethods,
	createEditorInsetsMethods,
	createEditorTabsMethods,
	createLanguageFeaturesMethods,
	createQuickDiffMethods,
	createTextEditorsMethods,
} from './editor-family.js';

// The webview family. These MUST come after the editor family above: the editor family
// answers the same channel names with "not supported", and the later entry wins.
import createWebviewCustomEditorsMethods from './custom-editors.js';
import createCustomEditorDocumentsMethods from './custom-editor-documents.js';
import createWebviewPanelsMethods from './webview-panels.js';
import createWebviewsMethods from './webview-content.js';
import createWebviewViewsMethods from './webview-views.js';

/**
 * One main-thread service: the channel it owns and the factory that builds its handlers.
 */
export interface MainThreadService {
	/** The `MainContext` key name, e.g. `'MainThreadCommands'`. */
	readonly channel: string;
	/** The factory that returns the service's handlers. */
	readonly create: MainThreadMethodFactory;
}

/**
 * The services that have a DSH implementation, in merge order.
 *
 * LATER WINS: a service registered after another one takes the channel over for the methods
 * both of them define.
 */
export const SERVICES: MainThreadService[] = [
	// --- the host's own core -------------------------------------------------------------------
	// The channels the extension host cannot work without. Everything here is the fallback for
	// a channel no per-service module covers.
	{ channel: 'MainThreadCommands', create: createHostCoreCommandsMethods },
	{ channel: 'MainThreadExtensionService', create: createExtensionServiceMethods },
	{ channel: 'MainThreadConsole', create: createConsoleMethods },
	{ channel: 'MainThreadLogger', create: createLoggerMethods },
	{ channel: 'MainThreadErrors', create: createErrorsMethods },
	{ channel: 'MainThreadStorage', create: createHostCoreStorageMethods },
	{ channel: 'MainThreadTelemetry', create: createTelemetryMethods },
	{ channel: 'MainThreadOutputService', create: createOutputServiceMethods },
	{ channel: 'MainThreadWindow', create: createWindowMethods },
	{ channel: 'MainThreadMessageService', create: createMessageServiceMethods },
	{ channel: 'MainThreadConfiguration', create: createHostCoreConfigurationMethods },

	// --- A-class: one module per main-thread service --------------------------------------------
	// These take the channels over from the host's own core above.
	{ channel: 'MainThreadCommands', create: createCommandsMethods },
	{ channel: 'MainThreadConfiguration', create: createConfigurationMethods },
	{ channel: 'MainThreadExtensionService', create: createEnvMethods },
	{ channel: 'MainThreadExtensionService', create: createExtensionsMethods },
	{ channel: 'MainThreadExtensionService', create: createLifecycleMethods },
	{ channel: 'MainThreadFileSystem', create: createFileSystemMethods },
	{ channel: 'MainThreadLanguages', create: createLanguagesMethods },
	{ channel: 'MainThreadSecretState', create: createSecretsMethods },
	{ channel: 'MainThreadStorage', create: createStorageMethods },
	{ channel: 'MainThreadTerminalService', create: createTerminalMethods },
	{ channel: 'MainThreadUrls', create: createUriMethods },
	{ channel: 'MainThreadWorkspace', create: createWorkspaceMethods },

	// --- A-class: the editor family, one channel each ---------------------------------------------
	{ channel: 'MainThreadLanguageFeatures', create: createLanguageFeaturesMethods },
	{ channel: 'MainThreadDocuments', create: createDocumentsMethods },
	{ channel: 'MainThreadTextEditors', create: createTextEditorsMethods },
	{ channel: 'MainThreadDecorations', create: createDecorationsMethods },
	{ channel: 'MainThreadDocumentContentProviders', create: createDocumentContentProvidersMethods },
	{ channel: 'MainThreadDiagnostics', create: createDiagnosticsMethods },
	{ channel: 'MainThreadDocumentDiff', create: createDocumentDiffMethods },
	{ channel: 'MainThreadQuickDiff', create: createQuickDiffMethods },
	{ channel: 'MainThreadEditorInsets', create: createEditorInsetsMethods },
	{ channel: 'MainThreadEditorTabs', create: createEditorTabsMethods },

	// --- the webview family -------------------------------------------------------------------
	// A webview is a DOCUMENT the extension produced, addressed by a handle. DSH has no
	// editor, no tab system and no view containers, so there is no "open the panel" step:
	// the surface renders the produced HTML where the file is previewed.
	{ channel: 'MainThreadCustomEditors', create: createWebviewCustomEditorsMethods },
	{ channel: 'MainThreadDocuments', create: createCustomEditorDocumentsMethods },
	{ channel: 'MainThreadWebviewPanels', create: createWebviewPanelsMethods },
	{ channel: 'MainThreadWebviews', create: createWebviewsMethods },
	{ channel: 'MainThreadWebviewViews', create: createWebviewViewsMethods },

	// --- D-class: the AI services -------------------------------------------------------------------
	// The channel is the `MainContext` KEY NAME. `MainThreadLanguageModelTools` is the key;
	// its proxy sid is `MainThreadChatSkills`.
	{ channel: 'MainThreadLanguageModelTools', create: createAiToolsMethods },
	{ channel: 'MainThreadLanguageModels', create: createAiModelsMethods },
	{ channel: 'MainThreadMcp', create: createAiMcpMethods },
	{ channel: 'MainThreadChatAgents2', create: createAiChatAgentsMethods },
	{ channel: 'MainThreadChatSessions', create: createAiChatSessionsMethods },
];

/**
 * Build every main-thread handler, grouped by channel.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @returns a map of channel name to (protocol method name to handler).
 */
export function createChannelMethods(ctx: any, host: ExtHostContext): Record<string, MainThreadMethods> {
	const grouped: Record<string, MainThreadMethods> = {};
	for (const service of SERVICES) {
		const methods = service.create(ctx, host) ?? {};
		grouped[service.channel] = { ...(grouped[service.channel] ?? {}), ...methods };
	}
	return grouped;
}

/**
 * Build every main-thread handler as one flat map.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @returns a map of protocol method name to handler.
 */
export default function createMethods(ctx: any, host: ExtHostContext): MainThreadMethods {
	const flat: MainThreadMethods = {};
	for (const methods of Object.values(createChannelMethods(ctx, host))) {
		Object.assign(flat, methods);
	}
	return flat;
}
