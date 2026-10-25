/*---------------------------------------------------------------------------------------------
 *  D-class (AI) main-thread service — MCP (`mcpServerDefinitionProviders`).
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  Protocol shape: `MainThreadMcpShape`
 *  (`vendor/src/vs/workbench/api/common/extHost.protocol.ts:3880`).
 *
 *  ⚠️ CORRECTION to the task brief: the vendored protocol has **no**
 *  `$getMcpServerDefinitions` / `$resolveMcpServerDefinition` / `$onDidChangeMcpServerDefinitions`
 *  methods. `grep -n "McpServerDefinition" extHost.protocol.ts` returns exactly two hits
 *  (lines 3838 and 3886), and the extension host pushes its definitions to the main side with
 *  `$upsertMcpCollection` / `$deleteMcpCollection`
 *  (`vendor/src/vs/workbench/api/common/extHostMcp.ts:245,250`). The method names below are the
 *  ones that actually exist in the protocol.
 *
 *  Direction: the extension host (client) → DSH (main). The extension's
 *  `vscode.lm.registerMcpServerDefinitionProvider(...)` implementation runs *inside* the extension
 *  host, which resolves the definitions eagerly and pushes them here.
 *
 *  DSH-side reality (verified in the harness source): `dsh-mcp-client` is **Loader-row static
 *  configuration only** — `apply(ctx, config)` connects one server during plugin activation
 *  (`packages/mcp/mcp-client/src/index.ts:154`). There is **no runtime registration API**, so this
 *  module collects the definitions and keeps them addressable, but cannot start a server. The
 *  missing API is drafted in `vscode-extension-support/mainthread-dclass.md` §"DSH 侧缺口".
 *--------------------------------------------------------------------------------------------*/

import { log } from './ai-support.js'

/** One MCP collection (one provider) as the extension host pushed it. */
interface McpCollection {
	readonly id: string
	readonly label: string
	readonly isTrustedByDefault: boolean
	readonly scope: number
	readonly canResolveLaunch: boolean
	readonly extensionId: string
	readonly configTarget: number
}

/** One serialized MCP server definition. */
interface McpServerDefinitionDto {
	readonly id: string
	readonly label: string
	readonly cacheNonce: string
	readonly launch: any
	readonly defaultCwd?: any
	readonly version?: string
	readonly gallery?: boolean | string
	readonly [key: string]: unknown
}

/**
 * The handlers for one main-thread service.
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension-host handle (for client→main calls).
 * @returns a map of VS Code protocol method name to handler.
 */
export default function createAiMcpMethods(ctx: any, host: any): Record<string, (...args: any[]) => any> {
	/** collection id → the collection plus the server definitions the provider resolved. */
	const collections = new Map<string, { collection: McpCollection; servers: McpServerDefinitionDto[] }>()
	/** collection id → the disposer of the DSH-side registration, when one could be made. */
	const disposers = new Map<string, () => void>()
	/** collection id → the DSH-side server namespace, when a runtime API accepted the server. */
	const serverNames = new Map<string, string>()

	/**
	 * Find a runtime registration API on the DSH side, if one exists.
	 *
	 * `dsh-mcp-client` currently has none; the probes below make the bridge forward-compatible
	 * with the API drafted in the report, and make the failure explicit instead of silent.
	 */
	function findRuntimeApi(): { register: (server: any) => (() => void) | void } | undefined {
		const candidates = [ctx?.mcp, ctx?.mcpClient, ctx?.get?.('mcp'), ctx?.get?.('mcpClient')]
		for (const candidate of candidates) {
			if (!candidate) { continue }
			for (const name of ['registerServer', 'register', 'addServer', 'upsertServer']) {
				if (typeof candidate[name] === 'function') {
					return { register: (server: any) => candidate[name](server) }
				}
			}
		}
		return undefined
	}

	/**
	 * Derive a DSH `serverName` from a VS Code server label.
	 *
	 * `dsh-mcp-client` requires `[A-Za-z0-9_-]{1,32}` and uniqueness across live instances
	 * (`packages/mcp/mcp-client/src/index.ts:60`); VS Code labels are free-form.
	 */
	function toServerName(label: string, taken: ReadonlySet<string>): string {
		const base = (label || 'server').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 32) || 'server'
		if (!taken.has(base)) { return base }
		let counter = 2
		while (taken.has(`${base}_${counter}`)) { counter++ }
		return `${base}_${counter}`.slice(0, 32)
	}

	/**
	 * Convert one serialized VS Code MCP definition into the DSH registration shape.
	 *
	 * The mapping is best-effort: VS Code's `McpServerLaunch.Serialized` carries more (oauth,
	 * sandbox, variable replacement) than DSH's `StdioConfig` / `StreamableHttpConfig`.
	 */
	function toDshServer(collection: McpCollection, server: McpServerDefinitionDto, serverName: string): any {
		const launch = server.launch ?? {}
		if (launch.type === 1 /* McpServerTransportType.Stdio */) {
			return {
				transport: 'stdio',
				serverName,
				command: launch.command,
				args: Array.isArray(launch.args) ? launch.args : [],
				env: isStringRecord(launch.env) ? launch.env : {},
				cwd: typeof launch.cwd === 'string' ? launch.cwd : '',
				toolCallTimeoutMs: undefined,
				failOnStartupError: false,
			}
		}
		if (launch.type === 2 /* McpServerTransportType.HTTP */) {
			return {
				transport: 'streamable-http',
				serverName,
				url: typeof launch.uri === 'string' ? launch.uri : (launch.uri?.path ?? ''),
				headers: Array.isArray(launch.headers)
					? Object.fromEntries(launch.headers.filter((entry: any) => Array.isArray(entry) && entry.length === 2))
					: {},
				toolCallTimeoutMs: undefined,
				failOnStartupError: false,
			}
		}
		log(ctx, 'warn', '[dsh-vscode] unsupported MCP launch type', { id: server.id, type: launch.type })
		return undefined
	}

	return {
		/**
		 * Check whether one MCP request destination is allowed.
		 *
		 * The protocol answers with the denial reason, or `undefined` when the destination is
		 * allowed. DSH has no MCP destination policy of its own, so nothing is denied here; the
		 * decision is logged so a deployment can add a policy without changing this shape.
		 */
		async '$checkMcpServerAllowed'(id: number, url: string): Promise<string | undefined> {
			log(ctx, 'info', '[dsh-vscode] MCP destination check', { id, url })
			return undefined
		},

		/** Record an MCP connection-state change reported by the extension host. */
		'$onDidChangeState'(id: number, state: any): void {
			log(ctx, 'info', '[dsh-vscode] MCP state change', { id, state })
		},

		/** Forward an MCP server log line to the DSH logger. */
		'$onDidPublishLog'(id: number, level: any, message: string): void {
			log(ctx, 'info', '[dsh-vscode] MCP server log', { id, level, message })
		},

		/** Record a raw MCP message (the extension host's transport-level trace). */
		'$onDidReceiveMessage'(id: number, message: string): void {
			log(ctx, 'info', '[dsh-vscode] MCP message', { id, message })
		},

		/**
		 * Receive the MCP server definitions one extension provider resolved.
		 *
		 * This is the D-class hand-off point: the extension's `provideMcpServerDefinitions()` has
		 * run inside the extension host and its answer arrives here. The definitions are stored and,
		 * when DSH exposes a runtime MCP registration API, handed to it. Without that API the
		 * definitions are kept addressable but **no server is started** — that step is an explicit
		 * gap, not a silent success.
		 */
		'$upsertMcpCollection'(collection: McpCollection, servers: McpServerDefinitionDto[]): void {
			if (!collection?.id) { return }
			collections.set(collection.id, { collection, servers: Array.isArray(servers) ? servers : [] })
			const runtime = findRuntimeApi()
			if (!runtime) {
				log(ctx, 'warn', '[dsh-vscode] MCP definitions collected but not started: the DSH MCP bridge has no runtime registration API', {
					collection: collection.id,
					extensionId: collection.extensionId,
					servers: (servers ?? []).map(server => server?.label),
				})
				return
			}
			disposers.get(collection.id)?.()
			disposers.delete(collection.id)
			const taken = new Set(serverNames.values())
			for (const server of servers ?? []) {
				const serverName = toServerName(server?.label ?? server?.id ?? '', taken)
				taken.add(serverName)
				const dshServer = toDshServer(collection, server, serverName)
				if (!dshServer) { continue }
				try {
					const dispose = runtime.register(dshServer)
					if (typeof dispose === 'function') {
						disposers.set(`${collection.id}::${serverName}`, dispose)
					}
					serverNames.set(`${collection.id}::${serverName}`, serverName)
				} catch (error) {
					log(ctx, 'error', '[dsh-vscode] MCP server registration failed', {
						collection: collection.id,
						server: server?.label,
						reason: String((error as any)?.message ?? error),
					})
				}
			}
		},

		/**
		 * Drop one MCP collection when its provider is disposed.
		 */
		'$deleteMcpCollection'(collectionId: string): void {
			collections.delete(collectionId)
			for (const key of [...disposers.keys()]) {
				if (key.startsWith(`${collectionId}::`)) {
					try { disposers.get(key)?.() } catch { /* disposal must not throw */ }
					disposers.delete(key)
				}
			}
			for (const key of [...serverNames.keys()]) {
				if (key.startsWith(`${collectionId}::`)) { serverNames.delete(key) }
			}
		},

		/**
		 * Resolve an OAuth token from a server's metadata.
		 *
		 * DSH's credential service (`ctx.credentials`) addresses POSIX shell identifiers, not MCP
		 * OAuth providers, so no token can be produced here. `undefined` means "no token"; the
		 * extension host then continues unauthenticated. Recorded as a gap in the report.
		 */
		async '$getTokenFromServerMetadata'(id: number, authDetails: any, options?: any): Promise<string | undefined> {
			log(ctx, 'warn', '[dsh-vscode] MCP token requests are not supported by the DSH credential service', { id })
			return undefined
		},

		/** Resolve an OAuth token for one provider id. Same gap as above. */
		async '$getTokenForProviderId'(id: number, providerId: string, scopes: string[], options?: any): Promise<string | undefined> {
			log(ctx, 'warn', '[dsh-vscode] MCP token requests are not supported by the DSH credential service', { id, providerId })
			return undefined
		},

		/** Record that the extension host started an MCP authentication setup. */
		'$logMcpAuthSetup'(data: any): void {
			log(ctx, 'info', '[dsh-vscode] MCP auth setup', { data })
		},

		/**
		 * Start an MCP gateway.
		 *
		 * DSH has no MCP gateway (no proxy that re-exposes MCP servers over HTTP). The protocol
		 * answers `undefined`, which the extension host turns into "no gateway"
		 * (`extHostMcp.ts:283`).
		 */
		async '$startMcpGateway'(chatSessionResource?: any): Promise<any> {
			log(ctx, 'warn', '[dsh-vscode] MCP gateways are not supported by DSH', { chatSessionResource })
			return undefined
		},

		/** Dispose an MCP gateway. Nothing to do: no gateway was ever started. */
		'$disposeMcpGateway'(gatewayId: string): void {
			log(ctx, 'info', '[dsh-vscode] MCP gateway dispose requested', { gatewayId })
		},
	}
}

/** Whether the value is a record of strings. */
function isStringRecord(value: unknown): value is Record<string, string> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
