/*---------------------------------------------------------------------------------------------
 *  A-class main-thread service — `extensions`.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  Protocol shape: `MainThreadExtensionServiceShape`
 *  (`vendor/src/vs/workbench/api/common/extHost.protocol.ts:2082`).
 *
 *      $getExtension(extensionId): Promise<Dto<IExtensionDescription> | undefined>
 *      $activateExtension(extensionId, reason): Promise<void>   <- lives in `lifecycle.ts`
 *      $onWillActivateExtension(extensionId): Promise<void>
 *      $onDidActivateExtension(extensionId, codeLoadingTime, activateCallTime, activateResolvedTime, reason): void
 *      $onExtensionActivationError(extensionId, error, missingExtensionDependency): Promise<void>
 *      $onExtensionRuntimeError(extensionId, error): void
 *      $setPerformanceMarks(marks): Promise<void>
 *      $asBrowserUri(uri): Promise<UriComponents>
 *
 *  THE TWO DIRECTIONS
 *  ------------------
 *  - the ext host CALLS the main side for `$getExtension` (the `vscode.extensions.getExtension`
 *    API, `extHostExtensionService.ts:290`) and for the three activation notifications;
 *  - the main side CALLS the ext host for `$activate`
 *    (`ExtHostExtensionServiceShape.$activate`, `extHost.protocol.ts`); that call lives in
 *    the `lifecycle` module, which owns the activation verb of this channel.
 *
 *  `$asBrowserUri` belongs to the `env` module: it is the one method that exposes the
 *  application's URI scheme.
 *
 *  THE `IExtensionDescription` DTO
 *  ------------------------------
 *  The ext host rebuilds the identifier and the location from the answer
 *  (`extHostExtensionService.ts:291-294`):
 *
 *      identifier: new ExtensionIdentifier(ext.identifier.value)
 *      extensionLocation: URI.revive(ext.extensionLocation)
 *
 *  so the DTO must carry `identifier: { value, _lower }` and a `UriComponents` location. The
 *  shape is the same one the init payload carries
 *  (`packages/dsh-vscode-protocol/src/vscode/init-data.ts:107-145`), so the two agree.
 *--------------------------------------------------------------------------------------------*/

import type { ExtHostContext } from '../host-context.js';
import { log, toExtensionIdentifier, toFileUriComponents } from './support.js';

/** The ext-host channel that activates an extension. */
const EXT_HOST_CHANNEL_EXTENSION_SERVICE = 'ExtHostExtensionService';

/**
 * The handlers for one main-thread service.
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle (for client→main calls).
 * @returns a map of VS Code protocol method name to handler.
 */
export default function createExtensionsMethods(ctx: any, host: ExtHostContext): Record<string, (...args: any[]) => any> {
	/**
	 * The protocol id of an extension identifier on the wire.
	 *
	 * `ExtensionIdentifier` is a class with `value` and `_lower`; a plain string is accepted
	 * too, because some call sites pass the id directly.
	 *
	 * @param id - the identifier.
	 * @returns the protocol id, `publisher.name`.
	 */
	function identifierValue(id: unknown): string {
		if (typeof id === 'string') { return id }
		const value = (id as any)?.value
		if (typeof value === 'string') { return value }
		const plain = (id as any)?.id
		if (typeof plain === 'string') { return plain }
		return String(id)
	}

	/**
	 * The resolved extension with that protocol id.
	 *
	 * @param id - the protocol id.
	 * @returns the extension, or `undefined`.
	 */
	function find(id: string): any {
		return (host.extensions ?? []).find((extension: any) => extension?.extensionId === id || extension?.id === id)
	}

	/**
	 * The `IExtensionDescription` of one extension, in the shape the ext host expects.
	 *
	 * The fields mirror the init payload's `allExtensions` entries
	 * (`packages/dsh-vscode-protocol/src/vscode/init-data.ts:107-145`) so that the ext host
	 * sees ONE description for an extension, no matter whether it read it from the init
	 * payload or asked the main side for it.
	 *
	 * @param extension - the resolved extension.
	 * @returns the DTO.
	 */
	function toDescription(extension: any): any {
		const manifest = extension?.manifest ?? {}
		return {
			id: extension?.extensionId ?? manifest.name,
			identifier: toExtensionIdentifier(extension?.extensionId ?? manifest.name),
			uuid: undefined,
			name: manifest.name,
			displayName: manifest.displayName,
			publisher: manifest.publisher ?? extension?.publisher,
			publisherDisplayName: manifest.publisher ?? extension?.publisher,
			version: manifest.version ?? extension?.version,
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
			targetPlatform: extension?.targetPlatform ?? 'undefined',
			isBuiltin: false,
			isUserBuiltin: false,
			isUnderDevelopment: false,
			extensionLocation: toFileUriComponents(extension?.extensionPath ?? ''),
			preRelease: false,
		}
	}

	/**
	 * The message of an error on the wire.
	 *
	 * @param error - the error.
	 * @returns the message.
	 */
	function errorText(error: unknown): string {
		if (typeof error === 'string') { return error }
		const message = (error as any)?.message
		if (typeof message === 'string') { return message }
		try {
			return JSON.stringify(error) ?? String(error)
		} catch {
			return String(error)
		}
	}

	return {
		/**
		 * Describe one extension.
		 *
		 * The ext host calls this for `vscode.extensions.getExtension(id)`
		 * (`extHostExtensionService.ts:290`). An unknown id answers `undefined`, which is the
		 * type-correct empty value.
		 *
		 * @param extensionId - the protocol id, `publisher.name`.
		 * @returns the extension description.
		 */
		async '$getExtension'(extensionId: string): Promise<any> {
			const extension = find(identifierValue(extensionId))
			if (!extension) { return undefined }
			return toDescription(extension)
		},

		/**
		 * Note that an extension is about to activate.
		 *
		 * @param extensionId - the protocol id.
		 */
		async '$onWillActivateExtension'(extensionId: unknown): Promise<void> {
			host.log(`MainThreadExtensionService.$onWillActivateExtension(${identifierValue(extensionId)})`)
		},

		/**
		 * Note that an extension activated.
		 *
		 * The host's own state (`host.markActivated`) is what the Extensions page reads, so
		 * this is the moment the extension becomes "active" for the user.
		 *
		 * @param extensionId - the protocol id.
		 * @param codeLoadingTime - the module load time, in milliseconds.
		 * @param activateCallTime - the time the activation call took.
		 * @param activateResolvedTime - the time until the activation resolved.
		 * @param reason - the activation reason.
		 */
		'$onDidActivateExtension'(
			extensionId: unknown,
			codeLoadingTime: number,
			activateCallTime: number,
			activateResolvedTime: number,
			reason: unknown,
		): void {
			const id = identifierValue(extensionId)
			try {
				host.markActivated?.(id)
			} catch { /* the handle is read-only in some builds */ }
			host.log(
				`MainThreadExtensionService.$onDidActivateExtension(${id}) ` +
				`codeLoading=${codeLoadingTime}ms activateCall=${activateCallTime}ms ` +
				`activateResolved=${activateResolvedTime}ms`,
			)
		},

		/**
		 * Note that an extension failed to activate.
		 *
		 * @param extensionId - the protocol id.
		 * @param error - the error on the wire.
		 * @param missingExtensionDependency - the dependency that was missing, if any.
		 */
		async '$onExtensionActivationError'(extensionId: unknown, error: unknown, missingExtensionDependency: unknown): Promise<void> {
			const id = identifierValue(extensionId)
			const message = errorText(error)
			try {
				host.markActivationError?.(id, message)
			} catch { /* the handle is read-only in some builds */ }
			host.log(`MainThreadExtensionService.$onExtensionActivationError(${id}): ${message}`)
			if (missingExtensionDependency) {
				host.log(`MainThreadExtensionService: missing dependency ${JSON.stringify(missingExtensionDependency)}`)
			}
		},

		/**
		 * Note that an extension threw at runtime.
		 *
		 * @param extensionId - the protocol id.
		 * @param error - the error on the wire.
		 */
		'$onExtensionRuntimeError'(extensionId: unknown, error: unknown): void {
			const id = identifierValue(extensionId)
			const message = errorText(error)
			try {
				host.markActivationError?.(id, message)
			} catch { /* the handle is read-only in some builds */ }
			host.log(`MainThreadExtensionService.$onExtensionRuntimeError(${id}): ${message}`)
		},

		/**
		 * Receive the extension host's performance marks.
		 *
		 * The marks are VS Code's own profiler output; DSH does not consume them, and the
		 * protocol method is `void`.
		 *
		 * @param marks - the marks.
		 */
		async '$setPerformanceMarks'(marks: unknown): Promise<void> {
			host.log(`MainThreadExtensionService.$setPerformanceMarks(${Array.isArray(marks) ? marks.length : 0} marks)`)
		},
	}
}
