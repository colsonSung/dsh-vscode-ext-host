#!/usr/bin/env node
/**
 * A minimal but real LSP server, used to exercise the provider without installing
 * anything.
 *
 * It speaks the LSP base protocol (`Content-Length` framing, JSON-RPC 2.0) over stdio and
 * answers exactly the four operations the DSH seam supports:
 *
 * - `textDocument/definition` -> one `Location`
 * - `textDocument/references` -> two `Location`s
 * - `textDocument/hover` -> one `Hover`
 * - `textDocument/implementation` -> a JSON-RPC error `-32601` (method not found), so the
 *   provider's `LSP_UNSUPPORTED_OPERATION` path can be exercised
 *
 * It reuses the bundle's own decoder, so the framing code is exercised in both directions.
 *
 * Flags:
 * - `--silent` - complete the handshake but never answer a request (timeout test)
 * - `--no-handshake` - never answer `initialize` (start-failure test)
 * - `--definition-line <n>` - the zero-based line the definition points at
 */

import { createMessageDecoder, encodeMessage } from '../lib/jsonrpc.js'

const args = process.argv.slice(2)
const silent = args.includes('--silent')
const noHandshake = args.includes('--no-handshake')
const definitionLineArg = args.indexOf('--definition-line')
const definitionLine = definitionLineArg >= 0 ? Number.parseInt(args[definitionLineArg + 1], 10) : 4

/** The file URI the fake server reports as the definition target. */
const DEFINITION_URI = 'file:///workspace/src/answer.ts'

/**
 * Write one framed JSON-RPC message to stdout.
 *
 * @param {object} message - the message to write.
 * @returns {void}
 */
function send(message) {
  process.stdout.write(encodeMessage(message))
}

const decoder = createMessageDecoder(
  (message) => {
    const { id, method, params } = message
    if (method === 'initialize') {
      if (noHandshake) return
      send({
        jsonrpc: '2.0',
        id,
        result: {
          capabilities: {
            textDocument: { hover: {}, definition: {}, references: {}, implementation: {} },
          },
          serverInfo: { name: 'fake-lsp-server', version: '0.1.0' },
        },
      })
      return
    }
    if (method === 'initialized') return
    if (id === undefined || id === null) return // a notification
    if (silent) return

    const uri = params?.textDocument?.uri ?? DEFINITION_URI
    switch (method) {
      case 'textDocument/definition':
        send({
          jsonrpc: '2.0',
          id,
          result: {
            uri: DEFINITION_URI,
            range: { start: { line: definitionLine, character: 2 }, end: { line: definitionLine, character: 8 } },
          },
        })
        return
      case 'textDocument/references':
        send({
          jsonrpc: '2.0',
          id,
          result: [
            { uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } } },
            { uri, range: { start: { line: 6, character: 4 }, end: { line: 6, character: 8 } } },
          ],
        })
        return
      case 'textDocument/hover':
        send({
          jsonrpc: '2.0',
          id,
          result: {
            contents: { kind: 'markdown', value: '**answer**: the answer' },
            range: { start: { line: 3, character: 0 }, end: { line: 3, character: 6 } },
          },
        })
        return
      case 'textDocument/implementation':
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: 'method not found: textDocument/implementation' },
        })
        return
      default:
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
    }
  },
  (error) => {
    process.stderr.write(`fake-lsp-server: ${error.message}\n`)
  },
)

process.stdin.on('data', (chunk) => decoder(chunk))
process.stdin.on('end', () => process.exit(0))
