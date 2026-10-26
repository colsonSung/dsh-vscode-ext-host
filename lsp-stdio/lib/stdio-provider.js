/**
 * The stdio language-server provider: one `LspProvider` per configured server.
 *
 * A provider owns one language server executable and answers the four operations the seam
 * supports. It speaks the LSP base protocol over the child's stdin/stdout with
 * `Content-Length` framing, keeps one live client per workspace root (language servers are
 * workspace-scoped), and normalizes every answer into the seam's closed result union.
 *
 * ## Positions
 *
 * LSP positions are **zero-based** lines and **UTF-16 code-unit** characters. The DSH
 * convention for this seam is **one-based**, so every conversion happens in exactly one
 * place — {@link toDshPosition} — and the base is configurable through `positionBase` so a
 * future shipped `@deepseek-ai/dsh-lsp` can be reconciled without touching this file.
 *
 * ## Honesty
 *
 * A missing server is never reported as an empty result. Every failure path raises an
 * {@link LspError} with a code that says what actually went wrong.
 *
 * @module @local/dsh-lsp-stdio/stdio-provider
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import { LspErrorCode, lspError } from './lsp-error.js'
import { createMessageDecoder, encodeMessage } from './jsonrpc.js'
import { normalizeExtension } from './lsp-service.js'

/** The four operations the seam supports, mapped to their LSP methods. */
export const OPERATION_METHODS = Object.freeze({
  goToDefinition: 'textDocument/definition',
  findReferences: 'textDocument/references',
  goToImplementation: 'textDocument/implementation',
  hover: 'textDocument/hover',
})

/** Environment variable names that must never reach a child process. */
const SENSITIVE_ENV_PATTERN = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION|COOKIE|SIGNATURE|PRIVATE)($|_)/i

/**
 * Build a child environment with credential-shaped names and DSH's own deployment facts
 * removed.
 *
 * DSH's canonical policy lives in `scrubbedParentEnv` (`@deepseek-ai/dsh-subprocess`). This
 * bundle does not depend on a shipped DSH package, so it mirrors that policy locally;
 * the report records this as a deliberate, swappable deviation.
 *
 * @param {Record<string, string|undefined>} overrides - explicit additions, applied last.
 * @returns {Record<string, string>} the environment for the child.
 */
export function scrubbedEnvironment(overrides = {}) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('DSH_')) continue
    if (SENSITIVE_ENV_PATTERN.test(key)) continue
    env[key] = value
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

/**
 * Convert one LSP position into the seam's coordinate base.
 *
 * @param {any} position - an LSP `{ line, character }` pair.
 * @param {number} base - `1` for the DSH one-based convention, `0` for LSP-native.
 * @returns {{ line: number, character: number }} the converted position.
 */
export function toDshPosition(position, base) {
  const line = typeof position?.line === 'number' ? position.line : 0
  const character = typeof position?.character === 'number' ? position.character : 0
  if (base === 0) return { line, character }
  return { line: line + 1, character: character + 1 }
}

/**
 * Convert one LSP range into the seam's coordinate base.
 *
 * @param {any} range - an LSP range.
 * @param {number} base - the coordinate base.
 * @returns {{ start: any, end: any }} the converted range.
 */
export function toDshRange(range, base) {
  return {
    start: toDshPosition(range?.start, base),
    end: toDshPosition(range?.end, base),
  }
}

/**
 * Normalize one LSP location (or `LocationLink`) into the seam's `{ uri, range }`.
 *
 * @param {any} location - the LSP location.
 * @param {number} base - the coordinate base.
 * @returns {{ uri: string, range: any }} the normalized location.
 */
export function toDshLocation(location, base) {
  if (location === null || typeof location !== 'object') {
    throw lspError(LspErrorCode.PROTOCOL_ERROR, 'the language server returned a location that is not an object')
  }
  // `LocationLink` carries the target in `targetUri`/`targetRange`.
  if (typeof location.targetUri === 'string') {
    return {
      uri: location.targetUri,
      range: toDshRange(location.targetRange ?? location.range, base),
    }
  }
  if (typeof location.uri !== 'string') {
    throw lspError(LspErrorCode.PROTOCOL_ERROR, 'the language server returned a location without a uri')
  }
  return { uri: location.uri, range: toDshRange(location.range, base) }
}

/**
 * Flatten an LSP answer that may be a single location, an array, or `null`.
 *
 * @param {any} value - the raw LSP result.
 * @param {number} base - the coordinate base.
 * @returns {Array<{ uri: string, range: any }>} the normalized locations.
 */
export function toDshLocations(value, base) {
  if (value === null || value === undefined) return []
  const list = Array.isArray(value) ? value : [value]
  return list.map((entry) => toDshLocation(entry, base))
}

/**
 * Normalize an LSP hover into the seam's `{ contents, range? }`.
 *
 * @param {any} value - the raw LSP hover.
 * @param {number} base - the coordinate base.
 * @returns {{ contents: string, range?: any }} the normalized hover.
 */
export function toDshHover(value, base) {
  if (value === null || value === undefined) return { contents: '' }
  const raw = value.contents
  let contents
  if (typeof raw === 'string') {
    contents = raw
  } else if (Array.isArray(raw)) {
    contents = raw
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part.value === 'string') return part.value
        return ''
      })
      .filter((part) => part.length > 0)
      .join('\n\n')
  } else if (raw && typeof raw.value === 'string') {
    contents = raw.value
  } else {
    contents = ''
  }
  const range = value.range === undefined || value.range === null ? undefined : toDshRange(value.range, base)
  return range === undefined ? { contents } : { contents, range }
}

/**
 * One live language-server client: a child process plus the LSP handshake.
 *
 * The client is created lazily on the first query for its workspace and torn down when
 * the provider is disposed.
 */
class LspClient {
  /**
   * @param {object} options - the client options.
   * @param {any} options.server - the server specification.
   * @param {string} options.workspaceRoot - the absolute workspace root.
   * @param {number} options.positionBase - the coordinate base for answers.
   * @param {number} options.requestTimeoutMs - the per-request deadline.
   * @param {number} options.initializeTimeoutMs - the handshake deadline.
   */
  constructor(options) {
    this.server = options.server
    this.workspaceRoot = options.workspaceRoot
    this.positionBase = options.positionBase
    this.requestTimeoutMs = options.requestTimeoutMs
    this.initializeTimeoutMs = options.initializeTimeoutMs

    /** @type {import('node:child_process').ChildProcess|null} */
    this.child = null
    /** @type {Promise<void>|null} */
    this.starting = null
    /** @type {Map<number, { resolve: Function, reject: Function, timer: any }>} */
    this.pending = new Map()
    /** @type {Set<string>} */
    this.openDocuments = new Set()
    /** @type {string} */
    this.nextId = 1
    /** @type {string} */
    this.stderrTail = ''
    /** @type {Error|null} */
    this.failure = null
    /** @type {any} */
    this.serverCapabilities = undefined
    this.decoder = createMessageDecoder(
      (message) => this.#onMessage(message),
      (error) => this.#onProtocolError(error),
    )
  }

  /**
   * Start the child process and complete the LSP handshake.
   *
   * @returns {Promise<void>} resolved once the server is initialized.
   */
  async start() {
    if (this.starting !== null) return this.starting
    this.starting = (async () => {
      const { command, args = [], cwd = '', env = {}, initOptions } = this.server
      let child
      try {
        child = spawn(command, args, {
          cwd: cwd.length > 0 ? cwd : this.workspaceRoot,
          env: scrubbedEnvironment(env),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (error) {
        throw lspError(
          LspErrorCode.SERVER_NOT_INSTALLED,
          `cannot start the language server "${command}": ${error instanceof Error ? error.message : String(error)}`,
          { command, args },
        )
      }
      this.child = child

      child.on('error', (error) => {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
        if (code === 'ENOENT') {
          this.failure = lspError(
            LspErrorCode.SERVER_NOT_INSTALLED,
            `the language server executable "${command}" was not found on PATH`,
            { command, args },
          )
        } else {
          this.failure = lspError(
            LspErrorCode.SERVER_START_FAILED,
            `the language server "${command}" failed to start: ${error instanceof Error ? error.message : String(error)}`,
            { command, args },
          )
        }
        this.#failPending(this.failure)
      })

      child.on('exit', (code, signal) => {
        // The server's own stderr is the only useful diagnosis for "it exited"; put it in
        // the message, not just in the details, so a caller reading the message sees it.
        const stderr = this.stderrTail.trim()
        const exited = lspError(
          LspErrorCode.SERVER_EXITED,
          `the language server "${command}" exited (code ${code}, signal ${signal ?? 'none'})${stderr.length > 0 ? `: ${stderr}` : ''}`,
          { command, code, signal, stderr: this.stderrTail },
        )
        this.failure ??= exited
        this.#failPending(exited)
      })

      child.stderr?.on('data', (chunk) => {
        this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-4096)
      })
      child.stdout?.on('data', (chunk) => this.decoder(chunk))

      try {
        await this.#initialize(initOptions)
      } catch (error) {
        await this.stop()
        throw error
      }
    })()
    return this.starting
  }

  /**
   * Send `initialize`, then the `initialized` notification.
   *
   * @param {any} initOptions - the server's `initializationOptions`.
   * @returns {Promise<void>} resolved once the server answered.
   */
  async #initialize(initOptions) {
    const rootUri = pathToFileURL(this.workspaceRoot).href
    const result = await this.sendRequest(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'dsh-lsp-stdio' },
        rootUri,
        rootPath: this.workspaceRoot,
        workspaceFolders: [{ uri: rootUri, name: this.workspaceRoot }],
        capabilities: {
          textDocument: {
            hover: { contentFormat: ['plaintext', 'markdown'] },
            definition: {},
            implementation: {},
            references: {},
          },
          workspace: { workspaceFolders: true },
        },
        ...(initOptions === undefined ? {} : { initializationOptions: initOptions }),
      },
      this.initializeTimeoutMs,
    )
    this.serverCapabilities = result?.capabilities
    this.#notify('initialized', {})
  }

  /**
   * Open the document a query refers to, if it is not open yet.
   *
   * @param {string} filePath - the absolute file path.
   * @param {string} languageId - the language id for the document.
   * @returns {Promise<string>} the document URI.
   */
  async ensureDocumentOpen(filePath, languageId) {
    const uri = pathToFileURL(filePath).href
    if (this.openDocuments.has(uri)) return uri

    let text
    try {
      text = await readFile(filePath, 'utf8')
    } catch (error) {
      throw lspError(
        LspErrorCode.INVALID_REQUEST,
        `cannot read ${filePath} to open it in the language server: ${error instanceof Error ? error.message : String(error)}`,
        { filePath },
      )
    }

    this.#notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    })
    this.openDocuments.add(uri)
    return uri
  }

  /**
   * Send a request and await its answer.
   *
   * @param {string} method - the LSP method.
   * @param {any} params - the method parameters.
   * @param {number} timeoutMs - the deadline.
   * @returns {Promise<any>} the raw LSP result.
   */
  sendRequest(method, params, timeoutMs) {
    if (this.failure !== null) return Promise.reject(this.failure)
    const child = this.child
    if (child === null) {
      return Promise.reject(lspError(LspErrorCode.SERVER_START_FAILED, 'the language server is not running'))
    }
    const id = Number(this.nextId++)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.#notify('$/cancelRequest', { id })
        reject(
          lspError(LspErrorCode.TIMEOUT, `the language server did not answer "${method}" within ${timeoutMs} ms`, {
            method,
            timeoutMs,
          }),
        )
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      try {
        child.stdin?.write(encodeMessage({ jsonrpc: '2.0', id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(
          lspError(LspErrorCode.SERVER_EXITED, `cannot write to the language server: ${error instanceof Error ? error.message : String(error)}`, {
            method,
          }),
        )
      }
    })
  }

  /**
   * Send a notification.
   *
   * @param {string} method - the LSP method.
   * @param {any} params - the method parameters.
   * @returns {void}
   */
  #notify(method, params) {
    const child = this.child
    if (child === null) return
    try {
      child.stdin?.write(encodeMessage({ jsonrpc: '2.0', method, params }))
    } catch {
      // A closed pipe is reported by the exit handler; a notification cannot fail loudly.
    }
  }

  /**
   * Route one decoded JSON-RPC message.
   *
   * @param {any} message - the decoded message.
   * @returns {void}
   */
  #onMessage(message) {
    if (message === null || typeof message !== 'object') return
    if (message.id === undefined || message.id === null) return // a notification or a server request
    const entry = this.pending.get(Number(message.id))
    if (entry === undefined) return
    clearTimeout(entry.timer)
    this.pending.delete(Number(message.id))

    if (message.error !== undefined && message.error !== null) {
      const code = typeof message.error.code === 'number' ? message.error.code : 0
      const messageText = typeof message.error.message === 'string' ? message.error.message : 'unknown error'
      if (code === -32601) {
        entry.reject(
          lspError(LspErrorCode.UNSUPPORTED_OPERATION, `the language server does not implement this request: ${messageText}`, {
            code,
          }),
        )
        return
      }
      if (code === -32602) {
        entry.reject(lspError(LspErrorCode.INVALID_REQUEST, `the language server rejected the request: ${messageText}`, { code }))
        return
      }
      entry.reject(
        lspError(LspErrorCode.SERVER_ERROR, `the language server failed the request: ${messageText}`, { code, data: message.error.data }),
      )
      return
    }
    entry.resolve(message.result)
  }

  /**
   * Record a framing failure and fail every in-flight request.
   *
   * @param {Error} error - the framing failure.
   * @returns {void}
   */
  #onProtocolError(error) {
    this.failure ??= lspError(LspErrorCode.PROTOCOL_ERROR, error.message)
    this.#failPending(this.failure)
  }

  /**
   * Reject every in-flight request with one error.
   *
   * @param {Error} error - the failure.
   * @returns {void}
   */
  #failPending(error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.reject(error)
    }
  }

  /**
   * Shut the server down.
   *
   * @returns {Promise<void>} resolved once the child is gone.
   */
  async stop() {
    const child = this.child
    this.child = null
    this.#failPending(lspError(LspErrorCode.SERVER_EXITED, 'the language server was stopped'))
    if (child === null) return
    try {
      child.stdin?.end()
    } catch {
      // already gone
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve(undefined)
        }, 2000)
        if (typeof timer.unref === 'function') timer.unref()
        child.once('exit', () => {
          clearTimeout(timer)
          resolve(undefined)
        })
      })
    }
  }
}

/**
 * One registered `LspProvider` backed by a stdio language server.
 */
export class StdioLspProvider {
  /**
   * @param {object} options - the provider options.
   * @param {string} options.id - the provider id.
   * @param {any} options.server - the server specification.
   * @param {Record<string, string>} options.extensionToLanguage - extension to language map.
   * @param {number} [options.positionBase] - the coordinate base for answers.
   * @param {number} [options.requestTimeoutMs] - the per-request deadline.
   * @param {number} [options.initializeTimeoutMs] - the handshake deadline.
   */
  constructor(options) {
    /** @type {string} */
    this.id = options.id
    /** @type {any} */
    this.server = options.server
    /** @type {Readonly<Record<string, string>>} */
    this.extensionToLanguage = Object.freeze({ ...options.extensionToLanguage })
    /** @type {number} */
    this.positionBase = options.positionBase ?? 1
    /** @type {number} */
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15000
    /** @type {number} */
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? 20000
    /** @type {Map<string, LspClient>} */
    this.clients = new Map()
    /** @type {boolean} */
    this.disposed = false
  }

  /**
   * Run one query against the language server.
   *
   * @param {any} request - the provider query, including the resolved `languageId`.
   * @param {AbortSignal} [signal] - optional cancellation.
   * @returns {Promise<any>} the normalized result.
   */
  async query(request, signal) {
    if (this.disposed) {
      throw lspError(LspErrorCode.UNAVAILABLE, `the LSP provider "${this.id}" is disposed`)
    }
    const operation = request.operation
    const method = OPERATION_METHODS[operation]
    if (method === undefined) {
      throw lspError(LspErrorCode.INVALID_REQUEST, `unknown LSP operation ${JSON.stringify(operation)}`)
    }

    const workspaceRoot = request.workspaceRoot
    if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
      throw lspError(LspErrorCode.INVALID_REQUEST, 'an LSP query needs a workspace root')
    }

    const client = await this.#client(workspaceRoot)
    const uri = await client.ensureDocumentOpen(request.filePath, request.languageId)

    const params = {
      textDocument: { uri },
      position: {
        // LSP positions are zero-based; the seam's are one-based.
        line: Math.max(0, (request.position?.line ?? 1) - (this.positionBase === 1 ? 1 : 0)),
        character: Math.max(0, (request.position?.character ?? 1) - (this.positionBase === 1 ? 1 : 0)),
      },
    }
    if (operation === 'findReferences') params.context = { includeDeclaration: true }

    const onAbort = () => {
      /* the client cancels the in-flight request on its own deadline; the signal only ends the wait */
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        throw lspError(LspErrorCode.CANCELLED, 'the LSP query was cancelled before it started')
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      const raw = await client.sendRequest(method, params, this.requestTimeoutMs)
      if (operation === 'hover') {
        return { kind: 'hover', hover: raw === null || raw === undefined ? null : toDshHover(raw, this.positionBase) }
      }
      return {
        kind: 'locations',
        locations: toDshLocations(raw, this.positionBase),
        resolvedWorkspaceUri: pathToFileURL(workspaceRoot).href,
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error) throw error
      throw lspError(
        LspErrorCode.SERVER_ERROR,
        `the language server failed the "${operation}" query: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Get or create the client for one workspace root.
   *
   * @param {string} workspaceRoot - the workspace root.
   * @returns {Promise<LspClient>} the client.
   */
  async #client(workspaceRoot) {
    const existing = this.clients.get(workspaceRoot)
    if (existing !== undefined) return existing
    const client = new LspClient({
      server: this.server,
      workspaceRoot,
      positionBase: this.positionBase,
      requestTimeoutMs: this.requestTimeoutMs,
      initializeTimeoutMs: this.initializeTimeoutMs,
    })
    this.clients.set(workspaceRoot, client)
    try {
      await client.start()
    } catch (error) {
      this.clients.delete(workspaceRoot)
      throw error
    }
    return client
  }

  /**
   * Stop every language server this provider started.
   *
   * @returns {Promise<void>} resolved once all children are gone.
   */
  async dispose() {
    this.disposed = true
    const clients = [...this.clients.values()]
    this.clients.clear()
    await Promise.all(clients.map((client) => client.stop()))
  }
}

/**
 * Build the extension to language map for one server specification.
 *
 * The explicit `extensionToLanguage` map wins. Otherwise the convenient form is used:
 * one language id applies to every extension, and equally long `extensions` and
 * `languageIds` lists pair up positionally (so `.ts` → `typescript` and
 * `.tsx` → `typescriptreact`).
 *
 * @param {any} server - the server specification.
 * @returns {Record<string, string>} the map, with normalized extension keys.
 */
export function buildExtensionMap(server) {
  const map = {}
  const explicit = server.extensionToLanguage
  if (explicit !== null && typeof explicit === 'object' && Object.keys(explicit).length > 0) {
    for (const [key, languageId] of Object.entries(explicit)) {
      const normalized = normalizeExtension(key)
      if (normalized.length === 0 || typeof languageId !== 'string' || languageId.length === 0) continue
      map[normalized] = languageId
    }
    return map
  }

  const extensions = server.extensions ?? []
  const languages = server.languageIds ?? []
  extensions.forEach((extension, index) => {
    const normalized = normalizeExtension(extension)
    if (normalized.length === 0) return
    const languageId = languages.length === extensions.length ? languages[index] : languages[0]
    map[normalized] = languageId ?? normalized
  })
  return map
}
