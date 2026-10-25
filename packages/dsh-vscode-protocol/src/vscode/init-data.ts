/*---------------------------------------------------------------------------------------------
 *  DSH `dsh-vscode-protocol` — building the extension-host init payload.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  THE THREE SHAPES THAT MUST BE EXACT
 *  -----------------------------------
 *  The init payload is JSON on the wire, and three of its fields have a shape that the
 *  TypeScript interface does not describe. Getting one of them wrong does not throw; it makes
 *  extensions silently fail to activate. Each of them was found by reading the vendored source:
 *
 *  1. `ExtensionIdentifier` is a CLASS with a `value` and a `_lower` own property, and
 *     `ExtensionIdentifier.toKey()` reads `id._lower`. The init payload therefore has to carry
 *     `{ value, _lower }` and NOT the `IExtensionIdentifier` shape `{ id, uuid }`. With the
 *     wrong shape every extension collapses onto the key `undefined`, the host logs
 *     "Extension `undefined` is already registered" and `$activate()` returns false.
 *
 *  2. A configuration model on the wire is `{ contents, keys, overrides, raw }`
 *     (`Configuration.parse` / `parseConfigurationModel`), NOT the `IConfigurationModel`
 *     interface `{ contents, overrides }`. Omitting `keys` crashes the host with
 *     "Cannot read properties of undefined (reading 'length')".
 *
 *  3. `autoStart` must be `false`. `true` means "the extension host starts itself"
 *     (`ExtensionHostStartup.EagerAutoStart`); DSH drives the start from the host side with
 *     `$startExtensionHost`, and doing both makes the host throw
 *     "Extension host is already started!".
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../vendor/src/vs/base/common/uri.js';
import { UIKind } from '../../../../vendor/src/vs/workbench/services/extensions/common/extensionHostProtocol.js';
import type { IExtensionHostInitData } from '../../../../vendor/src/vs/workbench/services/extensions/common/extensionHostProtocol.js';
import { PRODUCT_BRAND } from './brand.js';

/** One extension the host is about to load. */
export interface InitExtension {
	/** The protocol id, `publisher.name`. */
	readonly extensionId: string;
	/** The absolute path of the extension's `extension/` subtree. */
	readonly extensionPath: string;
	/** The extension's own `package.json`. */
	readonly manifest: any;
}

/**
 * The wire shape of an `ExtensionIdentifier`.
 *
 * @param id - the protocol id, `publisher.name`.
 * @returns the flattened class instance.
 */
export function toExtId(id: string): { value: string; _lower: string } {
	return { value: id, _lower: id.toLowerCase() };
}

/**
 * Derive the activation events VS Code infers from `contributes` when the manifest does not
 * declare them explicitly (VS Code >= 1.74 behaviour).
 *
 * @param manifest - the extension's `package.json`.
 * @returns the inferred activation events.
 */
export function deriveImplicitActivationEvents(manifest: any): string[] {
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
	for (const participant of contributes.chatParticipants ?? []) {
		events.add(`onChatParticipant:${participant.id}`);
	}
	return [...events];
}

/** Everything the init payload needs to know about the profile it runs in. */
export interface InitDataOptions {
	/** The profile directory. */
	readonly profileDir: string;
	/** The extensions to load. */
	readonly extensions: readonly InitExtension[];
	/** The workspace id; DSH has no workspace files, so this is a synthetic one. */
	readonly workspaceId: string;
	/** The workspace name. */
	readonly workspaceName: string;
	/** The directory the extension host writes its own logs into. */
	readonly logsDir: string;
	/** The session id reported in the telemetry block. */
	readonly sessionId: string;
}

/**
 * Build the extension-host init payload.
 *
 * @param options - the profile facts.
 * @returns the payload the extension host expects.
 */
export function buildInitData(options: InitDataOptions): IExtensionHostInitData {
	const { profileDir, extensions, workspaceId, workspaceName, logsDir, sessionId } = options;

	const allExtensions = extensions.map((extension) => {
		const manifest = extension.manifest ?? {};
		return {
			id: extension.extensionId,
			identifier: toExtId(extension.extensionId),
			uuid: undefined,
			name: manifest.name,
			displayName: manifest.displayName,
			publisher: manifest.publisher,
			publisherDisplayName: manifest.publisher,
			version: manifest.version,
			engines: manifest.engines ?? { vscode: '*' },
			description: manifest.description,
			main: manifest.main,
			browser: manifest.browser,
			type: manifest.type ?? 'workspace',
			preview: manifest.preview,
			l10n: manifest.l10n,
			icon: manifest.icon,
			categories: manifest.categories,
			keywords: manifest.keywords,
			activationEvents: manifest.activationEvents ?? [],
			extensionDependencies: manifest.extensionDependencies,
			extensionAffinity: manifest.extensionAffinity,
			extensionPack: manifest.extensionPack,
			extensionKind: manifest.extensionKind,
			contributes: manifest.contributes,
			repository: manifest.repository,
			bugs: manifest.bugs,
			capabilities: manifest.capabilities,
			enabledApiProposals: manifest.enabledApiProposals,
			targetPlatform: 'undefined',
			isBuiltin: false,
			isUserBuiltin: false,
			isUnderDevelopment: false,
			extensionLocation: URI.file(extension.extensionPath).toJSON(),
			preRelease: false,
		};
	});

	const activationEvents: Record<string, string[]> = {};
	for (const extension of extensions) {
		const explicit: string[] = extension.manifest?.activationEvents ?? [];
		const implicit = deriveImplicitActivationEvents(extension.manifest);
		activationEvents[extension.extensionId] = [...new Set([...explicit, ...implicit])];
	}

	return {
		version: PRODUCT_BRAND.version,
		quality: PRODUCT_BRAND.quality,
		commit: PRODUCT_BRAND.commit,
		date: new Date().toISOString(),
		// 0 disables the "is my parent still alive?" polling loop.
		parentPid: 0,
		environment: {
			isExtensionDevelopmentDebug: false,
			appName: PRODUCT_BRAND.nameShort,
			appHost: 'desktop',
			appRoot: URI.file(profileDir).toJSON(),
			appLanguage: 'en',
			isExtensionTelemetryLoggingOnly: false,
			appUriScheme: PRODUCT_BRAND.urlProtocol,
			globalStorageHome: URI.file(`${profileDir}/global-storage`).toJSON(),
			workspaceStorageHome: URI.file(`${profileDir}/workspace-storage`).toJSON(),
		},
		workspace: {
			id: workspaceId,
			name: workspaceName,
			transient: false,
			configuration: null,
			isUntitled: false,
		},
		extensions: {
			versionId: 1,
			allExtensions: allExtensions as any,
			activationEvents,
			myExtensions: extensions.map((extension) => toExtId(extension.extensionId)),
		},
		nlsBaseUrl: URI.file(profileDir).toJSON(),
		telemetryInfo: {
			sessionId,
			machineId: 'dsh-machine',
			sqmId: 'dsh-sqm',
			devDeviceId: 'dsh-device',
			firstSessionDate: new Date().toISOString(),
		},
		logLevel: 2 /* LogLevel.Info */,
		loggers: [],
		logsLocation: URI.file(logsDir).toJSON(),
		// false => the HOST drives the start with `$startExtensionHost` (LazyAutoStart).
		autoStart: false,
		remote: { isRemote: false, authority: undefined, connectionData: null },
		consoleForward: { includeStack: true, logNative: true },
		uiKind: UIKind.Desktop,
	} as unknown as IExtensionHostInitData;
}

/**
 * The four init RPCs the host sends to the extension host, in order.
 *
 * `$initializeWorkspace` is the blocking one: the extension host waits for it before it opens
 * the `_readyToStartExtensionHost` barrier, and `$initializeConfiguration` is what releases the
 * configuration provider the extension host waits for while it finishes booting.
 */
export const INITIALIZE_METHODS = [
	'$initializeWorkspace',
	'$initializeConfiguration',
	'$initializeTelemetryLevel',
	'$initializeIsConnectionMetered',
] as const;
