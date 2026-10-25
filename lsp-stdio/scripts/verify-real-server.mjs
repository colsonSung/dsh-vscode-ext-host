#!/usr/bin/env node
/**
 * Verification against a **real** language server.
 *
 * `verify.mjs` proves the protocol path with the bundle's own fake server. This script
 * proves it with a real one: `pyright-langserver` (the `pyright` npm package's LSP
 * entry point), driven through exactly the same provider the DSH seam uses.
 *
 * If the real server is not reachable, the script reports that honestly and exits with a
 * non-zero code — it never falls back to a simulated result.
 *
 * Run it with:
 * ```bash
 * node scripts/verify-real-server.mjs
 * ```
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = resolve(HERE, '..')
const EVIDENCE_DIR = join(BUNDLE, 'runtime', 'verify', 'evidence')
const TMP_DIR = join(BUNDLE, 'runtime', 'verify', 'tmp')

const { StdioLspProvider } = await import('../lib/stdio-provider.js')

/**
 * Find a real language server to test against.
 *
 * `pyright-langserver` is a bin *inside* the `pyright` npm package, so it is not on PATH
 * by default. It is looked up in three places, in order:
 *
 * 1. `DSH_REAL_LSP_COMMAND` / `DSH_REAL_LSP_ARGS` — an explicit override.
 * 2. `pyright-langserver` on PATH.
 * 3. the npm execution cache (`~/.npm/_npx/<hash>/node_modules/.bin/pyright-langserver`),
 *    which
 *    is where `npx -y -p pyright …` puts it.
 *
 * The `npx` wrapper itself is deliberately **not** used: npm's process wrapper does not
 * pass the child's stdio through cleanly to a long-lived LSP stream (the server starts and
 * then the stream goes silent), so the resolved binary is used directly.
 *
 * @returns {{ id: string, command: string, args: string[], source: string }|undefined} the
 *   server, or undefined when none is installed.
 */
function findRealServer() {
  if (typeof process.env.DSH_REAL_LSP_COMMAND === 'string' && process.env.DSH_REAL_LSP_COMMAND.length > 0) {
    return {
      id: 'python',
      command: process.env.DSH_REAL_LSP_COMMAND,
      args: process.env.DSH_REAL_LSP_ARGS?.split(' ').filter(Boolean) ?? ['--stdio'],
      source: 'DSH_REAL_LSP_COMMAND',
    }
  }

  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory.length === 0) continue
    const candidate = join(directory, 'pyright-langserver')
    if (existsSync(candidate)) {
      return { id: 'python', command: candidate, args: ['--stdio'], source: 'PATH' }
    }
  }

  const npxRoot = join(homedir(), '.npm', '_npx')
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      const candidate = join(npxRoot, entry, 'node_modules', '.bin', 'pyright-langserver')
      if (existsSync(candidate)) {
        return { id: 'python', command: candidate, args: ['--stdio'], source: `npm exec cache (${entry})` }
      }
    }
  }
  return undefined
}

/** The server under test. */
const SERVER = findRealServer()

mkdirSync(EVIDENCE_DIR, { recursive: true })
mkdirSync(TMP_DIR, { recursive: true })

if (SERVER === undefined) {
  const evidence = {
    generatedAt: new Date().toISOString(),
    server: null,
    checks: [
      {
        name: 'R0 a real language server is installed',
        ok: false,
        detail:
          'no real language server found: install one with `npm install -g pyright` (which provides pyright-langserver) or set DSH_REAL_LSP_COMMAND',
      },
    ],
  }
  evidence.passed = 0
  evidence.total = 1
  evidence.failed = 1
  writeFileSync(join(EVIDENCE_DIR, 'lsp-provider-real-server.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  process.stdout.write('FAIL  R0 a real language server is installed\n      no real language server found\n')
  process.exit(1)
}
process.stdout.write(`Using the real language server: ${SERVER.command} (${SERVER.source})\n`)

/** The workspace the server is pointed at. */
const WORKSPACE = mkdtempSync(join(TMP_DIR, 'pyright-'))

const SOURCE = `def greet(name):
    return "hello " + name


def main():
    greet("world")


main()
`

writeFileSync(join(WORKSPACE, 'app.py'), SOURCE, 'utf8')
writeFileSync(
  join(WORKSPACE, 'pyrightconfig.json'),
  JSON.stringify({ include: ['app.py'], pythonVersion: '3.11' }, null, 2),
  'utf8',
)

/**
 * The `greet` call site, in the seam's **one-based** coordinates.
 *
 * `SOURCE` line 5 (zero-based) is `    greet("world")`; the identifier `greet` starts at
 * zero-based character 4. One-based, that is line 6 and character 5. The definition is
 * `def greet(name):` on zero-based line 0, which the one-based seam must report as line 1.
 */
const CALL_SITE = { line: 6, character: 5 }

const provider = new StdioLspProvider({
  id: 'stdio:python',
  server: SERVER,
  extensionToLanguage: { py: 'python' },
  positionBase: 1,
  requestTimeoutMs: 120000,
  initializeTimeoutMs: 120000,
})

const request = {
  operation: 'goToDefinition',
  filePath: join(WORKSPACE, 'app.py'),
  position: CALL_SITE,
  workspaceRoot: WORKSPACE,
  languageId: 'python',
}

const evidence = {
  generatedAt: new Date().toISOString(),
  server: SERVER,
  workspace: WORKSPACE,
  checks: [],
}

/**
 * Record one check.
 *
 * @param {string} name - the check name.
 * @param {boolean} ok - whether it passed.
 * @param {string} detail - the evidence.
 * @returns {void}
 */
function check(name, ok, detail) {
  evidence.checks.push({ name, ok, detail })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}\n`)
}

// Give the server a moment to pick the opened document up; pyright analyses a document
// shortly after `textDocument/didOpen`.
await new Promise((resolve) => setTimeout(resolve, 2000))

let definition = null
let hover = null
let failure = null
try {
  definition = await provider.query(request)
} catch (error) {
  failure = error
}

if (failure !== null) {
  check('R1 goToDefinition against a real language server', false, `raised ${failure?.code ?? failure?.name}: ${failure?.message}`)
} else {
  const locations = definition?.kind === 'locations' ? definition.locations : []
  const onTheDefinition = locations.some((location) => {
    const start = location.range?.start
    return start !== undefined && start.line === 1 && location.uri.endsWith('app.py')
  })
  check(
    'R1 goToDefinition against a real language server',
    onTheDefinition,
    JSON.stringify(locations),
  )
}

try {
  hover = await provider.query({ ...request, operation: 'hover' })
  const contents = hover?.kind === 'hover' ? (hover.hover?.contents ?? '') : ''
  check('R2 hover against a real language server', contents.includes('greet'), JSON.stringify(contents))
} catch (error) {
  check('R2 hover against a real language server', false, `raised ${error?.code ?? error?.name}: ${error?.message}`)
}

await provider.dispose()
rmSync(TMP_DIR, { recursive: true, force: true })

const failed = evidence.checks.filter((entry) => !entry.ok)
evidence.passed = evidence.checks.length - failed.length
evidence.total = evidence.checks.length
evidence.failed = failed.length

mkdirSync(EVIDENCE_DIR, { recursive: true })
writeFileSync(join(EVIDENCE_DIR, 'lsp-provider-real-server.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

process.stdout.write(`\n${evidence.passed}/${evidence.total} real-server checks passed. Evidence: ${EVIDENCE_DIR}\n`)
process.exit(failed.length === 0 ? 0 : 1)
