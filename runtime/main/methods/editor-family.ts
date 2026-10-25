/*---------------------------------------------------------------------------------------------
 *  A-class main-thread service — `editorFamily`.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  EVERY EDITOR-SURFACE METHOD IS EXPLICITLY UNSUPPORTED
 *  ---------------------------------------------------
 *  DSH has NO editor, NO document model, NO cursor, NO selection, NO decoration surface and
 *  NO status bar. Every method of the editor family therefore answers with the
 *  TYPE-CORRECT EMPTY VALUE and NEVER THROWS.
 *
 *  Throwing is the wrong move here, and the spike measured why: an extension that registers
 *  a provider during `activate()` would fail to ACTIVATE, and the failure takes the WHOLE
 *  extension host with it. `redhat.vscode-yaml` registers 11 language providers in its
 *  `activate()`; every one of them is silently dropped and the extension activates fine
 *  (`vscode-extension-support/exthost-spike.md` §4.5).
 *
 *  WHAT THIS MODULE IS FOR
 *  -----------------------
 *  The generated stub (`runtime/main/stub-returns.ts`) already answers the right empty value
 *  for all of these methods. This module makes the contract EXPLICIT and INDEPENDENT of the
 *  generator: a reader of the code sees "this is not supported" rather than having to infer
 *  it from a table, and a future change to the generator cannot silently break the contract.
 *
 *  The channel split follows the protocol: the editor surface is ELEVEN channels. The
 *  default export is the biggest one, `MainThreadLanguageFeatures` — the provider
 *  registrations that cover completion, hover, suggest, code lens, inline values, code
 *  actions, formatting, rename, signature help and the rest. The other ten channels are
 *  exported as named factories.
 *--------------------------------------------------------------------------------------------*/

import type { ExtHostContext, MainThreadMethodFactory } from '../host-context.js';

/**
 * The handlers for the `MainThreadLanguageFeatures` channel.
 *
 * Every method is a REGISTRATION or a NOTIFICATION, so the type-correct empty value for
 * all of them is `undefined`.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @returns a map of VS Code protocol method name to handler.
 */
export const createLanguageFeaturesMethods: MainThreadMethodFactory = (_ctx: any, _host: ExtHostContext) => ({
	// -- the events the host would raise when a provider's result changed
	'$emitCodeLensEvent'(): void { /* no editor, no code lens */ },
	'$emitDocumentRangeSemanticTokensEvent'(): void { /* no editor, no semantic tokens */ },
	'$emitDocumentSemanticTokensEvent'(): void { /* no editor, no semantic tokens */ },
	'$emitFoldingRangeEvent'(): void { /* no editor, no folding ranges */ },
	'$emitInlayHintsEvent'(): void { /* no editor, no inlay hints */ },
	'$emitInlineCompletionModelInfoChange'(): void { /* no editor, no inline completions */ },
	'$emitInlineCompletionProviderOptionsChange'(): void { /* no editor, no inline completions */ },
	'$emitInlineCompletionsChange'(): void { /* no editor, no inline completions */ },
	'$emitInlineValuesEvent'(): void { /* no editor, no inline values */ },

	// -- the provider registrations
	'$registerCallHierarchyProvider'(): void { /* no editor */ },
	'$registerCodeActionSupport'(): void { /* no editor */ },
	'$registerCodeLensSupport'(): void { /* no editor */ },
	'$registerCompletionsProvider'(): void { /* no editor */ },
	'$registerDeclarationSupport'(): void { /* no editor */ },
	'$registerDefinitionSupport'(): void { /* no editor */ },
	'$registerDocumentColorProvider'(): void { /* no editor */ },
	'$registerDocumentFormattingSupport'(): void { /* no editor */ },
	'$registerDocumentHighlightProvider'(): void { /* no editor */ },
	'$registerDocumentLinkProvider'(): void { /* no editor */ },
	'$registerDocumentOnDropEditProvider'(): void { /* no editor */ },
	'$registerDocumentRangeSemanticTokensProvider'(): void { /* no editor */ },
	'$registerDocumentSemanticTokensProvider'(): void { /* no editor */ },
	'$registerDocumentSymbolProvider'(): void { /* no editor */ },
	'$registerEvaluatableExpressionProvider'(): void { /* no editor */ },
	'$registerFoldingRangeProvider'(): void { /* no editor */ },
	'$registerHoverProvider'(): void { /* no editor */ },
	'$registerImplementationSupport'(): void { /* no editor */ },
	'$registerInlayHintsProvider'(): void { /* no editor */ },
	'$registerInlineCompletionsSupport'(): void { /* no editor */ },
	'$registerInlineValuesProvider'(): void { /* no editor */ },
	'$registerLinkedEditingRangeProvider'(): void { /* no editor */ },
	'$registerMultiDocumentHighlightProvider'(): void { /* no editor */ },
	'$registerNavigateTypeSupport'(): void { /* no editor */ },
	'$registerNewSymbolNamesProvider'(): void { /* no editor */ },
	'$registerOnTypeFormattingSupport'(): void { /* no editor */ },
	'$registerPasteEditProvider'(): void { /* no editor */ },
	'$registerRangeFormattingSupport'(): void { /* no editor */ },
	'$registerReferenceSupport'(): void { /* no editor */ },
	'$registerRenameSupport'(): void { /* no editor */ },
	'$registerSelectionRangeProvider'(): void { /* no editor */ },
	'$registerSignatureHelpProvider'(): void { /* no editor */ },
	'$registerTypeDefinitionSupport'(): void { /* no editor */ },
	'$registerTypeHierarchyProvider'(): void { /* no editor */ },
	'$resolveDocumentOnDropFileData'(): void { /* no editor */ },
	'$resolvePasteFileData'(): void { /* no editor */ },
	'$setLanguageConfiguration'(): void { /* no editor */ },
	'$unregister'(): void { /* no editor */ },
})

/**
 * The handlers for the `MainThreadDocuments` channel.
 *
 * @returns a map of VS Code protocol method name to handler.
 */
export const createDocumentsMethods: MainThreadMethodFactory = () => ({
	'$tryCreateDocument'(): undefined { return undefined },
	'$tryOpenDocument'(): undefined { return undefined },
	'$trySaveDocument'(): boolean { return false },
})

/**
 * The handlers for the `MainThreadTextEditors` channel.
 *
 * @returns a map of VS Code protocol method name to handler.
 */
export const createTextEditorsMethods: MainThreadMethodFactory = () => ({
	'$getDiffInformation'(): unknown[] { return [] },
	'$registerTextEditorDecorationType'(): undefined { return undefined },
	'$removeTextEditorDecorationType'(): undefined { return undefined },
	'$tryApplyEdits'(): boolean { return false },
	'$tryHideEditor'(): undefined { return undefined },
	'$tryInsertSnippet'(): boolean { return false },
	'$tryRevealRange'(): undefined { return undefined },
	'$trySetDecorations'(): undefined { return undefined },
	'$trySetDecorationsFast'(): undefined { return undefined },
	'$trySetOptions'(): undefined { return undefined },
	'$trySetSelections'(): undefined { return undefined },
	'$tryShowEditor'(): undefined { return undefined },
	'$tryShowTextDocument'(): undefined { return undefined },
})

/**
 * The handlers for the `MainThreadDecorations` channel.
 *
 * @returns a map of VS Code protocol method name to handler.
 */
export const createDecorationsMethods: MainThreadMethodFactory = () => ({
	'$onDidChange'(): void { /* no editor, no decorations */ },
	'$registerDecorationProvider'(): void { /* no editor */ },
	'$unregisterDecorationProvider'(): void { /* no editor */ },
})

/**
 * The handlers for the `MainThreadCustomEditors` channel.
 *
 * @returns a map of VS Code protocol method name to handler.
 */
export const createCustomEditorsMethods: MainThreadMethodFactory = () => ({
	'$onContentChange'(): void { /* no custom editors */ },
	'$onDidChangeCustomTextEditorSelection'(): void { /* no custom editors */ },
	'$onDidEdit'(): void { /* no custom editors */ },
	'$registerCustomEditorProvider'(): void { /* no custom editors */ },
	'$registerTextEditorProvider'(): void { /* no custom editors */ },
	'$unregisterEditorProvider'(): void { /* no custom editors */ },
})

/**
 * The handlers for the `MainThreadDocumentContentProviders` channel.
 *
 * @returns a map of VS Code protocol method name to handler.
 */
export const createDocumentContentProvidersMethods: MainThreadMethodFactory = () => ({
	'$onVirtualDocumentChange'(): void { /* no virtual documents */ },
	'$registerTextContentProvider'(): void { /* no virtual documents */ },
	'$unregisterTextContentProvider'(): void { /* no virtual documents */ },
})

/**
 * The handlers for the `MainThreadDiagnostics` channel.
 *
 * @returns a map of VS Code protocol method name to handler.
 */
export const createDiagnosticsMethods: MainThreadMethodFactory = () => ({
	'$changeMany'(): void { /* no editor, no markers */ },
	'$clear'(): void { /* no editor, no markers */ },
})

/**
 * The handlers for the `MainThreadDocumentDiff` channel.
 *
 * @returns a map of VS Code protocol method name to handler.
 */
export const createDocumentDiffMethods: MainThreadMethodFactory = () => ({
	'$computeDocumentDiff'(): undefined { return undefined },
})

/**
 * The handlers for the `MainThreadQuickDiff` channel.
 *
 * @returns a map of VS Code protocol method name to handler.
 */
export const createQuickDiffMethods: MainThreadMethodFactory = () => ({
	'$createSourceControlDiffInformation'(): undefined { return undefined },
	'$disposeSourceControlDiffInformation'(): undefined { return undefined },
	'$registerQuickDiffProvider'(): void { /* no editor */ },
	'$unregisterQuickDiffProvider'(): void { /* no editor */ },
})

/**
 * The handlers for the `MainThreadEditorInsets` channel.
 *
 * @returns a map of VS Code protocol method name to handler.
 */
export const createEditorInsetsMethods: MainThreadMethodFactory = () => ({
	'$createEditorInset'(): void { /* no editor, and DSH has no webview */ },
	'$disposeEditorInset'(): void { /* no editor, and DSH has no webview */ },
	'$postMessage'(): boolean { return false },
	'$setHtml'(): void { /* no editor, and DSH has no webview */ },
	'$setOptions'(): void { /* no editor, and DSH has no webview */ },
})

/**
 * The handlers for the `MainThreadEditorTabs` channel.
 *
 * @returns a map of VS Code protocol method name to handler.
 */
export const createEditorTabsMethods: MainThreadMethodFactory = () => ({
	'$closeGroup'(): boolean { return false },
	'$closeTab'(): boolean { return false },
	'$moveTab'(): undefined { return undefined },
})

/**
 * The handlers for one main-thread service.
 *
 * The default export is the `MainThreadLanguageFeatures` channel — the provider
 * registrations that cover completion, hover, suggest, code lens, inline values, code
 * actions, formatting, rename and signature help. The other ten editor channels are
 * exported as the named factories above.
 *
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle.
 * @returns a map of VS Code protocol method name to handler.
 */
export default function createEditorFamilyMethods(ctx: any, host: ExtHostContext): Record<string, (...args: any[]) => any> {
	return createLanguageFeaturesMethods(ctx, host)
}
