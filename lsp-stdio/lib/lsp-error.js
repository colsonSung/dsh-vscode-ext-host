/**
 * The `LspError` taxonomy for the LSP seam and its providers.
 *
 * The seam contract (generated API catalog, `SERVICE_API` key `lsp`) names exactly one
 * code — `LSP_UNAVAILABLE` — for "no provider matched the file's extension". Every other
 * failure mode is this bundle's own taxonomy, kept deliberately explicit so a caller can
 * tell "you did not configure a server" apart from "the server is not installed" apart
 * from "the server hung". Nothing here ever reports success for work that did not happen.
 *
 * @module @local/dsh-lsp-stdio/lsp-error
 */

/**
 * Every error code this bundle can raise.
 *
 * - `LSP_UNAVAILABLE` — the seam found no provider for the request's file extension.
 * - `LSP_INVALID_REQUEST` — the request itself is malformed (bad position, unreadable file).
 * - `LSP_CONFLICT` — a provider id or a normalized file extension is already reserved.
 * - `LSP_NOT_CONFIGURED` — no language server is configured for the requested language.
 * - `LSP_SERVER_NOT_INSTALLED` — the configured executable could not be resolved or spawned.
 * - `LSP_SERVER_START_FAILED` — the process started but the LSP handshake did not complete.
 * - `LSP_SERVER_EXITED` — the server process exited while a request was in flight.
 * - `LSP_SERVER_ERROR` — the server answered with a JSON-RPC error object.
 * - `LSP_TIMEOUT` — the request exceeded its deadline.
 * - `LSP_PROTOCOL_ERROR` — the byte stream violated the LSP framing or JSON-RPC shape.
 * - `LSP_UNSUPPORTED_OPERATION` — the server does not implement the requested method.
 * - `LSP_CANCELLED` — the caller aborted the request.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const LspErrorCode = Object.freeze({
  UNAVAILABLE: 'LSP_UNAVAILABLE',
  INVALID_REQUEST: 'LSP_INVALID_REQUEST',
  CONFLICT: 'LSP_CONFLICT',
  NOT_CONFIGURED: 'LSP_NOT_CONFIGURED',
  SERVER_NOT_INSTALLED: 'LSP_SERVER_NOT_INSTALLED',
  SERVER_START_FAILED: 'LSP_SERVER_START_FAILED',
  SERVER_EXITED: 'LSP_SERVER_EXITED',
  SERVER_ERROR: 'LSP_SERVER_ERROR',
  TIMEOUT: 'LSP_TIMEOUT',
  PROTOCOL_ERROR: 'LSP_PROTOCOL_ERROR',
  UNSUPPORTED_OPERATION: 'LSP_UNSUPPORTED_OPERATION',
  CANCELLED: 'LSP_CANCELLED',
})

/**
 * The error every LSP failure is reported as.
 *
 * The seam contract says a bad registration or an unmatched query "throws `LspError`"
 * without pinning the class shape, so this bundle defines it: a plain `Error` subclass
 * carrying a stable machine-readable `code` and optional structured `details`. It is
 * exported so a future shipped `@deepseek-ai/dsh-lsp` can be checked against it.
 *
 * @extends Error
 */
export class LspError extends Error {
  /**
   * @param {string} code - one of {@link LspErrorCode}.
   * @param {string} message - the human-readable cause.
   * @param {Record<string, unknown>} [details] - structured context for logs and the model.
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'LspError'
    /** @type {string} */
    this.code = code
    /** @type {Record<string, unknown>|undefined} */
    this.details = details
  }
}

/**
 * Build an {@link LspError} whose message names the code.
 *
 * @param {string} code - one of {@link LspErrorCode}.
 * @param {string} message - the human-readable cause.
 * @param {Record<string, unknown>} [details] - structured context.
 * @returns {LspError} the error to throw.
 */
export function lspError(code, message, details) {
  return new LspError(code, `[${code}] ${message}`, details)
}
