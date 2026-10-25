/*---------------------------------------------------------------------------------------------
 *  A-class main-thread service — `configuration`.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  Protocol shape: `MainThreadConfigurationShape`
 *  (`vendor/src/vs/workbench/api/common/extHost.protocol.ts:250`).
 *
 *      $updateConfigurationOption(target, key, value, overrides, scopeToLanguage): Promise<void>
 *      $removeConfigurationOption(target, key, overrides, scopeToLanguage): Promise<void>
 *
 *  THERE IS NO `$getConfiguration`
 *  ------------------------------
 *  The ext host does NOT ask the main side for a configuration value. It RECEIVES the whole
 *  configuration model through the init RPC `$initializeConfiguration`
 *  (`ExtHostConfigurationShape`, `extHost.protocol.ts:2476`), and the main side pushes an
 *  update through `$acceptConfigurationChanged` (`extHostConfiguration.ts:134`).
 *
 *  So a VS Code extension's `workspace.getConfiguration('x').get('y')` answers from the model
 *  DSH pushed, not from a per-call RPC. This module therefore has TWO jobs:
 *
 *    1. build the model — the DEFAULTS from the extensions' own `contributes.configuration`
 *       manifests, plus the values the user set;
 *    2. keep the model in step when the ext host writes to it.
 *
 *  WHERE THE VALUES LIVE
 *  ---------------------
 *  A VSIX extension is NOT a DSH Loader entry: it is a VSIX under
 *  `<profile>/extensions/`, loaded by the extension host, not by the Loader. `ctx.settings`
 *  and `ctx.configEditor` both address a Loader ENTRY
 *  (`@deepseek-ai/dsh-settings/lib/index.js:502` — `entries().find(row => row.options.id === ns)`),
 *  so neither can hold a VSIX extension's settings.
 *
 *  DSH therefore keeps them in its own profile-level document, `<profile>/configuration.json`,
 *  written by this module. The mapping is documented in the report.
 *
 *  THE LAYERS
 *  ----------
 *  `ConfigurationTarget` on the wire is the ext-host enum
 *  (`vendor/src/vs/workbench/api/common/extHostTypes.ts:1870`): `Global = 1`,
 *  `Workspace = 2`, `WorkspaceFolder = 3`. DSH maps `Global` onto the `userLocal` layer and
 *  `Workspace`/`WorkspaceFolder` onto the `workspace` layer; DSH has no per-folder layer.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ExtHostContext } from '../host-context.js';
import { log, service } from './support.js';

/** The ext-host channel that owns the configuration model. */
const EXT_HOST_CHANNEL_CONFIGURATION = 'ExtHostConfiguration';

/** `ConfigurationTarget` values on the wire (`extHostTypes.ts:1870`). */
const TARGET_GLOBAL = 1;
const TARGET_WORKSPACE = 2;
const TARGET_WORKSPACE_FOLDER = 3;

/** One configuration layer, in the shape the ext host's `Configuration.parse` expects. */
interface ConfigurationLayer {
	/** The values, keyed by the FULL configuration key (`section.property`). */
	contents: Record<string, unknown>
	/** The keys, in the order they were written. */
	keys: string[]
}

/**
 * The handlers for one main-thread service.
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle (for client→main calls).
 * @returns a map of VS Code protocol method name to handler.
 */
export default function createConfigurationMethods(ctx: any, host: ExtHostContext): Record<string, (...args: any[]) => any> {
	/** The DEFAULTS layer, built from the extensions' `contributes.configuration`. */
	const defaults = emptyLayer()
	/** The USER layer — the values the user set. */
	const userLayer = emptyLayer()
	/** The WORKSPACE layer — DSH has no workspace folder, so this is the same store. */
	const workspaceLayer = emptyLayer()

	/** The document the user layer is persisted in. */
	const documentPath = join(host.profileDir, 'configuration.json')

	/**
	 * Read the persisted user layer.
	 *
	 * A missing or unreadable document simply means "no user values"; it never fails the
	 * extension host.
	 */
	function loadPersisted(): void {
		try {
			if (!existsSync(documentPath)) { return }
			const parsed = JSON.parse(readFileSync(documentPath, 'utf8')) as any
			applyLayer(userLayer, parsed?.userLocal)
			applyLayer(workspaceLayer, parsed?.workspace)
		} catch (error) {
			log(ctx, 'warn', '[dsh-vscode] the persisted configuration could not be read', {
				path: documentPath,
				reason: String((error as any)?.message ?? error),
			})
		}
	}

	/**
	 * Write the user layer back to the profile.
	 */
	function persist(): void {
		try {
			mkdirSync(dirname(documentPath), { recursive: true })
			writeFileSync(
				documentPath,
				JSON.stringify({ userLocal: userLayer.contents, workspace: workspaceLayer.contents }, undefined, 2) + '\n',
				'utf8',
			)
		} catch (error) {
			log(ctx, 'warn', '[dsh-vscode] the configuration could not be written', {
				path: documentPath,
				reason: String((error as any)?.message ?? error),
			})
		}
	}

	/**
	 * Collect the DEFAULTS every extension declares.
	 *
	 * `contributes.configuration` is either one object or an array of them, and every object's
	 * `properties` map holds the FULL configuration keys (`yaml.schemas`), each with its own
	 * `default`.
	 */
	function collectDefaults(): void {
		for (const extension of host.extensions ?? []) {
			const contributed = (extension as any)?.manifest?.contributes?.configuration
			const blocks = Array.isArray(contributed) ? contributed : contributed ? [contributed] : []
			for (const block of blocks) {
				const properties = block?.properties
				if (!properties || typeof properties !== 'object') { continue }
				for (const [key, schema] of Object.entries(properties as Record<string, any>)) {
					if (!schema || typeof schema !== 'object') { continue }
					if (!('default' in schema)) { continue }
					setValue(defaults, key, schema.default)
				}
			}
		}
	}

	/**
	 * Build the init payload the ext host parses.
	 *
	 * The wire shape is `{ contents, keys, overrides, raw }` per model
	 * (`platform/configuration/common/configuration.ts:209`); omitting `keys` crashes the ext
	 * host with "Cannot read properties of undefined (reading 'length')" — the spike measured
	 * exactly that.
	 *
	 * @returns the init data.
	 */
	function initData(): any {
		const model = (layer: ConfigurationLayer) => ({
			contents: { ...layer.contents },
			keys: [...layer.keys],
			overrides: [],
		})
		return {
			defaults: model(defaults),
			policy: model(emptyLayer()),
			application: model(emptyLayer()),
			userLocal: model(userLayer),
			userRemote: model(emptyLayer()),
			workspace: model(workspaceLayer),
			folders: [],
			configurationScopes: [],
		}
	}

	/**
	 * Push the current model into the extension host.
	 *
	 * The ext host's `$acceptConfigurationChanged` awaits its own barrier
	 * (`extHostConfiguration.ts:134-136`), so a call that arrives BEFORE
	 * `$initializeConfiguration` is applied right after it — the push is therefore safe at
	 * any time.
	 *
	 * @param changedKeys - the keys the change touched.
	 */
	async function push(changedKeys: string[]): Promise<void> {
		await host.call(
			'ExtHostConfiguration',
			'$acceptConfigurationChanged',
			initData(),
			{ keys: changedKeys, overrides: [] },
		)
	}

	/**
	 * Push the model, retrying while the extension host is not ready yet.
	 *
	 * The actor only exists once the child registered it, and the first RPCs of the boot
	 * happen right after the actor registration. A bounded retry keeps the configuration in
	 * step without a timer that outlives the host.
	 */
	async function pushWithRetry(changedKeys: string[]): Promise<void> {
		for (let attempt = 0; attempt < 20; attempt++) {
			try {
				await push(changedKeys)
				return
			} catch (error) {
				const message = String((error as any)?.message ?? error)
				if (!/Unknown actor|Unknown method|No such method/i.test(message)) {
					log(ctx, 'warn', '[dsh-vscode] the configuration could not be pushed', { reason: message })
					return
				}
				await new Promise((resolve) => setTimeout(resolve, 250))
			}
		}
	}

	/**
	 * The layer a configuration target addresses.
	 *
	 * @param target - the wire target.
	 * @returns the layer, or `undefined` when the target is not one DSH stores.
	 */
	function layerFor(target: number | null | undefined): ConfigurationLayer | undefined {
		if (target === TARGET_GLOBAL) { return userLayer }
		if (target === TARGET_WORKSPACE || target === TARGET_WORKSPACE_FOLDER) { return workspaceLayer }
		return undefined
	}

	// Load the persisted values and publish the defaults as soon as the host is ready.
	loadPersisted()
	collectDefaults()
	void pushWithRetry([])

	return {
		/**
		 * Write one configuration value.
		 *
		 * @param target - the `ConfigurationTarget` the value belongs to.
		 * @param key - the FULL configuration key (`section.property`).
		 * @param value - the value.
		 */
		async '$updateConfigurationOption'(target: number | null, key: string, value: unknown): Promise<void> {
			if (typeof key !== 'string' || key.length === 0) { return }
			const layer = layerFor(target)
			if (!layer) {
				// A `null` target means "the default target" in VS Code, which is the user
				// layer for an extension that did not ask for anything else.
				setValue(userLayer, key, value)
				persist()
				await pushWithRetry([key])
				return
			}
			setValue(layer, key, value)
			persist()
			await pushWithRetry([key])
		},

		/**
		 * Remove one configuration value.
		 *
		 * @param target - the `ConfigurationTarget` the value belongs to.
		 * @param key - the FULL configuration key (`section.property`).
		 */
		async '$removeConfigurationOption'(target: number | null, key: string): Promise<void> {
			if (typeof key !== 'string' || key.length === 0) { return }
			const layer = layerFor(target) ?? userLayer
			removeValue(layer, key)
			persist()
			await pushWithRetry([key])
		},
	}
}

/**
 * An empty configuration layer.
 *
 * @returns the layer.
 */
function emptyLayer(): ConfigurationLayer {
	return { contents: {}, keys: [] }
}

/**
 * Write one value into a layer.
 *
 * @param layer - the layer.
 * @param key - the configuration key.
 * @param value - the value.
 */
function setValue(layer: ConfigurationLayer, key: string, value: unknown): void {
	layer.contents[key] = value
	if (!layer.keys.includes(key)) { layer.keys.push(key) }
}

/**
 * Remove one value from a layer.
 *
 * @param layer - the layer.
 * @param key - the configuration key.
 */
function removeValue(layer: ConfigurationLayer, key: string): void {
	delete layer.contents[key]
	const index = layer.keys.indexOf(key)
	if (index >= 0) { layer.keys.splice(index, 1) }
}

/**
 * Copy a persisted layer into a live one.
 *
 * @param layer - the live layer.
 * @param source - the persisted contents.
 */
function applyLayer(layer: ConfigurationLayer, source: unknown): void {
	if (!source || typeof source !== 'object' || Array.isArray(source)) { return }
	for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
		setValue(layer, key, value)
	}
}
