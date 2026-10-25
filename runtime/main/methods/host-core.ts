/*---------------------------------------------------------------------------------------------
 *  DSH S1 production — the main-thread services the host itself needs.
 *
 *  This file used to be called `dsh-core.ts`; it was renamed so that it cannot collide with
 *  the A-class module of the same name.
 *
 *  DSH-authored (MIT).
 *
 *  These are the channels the S1 host cannot work without:
 *
 *  - `MainThreadCommands` — the extensions' commands have to reach the DSH side;
 *  - `MainThreadExtensionService` — the activation notifications are how the host knows which
 *    extension is active and which one failed;
 *  - `MainThreadConsole` / `MainThreadLogger` / `MainThreadErrors` — the extension's own
 *    output has to reach the profile's log instead of vanishing;
 *  - `MainThreadStorage` / `MainThreadTelemetry` / `MainThreadOutputService` /
 *    `MainThreadWindow` / `MainThreadMessageService` / `MainThreadConfiguration` — cheap
 *    services whose absence makes extensions log warnings or throw.
 *
 *  The method names are VS Code's own, byte for byte, `$` prefix included.
 *
 *  A per-service module written by another owner can take a channel over: the registry merges
 *  the services in order and the later entry wins for the methods both define.
 *--------------------------------------------------------------------------------------------*/

import type { ExtHostContext, MainThreadMethodFactory, MainThreadMethods } from '../host-context.js';
import { dshCommandName } from './support.js';

/**
 * Build the core main-thread services.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @returns a map of channel name to the channel's handlers.
 */
function buildCoreServices(ctx: any, host: ExtHostContext): Record<string, MainThreadMethods> {
	return {
		// -------------------------------------------------------------------------------------
		// MainThreadCommands
		// -------------------------------------------------------------------------------------
		MainThreadCommands: {
			'$registerCommand'(id: string) {
				host.commands.set(id, async (...args: any[]) => {
					return host.call('ExtHostCommands', '$executeContributedCommand', id, ...args);
				});
				host.log(`MainThreadCommands.$registerCommand("${id}")`);
				registerDshCommand(ctx, host, id);
			},
			'$unregisterCommand'(id: string) {
				host.commands.delete(id);
				host.log(`MainThreadCommands.$unregisterCommand("${id}")`);
			},
			'$fireCommandActivationEvent'(id: string) {
				host.log(`MainThreadCommands.$fireCommandActivationEvent("${id}")`);
			},
			// The extension host asks the HOST to run a command. DSH has no command with that
			// id, so the answer is the type-correct empty value.
			'$executeCommand'(_id: string, _args: unknown, _retry: boolean) {
				return undefined;
			},
			'$getCommands'() {
				return [...host.commands.keys()];
			},
		},

		// -------------------------------------------------------------------------------------
		// MainThreadExtensionService — the lifecycle half
		// -------------------------------------------------------------------------------------
		MainThreadExtensionService: {
			'$onWillActivateExtension'(id: any) {
				host.log(`MainThreadExtensionService.$onWillActivateExtension(${identifierValue(id)})`);
			},
			'$onDidActivateExtension'(id: any, codeLoadingTime: number, activateCallTime: number, activateResolvedTime: number, reason: any) {
				const extensionId = identifierValue(id);
				host.markActivated(extensionId);
				host.log(
					`MainThreadExtensionService.$onDidActivateExtension(${extensionId}) ` +
					`codeLoading=${codeLoadingTime}ms activateCall=${activateCallTime}ms ` +
					`activateResolved=${activateResolvedTime}ms reason=${safeText(reason)}`,
				);
			},
			'$onExtensionActivationError'(id: any, error: any) {
				const extensionId = identifierValue(id);
				const message = errorText(error);
				host.markActivationError(extensionId, message);
				host.log(`MainThreadExtensionService.$onExtensionActivationError(${extensionId}): ${message}`);
			},
			'$onExtensionRuntimeError'(id: any, error: any) {
				const extensionId = identifierValue(id);
				host.markActivationError(extensionId, errorText(error));
				host.log(`MainThreadExtensionService.$onExtensionRuntimeError(${extensionId}): ${errorText(error)}`);
			},
			'$setPerformanceMarks'(_marks: any[]) {
				// The marks are VS Code's own profiler output; DSH does not consume them.
			},
			'$asBrowserUri'(uri: any) {
				return uri;
			},
		},

		// -------------------------------------------------------------------------------------
		// MainThreadConsole — the extension's own console output
		// -------------------------------------------------------------------------------------
		MainThreadConsole: {
			'$logExtensionHostMessage'(payload: any) {
				const args = Array.isArray(payload?.arguments) ? payload.arguments : [payload];
				const text = args.map((entry: any) => (typeof entry === 'string' ? entry : safeText(entry))).join(' ');
				host.log(`[extension-console:${payload?.severity ?? 'log'}] ${text}`);
			},
		},

		// -------------------------------------------------------------------------------------
		// MainThreadLogger
		// -------------------------------------------------------------------------------------
		MainThreadLogger: {
			'$log'(extensionId: string, ...rest: any[]) {
				host.log(`MainThreadLogger.$log(${extensionId}) ${rest.map((entry) => safeText(entry)).join(' ')}`);
			},
			'$flush'() {
				// The host writes every line straight to the profile's log file.
			},
			'$createLogger'(extensionId: string, label: string) {
				host.log(`MainThreadLogger.$createLogger(${extensionId}, ${label})`);
				return 1;
			},
			'$registerLogger'(_id: string, _options: any) {
				// The extension host's own log file is configured through the init payload.
			},
			'$deregisterLogger'(_id: string) {
				// Nothing to do.
			},
			'$setVisibility'(_id: string, _visible: boolean) {
				// Nothing to do.
			},
		},

		// -------------------------------------------------------------------------------------
		// MainThreadErrors
		// -------------------------------------------------------------------------------------
		MainThreadErrors: {
			'$onUnexpectedError'(error: any) {
				host.log(`MainThreadErrors.$onUnexpectedError: ${errorText(error)}`);
			},
		},

		// -------------------------------------------------------------------------------------
		// MainThreadStorage
		// -------------------------------------------------------------------------------------
		MainThreadStorage: {
			'$initializeExtensionStorage'(_shared: boolean, extensionId: string) {
				host.log(`MainThreadStorage.$initializeExtensionStorage(${extensionId})`);
				return undefined;
			},
			'$setValue'(_extensionId: string, _key: string, _value: any) {
				return undefined;
			},
			'$registerExtensionStorageKeysToSync'(_extensionId: string, _keys: string[]) {
				return undefined;
			},
		},

		// -------------------------------------------------------------------------------------
		// MainThreadTelemetry
		// -------------------------------------------------------------------------------------
		MainThreadTelemetry: {
			'$publicLog'(_extensionId: string, _data: any) {
				return undefined;
			},
			'$publicLog2'(_extensionId: string, _data: any) {
				return undefined;
			},
		},

		// -------------------------------------------------------------------------------------
		// MainThreadOutputService
		// -------------------------------------------------------------------------------------
		MainThreadOutputService: {
			'$register'(_id: string, _label: string, _logLevel: any) {
				return undefined;
			},
			'$update'(_id: string, _label: string, _logLevel: any) {
				return undefined;
			},
			'$reveal'(_id: string) {
				return undefined;
			},
			'$close'(_id: string) {
				return undefined;
			},
			'$dispose'(_id: string) {
				return undefined;
			},
		},

		// -------------------------------------------------------------------------------------
		// MainThreadWindow
		// -------------------------------------------------------------------------------------
		MainThreadWindow: {
			'$getInitialState'() {
				return {
					activeWindow: undefined,
					activeTerminal: undefined,
					tabs: { groups: [], lastFocusedGroup: undefined },
				};
			},
			'$openUri'() {
				return true;
			},
			'$asExternalUri'(uri: any) {
				return uri;
			},
		},

		// -------------------------------------------------------------------------------------
		// MainThreadMessageService
		// -------------------------------------------------------------------------------------
		MainThreadMessageService: {
			'$showMessage'(message: string) {
				host.log(`MainThreadMessageService.$showMessage("${message}")`);
				return undefined;
			},
		},

		// -------------------------------------------------------------------------------------
		// MainThreadConfiguration
		// -------------------------------------------------------------------------------------
		MainThreadConfiguration: {
			'$updateConfigurationOption'(_configuration: any, _value: any) {
				return undefined;
			},
			'$removeConfigurationOption'(_configuration: any) {
				return undefined;
			},
		},
	};
}

/**
 * Register an extension command in the DSH command registry, so that it is visible and
 * runnable from the DSH side.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @param id - the extension command id.
 */
function registerDshCommand(ctx: any, host: ExtHostContext, id: string): void {
	const registry = ctx?.commands;
	if (registry === undefined || typeof registry.register !== 'function') {
		return;
	}
	try {
		registry.register({
			name: dshCommandName(id),
			description: `the VS Code extension command "${id}"`,
			handler: async () => {
				try {
					const result = await host.call('ExtHostCommands', '$executeContributedCommand', id);
					return { kind: 'success' as const, text: typeof result === 'string' ? result : `the command "${id}" finished` };
				} catch (error) {
					return { kind: 'error' as const, text: `the command "${id}" failed: ${(error as Error).message}` };
				}
			},
		});
	} catch {
		// The name is taken by another command; the extension command stays reachable through
		// the extension host itself.
	}
}

/**
 * The value of an extension identifier on the wire.
 *
 * @param id - the identifier.
 * @returns the extension id.
 */
function identifierValue(id: any): string {
	if (typeof id === 'string') {
		return id;
	}
	return id?.value ?? id?.id ?? String(id);
}

/**
 * The message of an error on the wire.
 *
 * @param error - the error.
 * @returns the message.
 */
function errorText(error: any): string {
	if (typeof error === 'string') {
		return error;
	}
	return error?.message ?? error?.name ?? safeText(error);
}

/**
 * Stringify a value without ever throwing.
 *
 * @param value - the value.
 * @returns the text.
 */
function safeText(value: unknown): string {
	try {
		const text = JSON.stringify(value);
		return text === undefined ? String(value) : text;
	} catch {
		return '<unserializable>';
	}
}

/**
 * The `MainThreadCommands` handlers.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @returns the channel's handlers.
 */
export const createCommandsMethods: MainThreadMethodFactory = (ctx, host) => (
	buildCoreServices(ctx, host).MainThreadCommands
);

/**
 * The `MainThreadExtensionService` handlers.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @returns the channel's handlers.
 */
export const createExtensionServiceMethods: MainThreadMethodFactory = (ctx, host) => (
	buildCoreServices(ctx, host).MainThreadExtensionService
);

/**
 * The `MainThreadConsole` handlers.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @returns the channel's handlers.
 */
export const createConsoleMethods: MainThreadMethodFactory = (ctx, host) => (
	buildCoreServices(ctx, host).MainThreadConsole
);

/**
 * The `MainThreadLogger` handlers.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @returns the channel's handlers.
 */
export const createLoggerMethods: MainThreadMethodFactory = (ctx, host) => (
	buildCoreServices(ctx, host).MainThreadLogger
);

/**
 * The `MainThreadErrors` handlers.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @returns the channel's handlers.
 */
export const createErrorsMethods: MainThreadMethodFactory = (ctx, host) => (
	buildCoreServices(ctx, host).MainThreadErrors
);

/**
 * The `MainThreadStorage` handlers.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @returns the channel's handlers.
 */
export const createStorageMethods: MainThreadMethodFactory = (ctx, host) => (
	buildCoreServices(ctx, host).MainThreadStorage
);

/**
 * The `MainThreadTelemetry` handlers.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @returns the channel's handlers.
 */
export const createTelemetryMethods: MainThreadMethodFactory = (ctx, host) => (
	buildCoreServices(ctx, host).MainThreadTelemetry
);

/**
 * The `MainThreadOutputService` handlers.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @returns the channel's handlers.
 */
export const createOutputServiceMethods: MainThreadMethodFactory = (ctx, host) => (
	buildCoreServices(ctx, host).MainThreadOutputService
);

/**
 * The `MainThreadWindow` handlers.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @returns the channel's handlers.
 */
export const createWindowMethods: MainThreadMethodFactory = (ctx, host) => (
	buildCoreServices(ctx, host).MainThreadWindow
);

/**
 * The `MainThreadMessageService` handlers.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @returns the channel's handlers.
 */
export const createMessageServiceMethods: MainThreadMethodFactory = (ctx, host) => (
	buildCoreServices(ctx, host).MainThreadMessageService
);

/**
 * The `MainThreadConfiguration` handlers.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @returns the channel's handlers.
 */
export const createConfigurationMethods: MainThreadMethodFactory = (ctx, host) => (
	buildCoreServices(ctx, host).MainThreadConfiguration
);
