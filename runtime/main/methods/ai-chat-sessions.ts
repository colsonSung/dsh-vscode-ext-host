/*---------------------------------------------------------------------------------------------
 *  D-class (AI) main-thread service — chat sessions (`contributes.chatSessions`).
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  Protocol shape: `MainThreadChatSessionsShape`
 *  (`vendor/src/vs/workbench/api/common/extHost.protocol.ts:4086`).
 *
 *  Reality: a VS Code chat session is a *chat widget* concept (a conversation in the chat view
 *  with its own provider, options and progress). DSH has no chat widget, no session list and no
 *  chat-session persistence. Every method below therefore answers with a type-correct empty
 *  value and records what it saw, so the extension host never crashes and the report can state
 *  exactly which surface is missing.
 *
 *  The one thing DSH *can* take from `contributes.chatSessions` is the declared session **type**
 *  (`type` / `name` / `displayName` / `description` / `icon` / `order`); those are collected and
 *  exposed for the DSH-side mapping draft in the report.
 *--------------------------------------------------------------------------------------------*/

import {
	log,
	protocolExtensionId,
	resolveExtensionRecords,
	type AiHostBridge,
} from './ai-support.js'

/** One chat-session type declared by an extension. */
interface ChatSessionType {
	/** The session type id. */
	type: string
	/** The technical name. */
	name: string
	/** The display name. */
	displayName: string
	/** The description. */
	description?: string
	/** The owning extension id. */
	extensionId: string
	/** The `when` clause, kept verbatim (DSH has no context-key engine to evaluate it). */
	when?: string
}

/**
 * The handlers for one main-thread service.
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension-host handle (for client→main calls).
 * @returns a map of VS Code protocol method name to handler.
 */
export default function createAiChatSessionsMethods(ctx: any, host: any): Record<string, (...args: any[]) => any> {
	const bridge = host as AiHostBridge | undefined
	/** controller handle → the session type it serves. */
	const controllers = new Map<number, { chatSessionType: string; supportsResolve: boolean }>()
	/** content-provider handle → the scheme it serves. */
	const contentProviders = new Map<number, string>()
	/** The session types the extensions declared. */
	const sessionTypes: ChatSessionType[] = []

	// Collect `contributes.chatSessions` from every resolved extension.
	for (const extension of resolveExtensionRecords(bridge)) {
		const declared = extension.manifest?.contributes?.chatSessions
		if (!Array.isArray(declared)) { continue }
		for (const entry of declared as any[]) {
			if (typeof entry?.type !== 'string') { continue }
			sessionTypes.push({
				type: entry.type,
				name: typeof entry.name === 'string' ? entry.name : entry.type,
				displayName: typeof entry.displayName === 'string' ? entry.displayName : entry.type,
				description: typeof entry.description === 'string' ? entry.description : undefined,
				extensionId: protocolExtensionId(extension),
				when: typeof entry.when === 'string' ? entry.when : undefined,
			})
		}
	}

	return {
		/**
		 * Note that an extension registered a chat-session item controller.
		 *
		 * The controller is what lets the extension list and resolve chat-session items. DSH has
		 * no chat-session list, so the registration is recorded only.
		 */
		'$registerChatSessionItemController'(controllerHandle: number, chatSessionType: string, supportsResolve: boolean): void {
			controllers.set(controllerHandle, { chatSessionType, supportsResolve: !!supportsResolve })
			log(ctx, 'info', '[dsh-vscode] chat session item controller registered (DSH has no chat session list)', { controllerHandle, chatSessionType })
		},

		/** Record a capability change of one chat-session item controller. */
		'$updateChatSessionItemControllerCapabilities'(controllerHandle: number, supportsResolve: boolean): void {
			const controller = controllers.get(controllerHandle)
			if (controller) { controller.supportsResolve = !!supportsResolve }
		},

		/** Forget one chat-session item controller. */
		'$unregisterChatSessionItemController'(controllerHandle: number): void {
			controllers.delete(controllerHandle)
		},

		/**
		 * Apply a change to the chat-session items of one controller.
		 *
		 * The protocol answers a promise; it resolves because there is no session store to fail.
		 */
		async '$updateChatSessionItems'(controllerHandle: number, change: any): Promise<void> {
			log(ctx, 'info', '[dsh-vscode] chat session items update dropped (DSH has no chat session store)', { controllerHandle })
		},

		/**
		 * Add or update one chat-session item.
		 *
		 * The protocol answers a promise. It resolves because there is no session store to fail.
		 */
		async '$addOrUpdateChatSessionItem'(controllerHandle: number, item: any): Promise<void> {
			log(ctx, 'info', '[dsh-vscode] chat session item dropped (DSH has no chat session store)', { controllerHandle, id: item?.id })
		},

		/** Note that a chat-session item was committed to a different resource. */
		'$onDidCommitChatSessionItem'(controllerHandle: number, original: any, modified: any): void {
			log(ctx, 'info', '[dsh-vscode] chat session item commit dropped (DSH has no chat session store)', { controllerHandle })
		},

		/**
		 * Note that an extension registered a chat-session content provider.
		 *
		 * The scheme would let the extension serve `scheme:` resources into a chat session. DSH
		 * has no chat widget and therefore no such resource surface.
		 */
		'$registerChatSessionContentProvider'(handle: number, chatSessionScheme: string): void {
			contentProviders.set(handle, chatSessionScheme)
			log(ctx, 'info', '[dsh-vscode] chat session content provider registered (DSH has no chat UI)', { handle, chatSessionScheme })
		},

		/** Forget one chat-session content provider. */
		'$unregisterChatSessionContentProvider'(handle: number): void {
			contentProviders.delete(handle)
		},

		/** Note that the options of one chat session changed. */
		'$onDidChangeChatSessionOptions'(handle: number, sessionResource: any, updates: any): void {
			log(ctx, 'info', '[dsh-vscode] chat session options changed (no DSH counterpart)', { handle })
		},

		/** Note that the provider options of the chat sessions changed. */
		'$onDidChangeChatSessionProviderOptions'(handle: number): void {
			log(ctx, 'info', '[dsh-vscode] chat session provider options changed (no DSH counterpart)', { handle })
		},

		/** Note that the input state of one chat session changed. */
		'$updateChatSessionInputState'(controllerHandle: number, sessionResource: any, optionGroups: any): void {
			log(ctx, 'info', '[dsh-vscode] chat session input state changed (no DSH counterpart)', { controllerHandle })
		},

		/**
		 * Accept a progress chunk of a chat-session request.
		 *
		 * The protocol answers a promise; it resolves because DSH renders no chat progress.
		 */
		async '$handleProgressChunk'(handle: number, sessionResource: any, requestId: string, chunks: any[]): Promise<void> {
			log(ctx, 'info', '[dsh-vscode] chat session progress dropped (DSH has no chat UI)', { handle, requestId })
		},

		/** Resolve an inline anchor of a chat-session response. */
		'$handleAnchorResolve'(handle: number, sessionResource: any, requestId: string, requestHandle: string, anchor: any): void {
			log(ctx, 'info', '[dsh-vscode] chat session anchor resolution dropped (DSH has no chat UI)', { handle, requestId })
		},

		/** Note that a chat-session request finished. */
		'$handleProgressComplete'(handle: number, sessionResource: any, requestId: string): void {
			log(ctx, 'info', '[dsh-vscode] chat session progress complete', { handle, requestId })
		},
	}
}
