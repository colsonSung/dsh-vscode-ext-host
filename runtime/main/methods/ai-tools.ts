/*---------------------------------------------------------------------------------------------
 *  D-class (AI) main-thread service — `languageModelTools`.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  Protocol shape: `MainThreadLanguageModelToolsShape`
 *  (`vendor/src/vs/workbench/api/common/extHost.protocol.ts:1900`). The method names below are the
 *  VS Code protocol names, unchanged (`$`-prefixed).
 *
 *  Direction recap (see `vscode-extension-support/exthost-spike.md` §5.3):
 *    - DSH (main side) IMPLEMENTS `MainThreadLanguageModelToolsShape` — the methods below.
 *    - DSH CALLS `ExtHostLanguageModelToolsShape`
 *      (`$invokeTool` / `$prepareToolInvocation` / `$handleToolStream`,
 *      `extHost.protocol.ts:1910`) to reach the extension's `invoke` / `prepareInvocation`.
 *  The two shapes share method names (`$invokeTool`); mixing them up inverts the call direction.
 *
 *  What DSH gains: a VS Code extension that declares `contributes.languageModelTools` and calls
 *  `vscode.lm.registerTool(...)` contributes a tool that the DSH model can call, with the
 *  extension's own confirmation copy routed through DSH's approval pipeline.
 *--------------------------------------------------------------------------------------------*/

import {
	EXT_HOST_CHANNEL,
	hostCall,
	log,
	protocolExtensionId,
	resolveDshToolName,
	resolveExtensionRecords,
	toExtensionIdentifier,
	toVsCancellationToken,
	type AiExtensionRecord,
	type AiHostBridge,
} from './ai-support.js'

/**
 * One tool as DSH knows it.
 *
 * `id` is the **VS Code** tool id (`contributes.languageModelTools[].name`) and is the value the
 * extension host keys on (`ExtHostLanguageModelTools._registeredTools`, `extHostLanguageModelTools.ts:78`),
 * so it is never rewritten. `dshName` is the name the DSH model sees.
 */
interface AiToolEntry {
	/** VS Code tool id — the protocol identity (`IToolDataDto.id`). */
	id: string
	/** The extension that owns the tool. */
	extensionId: string
	/** The extension publisher, used for the DSH-side fallback name prefix. */
	publisher: string
	/** Human-facing name shown in the tool list. */
	displayName: string
	/** The description handed to the model. */
	modelDescription: string
	/** The description shown to the human. */
	userDescription?: string
	/** The `#reference` name; present only when the tool may be referenced in a prompt. */
	toolReferenceName?: string
	/** The JSON Schema of the tool input. */
	inputSchema?: Record<string, unknown>
	/** Free-form tags. */
	tags?: string[]
	/** The name the DSH model sees. */
	dshName: string
	/** Whether the extension has registered an implementation (`vscode.lm.registerTool`). */
	implemented: boolean
	/** Whether the extension's tool implements `handleToolStream`. */
	hasHandleToolStream: boolean
	/** The disposer returned by `ctx.tools.register`. */
	dispose?: () => void
}

/**
 * The JSON-safe value a VS Code tool invocation returns to DSH.
 *
 * `IToolResult.content` may carry `VSBuffer` payloads, which are not JSON; binary parts are
 * base64-encoded here so the DSH tool pipeline can treat the value as plain JSON.
 */
interface AiToolValue {
	content: Array<{ kind: 'text'; value: string }>
	toolResultError?: string
}

/**
 * The handlers for one main-thread service.
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension-host handle (for client→main calls).
 * @returns a map of VS Code protocol method name to handler.
 */
export default function createAiToolsMethods(ctx: any, host: any): Record<string, (...args: any[]) => any> {
	const bridge = host as AiHostBridge | undefined
	/** VS Code tool id → entry. */
	const tools = new Map<string, AiToolEntry>()
	/** DSH tool name → VS Code tool id. */
	const byDshName = new Map<string, string>()

	// -------------------------------------------------------------------------
	// registration
	// -------------------------------------------------------------------------

	/** The tool names already visible in the DSH registry (used for collision detection). */
	function takenDshNames(): Set<string> {
		const taken = new Set<string>()
		try {
			for (const schema of ctx?.tools?.schemas?.() ?? []) {
				if (schema?.name) { taken.add(schema.name) }
			}
		} catch { /* an unreadable registry just means fewer collisions are detected */ }
		for (const name of byDshName.keys()) { taken.add(name) }
		return taken
	}

	/**
	 * Register (or re-register) one tool with the DSH tool registry.
	 *
	 * The DSH definition carries the extension's `modelDescription` as the tool description and the
	 * extension's `inputSchema` verbatim as the JSON-Schema `parameters`. DSH projects
	 * `ToolSchema.parameters` straight to the model, so the extension's schema reaches the model
	 * unchanged.
	 */
	function publishToDsh(entry: AiToolEntry): void {
		const registry = ctx?.tools
		if (!registry?.register) {
			log(ctx, 'warn', '[dsh-vscode] DSH tool registry is unavailable; extension tools are not exposed')
			return
		}
		entry.dispose?.()
		entry.dispose = undefined
		const definition = {
			name: entry.dshName,
			description: entry.modelDescription || entry.displayName || entry.id,
			parameters: (entry.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
			output: {
				// The VS Code tool result shape is not expressible in DSH's enforced JSON-Schema
				// subset, so the output is declared as a generic object and rendered as text.
				schema: { type: 'object' as const },
				render: (_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> => {
					const text = renderToolValue(value)
					return [{ type: 'text', text }]
				},
			},
			execute: async (args: unknown, exec: any): Promise<AiToolValue> => {
				return await runExtensionTool(entry, args, exec)
			},
		}
		try {
			entry.dispose = registry.register(definition as any)
			byDshName.set(entry.dshName, entry.id)
		} catch (error) {
			// A duplicate DSH name means another extension (or a DSH-native tool) already owns it.
			// Re-key with the publisher prefix and try once more before giving up.
			const fallback = resolveDshToolName(entry.id, entry.publisher, takenDshNames())
			log(ctx, 'warn', '[dsh-vscode] tool name collision, re-keying', {
				id: entry.id,
				dshName: fallback,
				reason: String((error as any)?.message ?? error),
			})
			entry.dshName = fallback
			const retry = { ...definition, name: fallback }
			try {
				entry.dispose = registry.register(retry as any)
				byDshName.set(fallback, entry.id)
			} catch (retryError) {
				log(ctx, 'error', '[dsh-vscode] tool could not be registered', {
					id: entry.id,
					reason: String((retryError as any)?.message ?? retryError),
				})
			}
		}
	}

	/**
	 * Collect the statically declared tools of every resolved extension.
	 *
	 * `contributes.languageModelTools` is a *declaration* point: the tool exists for the model as
	 * soon as the extension is installed, long before the extension activates and calls
	 * `vscode.lm.registerTool`. DSH therefore registers the DSH-side tool here, and the
	 * implementation is attached later by `$registerTool` / `$registerToolWithDefinition`.
	 */
	function collectDeclaredTools(): void {
		const extensions = resolveExtensionRecords(bridge)
		const taken = takenDshNames()
		for (const extension of extensions) {
			const declared = extension.manifest?.contributes?.languageModelTools
			if (!Array.isArray(declared)) { continue }
			for (const raw of declared as any[]) {
				const id = typeof raw?.name === 'string' ? raw.name : undefined
				if (!id) { continue }
				const existing = tools.get(id)
				const dshName = existing?.dshName ?? resolveDshToolName(id, extension.publisher, taken)
				taken.add(dshName)
				const entry: AiToolEntry = {
					id,
					extensionId: protocolExtensionId(extension),
					publisher: extension.publisher,
					displayName: typeof raw?.displayName === 'string' ? raw.displayName : id,
					modelDescription: typeof raw?.modelDescription === 'string' ? raw.modelDescription : '',
					userDescription: typeof raw?.userDescription === 'string' ? raw.userDescription : undefined,
					toolReferenceName: typeof raw?.toolReferenceName === 'string' ? raw.toolReferenceName : undefined,
					inputSchema: isPlainObject(raw?.inputSchema) ? raw.inputSchema : undefined,
					tags: Array.isArray(raw?.tags) ? raw.tags.filter((tag: unknown) => typeof tag === 'string') : undefined,
					dshName,
					implemented: existing?.implemented ?? false,
					hasHandleToolStream: existing?.hasHandleToolStream ?? false,
					dispose: existing?.dispose,
				}
				tools.set(id, entry)
				publishToDsh(entry)
			}
		}
	}

	collectDeclaredTools()

	// -------------------------------------------------------------------------
	// execution
	// -------------------------------------------------------------------------

	/**
	 * Ensure the extension has an implementation for this tool.
	 *
	 * When the extension has not activated yet, the main side asks the extension host to activate
	 * it through the implicit `onLanguageModelTool:<name>` activation event and then waits for the
	 * matching `$registerTool` call.
	 */
	async function ensureImplemented(entry: AiToolEntry, signal?: AbortSignal): Promise<boolean> {
		if (entry.implemented) { return true }
		await hostCall(bridge, EXT_HOST_CHANNEL.extensionService, '$activateByEvent', `onLanguageModelTool:${entry.id}`, 0)
		const deadline = Date.now() + 5_000
		while (Date.now() < deadline) {
			if (entry.implemented) { return true }
			if (signal?.aborted) { return false }
			await new Promise(resolve => setTimeout(resolve, 50))
		}
		return entry.implemented
	}

	/** Extract the human-readable text of a `string | MarkdownString` confirmation field. */
	function confirmationText(value: unknown): string | undefined {
		if (typeof value === 'string') { return value }
		if (value && typeof value === 'object' && typeof (value as any).value === 'string') {
			return (value as any).value
		}
		return undefined
	}

	/**
	 * Ask DSH's approval service before running the extension's tool.
	 *
	 * VS Code always shows a confirmation for extension-provided tools; `prepareInvocation` only
	 * customizes the wording. DSH therefore always asks, and the extension's confirmation copy
	 * becomes the audited approval reason.
	 *
	 * When no approval service is mounted, or the call carries no agent to route the request
	 * through, the call proceeds with a warning: DSH's own privileged tools already go through the
	 * approval gate, and a deployment without an approval channel has no human to ask.
	 */
	async function approveExecution(entry: AiToolEntry, exec: any, prepared: any): Promise<void> {
		const title = confirmationText(prepared?.confirmationMessages?.title)
		const message = confirmationText(prepared?.confirmationMessages?.message)
		const reason = [title, message].filter((part): part is string => !!part).join(' — ')
			|| `VS Code extension tool "${entry.id}" wants to run`
		const approval = ctx?.approval ?? ctx?.get?.('approval')
		if (!approval?.request) {
			log(ctx, 'warn', '[dsh-vscode] no approval service mounted; running the extension tool without confirmation', { tool: entry.id })
			return
		}
		if (!exec?.agent) {
			log(ctx, 'warn', '[dsh-vscode] the tool call carries no agent; running the extension tool without confirmation', { tool: entry.id })
			return
		}
		const outcome = await approval.request({
			agent: exec.agent,
			toolName: entry.dshName,
			...(exec.callId !== undefined ? { callId: exec.callId } : {}),
			reason,
			displayReason: { en: reason },
			...(exec.signal ? { signal: exec.signal } : {}),
		})
		if (outcome !== 'allowed-once') {
			throw new Error(`the user did not approve the extension tool "${entry.id}" (${outcome})`)
		}
	}

	/**
	 * Run one extension tool end to end: prepare → approve → invoke.
	 */
	async function runExtensionTool(entry: AiToolEntry, args: unknown, exec: any): Promise<AiToolValue> {
		if (!await ensureImplemented(entry, exec?.signal)) {
			throw new Error(`the extension "${entry.extensionId}" did not register an implementation for the tool "${entry.id}"`)
		}
		const token = toVsCancellationToken(exec?.signal)
		const callId = typeof exec?.callId === 'string' ? exec.callId : `${entry.id}-${Date.now()}`
		const preparationContext = {
			parameters: args ?? {},
			toolCallId: callId,
		}
		const prepared = await hostCall<any>(
			bridge,
			EXT_HOST_CHANNEL.languageModelTools,
			'$prepareToolInvocation',
			entry.id,
			preparationContext,
			token,
		)
		await approveExecution(entry, exec, prepared)
		const invocation = {
			toolId: entry.id,
			callId,
			parameters: (args ?? {}) as Record<string, any>,
		}
		const result = await hostCall<any>(
			bridge,
			EXT_HOST_CHANNEL.languageModelTools,
			'$invokeTool',
			invocation,
			token,
		)
		return toToolValue(result)
	}

	/** Convert an `IToolResult` (or its `SerializableObjectWithBuffers` wrapper) into JSON. */
	function toToolValue(result: any): AiToolValue {
		const dto = result && typeof result === 'object' && 'value' in result ? result.value : result
		if (!dto || typeof dto !== 'object') {
			return { content: [{ kind: 'text', value: result === undefined ? '' : String(result) }] }
		}
		const content: Array<{ kind: 'text'; value: string }> = []
		for (const part of Array.isArray(dto.content) ? dto.content : []) {
			if (part?.kind === 'text' && typeof part.value === 'string') {
				content.push({ kind: 'text', value: part.value })
			} else if (part?.kind === 'data' && part.value) {
				const data = part.value.data
				const bytes = typeof data === 'string' ? data : (data?.buffer ? Buffer.from(data.buffer).toString('base64') : '')
				content.push({ kind: 'text', value: `[${part.value.mimeType ?? 'application/octet-stream'}] ${bytes}` })
			} else if (part?.kind === 'promptTsx') {
				content.push({ kind: 'text', value: JSON.stringify(part.value) })
			}
		}
		const value: AiToolValue = { content }
		if (dto.toolResultError) {
			value.toolResultError = typeof dto.toolResultError === 'string' ? dto.toolResultError : 'tool error'
		}
		return value
	}

	/** Render a tool value as the text DSH hands back to the model. */
	function renderToolValue(value: unknown): string {
		const dto = value as AiToolValue | undefined
		if (!dto || !Array.isArray(dto.content)) {
			return value === undefined ? '' : JSON.stringify(value)
		}
		const text = dto.content.map(part => part.value).join('\n')
		return dto.toolResultError ? `${dto.toolResultError}\n${text}` : text
	}

	/** Build the protocol DTO for one entry. */
	function toToolData(entry: AiToolEntry): Record<string, any> {
		return {
			id: entry.id,
			toolReferenceName: entry.toolReferenceName,
			// The upstream main thread fills this in from the extension id and the reference name
			// (`extHostLanguageModelTools.ts:373`); the exact separator is not vendored, so the
			// dotted form is used. [inferred]
			fullReferenceName: entry.toolReferenceName ? `${entry.extensionId}.${entry.toolReferenceName}` : undefined,
			tags: entry.tags,
			displayName: entry.displayName,
			userDescription: entry.userDescription,
			modelDescription: entry.modelDescription,
			source: {
				type: 'extension',
				label: entry.extensionId,
				extensionId: toExtensionIdentifier(entry.extensionId),
			},
			inputSchema: entry.inputSchema,
		}
	}

	// -------------------------------------------------------------------------
	// the protocol methods
	// -------------------------------------------------------------------------

	return {
		/**
		 * List every tool the extension host should know about.
		 *
		 * Called once when `ExtHostLanguageModelTools` is constructed, so it must answer the
		 * *declared* tools (from `contributes.languageModelTools`) as well as the ones registered at
		 * runtime. A wrong shape here crashes the extension host (`spike/src/main-host.ts` PATCH #5).
		 */
		async '$getTools'(): Promise<any[]> {
			return [...tools.values()].map(toToolData)
		},

		/**
		 * Accept a progress report emitted by a running extension tool.
		 *
		 * DSH has no channel that renders in-flight tool progress in the extension's own UI, so the
		 * report is logged. The protocol method is `void`.
		 */
		'$acceptToolProgress'(callId: string, progress: any): void {
			log(ctx, 'info', '[dsh-vscode] tool progress', {
				callId,
				message: typeof progress?.message === 'string' ? progress.message : undefined,
				progress: progress?.progress,
			})
		},

		/**
		 * Invoke a tool on behalf of the extension host.
		 *
		 * The extension host calls this when an extension uses `vscode.lm.invokeTool`. DSH routes the
		 * call through its own tool pipeline (permissions, approval, concurrency, restriction) and
		 * converts the outcome back into the protocol's `IToolResult`.
		 */
		async '$invokeTool'(dto: any, token?: any): Promise<any> {
			const toolId = typeof dto?.toolId === 'string' ? dto.toolId : undefined
			if (!toolId) {
				return { content: [], toolResultError: 'missing toolId' }
			}
			const entry = tools.get(toolId)
			if (!entry) {
				return { content: [], toolResultError: `unknown tool "${toolId}"` }
			}
			const registry = ctx?.tools
			if (!registry?.execute) {
				return { content: [], toolResultError: 'the DSH tool pipeline is unavailable' }
			}
			const callId = typeof dto?.callId === 'string' ? dto.callId : `${toolId}-${Date.now()}`
			const controller = new AbortController()
			const result = await registry.execute({
				callId: callId as any,
				name: entry.dshName,
				arguments: dto?.parameters ?? {},
				signal: controller.signal,
			} as any)
			if (result?.isError) {
				return {
					content: [{ kind: 'text', value: result?.error?.message ?? 'tool failed' }],
					toolResultError: result?.error?.message ?? 'tool failed',
				}
			}
			return toToolValue(result?.value)
		},

		/**
		 * Count the tokens of one tool input.
		 *
		 * The protocol requires a number. DSH's exact model tokenizer is not reachable from here,
		 * so a character-based estimate is returned; the extension only uses it for budgeting.
		 */
		async '$countTokensForInvocation'(callId: string, input: string, token?: any): Promise<number> {
			const text = typeof input === 'string' ? input : ''
			return Math.ceil(text.length / 4)
		},

		/**
		 * Note that the extension registered an implementation for one tool.
		 *
		 * The protocol carries only the tool id, so the owning extension is resolved from the
		 * static declaration.
		 */
		'$registerTool'(id: string, hasHandleToolStream: boolean): void {
			const entry = tools.get(id)
			if (!entry) {
				// The extension registered a tool that is not declared in its manifest. VS Code
				// requires the declaration, so the tool stays invisible but is remembered.
				log(ctx, 'warn', '[dsh-vscode] an extension registered an undeclared tool', { id })
				tools.set(id, {
					id,
					extensionId: 'unknown',
					publisher: 'unknown',
					displayName: id,
					modelDescription: '',
					dshName: id,
					implemented: true,
					hasHandleToolStream: !!hasHandleToolStream,
				})
				return
			}
			entry.implemented = true
			entry.hasHandleToolStream = !!hasHandleToolStream
		},

		/**
		 * Register a tool together with its full definition.
		 *
		 * This is the proposed-API path (`languageModelToolSupportsModel`): the extension itself
		 * supplies the display name, the reference name, the model description, the input schema and
		 * the model selectors, so the manifest declaration is not needed.
		 */
		'$registerToolWithDefinition'(extensionId: any, definition: any, hasHandleToolStream: boolean): void {
			const id = typeof definition?.id === 'string' ? definition.id : undefined
			if (!id) { return }
			const owner = typeof extensionId === 'string'
				? extensionId
				: (typeof extensionId?.value === 'string' ? extensionId.value : 'unknown')
			const taken = takenDshNames()
			const existing = tools.get(id)
			const dshName = existing?.dshName ?? resolveDshToolName(id, owner.split('.')[0] ?? 'ext', taken)
			const entry: AiToolEntry = {
				id,
				extensionId: owner,
				publisher: owner.split('.')[0] ?? 'ext',
				displayName: typeof definition?.displayName === 'string' ? definition.displayName : id,
				modelDescription: typeof definition?.modelDescription === 'string' ? definition.modelDescription : '',
				userDescription: typeof definition?.userDescription === 'string' ? definition.userDescription : undefined,
				toolReferenceName: typeof definition?.toolReferenceName === 'string' ? definition.toolReferenceName : undefined,
				inputSchema: isPlainObject(definition?.inputSchema) ? definition.inputSchema : undefined,
				tags: Array.isArray(definition?.tags) ? definition.tags.filter((tag: unknown) => typeof tag === 'string') : undefined,
				dshName,
				implemented: true,
				hasHandleToolStream: !!hasHandleToolStream,
				dispose: existing?.dispose,
			}
			tools.set(id, entry)
			publishToDsh(entry)
		},

		/**
		 * Note that the extension disposed its tool registration.
		 *
		 * The static declaration survives (VS Code keeps the declared tool visible), but the tool
		 * has no implementation left, so invoking it fails with an explicit message.
		 */
		'$unregisterTool'(name: string): void {
			const entry = tools.get(name)
			if (!entry) { return }
			entry.implemented = false
			entry.hasHandleToolStream = false
		},
	}
}

/** Whether the value is a plain JSON object (and not an array or `null`). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Re-exported for the report and for other D-class modules that need the same record shape. */
export type { AiExtensionRecord }
