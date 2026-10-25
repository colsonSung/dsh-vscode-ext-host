/*---------------------------------------------------------------------------------------------
 *  DSH S1 production — the main-thread method context.
 *
 *  DSH-authored (MIT).
 *
 *  This module owns the contract between the main side and the per-service method modules in
 *  `runtime/main/methods/`. Every method module exports a factory
 *
 *      export default function createXxxMethods(ctx: any, host: any): Record<string, handler>
 *
 *  and the factory receives the DSH Host plugin context plus the {@link ExtHostContext} below.
 *
 *  TWO IDS, ON PURPOSE
 *  -------------------
 *  `ResolvedExtension.id` is `publisher.name@version` — the id the VSIX store writes into
 *  `extensions.json` and the id the Extensions page shows.
 *
 *  `ResolvedExtension.extensionId` is `publisher.name` — the id the VS Code PROTOCOL uses.
 *  VS Code's `Extension.id` never carries a version, and the extension host keys its registry
 *  by that value. Confusing the two makes every extension collapse onto one key.
 *--------------------------------------------------------------------------------------------*/

/** One extension the host process loaded (or refused to load). */
export interface ResolvedExtension {
	/** `publisher.name@version` — the DSH / store facing id. */
	readonly id: string;
	/** `publisher.name` — the VS Code protocol facing id. */
	readonly extensionId: string;
	/** The publisher name. */
	readonly publisher: string;
	/** The extension name. */
	readonly name: string;
	/** The extension version. */
	readonly version: string;
	/** The directory name under `<profile>/extensions/`. */
	readonly directory: string;
	/** Whether the extension is enabled in `extensions.json`. */
	readonly enabled: boolean;
	/** The absolute path of the extension's `extension/` subtree. */
	readonly extensionPath: string;
	/** The extension's own `package.json`. */
	readonly manifest: any;
	/** The value `activate()` returned, once the extension host reported it. */
	readonly exports?: unknown;
	/** The sha256 of the original `.vsix`, when the store recorded one. */
	readonly sha256?: string;
	/** The target platform suffix, when the package had one. */
	readonly targetPlatform?: string;
}

/** The lifecycle state of the extension host process. */
export interface ExtensionHostState {
	/** Whether the child process is alive. */
	readonly running: boolean;
	/** The child's process id, while it runs. */
	readonly pid?: number;
	/** When the current process was started (ISO 8601). */
	readonly startedAt?: string;
	/** How many times the host has been restarted in this process lifetime. */
	readonly restarts: number;
	/** The most recent crash or start-up failure, in one sentence. */
	readonly lastError?: string;
	/** Why the host is in its current state. */
	readonly reason?: string;
}

/** What the Extensions page and the model tool read about one loaded extension. */
export interface LoadedExtension {
	/** `publisher.name@version`. */
	readonly id: string;
	/** The publisher name. */
	readonly publisher: string;
	/** The extension name. */
	readonly name: string;
	/** The extension version. */
	readonly version: string;
	/** Whether the extension has been activated in this host process. */
	readonly active: boolean;
	/** When it was activated (ISO 8601). */
	readonly activatedAt?: string;
	/** The activation error, when it failed. */
	readonly error?: string;
}

/**
 * The handle a main-thread method module gets as its second argument.
 *
 * It is the host's window onto the extension host process: it can call back into the child,
 * it can read what the child loaded, and it can write into the profile's log.
 */
export interface ExtHostContext {
	/** The DSH Host plugin context. Same object as the factory's first argument. */
	readonly ctx: any;
	/**
	 * Call a method on one of the extension host's channels.
	 *
	/**
	 * Call a method on one of the extension host's channels.
	 *
	 * @param channel - the CHANNEL KEY NAME, e.g. `'ExtHostCommands'` or `'MainThreadCommands'`;
	 * not the proxy sid. Both channel tables are accepted.
	 * @param method - the protocol method name, `$` prefix included, e.g. `'$executeCommand'`.
	 * @param args - the method arguments.
	 * @returns the method's reply.
	 */
	call<T = any>(channel: string, method: string, ...args: any[]): Promise<T>;
	/** The extensions the current host process actually loaded. */
	readonly extensions: readonly ResolvedExtension[];
	/** The profile directory. */
	readonly profileDir: string;
	/** Write one line into the profile's extension-host log. */
	log(message: string): void;
	/** The commands the extensions registered, by command id. */
	readonly commands: ReadonlyMap<string, (...args: any[]) => any>;
	/** The value `activate()` returned for one extension, or `undefined`. */
	getExtensionExports(id: string): unknown;
	/** Record that an extension finished activating. */
	markActivated(extensionId: string): void;
	/** Record that an extension failed to activate or failed at runtime. */
	markActivationError(extensionId: string, error: string): void;
	/** Record the value an extension's `activate()` returned. */
	setExtensionExports(extensionId: string, exports: unknown): void;
	/** The host's lifecycle snapshot. */
	status(): ExtensionHostState;
}

/**
 * A factory for one main-thread service.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @returns a map of VS Code protocol method name to handler. The names keep their `$` prefix.
 */
export type MainThreadMethodFactory = (
	ctx: any,
	host: ExtHostContext,
) => Record<string, (...args: any[]) => any>;

/** A map of VS Code protocol method name to handler. */
export type MainThreadMethods = Record<string, (...args: any[]) => any>;
