/*---------------------------------------------------------------------------------------------
 *  D-class (AI) main-thread service — `languageModelChatProviders` (BYOK model providers).
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  Protocol shape: `MainThreadLanguageModelsShape`
 *  (`vendor/src/vs/workbench/api/common/extHost.protocol.ts:1475`).
 *
 *  Direction (verified in `vendor/src/vs/workbench/api/common/extHostLanguageModels.ts`):
 *    - the extension host implements `ExtHostLanguageModelsShape`
 *      (`$provideLanguageModelChatInfo` line 194, `$startChatRequest` line 299) — DSH calls those;
 *    - DSH implements `$reportResponsePart` / `$reportResponseDone` (lines 321/386/390),
 *      `$selectChatModels` (line 449/536), `$tryStartChatRequest` (line 573) and `$countTokens`.
 *
 *  DSH-side pluggable surface: **found**. `ctx.llm.registerAdapter(providers, adapter)`
 *  (`packages/llm/llm/src/index.ts:401`) accepts a duck-typed adapter — `providerInfo`,
 *  `providerRetryPolicy` and `stream` are the only members the registry reads
 *  (`packages/llm/llm/src/index.ts:436`). A VS Code BYOK provider is therefore reachable:
 *  the adapter's `stream()` runs the provider inside the extension host and converts the
 *  extension host's response parts into DSH `StreamChunk`s.
 *
 *  Model identity: a VS Code provider is identified by `vendor`; DSH identifies a model by
 *  `provider route` + `model id`. The bridge uses the route `vscode-<vendor>` and keeps the
 *  VS Code model id unchanged, so `selectChatModels` answers with VS Code identifiers while the
 *  DSH model picker shows the `vscode-<vendor>` route.
 *--------------------------------------------------------------------------------------------*/

import {
	EXT_HOST_CHANNEL,
	hostCall,
	log,
	toVsCancellationToken,
	type AiHostBridge,
} from './ai-support.js'

/** One BYOK provider registered by an extension. */
interface VsCodeProvider {
	/** The VS Code `vendor` id. */
	vendor: string
	/** The DSH provider route this vendor is exposed under. */
	route: string
	/** The models the provider advertised. */
	models: any[]
	/** The disposer of the DSH adapter registration. */
	dispose?: () => void
}

/** One in-flight chat request the extension host is serving. */
interface PendingRequest {
	resolve: (error?: any) => void
	reject: (error: any) => void
	chunks: any[]
	settled: boolean
}

/**
 * The handlers for one main-thread service.
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension-host handle (for client→main calls).
 * @returns a map of VS Code protocol method name to handler.
 */
export default function createAiModelsMethods(ctx: any, host: any): Record<string, (...args: any[]) => any> {
	const bridge = host as AiHostBridge | undefined
	/** vendor → provider record. */
	const providers = new Map<string, VsCodeProvider>()
	/** request id → pending request. */
	const requests = new Map<number, PendingRequest>()
	/** model identifier → the vendor that owns it. */
	const modelOwners = new Map<string, string>()
	let nextRequestId = 1

	/** The DSH provider route a VS Code vendor is exposed under. */
	function routeFor(vendor: string): string {
		return `vscode-${vendor.replace(/[^\w-]+/g, '_')}`.slice(0, 64)
	}

	/**
	 * Ask the extension host for the models one provider advertises.
	 *
	 * `ILanguageModelChatInfoOptions.silent` is `true`: the discovery call must not raise UI
	 * (the VS Code source doc says the editor calls `provideMcpServerDefinitions`-style providers
	 * eagerly and they must not require user interaction — the same rule applies to model info).
	 */
	async function refreshModels(vendor: string): Promise<any[]> {
		const info = await hostCall<any[]>(
			bridge,
			EXT_HOST_CHANNEL.languageModels,
			'$provideLanguageModelChatInfo',
			vendor,
			{ silent: true },
			toVsCancellationToken(),
		)
		const models = Array.isArray(info) ? info : []
		const provider = providers.get(vendor)
		if (provider) {
			provider.models = models
			modelOwners.clear()
			for (const entry of models) {
				const id = entry?.metadata?.id ?? entry?.identifier
				if (typeof id === 'string') { modelOwners.set(id, vendor) }
			}
		}
		return models
	}

	/**
	 * Expose the provider's models through the DSH model layer.
	 *
	 * The adapter's `stream()` runs the provider inside the extension host; the extension host
	 * pushes the response back through `$reportResponsePart` / `$reportResponseDone`.
	 */
	function publishToDsh(provider: VsCodeProvider): void {
		const llm = ctx?.llm
		if (!llm?.registerAdapter) {
			log(ctx, 'warn', '[dsh-vscode] the DSH model layer exposes no registerAdapter(); the BYOK models stay invisible to the DSH model picker', { vendor: provider.vendor })
			return
		}
		const adapter = {
			providerInfo(route: string) {
				const model = provider.models.find(entry => entry?.metadata?.id === route)
				return { id: route, name: provider.vendor }
			},
			providerRetryPolicy() {
				return undefined
			},
			async listModels(route: string) {
				return provider.models
					.filter(entry => typeof entry?.metadata?.id === 'string')
					.map(entry => ({
						provider: route,
						id: entry.metadata.id,
						name: entry.metadata.name ?? entry.metadata.id,
						...(entry.metadata.detail ? { description: entry.metadata.detail } : {}),
					}))
			},
			async resolveModel(route: string, model: string) {
				const entry = provider.models.find(candidate => candidate?.metadata?.id === model)
				const metadata = entry?.metadata
				return {
					provider: route,
					id: model,
					name: metadata?.name ?? model,
					...(metadata?.maxInputTokens
						? { context: { contextWindow: metadata.maxInputTokens } }
						: {}),
				}
			},
			async *stream(options: any): AsyncIterable<any> {
				yield* runProviderRequest(provider, options)
			},
		}
		try {
			provider.dispose = llm.registerAdapter([provider.route], adapter as any)
		} catch (error) {
			log(ctx, 'error', '[dsh-vscode] the BYOK provider could not be registered with the DSH model layer', {
				vendor: provider.vendor,
				reason: String((error as any)?.message ?? error),
			})
		}
	}

	/**
	 * Run one chat request through the extension's provider and yield DSH stream chunks.
	 */
	async function* runProviderRequest(provider: VsCodeProvider, options: any): AsyncIterable<any> {
		const requestId = nextRequestId++
		const pending: PendingRequest = {
			resolve: () => { },
			reject: () => { },
			chunks: [],
			settled: false,
		}
		const done = new Promise<void>((resolve, reject) => {
			pending.resolve = resolve
			pending.reject = reject
		})
		requests.set(requestId, pending)
		const token = toVsCancellationToken(options?.signal)
		const messages = toVsCodeMessages(options?.messages ?? [])
		const startPromise = hostCall(
			bridge,
			EXT_HOST_CHANNEL.languageModels,
			'$startChatRequest',
			options?.model,
			requestId,
			undefined,
			messages,
			{
				...(options?.tools ? { tools: options.tools.map((tool: any) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) } : {}),
				...(options?.system ? { systemPrompt: options.system } : {}),
				...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
				...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
			},
			token,
		)
		try {
			await startPromise
		} catch (error) {
			requests.delete(requestId)
			throw error
		}
		let index = 0
		try {
			for await (const chunk of drain(pending, done)) {
				yield chunk
				index++
			}
		} finally {
			requests.delete(requestId)
		}
	}

	/** Turn the pending-request queue into an async iterable. */
	async function* drain(pending: PendingRequest, done: Promise<void>): AsyncIterable<any> {
		while (!pending.settled || pending.chunks.length > 0) {
			if (pending.chunks.length === 0) {
				await Promise.race([done, new Promise(resolve => setTimeout(resolve, 50))])
				continue
			}
			const chunk = pending.chunks.shift()
			yield chunk
		}
	}

	/** Convert DSH request messages into the VS Code chat message shape. */
	function toVsCodeMessages(messages: any[]): any[] {
		const result: any[] = []
		for (const message of messages) {
			const role = message?.role === 'assistant' ? 'assistant' : (message?.role === 'system' ? 'system' : 'user')
			const content: any[] = []
			for (const block of Array.isArray(message?.content) ? message.content : []) {
				if (block?.type === 'text' && typeof block.text === 'string') {
					content.push({ type: 'text', value: block.text })
				} else if (block?.type === 'reasoning' && typeof block.text === 'string') {
					content.push({ type: 'thinking', value: block.text })
				} else if (block?.type === 'tool-call') {
					content.push({
						type: 'tool_use',
						name: block.name,
						toolCallId: block.id,
						parameters: safeParse(block.arguments),
					})
				}
			}
			result.push({ role, content })
		}
		return result
	}

	/** Parse a JSON argument string, falling back to the raw string. */
	function safeParse(value: unknown): any {
		if (typeof value !== 'string') { return value }
		try { return JSON.parse(value) } catch { return value }
	}

	/** Convert one VS Code response part into DSH stream chunks. */
	function toStreamChunks(part: any): any[] {
		if (!part || typeof part !== 'object') { return [] }
		switch (part.type) {
			case 'text':
				return [{ type: 'text-delta', index: 0, text: String(part.value ?? '') }]
			case 'thinking': {
				const text = Array.isArray(part.value) ? part.value.join('\n') : String(part.value ?? '')
				return [{ type: 'reasoning-delta', index: 0, text }]
			}
			case 'tool_use':
				return [{
					type: 'tool-call-delta',
					index: 0,
					id: part.toolCallId,
					name: part.name,
					argumentsDelta: JSON.stringify(part.parameters ?? {}),
				}]
			default:
				return []
		}
	}

	return {
		/**
		 * Note that an extension registered a BYOK model provider.
		 *
		 * The extension host has already resolved the provider's models; DSH asks for them and
		 * publishes them through the model layer so they show up in the DSH model picker.
		 */
		async '$registerLanguageModelProvider'(vendor: string): Promise<void> {
			if (typeof vendor !== 'string' || !vendor) { return }
			const route = routeFor(vendor)
			providers.set(vendor, { vendor, route, models: [] })
			await refreshModels(vendor)
			const provider = providers.get(vendor)
			if (provider) { publishToDsh(provider) }
		},

		/**
		 * Note that one provider's model list changed.
		 */
		async '$onLMProviderChange'(vendor: string): Promise<void> {
			if (!providers.has(vendor)) {
				providers.set(vendor, { vendor, route: routeFor(vendor), models: [] })
			}
			await refreshModels(vendor)
		},

		/**
		 * Note that one provider was disposed.
		 */
		'$unregisterProvider'(vendor: string): void {
			const provider = providers.get(vendor)
			if (!provider) { return }
			try { provider.dispose?.() } catch { /* disposal must not throw */ }
			providers.delete(vendor)
			for (const [id, owner] of [...modelOwners.entries()]) {
				if (owner === vendor) { modelOwners.delete(id) }
			}
		},

		/**
		 * Run a chat request that an extension asked to route through a model.
		 *
		 * The extension host calls this when an extension's `LanguageModelChat.sendRequest`
		 * targets a model DSH owns. DSH has no core chat service of its own, so the request is
		 * rejected explicitly instead of silently hanging.
		 */
		async '$tryStartChatRequest'(
			extension: any,
			modelIdentifier: string,
			requestId: number,
			messages: any,
			options: any,
			token?: any,
		): Promise<void> {
			const error = { name: 'NotSupported', message: `DSH cannot serve the model request "${modelIdentifier}" from a VS Code extension` }
			log(ctx, 'warn', '[dsh-vscode] unsupported core chat request', { modelIdentifier })
			await this['$reportResponseDone']?.(requestId, error)
		},

		/**
		 * Receive one chunk of a provider's response.
		 */
		async '$reportResponsePart'(requestId: number, chunk: any): Promise<void> {
			const pending = requests.get(requestId)
			if (!pending) { return }
			const parts = Array.isArray(chunk) ? chunk : (chunk?.value !== undefined && Array.isArray(chunk.value) ? chunk.value : [chunk])
			for (const part of parts) {
				pending.chunks.push(...toStreamChunks(part))
			}
		},

		/**
		 * Receive the end of a provider's response.
		 */
		async '$reportResponseDone'(requestId: number, error?: any): Promise<void> {
			const pending = requests.get(requestId)
			if (!pending) { return }
			pending.settled = true
			if (error) {
				pending.reject(error)
			} else {
				pending.resolve()
			}
		},

		/**
		 * Select the models that match a selector.
		 *
		 * The protocol answers with model identifiers; an empty array is a legal answer and the
		 * extension must cope with it (the VS Code source doc says so explicitly).
		 */
		async '$selectChatModels'(selector: any): Promise<string[]> {
			const vendor = typeof selector?.vendor === 'string' ? selector.vendor : undefined
			const wantedFamily = typeof selector?.family === 'string' ? selector.family : undefined
			const wantedVersion = typeof selector?.version === 'string' ? selector.version : undefined
			const wantedId = typeof selector?.id === 'string' ? selector.id : undefined
			const result: string[] = []
			for (const provider of providers.values()) {
				if (vendor && provider.vendor !== vendor) { continue }
				for (const entry of provider.models) {
					const metadata = entry?.metadata
					if (!metadata) { continue }
					if (wantedId && metadata.id !== wantedId) { continue }
					if (wantedFamily && metadata.family !== wantedFamily) { continue }
					if (wantedVersion && metadata.version !== wantedVersion) { continue }
					result.push(entry.identifier ?? metadata.id)
				}
			}
			return result
		},

		/**
		 * Count the tokens of one message.
		 *
		 * DSH's exact tokenizer is not reachable from the main-thread service, so the count is a
		 * character-based estimate. The protocol only requires a number.
		 */
		async '$countTokens'(modelId: string, value: any, token?: any): Promise<number> {
			const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
			return Math.ceil(text.length / 4)
		},

		/**
		 * Cancel one in-flight chat request.
		 */
		'$cancelLanguageModelChatRequest'(requestId: number): void {
			const pending = requests.get(requestId)
			if (!pending) { return }
			pending.settled = true
			pending.reject({ name: 'Canceled', message: 'the chat request was cancelled' })
		},

		/**
		 * Report whether a file is ignored by the workspace.
		 *
		 * DSH has no ignore-file engine, so nothing is reported as ignored. Returning `false`
		 * keeps the extension host's context collection inclusive rather than empty.
		 */
		async '$fileIsIgnored'(uri: any, token?: any): Promise<boolean> {
			return false
		},

		/** Note that an extension registered a file-ignore provider. */
		'$registerFileIgnoreProvider'(handle: number): void {
			log(ctx, 'info', '[dsh-vscode] file-ignore provider registered (DSH has no ignore engine)', { handle })
		},

		/** Note that an extension disposed its file-ignore provider. */
		'$unregisterFileIgnoreProvider'(handle: number): void {
			log(ctx, 'info', '[dsh-vscode] file-ignore provider unregistered', { handle })
		},
	}
}
