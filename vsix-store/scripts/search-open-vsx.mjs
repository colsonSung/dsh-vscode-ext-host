/**
 * Unit-level check: one live search against the Open VSX registry.
 *
 * Run: `node scripts/search-open-vsx.mjs [query] [size]`
 *
 * It prints the number of matches and the first few results with the fields
 * the catalog promises, so the shape can be checked against a real answer
 * rather than against the documentation.
 */

import { searchOpenVsx, inspectManifest, searchMarketplace } from '../src/catalog.js'

const query = process.argv[2] ?? 'language model tool'
const size = Number(process.argv[3] ?? 3)

const answer = await searchOpenVsx(query, size)
console.log(`query      : ${JSON.stringify(query)}`)
console.log(`source     : open-vsx (GET https://open-vsx.org/api/-/search?size=${size}&query=…)`)
console.log(`totalSize  : ${answer.total}`)
console.log(`returned   : ${answer.entries.length}`)
console.log('')
for (const entry of answer.entries.slice(0, 3)) {
  console.log(`--- ${entry.publisher}.${entry.name}@${entry.version}`)
  console.log(`  displayName        : ${entry.displayName}`)
  console.log(`  description        : ${entry.description.slice(0, 110)}`)
  console.log(`  publisherVerified  : ${entry.publisherVerified}`)
  console.log(`  downloadUrl        : ${entry.downloadUrl}`)
  console.log(`  signatureUrl       : ${entry.signatureUrl}`)
  console.log(`  publicKeyUrl       : ${entry.publicKeyUrl}`)
  console.log(`  manifestUrl        : ${entry.manifestUrl}`)
  const capability = await inspectManifest(entry.manifestUrl)
  console.log(`  DSH capability     : ${capability.status} (basis: ${capability.basis})`)
  console.log(`    contributes       : ${capability.contributes.join(', ') || '(none)'}`)
  console.log(`    supported         : ${capability.supported.join(', ') || '(none)'}`)
  console.log(`    unsupported       : ${capability.unsupported.join(', ') || '(none)'}`)
  console.log('')
}

const marketplace = await searchMarketplace(query, size)
console.log(`--- marketplace (POST /_apis/public/gallery/extensionquery)`)
console.log(`  returned   : ${marketplace.entries.length}`)
for (const entry of marketplace.entries.slice(0, 3)) {
  console.log(`  ${entry.publisher}.${entry.name}@${entry.version} — ${entry.displayName}`)
  console.log(`    publisherVerified : ${entry.publisherVerified}`)
  console.log(`    downloadUrl       : ${entry.downloadUrl}`)
}
