/*---------------------------------------------------------------------------------------------
 *  A-class main-thread service — `languages`.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  Protocol shape: `MainThreadLanguagesShape`
 *  (`vendor/src/vs/workbench/api/common/extHost.protocol.ts`).
 *
 *      $changeLanguage(resource, languageId): Promise<void>
 *      $tokensAtPosition(resource, position): Promise<undefined | { type, range }>
 *      $computeFullSyntaxHighlighting(source, languageId): Promise<ISyntaxHighlightingResultDto>
 *      $setLanguageStatus(handle, status): void
 *      $removeLanguageStatus(handle): void
 *
 *  AND `MainThreadLanguageFeaturesShape` (the 40-odd provider registrations)
 *  ----------------------------------------------------------------------
 *  Those methods are NOT implemented here, and they do not need to be: every one of them is
 *  a REGISTRATION or a NOTIFICATION, and the type-correct empty value for all of them is
 *  `undefined` — which is exactly what the generated stub already answers
 *  (`runtime/main/stub-returns.ts`, the `MainThreadLanguageFeatures.*` entries).
 *
 *  The spike measured that behaviour: `redhat.vscode-yaml` registered 11 language providers
 *  during `activate()` and every one of them was silently dropped, with no error and no
 *  crash (`vscode-extension-support/exthost-spike.md` §4.5, "静默丢弃").
 *
 *  `ctx.lsp`
 *  -------
 *  DSH's API catalog describes a language-server seam — `ctx.lsp.registerProvider(provider)`
 *  and `ctx.lsp.query(request, signal)`
 *  (`dsh-tool-cordis/lib/types/api-catalog.js`, the `lsp` service) with a complete type
 *  contract (`LspProvider`, `LspQueryRequest`, `LspQueryResult`). There is NO IMPLEMENTATION
 *  package in this build: `@deepseek-ai/` has no `*lsp*` package, and no service registers
 *  the name `lsp`. The seam is therefore a documented capability DSH does not have yet, and
 *  the methods that would use it answer the empty value.
 *--------------------------------------------------------------------------------------------*/

import type { ExtHostContext } from '../host-context.js';
import { log, service } from './support.js';

/**
 * The handlers for one main-thread service.
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle (for client→main calls).
 * @returns a map of VS Code protocol method name to handler.
 */
export default function createLanguagesMethods(ctx: any, host: ExtHostContext): Record<string, (...args: any[]) => any> {
	/**
	 * The DSH language-server seam, or `undefined` when it is not mounted.
	 *
	 * @returns the service.
	 */
	function lsp(): any {
		return service(ctx, 'lsp')
	}

	return {
		/**
		 * Change the language of a resource.
		 *
		 * DSH has no document model, so there is no resource to change the language of.
		 *
		 * @param resource - the URI.
		 * @param languageId - the language id.
		 */
		async '$changeLanguage'(resource: unknown, languageId: string): Promise<void> {
			host.log(`MainThreadLanguages.$changeLanguage(${languageId}) is ignored: DSH has no document model`)
		},

		/**
		 * Read the syntax token at a position.
		 *
		 * The protocol allows `undefined` for "no token", which is the type-correct empty
		 * value.
		 *
		 * @returns `undefined`.
		 */
		async '$tokensAtPosition'(): Promise<undefined> {
			return undefined
		},

		/**
		 * Compute the syntax highlighting of a source.
		 *
		 * The protocol types the answer as `ISyntaxHighlightingResultDto`
		 * (`extHost.protocol.ts:615`): `{ tokens, colorMap, darkColorMap? }`. The generated
		 * stub answers `undefined`, which is NOT type-correct, so the empty result is built
		 * here.
		 *
		 * @returns the empty highlighting result.
		 */
		async '$computeFullSyntaxHighlighting'(): Promise<{ tokens: unknown[]; colorMap: string[]; darkColorMap?: string[] }> {
			return { tokens: [], colorMap: [], darkColorMap: [] }
		},

		/**
		 * Publish a language status.
		 *
		 * DSH has no status bar, so the status is dropped.
		 *
		 * @param handle - the handle.
		 * @param status - the status.
		 */
		'$setLanguageStatus'(handle: number, status: unknown): void {
			// DSH has no status bar; the status is dropped.
		},

		/**
		 * Withdraw a language status.
		 *
		 * @param handle - the handle.
		 */
		'$removeLanguageStatus'(handle: number): void {
			// DSH has no status bar; the status is dropped.
		},
	}
}
