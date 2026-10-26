/**
 * Host half of the stdio LSP provider bundle.
 *
 * ## What this bundle does
 *
 * It makes `ctx.lsp` real and points it at language servers.
 *
 * The generated DSH API catalog describes a service `lsp` with two operations
 * (`registerProvider`, `query`) and a complete `Lsp*` type set, but **no shipped package
 * registers that service** — the reference to `@deepseek-ai/dsh-lsp` in the composition
 * reference names the monorepo package, which is not in the distribution. A catalog entry
 * is a contract, not an implementation: with nothing mounted, `ctx.lsp.query(...)` cannot
 * answer anything.
 *
 * So this bundle:
 *
 * 1. **provides the seam itself** when nothing else has (`ctx.provide('lsp', …)`),
 *    implementing the catalogued contract exactly — atomic registration with id and
 *    extension reservations, order-independent per-query selection, `LSP_UNAVAILABLE` when
 *    no provider matches. When a real `@deepseek-ai/dsh-lsp` is present, this bundle uses
 *    *that* seam instead and registers into it, because the provider contract is identical.
 * 2. **registers one provider per language server**, resolving the servers in two steps:
 *    first the servers an installed VSIX extension declares (route a), then the servers
 *    this row configures (route b). An extension-declared server wins the extensions it
 *    claims; a configured server fills the rest.
 * 3. **reports failures honestly.** No server, no binary, a hung server, a protocol
 *    violation — each raises an `LspError` with its own code. Nothing ever answers with an
 *    empty result for work that did not happen.
 *
 * @module @local/dsh-lsp-stdio
 */

import { Config, DEFAULT_SERVERS, resolveServers } from './lib/config.js'
import { collectExtensionServers } from './lib/extension-servers.js'
import { LspErrorCode, lspError } from './lib/lsp-error.js'
import { LspSeam } from './lib/lsp-service.js'
import { buildExtensionMap, StdioLspProvider } from './lib/stdio-provider.js'

export { Config }
export const name = 'dsh-lsp-stdio'

/**
 * Merge the two server sources into the providers to register.
 *
 * Extension-declared servers come first and therefore win every extension they claim; a
 * configured server keeps only the extensions no extension claimed. A server that ends up
 * with no extension at all is dropped rather than registered empty.
 *
 * @param {Array<any>} extensionServers - the servers an installed VSIX extension declared.
 * @param {Array<any>} configuredServers - the servers this row configured.
 * @returns {Array<{ provider: StdioLspProvider, server: any }>} the providers to register.
 */
export function buildProviders(extensionServers, configuredServers) {
  const claimed = new Set()
  const providers = []

  const add = (server, providerId) => {
    const map = buildExtensionMap(server)
    const free = {}
    for (const [extension, languageId] of Object.entries(map)) {
      if (claimed.has(extension)) continue
      free[extension] = languageId
    }
    if (Object.keys(free).length === 0) return
    for (const extension of Object.keys(free)) claimed.add(extension)
    const provider = new StdioLspProvider({
      id: providerId,
      server: { ...server, extensionToLanguage: free },
      extensionToLanguage: free,
    })
    providers.push({ provider, server })
  }

  for (const server of extensionServers) {
    if (server.enabled === false) continue
    add(server, `vsix:${server.id}`)
  }
  for (const server of configuredServers) {
    if (server.enabled === false) continue
    add(server, `stdio:${server.id}`)
  }
  return providers
}

/**
 * Apply the plugin.
 *
 * @param {object} ctx - the Host plugin context.
 * @param {any} config - the resolved row configuration.
 * @returns {Promise<() => void>} the cleanup that unregisters everything this plugin published.
 */
export async function apply(ctx, config) {
  const resolved = {
    positionBase: config.positionBase ?? 1,
    requestTimeoutMs: config.requestTimeoutMs ?? 15000,
    initializeTimeoutMs: config.initializeTimeoutMs ?? 20000,
    servers: resolveServers(DEFAULT_SERVERS, config.servers ?? []),
    extensionServers: {
      enabled: config.extensionServers?.enabled !== false,
      requireTrusted: config.extensionServers?.requireTrusted !== false,
    },
  }

  // The seam may already exist: a real `@deepseek-ai/dsh-lsp` would own it. Use that one
  // when it is there, because the provider contract is the same either way.
  const existing = ctx.get('lsp')
  const seam = existing ?? new LspSeam(ctx)
  const ownsSeam = existing === undefined
  if (ownsSeam) ctx.provide('lsp', seam)

  /** @type {Array<StdioLspProvider>} */
  const providers = []
  /** @type {Array<() => void>} */
  const disposers = []
  /** @type {Array<{ id: string, source: string, extensions: string[] }>} */
  const registered = []

  const extensionServers = resolved.extensionServers.enabled
    ? await collectExtensionServers(ctx, { requireTrusted: resolved.extensionServers.requireTrusted })
    : []

  const built = buildProviders(extensionServers, resolved.servers)
  for (const entry of built) {
    const provider = new StdioLspProvider({
      id: entry.provider.id,
      server: entry.provider.server,
      extensionToLanguage: entry.provider.extensionToLanguage,
      positionBase: resolved.positionBase,
      requestTimeoutMs: resolved.requestTimeoutMs,
      initializeTimeoutMs: resolved.initializeTimeoutMs,
    })
    try {
      disposers.push(seam.registerProvider(provider))
    } catch (error) {
      // A conflicting provider must not take the whole bundle down; the remaining
      // providers still serve their languages.
      ctx.logger.warn(
        `dsh-lsp-stdio: could not register the provider "${provider.id}": ${error instanceof Error ? error.message : String(error)}`,
      )
      continue
    }
    providers.push(provider)
    registered.push({
      id: provider.id,
      source: provider.id.startsWith('vsix:') ? 'vsix-extension' : 'dsh-config',
      extensions: Object.keys(provider.extensionToLanguage),
    })
  }

  const status = {
    /** The seam this bundle publishes or joins. */
    seam: ownsSeam ? 'provided-by-this-bundle' : 'provided-by-another-plugin',
    /** The servers that were registered, and where each came from. */
    providers: registered,
    /** The servers an installed VSIX extension declared. */
    extensionServers: [],
    /** The last error a query raised, for diagnostics. */
    lastError: undefined,
    /**
     * The error codes this bundle can raise.
     * @returns {string[]} the codes.
     */
    errorCodes() {
      return Object.values(LspErrorCode)
    },
  }
  ctx.provide('lspStdio', status)

  ctx.effect(() => {
    return () => {
      for (const dispose of disposers.splice(0)) dispose()
      for (const provider of providers.splice(0)) void provider.dispose()
      if (ownsSeam && typeof seam.dispose === 'function') seam.dispose()
    }
  }, 'dsh-lsp-stdio.cleanup')
}

/**
 * Report an error through the status surface.
 *
 * @param {object} status - the status object published by {@link apply}.
 * @param {unknown} error - the error to record.
 * @returns {void}
 */
export function recordError(status, error) {
  status.lastError = error instanceof Error ? { name: error.name, message: error.message, code: error.code } : { message: String(error) }
}

export { lspError }
