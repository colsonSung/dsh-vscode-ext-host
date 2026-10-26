/**
 * The `ctx.lsp` seam: provider registration and per-query selection.
 *
 * ## Why this file exists
 *
 * The generated DSH API catalog (`@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js`,
 * produced by `scripts/gen-cordis-api.ts`) documents a service `lsp` with exactly two
 * operations — `registerProvider` and `query` — and a complete set of `Lsp*` types. That
 * catalog is a **static description of the API surface**, not proof that a service is
 * running: in the shipped build no package registers `lsp`
 * (`grep -rn "super(ctx, 'lsp')"` over `@deepseek-ai/` finds nothing, and there is no
 * `@deepseek-ai/dsh-lsp*` package in the distribution). The reference to
 * `@deepseek-ai/dsh-lsp` in the composition reference is the monorepo package, which is
 * not shipped.
 *
 * So this bundle **provides the seam itself** when nothing else has, implementing the
 * catalogued contract exactly, and registers its own stdio provider into it. When a real
 * `@deepseek-ai/dsh-lsp` is present, this bundle steps aside and registers into that one
 * instead — the provider contract is identical either way.
 *
 * ## The contract this implements
 *
 * - `registerProvider(provider)` — "atomically reserving its id and every normalized
 *   extension. Any conflict or invalid input publishes nothing and throws `LspError`; the
 *   returned disposer releases all reservations."
 * - `query(request, signal?)` — "Select a provider by the file's extension and run one
 *   query. Selection is per-query and order-independent; no match throws `LspError`
 *   `LSP_UNAVAILABLE`."
 *
 * @module @local/dsh-lsp-stdio/lsp-service
 */

import { LspErrorCode, lspError } from './lsp-error.js'

/**
 * Normalize a file extension to the seam's reservation key.
 *
 * The catalog says "every normalized extension" without defining the normalization, so
 * this bundle defines it: lower-cased, no leading dot, so `.ts`, `.TS` and `ts` are the
 * same reservation. Both a provider's `extensionToLanguage` keys and a request's file
 * path go through this function, so the two always meet.
 *
 * @param {string} extension - a file extension, with or without its dot.
 * @returns {string} the normalized key, or the empty string when there is none.
 */
export function normalizeExtension(extension) {
  const raw = typeof extension === 'string' ? extension.trim().toLowerCase() : ''
  if (raw.length === 0) return ''
  return raw.startsWith('.') ? raw.slice(1) : raw
}

/**
 * Extract the normalized extension of a file path.
 *
 * @param {string} filePath - an absolute or relative file path.
 * @returns {string} the normalized extension, or the empty string for a dotless name.
 */
export function extensionOfFilePath(filePath) {
  const raw = typeof filePath === 'string' ? filePath : ''
  const base = raw.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return normalizeExtension(base.slice(dot + 1))
}

/**
 * Validate a provider and compute its reservations, without publishing anything.
 *
 * @param {any} provider - the candidate provider.
 * @returns {{ id: string, extensions: Map<string, string> }} the validated id and the
 *   normalized extension to language map.
 * @throws {LspError} `LSP_INVALID_REQUEST` when the provider is not usable.
 */
export function validateProvider(provider) {
  if (provider === null || typeof provider !== 'object') {
    throw lspError(LspErrorCode.INVALID_REQUEST, 'an LSP provider must be an object')
  }
  const { id, extensionToLanguage, query } = provider
  if (typeof id !== 'string' || id.length === 0) {
    throw lspError(LspErrorCode.INVALID_REQUEST, 'an LSP provider must carry a non-empty string id')
  }
  if (typeof query !== 'function') {
    throw lspError(LspErrorCode.INVALID_REQUEST, `LSP provider "${id}" must expose a query() function`)
  }
  if (extensionToLanguage === null || typeof extensionToLanguage !== 'object') {
    throw lspError(LspErrorCode.INVALID_REQUEST, `LSP provider "${id}" must carry an extensionToLanguage map`)
  }

  const extensions = new Map()
  for (const [key, languageId] of Object.entries(extensionToLanguage)) {
    const normalized = normalizeExtension(key)
    if (normalized.length === 0) {
      throw lspError(LspErrorCode.INVALID_REQUEST, `LSP provider "${id}" declares an empty extension key`)
    }
    if (typeof languageId !== 'string' || languageId.length === 0) {
      throw lspError(LspErrorCode.INVALID_REQUEST, `LSP provider "${id}" maps extension "${key}" to an empty language id`)
    }
    if (extensions.has(normalized)) {
      throw lspError(
        LspErrorCode.INVALID_REQUEST,
        `LSP provider "${id}" declares the extension "${normalized}" twice`,
      )
    }
    extensions.set(normalized, languageId)
  }
  if (extensions.size === 0) {
    throw lspError(LspErrorCode.INVALID_REQUEST, `LSP provider "${id}" reserves no file extension`)
  }
  return { id, extensions }
}

/**
 * The LSP seam itself.
 *
 * It is a plain object rather than a Cordis `Service` subclass so that this bundle needs
 * no dependency on a shipped DSH package; `ctx.provide('lsp', …)` publishes it exactly
 * like any other Host capability.
 */
export class LspSeam {
  /**
   * @param {object} ctx - the Host plugin context.
   */
  constructor(ctx) {
    /** @type {object} */
    this.ctx = ctx
    /** @type {Map<string, { provider: any, extensions: Map<string, string> }>} */
    this.providers = new Map()
    /** @type {Map<string, string>} normalized extension to provider id */
    this.owners = new Map()
  }

  /**
   * Register one provider and reserve its id and every normalized extension.
   *
   * Nothing is published until the whole registration is known to be conflict-free, so a
   * rejected registration leaves the seam exactly as it was.
   *
   * @param {any} provider - the provider to register.
   * @returns {() => void} a disposer releasing the id and every extension reservation.
   */
  registerProvider(provider) {
    const { id, extensions } = validateProvider(provider)

    if (this.providers.has(id)) {
      throw lspError(LspErrorCode.CONFLICT, `an LSP provider with the id "${id}" is already registered`)
    }
    for (const extension of extensions.keys()) {
      const owner = this.owners.get(extension)
      if (owner !== undefined) {
        throw lspError(
          LspErrorCode.CONFLICT,
          `the file extension "${extension}" is already reserved by the LSP provider "${owner}"`,
        )
      }
    }

    this.providers.set(id, { provider, extensions })
    for (const extension of extensions.keys()) this.owners.set(extension, id)

    let released = false
    return () => {
      if (released) return
      released = true
      const entry = this.providers.get(id)
      if (entry === undefined) return
      this.providers.delete(id)
      for (const extension of entry.extensions.keys()) {
        if (this.owners.get(extension) === id) this.owners.delete(extension)
      }
    }
  }

  /**
   * Select a provider by the request's file extension and run one query.
   *
   * Selection is per query and order-independent: the owner map is a flat extension →
   * provider index, so the result never depends on registration order.
   *
   * @param {any} request - the normalized query request.
   * @param {AbortSignal} [signal] - optional cancellation forwarded to the provider.
   * @returns {Promise<any>} the provider's normalized result.
   */
  async query(request, signal) {
    if (request === null || typeof request !== 'object') {
      throw lspError(LspErrorCode.INVALID_REQUEST, 'an LSP query request must be an object')
    }
    const extension = extensionOfFilePath(request.filePath)
    if (extension.length === 0) {
      throw lspError(
        LspErrorCode.INVALID_REQUEST,
        `cannot derive a file extension from ${JSON.stringify(request.filePath)}`,
      )
    }
    const ownerId = this.owners.get(extension)
    if (ownerId === undefined) {
      throw lspError(
        LspErrorCode.UNAVAILABLE,
        `no LSP provider serves the file extension "${extension}"`,
        { extension, filePath: request.filePath },
      )
    }
    const entry = this.providers.get(ownerId)
    /* v8 ignore next 3 -- the owner map and the provider map are mutated together. */
    if (entry === undefined) {
      throw lspError(LspErrorCode.UNAVAILABLE, `the LSP provider "${ownerId}" is no longer registered`)
    }
    const languageId = entry.extensions.get(extension)
    /* v8 ignore next 3 -- every reserved extension has a language id. */
    if (languageId === undefined) {
      throw lspError(LspErrorCode.UNAVAILABLE, `the LSP provider "${ownerId}" has no language for "${extension}"`)
    }
    return entry.provider.query({ ...request, languageId }, signal)
  }

  /**
   * Release every registration. Used when the owning plugin is disposed.
   *
   * @returns {void}
   */
  dispose() {
    this.providers.clear()
    this.owners.clear()
  }
}
