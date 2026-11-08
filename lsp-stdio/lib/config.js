/**
 * The Config schema for the stdio LSP provider.
 *
 * The schema describes one row's whole configuration. Defaults are applied in code
 * ({@link resolveServers}) rather than through Schemastery's `.default()`, because the
 * defaults are *overridable by id* rather than *replaced wholesale* — a user who wants to
 * point the TypeScript server at a different executable must not have to restate the other
 * three languages.
 *
 * @module dsh-lsp-stdio/config
 */

import z from '@deepseek-ai/schemastery'

/**
 * One language-server specification.
 *
 * `extensions` and `languageIds` are the convenient form: a single language id applies to
 * every extension, and equally long lists pair up positionally. `extensionToLanguage` is
 * the explicit form and wins when both are present.
 */
const Server = z.object({
  /** Stable key; also the provider id suffix. */
  id: z.string().required(),
  /** Whether this server is offered at all. */
  enabled: z.boolean().default(true),
  /** The executable to spawn. */
  command: z.string().required(),
  /** Arguments passed to the executable. */
  args: z.array(String).default([]),
  /** Working directory; empty means the workspace root. */
  cwd: z.string().default(''),
  /** Extra environment variables for the child. */
  env: z.dict(String).default({}),
  /** File extensions this server claims. */
  extensions: z.array(String).default([]),
  /** Language ids this server serves. */
  languageIds: z.array(String).default([]),
  /** The explicit extension to language map; wins over `extensions`/`languageIds`. */
  extensionToLanguage: z.dict(String).default({}),
  /** The server's `initializationOptions`. */
  initOptions: z.any().default({}),
})

/**
 * The whole configuration of one `dsh-lsp-stdio` row.
 */
export const Config = z.object({
  /**
   * The coordinate base of every position this bundle returns.
   *
   * `1` is the DSH convention (one-based lines and characters); `0` is the LSP-native
   * zero-based form. The conversion lives in exactly one function
   * (`toDshPosition` in `stdio-provider.js`).
   */
  positionBase: z.union([z.const(1), z.const(0)]).default(1),
  /** The deadline for one LSP request. */
  requestTimeoutMs: z.number().min(100).max(600000).default(15000),
  /** The deadline for the `initialize` handshake. */
  initializeTimeoutMs: z.number().min(100).max(600000).default(20000),
  /** The language servers this row offers. */
  servers: z.array(Server).default([]),
  /** How installed VSIX extensions may contribute servers. */
  extensionServers: z.object({
    /** Whether to look at installed VSIX extensions for a server declaration. */
    enabled: z.boolean().default(true),
    /** Whether only trusted publishers may contribute. */
    requireTrusted: z.boolean().default(true),
  }).default({}),
})

/**
 * The servers offered when the user configures none.
 *
 * The commands are **bare executable names on purpose**: the provider never downloads or
 * installs anything at query time (an `npx -y …` default would silently fetch and run
 * code the moment a file is queried), and a missing server fails immediately with
 * `LSP_SERVER_NOT_INSTALLED` and a message that names what to install.
 *
 * @type {ReadonlyArray<Record<string, any>>}
 */
export const DEFAULT_SERVERS = Object.freeze([
  Object.freeze({
    id: 'typescript',
    enabled: true,
    command: 'typescript-language-server',
    args: Object.freeze(['--stdio']),
    cwd: '',
    env: Object.freeze({}),
    extensions: Object.freeze(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']),
    languageIds: Object.freeze(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']),
    extensionToLanguage: Object.freeze({
      ts: 'typescript',
      tsx: 'typescriptreact',
      js: 'javascript',
      jsx: 'javascriptreact',
      mjs: 'javascript',
      cjs: 'javascript',
    }),
    initOptions: Object.freeze({}),
  }),
  Object.freeze({
    id: 'python',
    enabled: true,
    command: 'pyright-langserver',
    args: Object.freeze(['--stdio']),
    cwd: '',
    env: Object.freeze({}),
    extensions: Object.freeze(['.py', '.pyi']),
    languageIds: Object.freeze(['python']),
    extensionToLanguage: Object.freeze({ py: 'python', pyi: 'python' }),
    initOptions: Object.freeze({}),
  }),
  Object.freeze({
    id: 'go',
    enabled: true,
    command: 'gopls',
    args: Object.freeze([]),
    cwd: '',
    env: Object.freeze({}),
    extensions: Object.freeze(['.go']),
    languageIds: Object.freeze(['go']),
    extensionToLanguage: Object.freeze({ go: 'go' }),
    initOptions: Object.freeze({}),
  }),
  Object.freeze({
    id: 'rust',
    enabled: true,
    command: 'rust-analyzer',
    args: Object.freeze([]),
    cwd: '',
    env: Object.freeze({}),
    extensions: Object.freeze(['.rs']),
    languageIds: Object.freeze(['rust']),
    extensionToLanguage: Object.freeze({ rs: 'rust' }),
    initOptions: Object.freeze({}),
  }),
])

/**
 * Merge the user's servers over the defaults, by id.
 *
 * A user entry with the same id replaces the default entirely; a user entry with a new
 * id is appended. Disabling a default is done by restating it with `enabled: false`.
 *
 * @param {ReadonlyArray<any>} defaults - the built-in servers.
 * @param {ReadonlyArray<any>} configured - the user's servers.
 * @returns {Array<any>} the merged list.
 */
export function resolveServers(defaults, configured) {
  const byId = new Map()
  for (const server of defaults) byId.set(server.id, server)
  for (const server of configured) byId.set(server.id, server)
  return [...byId.values()]
}
