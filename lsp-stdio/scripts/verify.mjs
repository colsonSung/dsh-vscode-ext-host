#!/usr/bin/env node
/**
 * Verification for the stdio LSP provider bundle.
 *
 * It runs the bundle's real modules against a real LSP server process (the bundle's own
 * `fake-lsp-server.mjs`, which speaks the LSP base protocol over stdio), so the protocol
 * path is genuinely exercised. Nothing is installed and no DSH profile is touched: the
 * only filesystem writes are a throwaway profile fixture under `runtime/verify/tmp` and
 * the evidence files under `runtime/verify/evidence`.
 *
 * Run it with:
 * ```bash
 * node scripts/verify.mjs
 * ```
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = resolve(HERE, '..')
const EVIDENCE_DIR = join(BUNDLE, 'runtime', 'verify', 'evidence')
const TMP_DIR = join(BUNDLE, 'runtime', 'verify', 'tmp')

/**
 * Make `@deepseek-ai/schemastery` resolvable from the bundle.
 *
 * The bundle declares it as a dependency, so an installed bundle resolves it from the
 * profile. For a local run there is no profile install yet, so this links the copy that
 * ships with the DSH installation. Nothing is downloaded and nothing is installed; the
 * link lives in the bundle's `node_modules`, which is not part of `files` and which pnpm
 * prunes on install.
 *
 * @returns {string|undefined} the directory the schema was linked from.
 */
function linkSchemastery() {
  const candidates = [
    process.env.DSH_SCHEMASTERY_ROOT,
    '/tmp/dsh-src/dsh/node_modules',
    resolve(BUNDLE, '../node_modules'),
  ].filter((candidate) => typeof candidate === 'string')
  for (const root of candidates) {
    const source = join(root, '@deepseek-ai', 'schemastery')
    if (!existsSync(source)) continue
    const targetDir = join(BUNDLE, 'node_modules', '@deepseek-ai')
    mkdirSync(targetDir, { recursive: true })
    const target = join(targetDir, 'schemastery')
    if (!existsSync(target)) symlinkSync(source, target, 'dir')
    return source
  }
  return undefined
}

/** Where the schema came from, for the evidence file. */
const schemasterySource = linkSchemastery()

/** @type {Array<{ name: string, ok: boolean, detail: string }>} */
const results = []

/**
 * Record one test outcome.
 *
 * @param {string} name - the test name.
 * @param {boolean} ok - whether it passed.
 * @param {string} detail - what happened.
 * @returns {void}
 */
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}\n`)
}

/**
 * Assert that a promise rejects with an `LspError` carrying one of the expected codes.
 *
 * @param {Promise<any>} promise - the promise to await.
 * @param {string[]} expected - the acceptable codes.
 * @returns {Promise<{ ok: boolean, detail: string }>} the outcome.
 */
async function expectCode(promise, expected) {
  try {
    const value = await promise
    return { ok: false, detail: `expected one of ${expected.join(', ')} but the call resolved with ${JSON.stringify(value)}` }
  } catch (error) {
    const code = error?.code
    const ok = expected.includes(code)
    return { ok, detail: ok ? `raised ${code}` : `raised ${code ?? error?.name}: ${error?.message}` }
  }
}

const { LspErrorCode } = await import('../lib/lsp-error.js')
const { LspSeam, normalizeExtension, extensionOfFilePath } = await import('../lib/lsp-service.js')
const { StdioLspProvider, buildExtensionMap, toDshPosition } = await import('../lib/stdio-provider.js')
const { collectExtensionServers, languagesFromManifest } = await import('../lib/extension-servers.js')
const { buildProviders } = await import('../index.js')

const FAKE_SERVER = join(HERE, 'fake-lsp-server.mjs')

/** A minimal Host context good enough for the seam and the providers. */
const ctx = {
  get: () => undefined,
  provide: () => {},
  logger: { warn: () => {}, info: () => {}, error: () => {} },
}

mkdirSync(EVIDENCE_DIR, { recursive: true })
mkdirSync(TMP_DIR, { recursive: true })

// ---------------------------------------------------------------------------
// T1 — seam registration, conflicts and atomicity
// ---------------------------------------------------------------------------
{
  const seam = new LspSeam(ctx)
  const providerA = { id: 'a', extensionToLanguage: { '.ts': 'typescript' }, query: async () => ({ kind: 'hover', hover: null }) }
  seam.registerProvider(providerA)

  const duplicateId = await expectCode(
    Promise.resolve().then(() => seam.registerProvider({ id: 'a', extensionToLanguage: { '.py': 'python' }, query: async () => ({}) })),
    [LspErrorCode.CONFLICT],
  )
  check('T1a duplicate provider id is rejected', duplicateId.ok, duplicateId.detail)

  const duplicateExtension = await expectCode(
    Promise.resolve().then(() => seam.registerProvider({ id: 'b', extensionToLanguage: { ts: 'python' }, query: async () => ({}) })),
    [LspErrorCode.CONFLICT],
  )
  check('T1b duplicate normalized extension is rejected', duplicateExtension.ok, duplicateExtension.detail)

  const invalid = await expectCode(
    Promise.resolve().then(() => seam.registerProvider({ id: 'c', extensionToLanguage: { py: 'python' } })),
    [LspErrorCode.INVALID_REQUEST],
  )
  check('T1c a provider without query() is rejected', invalid.ok, invalid.detail)

  const atomic = seam.providers.size === 1 && seam.owners.get('ts') === 'a'
  check('T1d a rejected registration publishes nothing', atomic, `providers=${seam.providers.size} owner(ts)=${seam.owners.get('ts')}`)
}

// ---------------------------------------------------------------------------
// T2 — per-query selection
// ---------------------------------------------------------------------------
{
  const seam = new LspSeam(ctx)
  let seen = null
  seam.registerProvider({
    id: 'a',
    extensionToLanguage: { '.ts': 'typescript' },
    query: async (request) => {
      seen = request
      return { kind: 'hover', hover: { contents: 'ok' } }
    },
  })
  const result = await seam.query({ operation: 'hover', filePath: '/w/a.ts', position: { line: 1, character: 1 }, workspaceRoot: '/w' })
  const routed = seen?.languageId === 'typescript' && result.kind === 'hover'
  check('T2a the provider is selected by file extension and receives the language id', routed, `languageId=${seen?.languageId} kind=${result.kind}`)

  const unavailable = await expectCode(
    seam.query({ operation: 'hover', filePath: '/w/a.unknown', position: { line: 1, character: 1 }, workspaceRoot: '/w' }),
    [LspErrorCode.UNAVAILABLE],
  )
  check('T2b an unserved extension raises LSP_UNAVAILABLE', unavailable.ok, unavailable.detail)

  const normalization = normalizeExtension('.TS') === 'ts' && extensionOfFilePath('/w/x/y.tar.gz') === 'gz'
  check('T2c extensions are normalized consistently', normalization, `normalizeExtension('.TS')=${normalizeExtension('.TS')} extensionOfFilePath('/w/x/y.tar.gz')=${extensionOfFilePath('/w/x/y.tar.gz')}`)
}

// ---------------------------------------------------------------------------
// T3 — a missing language server is reported, never faked
// ---------------------------------------------------------------------------
{
  const provider = new StdioLspProvider({
    id: 'missing',
    server: { id: 'missing', command: 'dsh-lsp-definitely-not-installed', args: [] },
    extensionToLanguage: { ts: 'typescript' },
    requestTimeoutMs: 2000,
    initializeTimeoutMs: 2000,
  })
  const outcome = await expectCode(
    provider.query({ operation: 'goToDefinition', filePath: '/w/a.ts', position: { line: 1, character: 1 }, workspaceRoot: '/w', languageId: 'typescript' }),
    [LspErrorCode.SERVER_NOT_INSTALLED],
  )
  check('T3a a missing executable raises LSP_SERVER_NOT_INSTALLED', outcome.ok, outcome.detail)
  await provider.dispose()
}

// ---------------------------------------------------------------------------
// T4 — a real LSP round trip against a real server process
// ---------------------------------------------------------------------------
{
  const provider = new StdioLspProvider({
    id: 'fake',
    server: { id: 'fake', command: process.execPath, args: [FAKE_SERVER, '--definition-line', '4'] },
    extensionToLanguage: { ts: 'typescript' },
    positionBase: 1,
    requestTimeoutMs: 5000,
    initializeTimeoutMs: 5000,
  })
  const request = {
    operation: 'goToDefinition',
    filePath: join(TMP_DIR, 'sample.ts'),
    position: { line: 3, character: 5 },
    workspaceRoot: TMP_DIR,
    languageId: 'typescript',
  }
  writeFileSync(request.filePath, 'export const answer = 42\n', 'utf8')

  const definition = await provider.query(request)
  const oneBased = definition.kind === 'locations'
    && definition.locations.length === 1
    && definition.locations[0].range.start.line === 5
    && definition.locations[0].range.start.character === 3
  check(
    'T4a goToDefinition returns a location with one-based positions',
    oneBased,
    JSON.stringify(definition),
  )

  const references = await provider.query({ ...request, operation: 'findReferences' })
  check(
    'T4b findReferences returns every reference',
    references.kind === 'locations' && references.locations.length === 2,
    JSON.stringify(references.locations),
  )

  const hover = await provider.query({ ...request, operation: 'hover' })
  check(
    'T4c hover returns the server contents',
    hover.kind === 'hover' && typeof hover.hover?.contents === 'string' && hover.hover.contents.includes('answer'),
    JSON.stringify(hover),
  )

  const unsupported = await expectCode(provider.query({ ...request, operation: 'goToImplementation' }), [LspErrorCode.UNSUPPORTED_OPERATION])
  check('T4d a method the server does not implement raises LSP_UNSUPPORTED_OPERATION', unsupported.ok, unsupported.detail)

  const workspaceUri = definition.kind === 'locations' ? definition.resolvedWorkspaceUri : ''
  check('T4e the result carries the resolved workspace uri', workspaceUri.startsWith('file://'), workspaceUri)

  await provider.dispose()
}

// ---------------------------------------------------------------------------
// T5 — a hung server times out
// ---------------------------------------------------------------------------
{
  const provider = new StdioLspProvider({
    id: 'silent',
    server: { id: 'silent', command: process.execPath, args: [FAKE_SERVER, '--silent'] },
    extensionToLanguage: { ts: 'typescript' },
    requestTimeoutMs: 600,
    initializeTimeoutMs: 4000,
  })
  const outcome = await expectCode(
    provider.query({
      operation: 'goToDefinition',
      filePath: join(TMP_DIR, 'sample.ts'),
      position: { line: 1, character: 1 },
      workspaceRoot: TMP_DIR,
      languageId: 'typescript',
    }),
    [LspErrorCode.TIMEOUT],
  )
  check('T5a a server that never answers raises LSP_TIMEOUT', outcome.ok, outcome.detail)
  await provider.dispose()
}

// ---------------------------------------------------------------------------
// T6 — an unreadable file is reported, not silently skipped
// ---------------------------------------------------------------------------
{
  const provider = new StdioLspProvider({
    id: 'fake',
    server: { id: 'fake', command: process.execPath, args: [FAKE_SERVER] },
    extensionToLanguage: { ts: 'typescript' },
    requestTimeoutMs: 5000,
    initializeTimeoutMs: 5000,
  })
  const outcome = await expectCode(
    provider.query({
      operation: 'goToDefinition',
      filePath: join(TMP_DIR, 'does-not-exist.ts'),
      position: { line: 1, character: 1 },
      workspaceRoot: TMP_DIR,
      languageId: 'typescript',
    }),
    [LspErrorCode.INVALID_REQUEST],
  )
  check('T6a an unreadable file raises LSP_INVALID_REQUEST', outcome.ok, outcome.detail)
  await provider.dispose()
}

// ---------------------------------------------------------------------------
// T7 — route (a): a server declared by an installed VSIX extension
// ---------------------------------------------------------------------------
{
  const profile = mkdtempSync(join(TMP_DIR, 'profile-'))
  const extensionDir = join(profile, 'extensions', 'acme.mylang-1.0.0')
  mkdirSync(join(extensionDir, 'extension'), { recursive: true })
  writeFileSync(
    join(extensionDir, 'extension', 'package.json'),
    JSON.stringify({
      name: 'mylang',
      publisher: 'acme',
      version: '1.0.0',
      contributes: {
        languages: [{ id: 'mylang', extensions: ['.ml'] }],
      },
    }),
    'utf8',
  )
  writeFileSync(
    join(extensionDir, 'dsh-lsp.json'),
    JSON.stringify({ command: 'mylang-server', args: ['--stdio'] }),
    'utf8',
  )
  writeFileSync(
    join(profile, 'extensions.json'),
    JSON.stringify({
      extensions: [
        {
          id: 'acme.mylang@1.0.0',
          kind: 'vsix',
          publisher: 'acme',
          name: 'mylang',
          version: '1.0.0',
          installed: true,
          enabled: true,
          trusted: true,
          directory: extensionDir,
        },
      ],
    }),
    'utf8',
  )
  writeFileSync(join(profile, 'extensions-trust.json'), JSON.stringify({ publishers: { acme: true } }), 'utf8')

  const fakeCtx = { get: (key) => (key === 'profileContext' ? { dir: profile } : undefined) }
  const servers = await collectExtensionServers(fakeCtx, { requireTrusted: true })
  const found = servers.length === 1 && servers[0].command === 'mylang-server' && servers[0].extensionToLanguage.ml === 'mylang'
  check('T7a an extension-declared server is discovered and its language map derived', found, JSON.stringify(servers))

  // The record's resolved `trusted` flag wins: an explicit false blocks the publisher.
  const stateFile = join(profile, 'extensions.json')
  const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'))
  const writeState = (value) => writeFileSync(stateFile, JSON.stringify(value), 'utf8')
  const untrustedState = readState()
  untrustedState.extensions[0].trusted = false
  writeState(untrustedState)
  writeFileSync(join(profile, 'extensions-trust.json'), JSON.stringify({ publishers: { acme: false } }), 'utf8')
  const untrustedServers = await collectExtensionServers(fakeCtx, { requireTrusted: true })
  check('T7b an untrusted publisher contributes no server', untrustedServers.length === 0, `untrusted=${untrustedServers.length}`)

  // A record without the flag falls back to the trust file.
  const fileOnlyState = readState()
  delete fileOnlyState.extensions[0].trusted
  writeState(fileOnlyState)
  writeFileSync(join(profile, 'extensions-trust.json'), JSON.stringify({ publishers: { acme: true } }), 'utf8')
  const fileOnlyServers = await collectExtensionServers(fakeCtx, { requireTrusted: true })
  check('T7c a record without the flag falls back to the trust file', fileOnlyServers.length === 1, `fileOnly=${fileOnlyServers.length}`)

  // A publisher that appears in neither source is not trusted.
  writeFileSync(join(profile, 'extensions-trust.json'), JSON.stringify({ publishers: {} }), 'utf8')
  const unknownServers = await collectExtensionServers(fakeCtx, { requireTrusted: true })
  check('T7d a publisher in neither source is not trusted', unknownServers.length === 0, `unknown=${unknownServers.length}`)
}

// ---------------------------------------------------------------------------
// T8 — extension map building and provider priority
// ---------------------------------------------------------------------------
{
  const map = buildExtensionMap({ extensions: ['.ts', '.tsx'], languageIds: ['typescript', 'typescriptreact'] })
  check('T8a equally long extension and language lists pair up', map.ts === 'typescript' && map.tsx === 'typescriptreact', JSON.stringify(map))

  const single = buildExtensionMap({ extensions: ['.py'], languageIds: ['python'] })
  check('T8b one language id applies to every extension', single.py === 'python', JSON.stringify(single))

  const fromManifest = languagesFromManifest({ contributes: { languages: [{ id: 'go', extensions: ['.go'] }] } })
  check('T8c a manifest contributes its language map', fromManifest.go === 'go', JSON.stringify(fromManifest))

  const built = buildProviders(
    [{ id: 'acme.mylang', enabled: true, command: 'ext-server', extensionToLanguage: { ts: 'typescript' } }],
    [{ id: 'typescript', enabled: true, command: 'config-server', extensionToLanguage: { ts: 'typescript', py: 'python' } }],
  )
  const ids = built.map((entry) => entry.provider.id)
  const configKept = built.find((entry) => entry.provider.id === 'stdio:typescript')?.provider.extensionToLanguage
  check(
    'T8d an extension-declared server wins the extensions it claims',
    ids.includes('vsix:acme.mylang') && configKept?.ts === undefined && configKept?.py === 'python',
    `ids=${ids.join(',')} configMap=${JSON.stringify(configKept)}`,
  )
}

// ---------------------------------------------------------------------------
// T9 — the coordinate conversion
// ---------------------------------------------------------------------------
{
  const one = toDshPosition({ line: 0, character: 0 }, 1)
  const zero = toDshPosition({ line: 0, character: 0 }, 0)
  check('T9 the position base conversion is explicit and single-sourced', one.line === 1 && one.character === 1 && zero.line === 0, JSON.stringify({ one, zero }))
}

// ---------------------------------------------------------------------------
// T10 — the plugin itself applies and publishes the seam
// ---------------------------------------------------------------------------
{
  const services = new Map()
  const cleanups = []
  const mockCtx = {
    get: (key) => services.get(key),
    provide: (key, value) => services.set(key, value),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    effect: (fn) => {
      const cleanup = fn()
      cleanups.push(cleanup)
      return cleanup
    },
  }

  const { apply } = await import('../index.js')
  await apply(mockCtx, {
    positionBase: 1,
    requestTimeoutMs: 2000,
    initializeTimeoutMs: 2000,
    servers: [],
    extensionServers: { enabled: false, requireTrusted: true },
  })

  const seam = services.get('lsp')
  const published = seam !== undefined && typeof seam.registerProvider === 'function' && typeof seam.query === 'function'
  check('T10a the plugin publishes the ctx.lsp seam', published, `seam=${seam === undefined ? 'missing' : typeof seam.registerProvider}`)

  const status = services.get('lspStdio')
  const providerIds = status?.providers?.map((entry) => entry.id) ?? []
  check(
    'T10b the default servers are registered as providers',
    providerIds.includes('stdio:typescript') && providerIds.includes('stdio:python') && providerIds.includes('stdio:go') && providerIds.includes('stdio:rust'),
    JSON.stringify(providerIds),
  )

  const extensions = status?.providers?.find((entry) => entry.id === 'stdio:typescript')?.extensions ?? []
  check('T10c the TypeScript provider claims the TypeScript extensions', extensions.includes('ts') && extensions.includes('tsx'), JSON.stringify(extensions))

  // The seam really routes: a .ts file reaches the TypeScript provider, which then fails
  // honestly because no language server is installed on this machine.
  const outcome = await expectCode(
    seam.query({ operation: 'goToDefinition', filePath: join(TMP_DIR, 'sample.ts'), position: { line: 1, character: 1 }, workspaceRoot: TMP_DIR }),
    [LspErrorCode.SERVER_NOT_INSTALLED],
  )
  check('T10d a query through the published seam reaches a provider and reports the missing server', outcome.ok, outcome.detail)

  for (const cleanup of cleanups) cleanup()
  const released = seam.owners.size === 0
  check('T10e disposing the plugin releases every reservation', released, `owners=${seam.owners.size}`)
}

// ---------------------------------------------------------------------------
// T11 — the Config schema round trip
// ---------------------------------------------------------------------------
{
  const { Config, DEFAULT_SERVERS, resolveServers } = await import('../lib/config.js')
  // Schemastery schemas expose the standard-schema interface: `~standard.validate(value)`
  // returns `{ value }` when the value is valid and `{ issues }` when it is not.
  const validate = (value) => Config['~standard'].validate(value)
  const accepted = validate({})
  const parsed = accepted.value ?? {}
  const positionBase = parsed.positionBase
  const timeout = parsed.requestTimeoutMs
  check(
    'T11a the Config schema fills the defaults',
    positionBase === 1 && timeout === 15000 && parsed.servers.length === 0 && parsed.extensionServers.enabled === true,
    JSON.stringify({ positionBase, timeout, servers: parsed.servers.length, extensionServers: parsed.extensionServers }),
  )

  const rejected = validate({ positionBase: 2 })
  check(
    'T11b an out-of-range position base is rejected',
    Array.isArray(rejected.issues) && rejected.issues.length > 0,
    JSON.stringify(rejected.issues ?? rejected.value),
  )

  const badServer = validate({ servers: [{ id: 'x' }] })
  check(
    'T11c a server without a command is rejected',
    Array.isArray(badServer.issues) && badServer.issues.length > 0,
    JSON.stringify(badServer.issues ?? badServer.value),
  )

  const merged = resolveServers(DEFAULT_SERVERS, [{ id: 'typescript', enabled: false, command: 'x', args: [] }])
  const ts = merged.find((server) => server.id === 'typescript')
  const stillFour = merged.length === DEFAULT_SERVERS.length
  check(
    'T11d a user server overrides the default with the same id',
    stillFour && ts.enabled === false && ts.command === 'x',
    `merged=${merged.length} typescript=${JSON.stringify(ts && { enabled: ts.enabled, command: ts.command })}`,
  )

  const added = resolveServers(DEFAULT_SERVERS, [{ id: 'custom', enabled: true, command: 'c', args: [], extensions: ['.c'] }])
  check('T11e a user server with a new id is appended', added.length === DEFAULT_SERVERS.length + 1, `added=${added.length}`)
}

// ---------------------------------------------------------------------------
const failed = results.filter((entry) => !entry.ok)
const summary = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  schemasterySource: schemasterySource ?? null,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  results,
}
writeFileSync(join(EVIDENCE_DIR, 'lsp-provider-verification.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
writeFileSync(
  join(EVIDENCE_DIR, 'lsp-provider-verification.txt'),
  `${results.map((entry) => `${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}\n      ${entry.detail}`).join('\n')}\n\n${summary.passed}/${summary.total} passed\n`,
  'utf8',
)
rmSync(TMP_DIR, { recursive: true, force: true })

process.stdout.write(`\n${summary.passed}/${summary.total} checks passed. Evidence: ${EVIDENCE_DIR}\n`)
process.exit(failed.length === 0 ? 0 : 1)
