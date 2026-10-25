/*---------------------------------------------------------------------------------------------
 *  DSH S1 production — the extension host MAIN SIDE.
 *
 *  DSH-authored (MIT). No Microsoft code except the vendored RPC framework, which is reused
 *  verbatim so that the wire format matches the vendored extension host exactly.
 *
 *  WHAT THIS CLASS DOES
 *  --------------------
 *  1. reads the profile's `extensions.json` + `extensions-trust.json` and keeps only the
 *     extensions that are enabled AND whose publisher is trusted;
 *  2. builds the extension host init payload;
 *  3. spawns the child process with the DSH runtime's own Node;
 *  4. waits for the child's READY handshake (fd 3), THEN sends the four init RPCs;
 *  5. drives the extension host: `$startExtensionHost`, then activates the extensions;
 *  6. answers the extension host's calls on the main-thread channels — the ones DSH implements
 *     for real, and a type-correct stub for the rest;
 *  7. restarts the child when it crashes, with a backoff and with VS Code's own cap
 *     ("3 crashes within 5 minutes, then stop and ask");
 *  8. watches `extensions.json` so that enabling or disabling an extension takes effect.
 *
 *  THE TWO RULES THAT MATTER
 *  -------------------------
 *  - A stub answers with a TYPE-CORRECT EMPTY VALUE, never with a bare `undefined`. The
 *    extension host does e.g. `proxy.$getTools().then(tools => { for (const tool of tools) })`,
 *    so `undefined` crashes the whole host with "tools is not iterable".
 *  - The host NEVER sends an init RPC before the ready handshake. The extension host
 *    registers its RPC actors asynchronously; a request that arrives too early is answered
 *    with "Unknown actor ExtHostWorkspace" and is lost for good.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
	ExtHostContext as ExtHostContextTable,
	MainContext as MainContextTable,
	RPCProtocol,
	ReadySignalReader,
	StdioSocket,
	buildInitData,
	mainThreadChannelNames,
	toExtId,
} from '../../packages/dsh-vscode-protocol/src/index.js';

import { STUB_RETURNS } from './stub-returns.js';
import { resolveProfileExtensions, type ResolvedExtension } from './profile.js';
import { createChannelMethods } from './methods/index.js';
import type {
	ExtHostContext as HostHandle,
	ExtensionHostState,
	LoadedExtension,
	MainThreadMethods,
} from './host-context.js';

/** The environment variable that overrides the Node executable used for the child. */
export const NODE_OVERRIDE_ENV = 'DSH_EXTHOST_NODE';

/** How long the host waits for the child's ready handshake. */
export const DEFAULT_READY_TIMEOUT_MS = 30_000;

/** The profile state files whose change the host reacts to. */
const WATCHED_FILES = ['extensions.json', 'extensions-trust.json'] as const;

/** How long the host polls `extensions.json` for a change. */
export const DEFAULT_WATCH_INTERVAL_MS = 2_000;

/** How many log lines the host keeps in memory. */
export const LOG_MEMORY_LINES = 2_000;

/** The upstream crash policy: three crashes within five minutes stop the automatic restart. */
export const CRASH_TIME_LIMIT_MS = 5 * 60 * 1000;
export const CRASH_LIMIT = 3;

/** The restart backoff. */
export const RESTART_BASE_DELAY_MS = 1_000;
export const RESTART_MAX_DELAY_MS = 30_000;

/** How the host is configured. */
export interface ExtensionHostConfig {
	/** The DSH Host plugin context. */
	readonly ctx: any;
	/** The profile directory. */
	readonly profileDir: string;
	/** The absolute path of the child bundle (`dist/extension-host.js`). */
	readonly childScript: string;
	/** Overrides the Node executable used for the child. */
	readonly nodeCommand?: string;
	/** Extra environment entries for the child. */
	readonly nodeEnv?: Record<string, string>;
	/** How long to wait for the ready handshake. */
	readonly readyTimeoutMs?: number;
	/** How often to poll `extensions.json`. */
	readonly watchIntervalMs?: number;
}

/** What the host resolved about the Node executable it will use. */
export interface NodeCommand {
	/** The executable. */
	readonly command: string;
	/** The environment the child needs on top of the curated base environment. */
	readonly env: Record<string, string>;
}

/**
 * The upstream crash tracker, reproduced faithfully.
 *
 * VS Code's `ExtensionHostCrashTracker` keeps the timestamps of the recent crashes, drops the
 * ones older than five minutes, and restarts automatically while fewer than three crashes are
 * inside that window. The third crash inside five minutes stops the automatic restart and
 * asks the user instead.
 */
export class ExtensionHostCrashTracker {

	private static readonly TIME_LIMIT = CRASH_TIME_LIMIT_MS;
	private static readonly CRASH_LIMIT = CRASH_LIMIT;

	private readonly _recentCrashes: number[] = [];

	private _removeOldCrashes(): void {
		const limit = Date.now() - ExtensionHostCrashTracker.TIME_LIMIT;
		while (this._recentCrashes.length > 0 && this._recentCrashes[0] < limit) {
			this._recentCrashes.shift();
		}
	}

	/** Record one crash. */
	registerCrash(): void {
		this._removeOldCrashes();
		this._recentCrashes.push(Date.now());
	}

	/** Whether the host may restart on its own. */
	shouldAutomaticallyRestart(): boolean {
		this._removeOldCrashes();
		return this._recentCrashes.length < ExtensionHostCrashTracker.CRASH_LIMIT;
	}

	/** How many crashes are inside the window. */
	get crashCount(): number {
		this._removeOldCrashes();
		return this._recentCrashes.length;
	}
}

/**
 * Resolve the Node executable the child process runs on.
 *
 * The extension host must run on DSH's own Node: it is a Node program, and running it on the
 * Electron binary would expose Electron APIs to third-party extension code. The packaged
 * application ships a plain Node build under
 * `Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node` and a wrapper
 * (`Contents/Resources/runtime/bin/node`) that starts it with `ELECTRON_RUN_AS_NODE=1`.
 *
 * @param override - an explicit executable, from `DSH_EXTHOST_NODE`.
 * @returns the executable and the environment it needs.
 */
export function resolveNodeCommand(override?: string): NodeCommand {
	const explicit = override ?? process.env[NODE_OVERRIDE_ENV];
	if (typeof explicit === 'string' && explicit.length > 0) {
		return { command: explicit, env: { ELECTRON_RUN_AS_NODE: '1' } };
	}

	// `<app>/Contents/MacOS/<binary>` -> `<app>/Contents/Resources`
	const execPath = process.execPath;
	const marker = `${'/'}Contents${'/'}MacOS${'/'}`;
	const markerIndex = execPath.indexOf(marker);
	if (markerIndex >= 0) {
		const resources = resolve(execPath.slice(0, markerIndex), 'Contents', 'Resources');
		const plainNode = join(resources, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node');
		const wrapper = join(resources, 'runtime', 'bin', 'node');
		if (existsSync(plainNode) && existsSync(wrapper)) {
			return {
				command: wrapper,
				env: { ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: plainNode },
			};
		}
		if (existsSync(plainNode)) {
			return { command: plainNode, env: { ELECTRON_RUN_AS_NODE: '1' } };
		}
	}

	const desktopNode = process.env.DSH_DESKTOP_NODE_EXECUTABLE;
	if (typeof desktopNode === 'string' && desktopNode.length > 0) {
		return { command: desktopNode, env: { ELECTRON_RUN_AS_NODE: '1' } };
	}

	if (process.versions.electron === undefined) {
		// Already a plain Node process (the development checkout runs the Host on Node).
		return { command: execPath, env: {} };
	}

	throw new Error(
		'no Node executable for the extension host: set DSH_EXTHOST_NODE to a Node binary, ' +
		'or run DSH from its packaged application, which ships one',
	);
}

/**
 * The environment the child process starts with.
 *
 * The child must not inherit the harness's ambient secrets, and it must not inherit a
 * `DSH_*` deployment fact it has no business seeing. The curated list keeps the things an
 * extension legitimately needs (PATH, HOME, TMPDIR, locale) and nothing else.
 *
 * @param extra - the entries the host adds on top.
 * @returns the child's environment.
 */
export function curatedChildEnv(extra: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ', 'USER', 'LOGNAME', 'SHELL']) {
		const value = process.env[name];
		if (typeof value === 'string' && value.length > 0) {
			env[name] = value;
		}
	}
	return { ...env, ...extra };
}

/**
 * A log sink that writes to the profile and keeps the tail in memory.
 */
export class HostLog {

	private readonly _file: string;
	private readonly _lines: string[] = [];
	private _fd: number | undefined;

	/**
	 * @param profileDir - the profile directory.
	 */
	constructor(profileDir: string) {
		this._file = join(profileDir, 'logs', 'extension-host.log');
		try {
			mkdirSync(dirname(this._file), { recursive: true });
		} catch {
			// The log is best-effort; the host must still run without it.
		}
	}

	/** The log file's path. */
	get file(): string {
		return this._file;
	}

	/**
	 * Write one line.
	 *
	 * @param message - the line.
	 */
	write(message: string): void {
		const line = `${new Date().toISOString()} ${message}`;
		this._lines.push(line);
		if (this._lines.length > LOG_MEMORY_LINES) {
			this._lines.splice(0, this._lines.length - LOG_MEMORY_LINES);
		}
		try {
			appendFileSync(this._file, `${line}\n`, 'utf8');
		} catch {
			// Best effort.
		}
	}

	/**
	 * The last lines of the log.
	 *
	 * @param count - how many lines to return.
	 * @returns the lines, oldest first.
	 */
	tail(count: number): string[] {
		const wanted = Math.max(0, Math.floor(count));
		return this._lines.slice(Math.max(0, this._lines.length - wanted));
	}
}

/** The per-extension runtime facts the host tracks. */
interface ExtensionRuntimeState {
	active: boolean;
	activatedAt?: string;
	error?: string;
}

/**
 * The extension host: the process, the protocol, the lifecycle.
 */
export class ExtensionHostService {

	private readonly _config: ExtensionHostConfig;
	private readonly _log: HostLog;
	private readonly _crashTracker = new ExtensionHostCrashTracker();

	private _child: ChildProcess | undefined;
	private _rpc: RPCProtocol | undefined;
	private _socket: StdioSocket | undefined;
	private _readyReader = new ReadySignalReader();

	private _running = false;
	private _starting = false;
	private _pid: number | undefined;
	private _startedAt: string | undefined;
	private _restarts = 0;
	private _lastError: string | undefined;
	private _reason: string | undefined;
	private _stopping = false;

	private _extensions: ResolvedExtension[] = [];
	private _skipped: Array<{ id: string; reason: string; detail: string }> = [];
	private _states = new Map<string, ExtensionRuntimeState>();
	private _commands = new Map<string, (...args: any[]) => any>();
	private _exports = new Map<string, unknown>();

	private _watcher: FSWatcher | undefined;
	private _watchTimer: NodeJS.Timeout | undefined;
	private _lastStateStamp = '';

	/**
	 * The colour scheme DSH's interface is showing, as VS Code's protocol names it.
	 *
	 * The extension host's `ExtHostTheming` starts on `Dark` and only changes when the main
	 * thread says so, so an extension that reads `vscode.window.activeColorTheme` before the
	 * first message sees Dark whatever the user actually chose.
	 */
	private _colorScheme: 'light' | 'dark' | undefined;

	/**
	 * The scheme the CURRENT child process was told about.
	 *
	 * The extension host's theming starts on Dark, so the scheme has to be sent at least
	 * once per process. Sending it again when nothing changed makes every extension that
	 * follows the theme rewrite its webview for no reason — and the browser half then
	 * reloads the frame for no reason too.
	 */
	private _toldColorScheme: 'light' | 'dark' | undefined;

	/**
	 * @param config - how the host is configured.
	 */
	constructor(config: ExtensionHostConfig) {
		this._config = config;
		this._log = new HostLog(config.profileDir);
	}

	/** The host's log sink. */
	get log(): HostLog {
		return this._log;
	}

	/** The DSH Host plugin context. */
	get ctx(): any {
		return this._config.ctx;
	}

	/** The profile directory. */
	get profileDir(): string {
		return this._config.profileDir;
	}

	/**
	 * The lifecycle snapshot the Extensions page and the model tool read.
	 *
	 * @returns the snapshot.
	 */
	status(): ExtensionHostState {
		return {
			running: this._running,
			pid: this._pid,
			startedAt: this._startedAt,
			restarts: this._restarts,
			lastError: this._lastError,
			reason: this._reason,
		};
	}

	/**
	 * The extensions the current host process loaded, with their activation state.
	 *
	 * @returns the list.
	 */
	loadedExtensions(): LoadedExtension[] {
		return this._extensions.map((extension) => {
			const state = this._states.get(extension.extensionId) ?? { active: false };
			return {
				id: extension.id,
				publisher: extension.publisher,
				name: extension.name,
				version: extension.version,
				active: state.active,
				activatedAt: state.activatedAt,
				error: state.error,
			};
		});
	}

	/**
	 * The extensions the host refused to load, and why.
	 *
	 * @returns the list.
	 */
	skippedExtensions(): Array<{ id: string; reason: string; detail: string }> {
		return [...this._skipped];
	}

	/**
	 * The commands the loaded extensions registered.
	 *
	 * @returns the command ids.
	 */
	registeredCommands(): string[] {
		return [...this._commands.keys()];
	}

	/**
	 * The tail of the host log.
	 *
	 * @param count - how many lines.
	 * @returns the lines.
	 */
	logLines(count: number): string[] {
		return this._log.tail(count);
	}

	/**
	 * Start the extension host.
	 *
	 * @returns the lifecycle snapshot.
	 */
	async start(): Promise<ExtensionHostState> {
		if (this._running) {
			return this.status();
		}
		this._stopping = false;
		await this._startProcess('the extension host was started');
		return this.status();
	}

	/**
	 * Stop the extension host.
	 *
	 * @returns the lifecycle snapshot.
	 */
	async stop(): Promise<ExtensionHostState> {
		this._stopping = true;
		this._stopWatching();
		const child = this._child;
		if (child !== undefined) {
			this._reason = 'the extension host was stopped';
			try {
				child.kill('SIGTERM');
			} catch {
				// Already gone.
			}
			await this._waitForExit(child, 5_000);
			if (child.exitCode === null && child.signalCode === null) {
				try {
					child.kill('SIGKILL');
				} catch {
					// Already gone.
				}
			}
		}
		this._child = undefined;
		this._rpc = undefined;
		this._socket = undefined;
		this._running = false;
		this._pid = undefined;
		this._startedAt = undefined;
		this._states.clear();
		this._exports.clear();
		this._commands.clear();
		return this.status();
	}

	/**
	 * Restart the extension host.
	 *
	 * @returns the lifecycle snapshot.
	 */
	async restart(): Promise<ExtensionHostState> {
		await this.stop();
		this._stopping = false;
		await this._startProcess('the extension host was restarted');
		return this.status();
	}

	/**
	 * Release everything.
	 */
	async dispose(): Promise<void> {
		await this.stop();
	}

	// ---------------------------------------------------------------------------------------
	// process lifecycle
	// ---------------------------------------------------------------------------------------

	private async _startProcess(reason: string): Promise<void> {
		if (this._starting) {
			return;
		}
		this._starting = true;
		try {
			const resolved = resolveProfileExtensions(this._config.profileDir);
			this._extensions = resolved.loaded;
			this._skipped = resolved.skipped.map((entry) => ({ id: entry.id, reason: entry.reason, detail: entry.detail }));
			for (const skipped of this._skipped) {
				this._log.write(`skip ${skipped.id}: ${skipped.reason} (${skipped.detail})`);
			}
			this._log.write(`resolved ${this._extensions.length} extension(s): ${this._extensions.map((e) => e.id).join(', ') || '(none)'}`);

			const node = resolveNodeCommand(this._config.nodeCommand);
			const logsDir = join(this._config.profileDir, 'logs');
			mkdirSync(logsDir, { recursive: true });

			const initData = buildInitData({
				profileDir: this._config.profileDir,
				extensions: this._extensions.map((extension) => ({
					extensionId: extension.extensionId,
					extensionPath: extension.extensionPath,
					manifest: extension.manifest,
				})),
				workspaceId: `dsh-${this._config.profileDir}`,
				workspaceName: 'DeepSeek Harness',
				logsDir,
				sessionId: `dsh-${Date.now()}`,
			});

			const env = curatedChildEnv({
				...node.env,
				...this._config.nodeEnv,
				DSH_EXTHOST_INIT_DATA: JSON.stringify(initData),
			});

			this._readyReader = new ReadySignalReader();
			this._lastError = undefined;
			this._reason = reason;

			const child = spawn(node.command, [this._config.childScript], {
				stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
				env,
				cwd: this._config.profileDir,
			});
			this._child = child;
			this._pid = child.pid;
			this._startedAt = new Date().toISOString();
			this._log.write(`spawn ${node.command} ${this._config.childScript} (pid ${child.pid})`);

			child.on('error', (error) => {
				this._lastError = `the extension host could not be started: ${error.message}`;
				this._log.write(`ERROR ${this._lastError}`);
			});

			child.stderr?.on('data', (chunk: Buffer) => {
				const text = chunk.toString('utf8');
				this._readyReader.consumeStderr(text);
				for (const line of text.split('\n')) {
					if (line.trim().length > 0) {
						this._log.write(`[exthost] ${line}`);
					}
				}
			});

			// fd 3 carries the ready handshake; it is the only channel that is guaranteed to be
			// free of protocol frames.
			const readyStream = child.stdio[3] as NodeJS.ReadableStream | null | undefined;
			readyStream?.on('data', (chunk: Buffer | string) => {
				this._readyReader.consumeFd(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
			});

			// The socket is created BEFORE the handshake completes so that no frame the child
			// sends can be lost.
			const socket = new StdioSocket(child.stdout as NodeJS.ReadableStream, child.stdin as NodeJS.WritableStream);
			this._socket = socket;
			const rpc = new RPCProtocol(socket.createMessagePassingProtocol(), {
				logIncoming: (length, request, initiator, method, data) => {
					this._log.write(`rpc <- ${method} ${safeJson(data)}`);
				},
				logOutgoing: (length, request, initiator, method, data) => {
					this._log.write(`rpc -> ${method} ${safeJson(data)}`);
				},
			});
			this._rpc = rpc;
			// A new process starts on Dark again: the scheme has to be sent to it.
			this._toldColorScheme = undefined;
			this._registerActors(rpc);

			child.on('exit', (code, signal) => {
				this._onChildExit(code, signal);
			});

			// THE HANDSHAKE. Nothing is sent over the protocol before it completes.
			const source = await this._readyReader.wait(this._config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
			this._log.write(`the extension host signalled readiness via ${source}`);

			await this._sendInitRpcs(rpc);
			await this._startExtensionHost(rpc);
			this._running = true;
			this._log.write('the extension host is running');
			// The watcher is armed HERE, not in `start()`: every path that brings a
			// process up goes through this method — the first start, a restart, and
			// the crash recovery — and a watcher that is not re-armed after a restart
			// silently stops reacting to the extension list.
			this._startWatching();
		} catch (error) {
			this._lastError = error instanceof Error ? error.message : String(error);
			this._log.write(`ERROR ${this._lastError}`);
			await this._killChild();
			throw error;
		} finally {
			this._starting = false;
		}
	}

	private _onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
		const wasRunning = this._running;
		this._running = false;
		this._pid = undefined;
		// The child is gone, so every RPC that is still waiting for a reply will never get
		// one. Disposing the protocol rejects those requests right away instead of letting
		// the caller wait for the timeout.
		try {
			this._rpc?.dispose();
		} catch {
			// The protocol may already be disposed.
		}
		this._rpc = undefined;
		const description = `the extension host exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}`;
		this._log.write(description);
		if (this._stopping) {
			return;
		}
		this._lastError = description;
		this._crashTracker.registerCrash();
		if (!this._crashTracker.shouldAutomaticallyRestart()) {
			this._reason = `the extension host terminated unexpectedly ${CRASH_LIMIT} times within ${CRASH_TIME_LIMIT_MS / 60000} minutes; it will not be restarted automatically`;
			this._log.write(`ERROR ${this._reason}`);
			return;
		}
		const delay = Math.min(RESTART_BASE_DELAY_MS * 2 ** this._restarts, RESTART_MAX_DELAY_MS);
		this._restarts += 1;
		this._reason = `restarting the extension host in ${delay}ms (crash ${this._crashTracker.crashCount} of ${CRASH_LIMIT})`;
		this._log.write(`INFO ${this._reason}`);
		setTimeout(() => {
			if (this._stopping) {
				return;
			}
			this._startProcess(this._reason).catch((error) => {
				this._log.write(`ERROR the restart failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}, delay).unref?.();
	}

	private async _waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
		if (child.exitCode !== null || child.signalCode !== null) {
			return;
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, timeoutMs);
			child.once('exit', () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	private async _killChild(): Promise<void> {
		const child = this._child;
		if (child === undefined) {
			return;
		}
		try {
			child.kill('SIGKILL');
		} catch {
			// Already gone.
		}
		await this._waitForExit(child, 2_000);
		this._child = undefined;
		this._running = false;
		this._pid = undefined;
	}

	// ---------------------------------------------------------------------------------------
	// the protocol
	// ---------------------------------------------------------------------------------------

	private _registerActors(rpc: RPCProtocol): void {
		const implemented = createChannelMethods(this._config.ctx, this._handle());
		for (const channel of mainThreadChannelNames()) {
			rpc.set((MainContextTable as any)[channel], this._makeActor(channel, implemented[channel] ?? {}));
		}
	}

	/**
	 * Build the actor for one main-thread channel.
	 *
	 * Every method the DSH does not implement is answered with the type-correct empty value
	 * the protocol declares. Throwing "NotSupported" instead would break every extension that
	 * registers a provider during `activate()` — language providers, custom editors, task
	 * systems — because the throw happens inside the extension's activation.
	 */
	private _makeActor(channel: string, implemented: MainThreadMethods): any {
		return new Proxy({}, {
			get: (_target, property) => {
				if (typeof property !== 'string') {
					return undefined;
				}
				const handler = implemented[property];
				if (typeof handler === 'function') {
					return handler;
				}
				return (...args: any[]) => {
					const empty = STUB_RETURNS[`${channel}.${property}`];
					this._log.write(`(stub) ${channel}.${property}(${args.length} args) -> ${safeJson(empty)}`);
					return Promise.resolve(empty);
				};
			},
		});
	}

	/**
	 * Record the colour scheme DSH's interface is showing and tell the extension host.
	 *
	 * VS Code's `ExtHostTheming` starts on `Dark`; without this message every extension
	 * believes the editor is dark, and the ones that follow the editor's theme (draw.io
	 * picks its light `Kennedy` theme from `vscode.window.activeColorTheme`) render wrong.
	 *
	 * @param scheme - `light` or `dark`.
	 * @returns true when the scheme was accepted.
	 */
	setColorScheme(scheme: string): boolean {
		const value = scheme === 'light' ? 'light' : scheme === 'dark' ? 'dark' : undefined;
		if (value === undefined) {
			return false;
		}
		if (value !== this._colorScheme) {
			this._colorScheme = value;
			this._applyColorScheme();
		}
		return true;
	}

	/** The colour scheme the extension host was told about. */
	get colorScheme(): 'light' | 'dark' | undefined {
		return this._colorScheme;
	}

	/**
	 * Send the colour scheme to the extension host, if it is running.
	 *
	 * The message is a notification, so a failure only means the extension keeps the theme
	 * it had; it is written to the host's log.
	 */
	private _applyColorScheme(): void {
		const scheme = this._colorScheme;
		const rpc = this._rpc;
		if (scheme === undefined || rpc === undefined || !this._running) {
			return;
		}
		if (scheme === this._toldColorScheme) {
			return;
		}
		this._toldColorScheme = scheme;
		try {
			const theming = rpc.getProxy(ExtHostContextTable.ExtHostTheming);
			const result = theming.$onColorThemeChange(scheme);
			if (result && typeof result.then === 'function') {
				result.then(
					() => { this._log.write(`-> $onColorThemeChange(${scheme})`); },
					(error: unknown) => { this._log.write(`ERROR $onColorThemeChange(${scheme}) failed: ${String(error)}`); },
				);
			}
		} catch (error) {
			this._log.write(`ERROR $onColorThemeChange(${scheme}) could not be sent: ${String(error)}`);
		}
	}

	private async _sendInitRpcs(rpc: RPCProtocol): Promise<void> {
		const workspace = rpc.getProxy(ExtHostContextTable.ExtHostWorkspace);
		const configuration = rpc.getProxy(ExtHostContextTable.ExtHostConfiguration);
		const telemetry = rpc.getProxy(ExtHostContextTable.ExtHostTelemetry);
		const metered = rpc.getProxy(ExtHostContextTable.ExtHostMeteredConnection);
		const theming = rpc.getProxy(ExtHostContextTable.ExtHostTheming);

		this._log.write('-> $initializeWorkspace (the blocking init call)');
		await workspace.$initializeWorkspace({
			id: `dsh-${this._config.profileDir}`,
			name: 'DeepSeek Harness',
			folders: [],
		} as any, true);

		// The configuration model on the wire is { contents, keys, overrides, raw }.
		// The IConfigurationModel interface only shows { contents, overrides }; omitting `keys`
		// crashes the extension host with "Cannot read properties of undefined (reading 'length')".
		const emptyModel = () => ({ contents: {}, keys: [], overrides: [] });
		this._log.write('-> $initializeConfiguration');
		await configuration.$initializeConfiguration({
			defaults: emptyModel(),
			policy: emptyModel(),
			application: emptyModel(),
			userLocal: emptyModel(),
			userRemote: emptyModel(),
			workspace: emptyModel(),
			folders: [],
			configurationScopes: [],
		} as any);

		this._log.write('-> $initializeTelemetryLevel');
		await telemetry.$initializeTelemetryLevel(0 /* NONE */, false, { usage: false, error: false });

		this._log.write('-> $initializeIsConnectionMetered');
		await metered.$initializeIsConnectionMetered(false);

		// The theme goes out BEFORE the extensions activate: an extension that reads
		// `vscode.window.activeColorTheme` while it activates must see the scheme the
		// user actually chose, not the extension host's built-in Dark.
		if (this._colorScheme !== undefined) {
			this._log.write(`-> $onColorThemeChange(${this._colorScheme})`);
			this._toldColorScheme = this._colorScheme;
			await theming.$onColorThemeChange(this._colorScheme);
		}
	}

	private async _startExtensionHost(rpc: RPCProtocol): Promise<void> {
		const service = rpc.getProxy(ExtHostContextTable.ExtHostExtensionService);
		this._log.write('-> $startExtensionHost');
		await service.$startExtensionHost({
			versionId: 1,
			toRemove: [],
			toAdd: [],
			addActivationEvents: {},
			myToRemove: [],
			myToAdd: [],
		} as any);
		await this._activateExtensions(service);
	}

	private async _activateExtensions(service: any): Promise<void> {
		const activationEvents = this._activationEventMap();
		for (const extension of this._extensions) {
			for (const event of activationEvents[extension.extensionId] ?? []) {
				try {
					await service.$activateByEvent(event, 0 /* ActivationKind.Normal */);
				} catch (error) {
					this._log.write(`ERROR the activation event "${event}" for ${extension.extensionId} failed: ${(error as Error).message}`);
				}
			}
			try {
				await service.$activate(toExtId(extension.extensionId) as any, { kind: 'explicit', extensionId: extension.extensionId } as any);
				this._log.write(`activated ${extension.extensionId}`);
			} catch (error) {
				this._log.write(`ERROR ${extension.extensionId} could not be activated: ${(error as Error).message}`);
				this._states.set(extension.extensionId, { active: false, error: (error as Error).message });
			}
		}
	}

	private _activationEventMap(): Record<string, string[]> {
		const map: Record<string, string[]> = {};
		for (const extension of this._extensions) {
			const explicit: string[] = extension.manifest?.activationEvents ?? [];
			map[extension.extensionId] = [...new Set([...explicit, ...deriveEvents(extension.manifest)])];
		}
		return map;
	}

	// ---------------------------------------------------------------------------------------
	// the handle a method module gets
	// ---------------------------------------------------------------------------------------

	/**
	 * The extension host handle.
	 *
	 * @returns the handle.
	 */
	private _handle(): HostHandle {
		const service = this;
		return {
			ctx: this._config.ctx,
			call: async <T = any>(channel: string, method: string, ...args: any[]) => {
				const rpc = service._rpc;
				if (rpc === undefined) {
					throw new Error('the extension host is not running');
				}
				// Both channel tables are reachable: `ExtHost*` for the calls the extension host
				// serves, `MainThread*` for the calls the extension host asks the host to make.
				const identifier = (ExtHostContextTable as any)[channel] ?? (MainContextTable as any)[channel];
				if (identifier === undefined) {
					throw new Error(`"${channel}" is not a protocol channel`);
				}
				const proxy: any = rpc.getProxy(identifier);
				const handler = proxy[method];
				if (typeof handler !== 'function') {
					throw new Error(`"${method}" is not a method of the protocol channel "${channel}"`);
				}
				return handler(...args) as Promise<T>;
			},
			get extensions() {
				return service._extensions;
			},
			profileDir: this._config.profileDir,
			log: (message: string) => this._log.write(message),
			get commands() {
				return service._commands;
			},
			getExtensionExports: (id: string) => service._exports.get(id),
			markActivated: (extensionId: string) => {
				const state = service._states.get(extensionId) ?? { active: false };
				service._states.set(extensionId, { ...state, active: true, activatedAt: new Date().toISOString(), error: undefined });
			},
			markActivationError: (extensionId: string, error: string) => {
				const state = service._states.get(extensionId) ?? { active: false };
				service._states.set(extensionId, { ...state, active: false, error });
			},
			setExtensionExports: (extensionId: string, exports: unknown) => {
				service._exports.set(extensionId, exports);
			},
			status: () => service.status(),
		};
	}

	// ---------------------------------------------------------------------------------------
	// watching `extensions.json`
	// ---------------------------------------------------------------------------------------

	private _startWatching(): void {
		this._stopWatching();
		this._lastStateStamp = this._stateStamp();

		// `fs.watch` is the fast path. It is unreliable on some network file systems, so a
		// poll runs next to it and the two agree on the same "did the file change" test.
		//
		// BOTH files are watched: `extensions.json` carries the enabled flag and
		// `extensions-trust.json` carries the publisher trust. Revoking a publisher's
		// trust must unload its extensions just as disabling one must.
		try {
			this._watcher = watch(this._config.profileDir, (_event, fileName) => {
				if (fileName === null || fileName === undefined || WATCHED_FILES.includes(fileName)) {
					this._checkForChanges();
				}
			});
			this._watcher.on('error', () => {
				this._watcher = undefined;
			});
		} catch {
			this._watcher = undefined;
		}

		this._watchTimer = setInterval(() => this._checkForChanges(), this._config.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS);
		this._watchTimer.unref?.();
	}

	private _stopWatching(): void {
		if (this._watcher !== undefined) {
			try {
				this._watcher.close();
			} catch {
				// Already closed.
			}
			this._watcher = undefined;
		}
		if (this._watchTimer !== undefined) {
			clearInterval(this._watchTimer);
			this._watchTimer = undefined;
		}
	}

	private _stamp(file: string): string {
		try {
			const stats = statSync(file);
			return `${stats.mtimeMs}:${stats.size}`;
		} catch {
			return 'absent';
		}
	}

	/**
	 * The stamp of every watched state file, so a change in any of them is seen.
	 * @returns the stamp.
	 */
	private _stateStamp(): string {
		return WATCHED_FILES.map((name) => `${name}:${this._stamp(join(this._config.profileDir, name))}`).join('|');
	}

	private _checkForChanges(): void {
		const stamp = this._stateStamp();
		if (stamp === this._lastStateStamp) {
			return;
		}
		this._lastStateStamp = stamp;
		this._reloadExtensions().catch((error) => {
			this._log.write(`ERROR the extension list could not be reloaded: ${(error as Error).message}`);
		});
	}

	/**
	 * Apply a change of the extension list WITHOUT restarting the host process.
	 *
	 * The extension host takes its extension list ONCE per process: `$startExtensionHost` calls
	 * the private `_startExtensionHost()`, whose first line is
	 *
	 *     if (this._started) { throw new Error(`Extension host is already started!`); }
	 *
	 * (vendor/src/vs/workbench/api/common/extHostExtensionService.ts:803`), so a SECOND
	 * `$startExtensionHost` is always refused. The protocol has a second method for exactly
	 * this case — `$deltaExtensions` (extHost.protocol.ts:2714) — which updates the
	 * registries WITHOUT starting the host again (extHostExtensionService.ts:1050).
	 *
	 * The identifiers in the delta are `ExtensionIdentifier` objects, so they travel as
	 * `{ value, _lower }`; that is what `toExtId()` produces.
	 */
	private async _reloadExtensions(): Promise<void> {
		const resolved = resolveProfileExtensions(this._config.profileDir);
		const before = new Map(this._extensions.map((extension) => [extension.extensionId, extension]));
		const after = new Map(resolved.loaded.map((extension) => [extension.extensionId, extension]));

		const added = resolved.loaded.filter((extension) => !before.has(extension.extensionId));
		const removed = this._extensions.filter((extension) => !after.has(extension.extensionId));

		this._extensions = resolved.loaded;
		this._skipped = resolved.skipped.map((entry) => ({ id: entry.id, reason: entry.reason, detail: entry.detail }));

		if (added.length === 0 && removed.length === 0) {
			return;
		}
		this._log.write(`the extension list changed: +${added.map((e) => e.extensionId).join(',') || 'none'} -${removed.map((e) => e.extensionId).join(',') || 'none'}`);

		const rpc = this._rpc;
		if (rpc === undefined || !this._running) {
			return;
		}
		try {
			const service = rpc.getProxy(ExtHostContextTable.ExtHostExtensionService);
			const activationEvents = this._activationEventMap();
			const addActivationEvents: Record<string, string[]> = {};
			for (const extension of added) {
				addActivationEvents[extension.extensionId] = activationEvents[extension.extensionId] ?? [];
			}
			await service.$deltaExtensions({
				versionId: Date.now(),
				toRemove: removed.map((extension) => toExtId(extension.extensionId) as any),
				toAdd: added.map((extension) => ({
					id: extension.extensionId,
					identifier: toExtId(extension.extensionId),
					name: extension.manifest?.name,
					displayName: extension.manifest?.displayName,
					publisher: extension.publisher,
					publisherDisplayName: extension.publisher,
					version: extension.manifest?.version,
					engines: extension.manifest?.engines ?? { vscode: '*' },
					main: extension.manifest?.main,
					type: extension.manifest?.type ?? 'workspace',
					activationEvents: extension.manifest?.activationEvents ?? [],
					contributes: extension.manifest?.contributes,
					extensionLocation: { path: extension.extensionPath, scheme: 'file' },
					isBuiltin: false,
					isUserBuiltin: false,
					isUnderDevelopment: false,
					targetPlatform: 'undefined',
				})),
				addActivationEvents,
				myToRemove: removed.map((extension) => toExtId(extension.extensionId) as any),
				myToAdd: added.map((extension) => toExtId(extension.extensionId) as any),
			} as any);
			for (const extension of removed) {
				this._states.delete(extension.extensionId);
			}
			// The extension that was removed leaves the host's registry, so it is never
			// activated again. Its ALREADY LOADED code keeps running until the host process
			// is replaced — the same semantics upstream's own delta path has.
			await this._activateExtensions(service);
		} catch (error) {
			const message = (error as Error).message;
			this._log.write(`ERROR the extension delta could not be applied: ${message}`);
			// A failed delta leaves the host's registry in an unknown state, so the process
			// has to be replaced with the new list.
			this._log.write('the running host cannot take the delta; restarting it with the new list');
			this._lastError = undefined;
			await this.restart();
		}
	}
}

// -----------------------------------------------------------------------------------------
// small helpers
// -----------------------------------------------------------------------------------------

/**
 * The activation events VS Code infers from `contributes`.
 *
 * @param manifest - the extension's `package.json`.
 * @returns the inferred events.
 */
function deriveEvents(manifest: any): string[] {
	const events = new Set<string>();
	const contributes = manifest?.contributes ?? {};
	for (const command of contributes.commands ?? []) {
		events.add(`onCommand:${command.command}`);
	}
	for (const editor of contributes.customEditors ?? []) {
		events.add(`onCustomEditor:${editor.viewType}`);
	}
	for (const language of contributes.languages ?? []) {
		events.add(`onLanguage:${language.id}`);
	}
	for (const view of Object.values(contributes.views ?? {}) as any[]) {
		events.add(`onView:${view.id}`);
	}
	return [...events];
}

/**
 * Stringify a value for the log without ever throwing.
 *
 * @param value - the value.
 * @returns the text.
 */
function safeJson(value: unknown): string {
	try {
		const text = JSON.stringify(value);
		return text === undefined ? '' : text.length > 400 ? `${text.slice(0, 400)}…` : text;
	} catch {
		return '<unserializable>';
	}
}

// The channel tables come from the protocol package under their VS Code names, so that the
// `$` prefixes and the channel names stay exactly as upstream has them.
