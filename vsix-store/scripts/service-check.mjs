/**
 * The store's own actions, run against a throwaway profile directory.
 *
 * Run: `node scripts/service-check.mjs [publisher] [name] [version]`
 *
 * The script builds a fake Host context whose profile directory is a fresh
 * temp directory, so it exercises exactly the code the `POST
 * /vscode-extensions` route calls — list, catalog, install, enable, trust,
 * remove — and prints the two profile files after every step.
 *
 * It never touches a real profile.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { VsixStore } from '../src/service.js'
import { createExtensionTool } from '../src/tool.js'

const publisher = process.argv[2] ?? 'secureannex'
const name = process.argv[3] ?? 'hello-world'
const version = process.argv[4] ?? '0.0.1'

const profileDir = mkdtempSync(join(tmpdir(), 'dsh-vsix-profile-'))
const ctx = { profileContext: { dir: profileDir }, fs: undefined, get: (name) => ctx[name] }
const service = new VsixStore(ctx)

console.log(`profile dir   : ${profileDir}`)
console.log(`extensions dir: ${service.paths.extensionsDir}`)
console.log(`state file    : ${service.paths.stateFile}`)
console.log(`trust file    : ${service.paths.trustFile}`)

console.log('')
console.log('== list (empty profile)')
let records = await service.list()
console.log(`   extensions  : ${records.length}`)
console.log(`   state file  : ${existsSync(service.paths.stateFile) ? 'written' : 'not written yet'}`)

console.log('')
console.log('== install without the trust confirmation')
try {
  await service.install({ publisher, name, version, source: 'open-vsx', trust: false })
  console.log('   result      : UNEXPECTEDLY INSTALLED')
} catch (error) {
  console.log(`   result      : refused — ${error.message}`)
}

console.log('')
console.log('== install with trust: true')
const record = await service.install({ publisher, name, version, source: 'open-vsx', trust: true })
console.log(`   id          : ${record.id}`)
console.log(`   kind        : ${record.kind}`)
console.log(`   displayName : ${record.displayName}`)
console.log(`   description : ${record.description}`)
console.log(`   enabled     : ${record.enabled}`)
console.log(`   trusted     : ${record.trusted}`)
console.log(`   installed   : ${record.installed}`)
console.log(`   source      : ${record.source}`)
console.log(`   contributes : ${record.contributes.join(', ') || '(none)'}`)
console.log(`   supported   : ${record.supported.join(', ') || '(none)'}`)
console.log(`   unsupported : ${record.unsupported.join(', ') || '(none)'}`)
console.log(`   directory   : ${record.directory}`)
console.log(`   icon        : ${record.icon === null ? '(none)' : `${record.icon.slice(0, 48)}…`}`)
for (const problem of record.problems) {
  console.log(`   [${problem.severity}] ${problem.code}: ${problem.message}`)
}
console.log('   installed tree:')
for (const name_ of ['dsh-extension.json', 'extension/package.json', 'global-storage']) {
  console.log(`     ${existsSync(join(record.directory, name_)) ? '✓' : '✗'} ${name_}`)
}
console.log('   extensions.json:')
console.log(JSON.stringify(JSON.parse(readFileSync(service.paths.stateFile, 'utf8')), null, 2).split('\n').map((line) => `     ${line}`).join('\n'))
console.log('   extensions-trust.json:')
console.log(JSON.stringify(JSON.parse(readFileSync(service.paths.trustFile, 'utf8')), null, 2).split('\n').map((line) => `     ${line}`).join('\n'))

console.log('')
console.log('== disable the extension')
const disabled = await service.setEnabled({ id: record.id, enabled: false })
console.log(`   enabled     : ${disabled.enabled}`)
console.log(`   host backend: ${JSON.stringify(disabled.host)}`)
records = await service.list()
console.log(`   state file  : enabled=${records[0].enabled}`)

console.log('')
console.log('== revoke the publisher trust')
await service.setTrust({ publisher, trusted: false })
records = await service.list()
console.log(`   trusted     : ${records[0].trusted}`)
console.log(`   problems    : ${records[0].problems.map((problem) => problem.code).join(', ')}`)

console.log('')
console.log('== catalog (both sources)')
const catalog = await service.catalog({ query: 'hello world', limit: 3 })
console.log(`   results     : ${catalog.results.length}`)
for (const entry of catalog.results.slice(0, 5)) {
  console.log(`   ${entry.source.padEnd(12)} ${entry.id}@${entry.version} — ${entry.displayName}`)
  console.log(`     capability : ${entry.capability.status} (basis: ${entry.capability.basis})`)
  console.log(`     installed  : ${entry.installed}`)
}

console.log('')
console.log('== the model tool')
const tool = createExtensionTool(service)
console.log(`   name        : ${tool.name}`)
console.log(`   parameters  : ${Object.keys(tool.parameters.properties).join(', ')}`)
const listed = await tool.execute({ action: 'list' }, {})
console.log(`   list action : ${listed.summary}`)
const searched = await tool.execute({ action: 'search', query: 'hello world', limit: 2 }, {})
console.log(`   search      : ${searched.summary}`)

console.log('')
console.log('== remove')
await service.remove({ id: record.id })
records = await service.list()
console.log(`   extensions  : ${records.length}`)
console.log(`   directory   : ${existsSync(record.directory) ? 'still there' : 'deleted'}`)
console.log(`   state file  : ${JSON.parse(readFileSync(service.paths.stateFile, 'utf8')).extensions.length} extension(s)`)

rmSync(profileDir, { recursive: true, force: true })
console.log('')
console.log(`cleaned up    : ${profileDir}`)
