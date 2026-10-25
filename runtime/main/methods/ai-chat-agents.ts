/*---------------------------------------------------------------------------------------------
 *  D-class (AI) main-thread service — chat customizations.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  Protocol shape: `MainThreadChatAgentsShape2`
 *  (`vendor/src/vs/workbench/api/common/extHost.protocol.ts:1686`).
 *
 *  Direction: the extension host calls `$provideSkills` / `$provideInstructions` /
 *  `$provideCustomAgents` / `$provideSlashCommands` on the **main** side to obtain the resources
 *  an extension contributed (`extHostChatAgents2.ts:531-536`), so DSH is the *provider* of the
 *  contributed files.
 *
 *  What is implemented:
 *    - `chatSkills`      → collected from the manifests, registered into DSH's `ctx.skills`
 *                          (this is the highest-value line: DSH's skill mechanism and the Agent
 *                          Skills specification are the same shape).
 *    - `chatInstructions`→ collected and exposed.
 *    - `chatAgents`      → collected (`.agent.md`); the DSH agent-preset mapping is drafted in the
 *                          report, not wired here.
 *    - `chatPromptFiles` → collected and exposed as slash commands ([inferred] mapping).
 *
 *  What is deliberately NOT implemented: `chatParticipants`. VS Code deprecated chat participants
 *  and the Copilot harness no longer supports them
 *  (`vscode-extension-research/vscode-extension-system.md` §C11.5/§C11.6), and `chatParticipants2`
 *  / `chatSessionParticipants` do not exist at all. A legacy participant registration is
 *  recognised and dropped with a warning.
 *--------------------------------------------------------------------------------------------*/

import {
	log,
	parseFrontmatter,
	protocolExtensionId,
	readContributedFile,
	resolveExtensionRecords,
	toFileUriComponents,
	type AiExtensionRecord,
	type AiHostBridge,
} from './ai-support.js'

/** One collected chat resource (skill / instruction / agent / prompt file). */
interface ChatResource {
	/** The absolute path of the contributed file. */
	path: string
	/** The resource name. */
	name: string
	/** The resource description, when the file declares one. */
	description?: string
	/** The owning extension id. */
	extensionId: string
	/** The extension display name. */
	extensionLabel: string
	/** The raw file body (frontmatter removed for skills). */
	body: string
	/** The parsed frontmatter. */
	frontmatter: Record<string, any>
	/** Whether the resource was already handed to DSH. */
	registered?: boolean
}

/**
 * The handlers for one main-thread service.
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension-host handle (for client→main calls).
 * @returns a map of VS Code protocol method name to handler.
 */
export default function createAiChatAgentsMethods(ctx: any, host: any): Record<string, (...args: any[]) => any> {
	const bridge = host as AiHostBridge | undefined
	/** The collected skills, keyed by their DSH-visible name. */
	const skills = new Map<string, ChatResource>()
	/** The collected instruction files. */
	const instructions: ChatResource[] = []
	/** The collected `.agent.md` custom agents. */
	const customAgents: ChatResource[] = []
	/** The collected `.prompt.md` prompt files. */
	const promptFiles: ChatResource[] = []
	/** handle → the runtime-registered agent (only `.agent.md` style agents are kept). */
	const runtimeAgents = new Map<number, { id: string; extensionId: string; dynamicProps: any; metadata: any }>()
	/** The disposers of the DSH skill registrations. */
	const skillDisposers = new Map<string, () => void>()

	// -------------------------------------------------------------------------
	// collection
	// -------------------------------------------------------------------------

	/**
	 * Read one contributed Markdown file and turn it into a chat resource.
	 */
	function collect(extension: AiExtensionRecord, relativePath: string, fallbackName: string): ChatResource | undefined {
		const text = readContributedFile(extension, relativePath)
		if (text === undefined) { return undefined }
		const { frontmatter, body } = parseFrontmatter(text)
		const name = typeof frontmatter.name === 'string' && frontmatter.name
			? frontmatter.name
			: (typeof frontmatter.title === 'string' && frontmatter.title ? frontmatter.title : fallbackName)
		const description = typeof frontmatter.description === 'string' ? frontmatter.description : undefined
		return {
			path: relativePath.startsWith('/') ? relativePath : joinPath(extension.extensionPath, relativePath),
			name,
			description,
			extensionId: protocolExtensionId(extension),
			extensionLabel: extension.manifest?.displayName ?? extension.manifest?.name ?? extension.name,
			body,
			frontmatter,
		}
	}

	/**
	 * Normalize a name into DSH's skill-name shape (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`).
	 */
	function toDshSkillName(name: string): string {
		const normalized = name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
		return normalized || 'skill'
	}

	/**
	 * Register one collected skill with DSH's skill registry.
	 *
	 * DSH's `ctx.skills.register()` takes a runtime skill: a name, a description and the Markdown
	 * body. The Agent Skills specification's `SKILL.md` has exactly those parts, so the mapping is
	 * one-to-one apart from the name normalization.
	 */
	function registerSkillWithDsh(skill: ChatResource): void {
		const registry = ctx?.skills
		if (!registry?.register) {
			log(ctx, 'warn', '[dsh-vscode] the DSH skill registry is unavailable; contributed skills stay invisible to the model', { skill: skill.name })
			return
		}
		const name = toDshSkillName(skill.name)
		if (skillDisposers.has(name)) {
			skillDisposers.get(name)?.()
			skillDisposers.delete(name)
		}
		try {
			const dispose = registry.register({
				name,
				description: skill.description ?? skill.frontmatter.description ?? `Skill contributed by ${skill.extensionLabel}`,
				content: skill.body,
				path: skill.path,
				source: 'custom',
				provider: skill.extensionId,
				resourceBase: { kind: 'directory', path: dirnameOf(skill.path) },
				invocation: { modelInvocable: true, userInvocable: true },
			} as any)
			skillDisposers.set(name, dispose)
			skill.registered = true
		} catch (error) {
			log(ctx, 'warn', '[dsh-vscode] a contributed skill could not be registered', {
				skill: skill.name,
				reason: String((error as any)?.message ?? error),
			})
		}
	}

	/**
	 * Scan every resolved extension for the four file-contributing chat extension points.
	 */
	function collectContributions(): void {
		for (const extension of resolveExtensionRecords(bridge)) {
			const contributes = extension.manifest?.contributes
			if (!contributes) { continue }

			for (const entry of asArray(contributes.chatSkills)) {
				const path = typeof entry?.path === 'string' ? entry.path : undefined
				if (!path) { continue }
				const skill = collect(extension, path, basenameWithoutExtension(path))
				if (!skill) {
					log(ctx, 'warn', '[dsh-vscode] a contributed skill file could not be read', { extension: protocolExtensionId(extension), path })
					continue
				}
				skills.set(skill.name, skill)
			}

			for (const entry of asArray(contributes.chatInstructions)) {
				const path = typeof entry?.path === 'string' ? entry.path : undefined
				if (!path) { continue }
				const instruction = collect(extension, path, basenameWithoutExtension(path))
				if (instruction) { instructions.push(instruction) }
			}

			for (const entry of asArray(contributes.chatAgents)) {
				const path = typeof entry?.path === 'string' ? entry.path : undefined
				if (!path) { continue }
				const agent = collect(extension, path, basenameWithoutExtension(path))
				if (agent) { customAgents.push(agent) }
			}

			for (const entry of asArray(contributes.chatPromptFiles)) {
				const path = typeof entry?.path === 'string' ? entry.path : undefined
				if (!path) { continue }
				const prompt = collect(extension, path, basenameWithoutExtension(path))
				if (prompt) { promptFiles.push(prompt) }
			}
		}
		for (const skill of skills.values()) {
			registerSkillWithDsh(skill)
		}
	}

	collectContributions()

	// -------------------------------------------------------------------------
	// the protocol methods
	// -------------------------------------------------------------------------

	return {
		/**
		 * Accept a progress chunk of a chat request.
		 *
		 * DSH has no chat widget, so the progress is dropped. The protocol method answers a
		 * promise; it must resolve, not reject.
		 */
		async '$handleProgressChunk'(requestId: string, chunks: any[]): Promise<void> {
			log(ctx, 'info', '[dsh-vscode] chat progress chunk dropped (DSH has no chat UI)', { requestId, count: Array.isArray(chunks) ? chunks.length : 0 })
		},

		/**
		 * Resolve an inline content anchor.
		 *
		 * DSH has no chat widget, so anchors cannot be resolved. The method is `void` upstream.
		 */
		'$handleAnchorResolve'(requestId: string, handle: string, anchor: any): void {
			log(ctx, 'info', '[dsh-vscode] chat anchor resolution dropped (DSH has no chat UI)', { requestId, handle })
		},

		/**
		 * Register one chat agent.
		 *
		 * A registration without `dynamicProps` is a **legacy chat participant**. Those are
		 * deprecated upstream and unsupported by the Copilot harness, so they are dropped with a
		 * warning instead of being turned into a DSH agent. A registration with `dynamicProps` is
		 * a `.agent.md`-style agent and is kept; the DSH agent-preset mapping is drafted in the
		 * report.
		 */
		'$registerAgent'(handle: number, extension: any, id: string, metadata: any, dynamicProps: any): void {
			const extensionId = typeof extension === 'string' ? extension : (extension?.value ?? 'unknown')
			if (!dynamicProps) {
				log(ctx, 'warn', '[dsh-vscode] chat participants are deprecated upstream and are not supported by DSH', { extension: extensionId, id })
				return
			}
			runtimeAgents.set(handle, { id, extensionId, dynamicProps, metadata })
		},

		/**
		 * Note that an extension registered a chat-participant detection provider.
		 *
		 * Participant detection belongs to the deprecated participant direction; DSH records the
		 * handle and does nothing else.
		 */
		'$registerChatParticipantDetectionProvider'(handle: number): void {
			log(ctx, 'warn', '[dsh-vscode] chat participant detection is not supported by DSH', { handle })
		},

		/** Note that a chat-participant detection provider was disposed. */
		'$unregisterChatParticipantDetectionProvider'(handle: number): void {
			log(ctx, 'info', '[dsh-vscode] chat participant detection provider unregistered', { handle })
		},

		/**
		 * Note that an extension registered a runtime prompt-file provider.
		 *
		 * The protocol has no `$providePromptFiles` counterpart, so the provider's files cannot be
		 * pulled through this channel; the handle is recorded only.
		 */
		'$registerPromptFileProvider'(handle: number, type: string, extension: any): void {
			log(ctx, 'info', '[dsh-vscode] runtime prompt-file provider registered', { handle, type })
		},

		/** Note that a runtime prompt-file provider was disposed. */
		'$unregisterPromptFileProvider'(handle: number): void {
			log(ctx, 'info', '[dsh-vscode] runtime prompt-file provider unregistered', { handle })
		},

		/** Note that the prompt files of one provider changed. */
		'$onDidChangePromptFiles'(handle: number): void {
			log(ctx, 'info', '[dsh-vscode] prompt files changed', { handle })
		},

		/**
		 * Note that an extension registered a chat-session customization provider.
		 *
		 * Chat sessions are a chat-widget concept; DSH has no chat widget, so the registration is
		 * recorded but not projected.
		 */
		'$registerChatSessionCustomizationProvider'(handle: number, chatSessionType: string, metadata: any, extension: any): void {
			log(ctx, 'info', '[dsh-vscode] chat session customization provider registered', { handle, chatSessionType })
		},

		/** Note that a chat-session customization provider was disposed. */
		'$unregisterChatSessionCustomizationProvider'(handle: number): void {
			log(ctx, 'info', '[dsh-vscode] chat session customization provider unregistered', { handle })
		},

		/** Note that the chat session customizations changed. */
		'$onDidChangeCustomizations'(handle: number): void {
			log(ctx, 'info', '[dsh-vscode] chat session customizations changed', { handle })
		},

		/**
		 * Note that an extension registered an agent-completion provider.
		 *
		 * Completions belong to the editor; DSH has no editor, so the registration is dropped.
		 */
		'$registerAgentCompletionsProvider'(handle: number, id: string, triggerCharacters: string[]): void {
			log(ctx, 'info', '[dsh-vscode] agent completions are not supported by DSH (no editor)', { handle, id })
		},

		/** Note that an agent-completion provider was disposed. */
		'$unregisterAgentCompletionsProvider'(handle: number, id: string): void {
			log(ctx, 'info', '[dsh-vscode] agent completions provider unregistered', { handle, id })
		},

		/** Apply a metadata update to one registered agent. */
		'$updateAgent'(handle: number, metadataUpdate: any): void {
			const agent = runtimeAgents.get(handle)
			if (!agent) { return }
			agent.metadata = { ...(agent.metadata ?? {}), ...(metadataUpdate ?? {}) }
		},

		/** Forget one registered agent. */
		'$unregisterAgent'(handle: number): void {
			runtimeAgents.delete(handle)
		},

		/**
		 * Move the active chat session to another workspace.
		 *
		 * DSH has no chat widget and therefore no active chat session; the call resolves.
		 */
		async '$transferActiveChatSession'(toWorkspace: any): Promise<void> {
			log(ctx, 'info', '[dsh-vscode] chat session transfer dropped (DSH has no chat UI)')
		},

		/**
		 * List the `.agent.md` custom agents the extensions contributed.
		 *
		 * The DTO shape is `ICustomAgentDto`; every field is required by the interface, so the
		 * values are filled with the documented defaults rather than left undefined.
		 */
		async '$provideCustomAgents'(token?: any): Promise<any[]> {
			const collected = customAgents.map(resource => toCustomAgentDto(resource))
			for (const agent of runtimeAgents.values()) {
				collected.push({
					uri: toFileUriComponents(''),
					name: agent.dynamicProps?.name ?? agent.id,
					description: agent.dynamicProps?.description,
					source: 'extension',
					extensionId: agent.extensionId,
					userInvocable: true,
					disableModelInvocation: false,
					enabled: true,
				})
			}
			return collected
		},

		/**
		 * List the instruction files the extensions contributed.
		 */
		async '$provideInstructions'(token?: any): Promise<any[]> {
			return instructions.map(resource => ({
				uri: toFileUriComponents(resource.path),
				name: resource.name,
				description: resource.description,
				source: 'extension',
				extensionId: resource.extensionId,
				pattern: typeof resource.frontmatter.applyTo === 'string' ? resource.frontmatter.applyTo : undefined,
			}))
		},

		/**
		 * List the skills the extensions contributed.
		 *
		 * The DTO shape is `ISkillDto`.
		 */
		async '$provideSkills'(token?: any): Promise<any[]> {
			return [...skills.values()].map(resource => ({
				uri: toFileUriComponents(resource.path),
				name: resource.name,
				description: resource.description,
				source: 'extension',
				extensionId: resource.extensionId,
				userInvocable: true,
				disableModelInvocation: false,
			}))
		},

		/**
		 * List the prompt files the extensions contributed.
		 *
		 * [inferred] The vendored protocol has no dedicated prompt-file provider, so the
		 * `.prompt.md` files are surfaced as slash commands, which is the closest DTO
		 * (`ISlashCommandDto`).
		 */
		async '$provideSlashCommands'(token?: any): Promise<any[]> {
			return promptFiles.map(resource => ({
				uri: toFileUriComponents(resource.path),
				name: resource.name,
				description: resource.description,
				source: 'extension',
				extensionId: resource.extensionId,
				userInvocable: true,
			}))
		},

		/**
		 * List the contributed hooks. DSH has no hook concept for chat sessions; the answer is an
		 * empty list (type-correct).
		 */
		async '$provideHooks'(token?: any): Promise<any[]> {
			return []
		},

		/**
		 * List the contributed plugins. DSH has no chat-plugin concept; the answer is an empty list
		 * (type-correct).
		 */
		async '$providePlugins'(token?: any): Promise<any[]> {
			return []
		},
	}
}

/** Build the `ICustomAgentDto` for one collected `.agent.md` file. */
function toCustomAgentDto(resource: ChatResource): any {
	return {
		uri: toFileUriComponents(resource.path),
		name: resource.name,
		description: resource.description,
		source: 'extension',
		extensionId: resource.extensionId,
		argumentHint: typeof resource.frontmatter.argumentHint === 'string' ? resource.frontmatter.argumentHint : undefined,
		tools: Array.isArray(resource.frontmatter.tools) ? resource.frontmatter.tools : undefined,
		model: typeof resource.frontmatter.model === 'string' ? [resource.frontmatter.model] : undefined,
		userInvocable: resource.frontmatter.disableModelInvocation !== 'true',
		disableModelInvocation: resource.frontmatter.disableModelInvocation === 'true',
		enabled: true,
	}
}

/** Coerce an unknown value into an array. */
function asArray(value: unknown): any[] {
	return Array.isArray(value) ? value : []
}

/** The file name without its extension. */
function basenameWithoutExtension(path: string): string {
	const base = path.split('/').pop() ?? path
	return base.replace(/\.[^.]+$/, '')
}

/** Join two path fragments with a single separator. */
function joinPath(base: string, relative: string): string {
	if (!base) { return relative }
	return `${base.replace(/\/$/, '')}/${relative.replace(/^\.\//, '').replace(/^\//, '')}`
}

/** The directory part of a path. */
function dirnameOf(path: string): string {
	const index = path.lastIndexOf('/')
	return index > 0 ? path.slice(0, index) : '.'
}
