/**
 * LSP base-protocol framing: `Content-Length` headers over a byte stream.
 *
 * The LSP base protocol is JSON-RPC 2.0 with a header block that ends in a blank line:
 *
 * ```text
 * Content-Length: 42\r\n
 * \r\n
 * {"jsonrpc":"2.0","id":1,"result":null}
 * ```
 *
 * The length counts **bytes**, not characters, so everything here works on `Buffer`s and
 * encodes the body as UTF-8 before measuring it. The decoder is incremental: a chunk may
 * contain half a header or half a body, and it keeps the remainder for the next `feed()`.
 *
 * @module dsh-lsp-stdio/jsonrpc
 */

/** The header this codec reads and writes. */
export const CONTENT_LENGTH_HEADER = 'Content-Length'

/**
 * Encode one JSON-RPC message as an LSP frame.
 *
 * @param {object} message - the JSON-RPC message (request, response or notification).
 * @returns {Buffer} the framed bytes to write to the server's stdin.
 */
export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.from(`${CONTENT_LENGTH_HEADER}: ${body.length}\r\n\r\n`, 'ascii')
  return Buffer.concat([header, body])
}

/**
 * Create an incremental frame decoder.
 *
 * The decoder never throws: a malformed frame is reported through `onError` and the
 * offending bytes are dropped, because a language server that emits garbage must not take
 * the whole provider down. A frame whose `Content-Length` is missing or unparsable is
 * skipped by resynchronizing on the next header block.
 *
 * @param {(message: any) => void} onMessage - called with each decoded JSON-RPC message.
 * @param {(error: Error) => void} onError - called with each framing/JSON failure.
 * @returns {(chunk: Buffer) => void} a function to push received bytes into.
 */
export function createMessageDecoder(onMessage, onError) {
  let buffer = Buffer.alloc(0)

  return function feed(chunk) {
    buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk])

    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return

      const headerText = buffer.toString('ascii', 0, headerEnd)
      let length = -1
      for (const line of headerText.split('\r\n')) {
        const separator = line.indexOf(':')
        if (separator < 0) continue
        if (line.slice(0, separator).trim().toLowerCase() !== CONTENT_LENGTH_HEADER.toLowerCase()) continue
        const parsed = Number.parseInt(line.slice(separator + 1).trim(), 10)
        if (Number.isInteger(parsed)) length = parsed
      }

      if (length < 0) {
        onError(new Error(`lsp: frame header without a usable ${CONTENT_LENGTH_HEADER}: ${JSON.stringify(headerText)}`))
        buffer = buffer.subarray(headerEnd + 4)
        continue
      }

      const bodyStart = headerEnd + 4
      if (buffer.length < bodyStart + length) return

      const body = buffer.toString('utf8', bodyStart, bodyStart + length)
      buffer = buffer.subarray(bodyStart + length)

      try {
        onMessage(JSON.parse(body))
      } catch (error) {
        onError(new Error(`lsp: frame body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`))
      }
    }
  }
}
