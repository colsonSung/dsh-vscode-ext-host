/*---------------------------------------------------------------------------------------------
 *  DSH S1 spike — main-thread side (the "renderer" role VS Code's extension host expects).
 *
 *  DSH-authored glue (MIT). No Microsoft code, except the vendored RPC framework which we
 *  reuse verbatim so that the wire format matches the vendored extension host exactly.
 *
 *  This is the DSH "Host" side of the future `dsh-vscode-extension-host` plugin:
 *    1. read `<profile>/extensions.json` + `<profile>/extensions-trust.json`
 *    2. build the extension host init data
 *    3. spawn the extension host child process
 *    4. speak VS Code's own RPC protocol with it
 *    5. implement the minimum set of main-thread services (rest => NotSupported stub)
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { URI } from '../../upstream/src/vs/base/common/uri.js';
import { RPCProtocol } from '../../upstream/src/vs/workbench/services/extensions/common/rpcProtocol.js';
import { ExtHostContext, MainContext } from '../../upstream/src/vs/workbench/api/common/extHost.protocol.js';
import { IExtensionHostInitData, UIKind } from '../../upstream/src/vs/workbench/services/extensions/common/extensionHostProtocol.js';
import { ExtensionIdentifier } from '../../upstream/src/vs/platform/extensions/common/extensions.js';

import { StdioSocket } from './stdio-socket.js';
import { STUB_RETURNS } from './stub-returns.js';

// ---------------------------------------------------------------------------
// 1. the DSH profile contract (see the VSIX-storage bundle's spec)
// ---------------------------------------------------------------------------

export interface ExtensionRecord {
	/** e.g. "publisher.name" */
	id: string;
	publisher: string;
	name: string;
	version: string;
	/** directory name under `<profile>/extensions/` */
	directory: string;
	enabled: boolean;
	/** sha256 of the .vsix, if known */
	sha256?: string;
	/** target platform suffix, if any */
	targetPlatform?: string;
}

export interface ExtensionsJson {
	extensions: ExtensionRecord[];
}

export interface ExtensionsTrustJson {
	publishers: Record<string, boolean>;
}

export interface ResolvedExtension extends ExtensionRecord {
	/** absolute path of the extension/ subtree */
	extensionPath: string;
	manifest: any;
}

/**
 * Read `<profile>/extensions.json` and `<profile>/extensions-trust.json`, resolve each enabled +
 * trusted extension's `extension/package.json`.
 *
 * This is the seam the VSIX-storage bundle owns. The extension host only ever sees the
 * resolved list, so the storage format can change without touching the host.
 */
export function resolveExtensions(profileDir: string): ResolvedExtension[] {
	const extensionsJsonPath = join(profileDir, 'extensions.json');
	if (!existsSync(extensionsJsonPath)) {
		throw new Error(`extensions.json not found at ${extensionsJsonPath}`);
	}
	const extensionsJson = JSON.parse(readFileSync(extensionsJsonPath, 'utf8')) as ExtensionsJson;

	const trustPath = join(profileDir, 'extensions-trust.json');
	const trust: ExtensionsTrustJson = existsSync(trustPath)
		? JSON.parse(readFileSync(trustPath, 'utf8'))
		: { publishers: {} };

	const resolved: ResolvedExtension[] = [];
	for (const record of extensionsJson.extensions ?? []) {
		if (!record.enabled) {
			console.log(`[dsh-main] skip ${record.id}: disabled`);
			continue;
		}
		if (!trust.publishers[record.publisher]) {
			console.log(`[dsh-main] skip ${record.id}: publisher not trusted`);
			continue;
		}
		const extensionPath = join(profileDir, 'extensions', record.directory, 'extension');
		const manifestPath = join(extensionPath, 'package.json');
		if (!existsSync(manifestPath)) {
			console.log(`[dsh-main] skip ${record.id}: no package.json at ${manifestPath}`);
			continue;
		}
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
		resolved.push({ ...record, extensionPath, manifest });
	}
	return resolved;
}

// ---------------------------------------------------------------------------
// 2. build the extension host init data
// ---------------------------------------------------------------------------

/**
 * Derive the activation events VS Code infers from `contributes` when the manifest does not
 * declare them explicitly (VS Code >= 1.74 behaviour).
 */
export function deriveImplicitActivationEvents(manifest: any): string[] {
	const events = new Set<string>();
	const contributes = manifest.contributes ?? {};
	for (const cmd of contributes.commands ?? []) {
		events.add(`onCommand:${cmd.command}`);
	}
	for (const editor of contributes.customEditors ?? []) {
		events.add(`onCustomEditor:${editor.viewType}`);
	}
	for (const lang of contributes.languages ?? []) {
		events.add(`onLanguage:${lang.id}`);
	}
	for (const view of Object.values(contributes.views ?? {}) as any[]) {
		events.add(`onView:${view.id}`);
	}
	return [...events];
}


/**
 * Wire format of an `ExtensionIdentifier`.
 *
 * `ExtensionIdentifier` is a CLASS with `value` + `_lower` own properties; `ExtensionIdentifier.toKey()`
 * reads `id._lower`. The init data is JSON, so the class instance is flattened to
 * `{ value, _lower }`. Passing `{ id, uuid }` (the shape of `IExtensionIdentifier`) instead makes
 * EVERY extension collapse onto the key `undefined` -> "Extension `undefined` is already
 * registered" and the extension never activates.
 */
export function toExtId(id: string): { value: string; _lower: string } {
	return { value: id, _lower: id.toLowerCase() };
}

export function buildInitData(profileDir: string, extensions: ResolvedExtension[]): IExtensionHostInitData {
	const allExtensions = extensions.map((ext) => ({
		id: ext.id,
		identifier: toExtId(ext.id),
		uuid: undefined,
		name: ext.manifest.name ?? ext.name,
		displayName: ext.manifest.displayName,
		publisher: ext.manifest.publisher ?? ext.publisher,
		publisherDisplayName: ext.manifest.publisher ?? ext.publisher,
		version: ext.manifest.version ?? ext.version,
		engines: ext.manifest.engines ?? { vscode: '*' },
		description: ext.manifest.description,
		main: ext.manifest.main,
		browser: ext.manifest.browser,
		type: ext.manifest.type ?? 'workspace',
		preview: ext.manifest.preview,
		l10n: ext.manifest.l10n,
		icon: ext.manifest.icon,
		categories: ext.manifest.categories,
		keywords: ext.manifest.keywords,
		activationEvents: ext.manifest.activationEvents ?? [],
		extensionDependencies: ext.manifest.extensionDependencies,
		extensionAffinity: ext.manifest.extensionAffinity,
		extensionPack: ext.manifest.extensionPack,
		extensionKind: ext.manifest.extensionKind,
		contributes: ext.manifest.contributes,
		repository: ext.manifest.repository,
		bugs: ext.manifest.bugs,
		capabilities: ext.manifest.capabilities,
		enabledApiProposals: ext.manifest.enabledApiProposals,
		targetPlatform: 'undefined',
		isBuiltin: false,
		isUserBuiltin: false,
		isUnderDevelopment: false,
		extensionLocation: URI.file(ext.extensionPath).toJSON(),
		preRelease: false,
	}));

	const activationEvents: { [extensionId: string]: string[] } = {};
	for (const ext of extensions) {
		const explicit: string[] = ext.manifest.activationEvents ?? [];
		const implicit = deriveImplicitActivationEvents(ext.manifest);
		activationEvents[ext.id] = [...new Set([...explicit, ...implicit])];
		console.log(`[dsh-main] activation events for ${ext.id}: ${JSON.stringify(activationEvents[ext.id])}`);
	}

	return {
		version: '1.104.0-spike',
		quality: 'stable',
		commit: 'spike',
		date: new Date().toISOString(),
		parentPid: 0, // 0 => no parent polling
		environment: {
			isExtensionDevelopmentDebug: false,
			appName: 'DeepSeek Harness',
			appHost: 'desktop',
			appRoot: URI.file(profileDir).toJSON(),
			appLanguage: 'en',
			isExtensionTelemetryLoggingOnly: false,
			appUriScheme: 'dsh',
			globalStorageHome: URI.file(join(profileDir, 'global-storage')).toJSON(),
			workspaceStorageHome: URI.file(join(profileDir, 'workspace-storage')).toJSON(),
		},
		workspace: {
			id: 'dsh-spike-workspace',
			name: 'DSH Spike Workspace',
			transient: false,
			configuration: null,
			isUntitled: false,
		},
		extensions: {
			versionId: 1,
			allExtensions: allExtensions as any,
			activationEvents,
			myExtensions: extensions.map(e => toExtId(e.id)),
		},
		nlsBaseUrl: URI.file(profileDir).toJSON(),
		telemetryInfo: {
			sessionId: 'dsh-spike-session',
			machineId: 'dsh-spike-machine',
			sqmId: 'dsh-spike-sqm',
			devDeviceId: 'dsh-spike-device',
			firstSessionDate: new Date().toISOString(),
		},
		logLevel: 2 /* LogLevel.Info */,
		loggers: [],
		logsLocation: URI.file(join(profileDir, 'logs')).toJSON(),
		// autoStart=true means "the ext host starts itself" (upstream: ExtensionHostStartup.EagerAutoStart).
		// DSH uses LazyAutoStart: the HOST drives the start via `$startExtensionHost`.
		// (With autoStart=true AND an explicit `$startExtensionHost`, the ext host throws
		//  "Extension host is already started!".)
		autoStart: false,
		remote: { isRemote: false, authority: undefined, connectionData: null },
		consoleForward: { includeStack: true, logNative: true },
		uiKind: UIKind.Desktop,
	} as unknown as IExtensionHostInitData;
}

// ---------------------------------------------------------------------------
// 3 + 4 + 5. the main-thread services
// ---------------------------------------------------------------------------


/**
 * PATCH #3: retry an RPC while the extension host is still booting.
 *
 * The vendored extension host registers its RPC actors asynchronously (inside
 * `AbstractExtHostExtensionService._beforeAlmostReadyToRunExtensions()`), i.e. a few ticks
 * AFTER the child process was spawned. Requests that arrive before that get an
 * "Unknown actor" error. A real DSH host must therefore wait for an explicit readiness
 * signal (or retry) before it may send the init RPCs.
 */
async function rpcWhenReady<T>(fn: () => Promise<T>, label: string, attempts = 60): Promise<T> {
	let lastErr: any;
	for (let i = 0; i < attempts; i++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			const msg = String((err as any)?.message ?? err);
			if (!/Unknown actor|Unknown method/.test(msg)) {
				throw err;
			}
			if (i === 0 || i % 10 === 0) {
				console.log(`[dsh-main] ${label}: extension host not ready yet (${msg}) - retry ${i + 1}`);
			}
			await new Promise(r => setTimeout(r, 50));
		}
	}
	throw lastErr;
}

/** Every main-thread channel the extension host called, for the report. */
export const observedCalls: string[] = [];

class MainThreadHost {

	private readonly _rpc: RPCProtocol;
	private readonly _commands = new Map<string, (...args: any[]) => any>();

	constructor(rpc: RPCProtocol) {
		this._rpc = rpc;
		this._registerGenericStubs();
		this._registerActors();
	}

	/**
	 * Register a `NotSupported`-style stub for EVERY `MainThread*` channel.
	 *
	 * This mirrors the `@codingame/monaco-vscode-api` `missing-services.ts` idea: the ext host
	 * never crashes because a service is missing; it only fails when the extension actually
	 * uses the capability. The stub logs every call so we can report exactly which
	 * main-thread services a real extension touches.
	 */
	private _registerGenericStubs(): void {
		for (const [name, identifier] of Object.entries(MainContext)) {
			this._rpc.set(identifier as any, this._makeStub(name));
		}
	}

	private _makeStub(channel: string): any {
		const stub: any = {
			$dispose: () => { },
			$log: () => { },
		};
		return new Proxy(stub, {
			get(target, prop) {
				if (typeof prop !== 'string') { return undefined; }
				if (prop in target) { return target[prop]; }
				return (...args: any[]) => {
					observedCalls.push(`${channel}.${prop}`);
					// PATCH #5: answer with a TYPE-CORRECT empty value (derived from the protocol),
					// never a bare `undefined`. The extension host does e.g.
					//   proxy.$getTools().then(tools => { for (const tool of tools) ... })
					// so `undefined` would crash the host with "tools is not iterable".
					const empty = STUB_RETURNS[`${channel}.${prop}`];
					console.log(`[dsh-main] (stub) ${channel}.${prop}(${args.length} args) -> ${JSON.stringify(empty)}`);
					return Promise.resolve(empty);
				};
			}
		});
	}

	private _registerActors(): void {
		// --- MainThreadExtensionService -------------------------------------
		this._rpc.set(MainContext.MainThreadExtensionService, {
			$getExtension: async (id: string) => {
				console.log(`[dsh-main] MainThreadExtensionService.$getExtension(${id})`);
				return undefined;
			},
			$activateExtension: async (id: string) => {
				console.log(`[dsh-main] MainThreadExtensionService.$activateExtension(${id})`);
			},
			$onWillActivateExtension: async (id: any) => {
				console.log(`[dsh-main] MainThreadExtensionService.$onWillActivateExtension(${id?.value ?? id?.id ?? id})`);
			},
			$onDidActivateExtension: (id: any, codeLoadingTime: number, activateCallTime: number, activateResolvedTime: number, reason: string) => {
				console.log(`[dsh-main] >>> ACTIVATED ${id?.value ?? id?.id ?? id} (reason=${JSON.stringify(reason)}, codeLoading=${codeLoadingTime}ms, activateCall=${activateCallTime}ms, activateResolved=${activateResolvedTime}ms)`);
			},
			$onExtensionActivationError: async (id: any, err: any) => {
				console.log(`[dsh-main] !!! ACTIVATION ERROR ${id?.value ?? id?.id ?? id}: ${err?.message ?? JSON.stringify(err)}`);
			},
			$onExtensionRuntimeError: (id: any, err: any) => {
				console.log(`[dsh-main] !!! RUNTIME ERROR ${id?.value ?? id?.id ?? id}: ${err?.message ?? JSON.stringify(err)}`);
			},
			$setPerformanceMarks: async (marks: any[]) => {
				console.log(`[dsh-main] MainThreadExtensionService.$setPerformanceMarks(${marks?.length ?? 0} marks)`);
			},
			$asBrowserUri: async (uri: any) => uri,
		});

		// --- MainThreadCommands ----------------------------------------------
		this._rpc.set(MainContext.MainThreadCommands, {
			$registerCommand: (id: string) => {
				this._commands.set(id, () => undefined);
				console.log(`[dsh-main] >>> MainThreadCommands.$registerCommand("${id}")`);
			},
			$unregisterCommand: (id: string) => {
				this._commands.delete(id);
				console.log(`[dsh-main] MainThreadCommands.$unregisterCommand("${id}")`);
			},
			$fireCommandActivationEvent: async (id: string) => {
				console.log(`[dsh-main] MainThreadCommands.$fireCommandActivationEvent("${id}")`);
			},
			$executeCommand: async (id: string, ...args: any[]) => {
				console.log(`[dsh-main] MainThreadCommands.$executeCommand("${id}", ${args.length} args)`);
				return undefined;
			},
			$getCommands: async () => Array.from(this._commands.keys()),
		});

		// --- MainThreadErrors -------------------------------------------------
		this._rpc.set(MainContext.MainThreadErrors, {
			$onUnexpectedError: (err: any) => {
				console.log(`[dsh-main] MainThreadErrors.$onUnexpectedError: ${err?.message ?? JSON.stringify(err)}`);
			},
		});

		// --- MainThreadConsole ------------------------------------------------
		this._rpc.set(MainContext.MainThreadConsole, {
			$logExtensionHostMessage: (payload: any) => {
				// Upstream forwards the extension's console output as a structured record
				// { type: '__$console', severity, arguments: [...] }.
				const args = Array.isArray(payload?.arguments) ? payload.arguments : [payload];
				const text = args
					.map((a: any) => (typeof a === 'string' ? a : (a && a.__$stack ? JSON.stringify(a) : JSON.stringify(a))))
					.join(' ');
				console.log(`[dsh-main] [extension-console:${payload?.severity ?? 'log'}] ${text}`);
			},
		});

		// --- MainThreadStorage ------------------------------------------------
		this._rpc.set(MainContext.MainThreadStorage, {
			$initializeExtensionStorage: async (shared: boolean, extensionId: string) => {
				console.log(`[dsh-main] MainThreadStorage.$initializeExtensionStorage(${shared}, ${extensionId})`);
				return undefined;
			},
			$setValue: async (extensionId: string, key: string, value: any) => {
				console.log(`[dsh-main] MainThreadStorage.$setValue(${extensionId}, ${key})`);
			},
			$registerExtensionStorageKeysToSync: async (extensionId: string, keys: string[]) => { },
		});

		// --- MainThreadLogger --------------------------------------------------
		this._rpc.set(MainContext.MainThreadLogger, {
			$log: (extensionId: string, ...rest: any[]) => {
				console.log(`[dsh-main] MainThreadLogger.$log(${extensionId})`);
			},
			$flush: () => { },
			$createLogger: (extensionId: string, label: string) => {
				console.log(`[dsh-main] MainThreadLogger.$createLogger(${extensionId}, ${label})`);
				return 1;
			},
			$registerLogger: (id: string, options: any) => { },
			$deregisterLogger: (id: string) => { },
			$setVisibility: (id: string, visible: boolean) => { },
		});

		// --- MainThreadTelemetry ----------------------------------------------
		this._rpc.set(MainContext.MainThreadTelemetry, {
			$publicLog: (extensionId: string, data: any) => { },
			$publicLog2: (extensionId: string, data: any) => { },
		});

		// --- MainThreadOutputService ------------------------------------------
		this._rpc.set(MainContext.MainThreadOutputService, {
			$register: (id: string, label: string, logLevel: any) => { },
			$update: (id: string, label: string, logLevel: any) => { },
			$reveal: (id: string) => { },
			$close: (id: string) => { },
			$dispose: (id: string) => { },
		});

		// --- MainThreadWindow ---------------------------------------------------
		this._rpc.set(MainContext.MainThreadWindow, {
			$getInitialState: async () => ({
				activeWindow: undefined,
				activeTerminal: undefined,
				tabs: { groups: [], lastFocusedGroup: undefined },
			}),
			$openUri: async () => true,
			$asExternalUri: async (uri: any) => uri,
		});

		// --- MainThreadMessageService -------------------------------------------
		this._rpc.set(MainContext.MainThreadMessageService, {
			$showMessage: async (message: string, options: any, token?: any) => {
				console.log(`[dsh-main] MainThreadMessageService.$showMessage("${message}")`);
				return undefined;
			},
		});

		// --- MainThreadConfiguration ---------------------------------------------
		this._rpc.set(MainContext.MainThreadConfiguration, {
			$updateConfigurationOption: async (configuration: any, value: any) => { },
			$removeConfigurationOption: async (configuration: any) => { },
		});
	}

	/** The 5 mandatory init RPCs. */
	async sendInitRpcs(): Promise<void> {
		const workspaceProxy = this._rpc.getProxy(ExtHostContext.ExtHostWorkspace);
		const configProxy = this._rpc.getProxy(ExtHostContext.ExtHostConfiguration);
		const telemetryProxy = this._rpc.getProxy(ExtHostContext.ExtHostTelemetry);
		const meteredProxy = this._rpc.getProxy(ExtHostContext.ExtHostMeteredConnection);

		console.log('[dsh-main] -> $initializeWorkspace  (BLOCKING POINT)');
		await rpcWhenReady(() => Promise.resolve(workspaceProxy.$initializeWorkspace({
			id: 'dsh-spike-workspace',
			name: 'DSH Spike Workspace',
			folders: [],
		} as any, true)), '$initializeWorkspace');

		console.log('[dsh-main] -> $initializeConfiguration');
		// NOTE: the wire shape of a configuration model is
		//   { contents, keys, overrides, raw }   (see Configuration.parse / parseConfigurationModel)
		// NOT the `IConfigurationModel` TS interface ({ contents, overrides }) — omitting `keys`
		// crashes the ext host with "Cannot read properties of undefined (reading 'length')".
		const emptyModel = () => ({ contents: {}, keys: [], overrides: [] });
		await rpcWhenReady(() => Promise.resolve(configProxy.$initializeConfiguration({
			defaults: emptyModel(),
			policy: emptyModel(),
			application: emptyModel(),
			userLocal: emptyModel(),
			userRemote: emptyModel(),
			workspace: emptyModel(),
			folders: [],
			configurationScopes: [],
		} as any)), '$initializeConfiguration');

		console.log('[dsh-main] -> $initializeTelemetryLevel');
		await rpcWhenReady(() => Promise.resolve(telemetryProxy.$initializeTelemetryLevel(0 /* NONE */, false, { usage: false, error: false })), '$initializeTelemetryLevel');

		console.log('[dsh-main] -> $initializeIsConnectionMetered');
		await rpcWhenReady(() => Promise.resolve(meteredProxy.$initializeIsConnectionMetered(false)), '$initializeIsConnectionMetered');
	}
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const profileDir = resolve(process.argv[2] ?? resolve(process.cwd(), 'spike/profile'));
	const nodeExec = process.env.DSH_NODE_EXEC ?? process.execPath;
	const childScript = resolve(process.cwd(), 'dist/extension-host.js');

	console.log(`[dsh-main] profile     = ${profileDir}`);
	console.log(`[dsh-main] node exec  = ${nodeExec}`);
	console.log(`[dsh-main] child      = ${childScript}`);

	const extensions = resolveExtensions(profileDir);
	console.log(`[dsh-main] resolved ${extensions.length} extension(s): ${extensions.map(e => e.id).join(', ')}`);

	const initData = buildInitData(profileDir, extensions);

	const child = spawn(nodeExec, [childScript], {
		stdio: ['pipe', 'pipe', 'pipe'],
		env: {
			...process.env,
			DSH_EXTHOST_INIT_DATA: JSON.stringify(initData),
			ELECTRON_RUN_AS_NODE: '1',
		},
	});
	child.stderr.on('data', (d: Buffer) => process.stderr.write(`[exthost] ${d.toString()}`));
	child.stdout.on('data', () => { /* consumed by the protocol */ });
	child.on('exit', (code, signal) => console.log(`[dsh-main] child exited code=${code} signal=${signal}`));

	const socket = new StdioSocket(child.stdout as any, child.stdin as any);
	const rpc = new RPCProtocol(socket.createMessagePassingProtocol(), {
		logIncoming: (len, req, initiator, str, data) => console.log(`[dsh-main rpc] <- ${str} ${JSON.stringify(data)?.slice(0, 300)}`),
		logOutgoing: (len, req, initiator, str, data) => console.log(`[dsh-main rpc] -> ${str} ${JSON.stringify(data)?.slice(0, 300)}`),
	});

	const host = new MainThreadHost(rpc);
	await host.sendInitRpcs();

	const extHostExtensionService = rpc.getProxy(ExtHostContext.ExtHostExtensionService);
	console.log('[dsh-main] -> $startExtensionHost');
	await rpcWhenReady(() => extHostExtensionService.$startExtensionHost({
		versionId: 1,
		toRemove: [],
		toAdd: [],
		addActivationEvents: {},
		myToRemove: [],
		myToAdd: [],
	} as any), '$startExtensionHost');

	// Activate every extension: first by activation event, then explicitly.
	for (const ext of extensions) {
		const events: string[] = initData.extensions.activationEvents[ext.id] ?? [];
		for (const ev of events) {
			console.log(`[dsh-main] -> $activateByEvent("${ev}")`);
			await extHostExtensionService.$activateByEvent(ev, 0 /* ActivationKind.Normal */);
		}
		console.log(`[dsh-main] -> $activate(${ext.id})`);
		await extHostExtensionService.$activate(toExtId(ext.id) as any, 'other' as any);
	}

	setTimeout(() => {
		console.log(`[dsh-main] observed main-thread calls (${observedCalls.length}): ${JSON.stringify([...new Set(observedCalls)])}`);
		console.log('[dsh-main] spike finished');
		child.kill();
		process.exit(0);
	}, 8000);
}

main().catch(err => {
	console.error('[dsh-main] fatal', err);
	process.exit(1);
});
