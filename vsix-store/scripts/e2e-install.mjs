/**
 * End-to-end check: download one real VSIX, verify it, unpack it, and read
 * the extension manifest.
 *
 * Run: `node scripts/e2e-install.mjs [publisher] [name] [version]`
 *
 * The script never touches a profile: it stages the package under the system
 * temp directory and deletes it afterwards. It uses the store's own modules,
 * so what it prints is what the install pipeline does — not a re-implementation.
 */

import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  createTempDirectory,
  downloadAndVerify,
  resolveSource,
  unpackExtension,
  writeExtensionMetadata,
} from '../src/install.js'
import { classifyContributes } from '../src/capabilities.js'
import { detectLocale, resolveDescription, resolveDisplayName, resolveIcon } from '../src/records.js'

const publisher = process.argv[2] ?? 'Harry3349'
const name = process.argv[3] ?? 'qwen-copilot-chat'
const version = process.argv[4] ?? undefined
const source = 'open-vsx'

console.log(`== target: ${publisher}.${name}${version === undefined ? '' : `@${version}`} (${source})`)

const entry = await resolveSource(source, publisher, name, version)
console.log(`   downloadUrl   : ${entry.downloadUrl}`)
console.log(`   signatureUrl  : ${entry.signatureUrl}`)
console.log(`   publicKeyUrl  : ${entry.publicKeyUrl}`)

const { bytes, report } = await downloadAndVerify(entry)
console.log('')
console.log('== download')
console.log(`   size          : ${report.size} bytes`)
console.log(`   sha256(base64): ${report.sha256}`)
console.log('')
console.log('== signature verification')
if (report.signature.valid === true) {
  console.log(`   algorithm     : ${report.signature.algorithm}`)
  console.log(`   signedPayload : ${report.signature.signedPayload}`)
  console.log(`   result        : VALID`)
  console.log(`   entry digests : ${report.entries.checked} checked, ${report.entries.mismatched.length} mismatched`)
} else {
  console.log(`   result        : ${report.signature.reason}`)
}

const staging = createTempDirectory()
try {
  console.log('')
  console.log('== unpack')
  const manifest = unpackExtension(bytes, staging)
  writeExtensionMetadata(staging, {
    id: `${manifest.publisher}.${manifest.name}@${manifest.version}`,
    publisher: manifest.publisher,
    name: manifest.name,
    version: manifest.version,
    source: entry.source,
    targetPlatform: entry.targetPlatform ?? null,
    installedAt: new Date().toISOString(),
    size: report.size,
    sha256: report.sha256,
    signature: report.signature,
  })
  console.log(`   staging dir   : ${staging}`)
  console.log('   tree:')
  for (const line of tree(staging)) console.log(`     ${line}`)

  console.log('')
  console.log('== extension/package.json')
  console.log(`   name          : ${manifest.name}`)
  console.log(`   displayName   : ${manifest.displayName}`)
  console.log(`   publisher     : ${manifest.publisher}`)
  console.log(`   version       : ${manifest.version}`)
  console.log(`   engines.vscode: ${manifest.engines?.vscode ?? '(none)'}`)
  console.log(`   main          : ${manifest.main ?? '(none — declarative extension)'}`)
  console.log(`   browser       : ${manifest.browser ?? '(none)'}`)
  console.log(`   resolves to   : ${resolveDisplayName(manifest, join(staging, 'extension'), detectLocale())}`)
  console.log(`   description   : ${resolveDescription(manifest, join(staging, 'extension'), detectLocale())}`)
  console.log(`   icon          : ${(resolveIcon(manifest, join(staging, 'extension')) ?? '(none)').slice(0, 60)}`)

  console.log('')
  console.log('== contributes')
  const classification = classifyContributes(manifest.contributes)
  console.log(`   declared      : ${classification.contributes.join(', ') || '(none)'}`)
  console.log(`   supported     : ${classification.supported.join(', ') || '(none)'}`)
  console.log(`   degraded      : ${classification.degraded.join(', ') || '(none)'}`)
  console.log(`   unsupported   : ${classification.unsupported.join(', ') || '(none)'}`)
  for (const problem of classification.problems) {
    console.log(`   [${problem.severity}] ${problem.code}: ${problem.message}`)
  }
  console.log('')
  console.log('== DSH capability verdict')
  console.log(`   status        : ${classification.status}`)
  console.log(`   runtime       : ${classification.runtime.verdict} (usable: ${classification.runtime.usable})`)
  console.log(`   executes code : ${typeof manifest.main === 'string' || typeof manifest.browser === 'string'}`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}

/**
 * Print a directory tree.
 * @param {string} directory - the directory to print.
 * @param {string} [prefix] - the current tree prefix.
 * @returns {Array<string>} the tree lines.
 */
function tree(directory, prefix = '') {
  const lines = []
  const entries = readdirSync(directory).sort()
  entries.forEach((entry, index) => {
    const last = index === entries.length - 1
    const path = join(directory, entry)
    lines.push(`${prefix}${last ? '└── ' : '├── '}${entry}`)
    if (statSync(path).isDirectory()) {
      lines.push(...tree(path, `${prefix}${last ? '    ' : '│   '}`))
    }
  })
  return lines
}
