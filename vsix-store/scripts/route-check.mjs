/**
 * The HTTP route and the model tool, exercised as the Host would use them.
 *
 * Run: `node scripts/route-check.mjs`
 *
 * The script applies the bundle to a fake Host context whose profile
 * directory is a fresh temp directory, captures the route the bundle
 * registers and the tool it registers, and then drives both:
 *
 * - `POST /vscode-extensions` with every action, checking the answer's shape;
 * - the `vscode_extension` tool, including its parameter schema, which is
 *   validated against the harness's own JSON Schema checker when the
 *   harness's packages are reachable.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, ROUTE } from '../index.js'

const profileDir = mkdtempSync(join(tmpdir(), 'dsh-vsix-route-'))

/** The captured route handler. */
let route = null
/** The captured tool definition. */
let tool = null
/** The services the bundle provided. */
const provided = new Map()

const ctx = {
  profileContext: { dir: profileDir },
  provide: (name, service) => { provided.set(name, service) },
  effect: (fn) => { fn(); return () => {} },
  webServer: {
    register: (spec) => { route = spec; return () => {} },
  },
  tools: {
    register: (definition) => { tool = definition; return () => {} },
  },
  connection: {
    authorizeIndex: () => true,
  },
  fs: undefined,
  get: (name) => ctx[name],
}

apply(ctx)

console.log(`route path    : ${ROUTE} (${route?.kind})`)
console.log(`provided      : ${[...provided.keys()].join(', ')}`)
console.log(`tool          : ${tool?.name}`)
console.log(`tool schema   : ${JSON.stringify(tool?.parameters)}`)

/**
 * Drive the route.
 * @param {object} body - the request body.
 * @returns {Promise<{ status: number, payload: any }>} the answer.
 */
async function call(body) {
  let status = 0
  let payload = ''
  const res = {
    writeHead: (code) => { status = code },
    end: (chunk) => { payload = chunk },
  }
  const req = {
    method: 'POST',
    on: (event, handler) => {
      if (event === 'data') handler(Buffer.from(JSON.stringify(body)))
      if (event === 'end') handler()
    },
    setEncoding: () => {},
  }
  await route.handler(req, res)
  return { status, payload: JSON.parse(payload) }
}

console.log('')
console.log('== POST /vscode-extensions')
const list = await call({ action: 'list' })
console.log(`   list        : HTTP ${list.status} ok=${list.payload.ok} extensions=${list.payload.extensions.length}`)

const bad = await call({ action: 'nonsense' })
console.log(`   unknown     : HTTP ${bad.status} ok=${bad.payload.ok} error=${JSON.stringify(bad.payload.error)}`)

const refused = await call({ action: 'install', publisher: 'secureannex', name: 'hello-world', source: 'open-vsx' })
console.log(`   no trust    : HTTP ${refused.status} ok=${refused.payload.ok} error=${JSON.stringify(refused.payload.error)}`)

const installed = await call({
  action: 'install',
  publisher: 'secureannex',
  name: 'hello-world',
  version: '0.0.1',
  source: 'open-vsx',
  trust: true,
})
console.log(`   install     : HTTP ${installed.status} ok=${installed.payload.ok} id=${installed.payload.record?.id}`)
console.log(`   record keys : ${Object.keys(installed.payload.record ?? {}).join(', ')}`)

const listed = await call({ action: 'list' })
console.log(`   list        : HTTP ${listed.status} extensions=${listed.payload.extensions.length}`)

const disabled = await call({ action: 'enable', id: 'secureannex.hello-world@0.0.1', enabled: false })
console.log(`   enable      : HTTP ${disabled.status} ok=${disabled.payload.ok} enabled=${disabled.payload.enabled}`)

const trusted = await call({ action: 'trust', publisher: 'secureannex', trusted: false })
console.log(`   trust       : HTTP ${trusted.status} ok=${trusted.payload.ok} trusted=${trusted.payload.trusted}`)

const catalog = await call({ action: 'catalog', query: 'hello world', limit: 2 })
console.log(`   catalog     : HTTP ${catalog.status} ok=${catalog.payload.ok} results=${catalog.payload.results.length}`)

const removed = await call({ action: 'remove', id: 'secureannex.hello-world@0.0.1' })
console.log(`   remove      : HTTP ${removed.status} ok=${removed.payload.ok} removed=${removed.payload.removed}`)

console.log('')
console.log('== the model tool')
const answer = await tool.execute({ action: 'list' }, {})
console.log(`   list        : ${answer.summary}`)
console.log(`   output keys : ${Object.keys(answer).join(', ')}`)
try {
  const missing = await tool.execute({ action: 'search' }, {})
  console.log(`   missing query: ok=${missing.ok} — ${missing.summary}`)
} catch (error) {
  console.log(`   missing query: refused — ${error.message}`)
}

console.log('')
console.log('== the harness schema checker')
await checkSchema(tool)

/**
 * Validate the tool's schemas against the harness's own checker.
 * @param {object} definition - the tool definition.
 * @returns {Promise<void>} after the check.
 */
async function checkSchema(definition) {
  let harness
  try {
    harness = await import('/tmp/dsh-src/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js')
  } catch {
    console.log('   skipped    : the harness package is not reachable from this checkout')
    return
  }
  try {
    harness.assertSupportedJsonSchema(definition.output.schema)
    console.log('   output schema: accepted by assertSupportedJsonSchema')
  } catch (error) {
    console.log(`   output schema: REJECTED — ${error.message}`)
  }
  try {
    harness.assertSupportedJsonSchema(definition.parameters)
    console.log('   parameters   : accepted by assertSupportedJsonSchema')
  } catch (error) {
    console.log(`   parameters   : REJECTED — ${error.message}`)
  }
}

rmSync(profileDir, { recursive: true, force: true })
console.log('')
console.log(`cleaned up    : ${profileDir}`)
