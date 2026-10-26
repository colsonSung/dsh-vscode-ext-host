/**
 * The market metadata the catalog publishes, checked against the real
 * registries.
 *
 * Run: `node scripts/market-metadata.mjs [query] [limit]`
 *
 * It searches the Microsoft Marketplace and Open VSX for one keyword and
 * prints every result's `downloads` / `rating` / `ratingCount` /
 * `publisherVerified` / `lastUpdated`, so the numbers can be compared with
 * what the VS Code extension list shows for the same extension.
 */

import { searchMarketplace, searchOpenVsx } from '../src/catalog.js'

const query = process.argv[2] ?? 'drawio'
const limit = Number(process.argv[3] ?? 6)

/**
 * Format a download count the way the VS Code extension list does.
 *
 * This is VS Code's own rule (`extensionsWidgets.ts`, `getInstallLabel`):
 * more than a million becomes `1.2M`, more than a thousand becomes `176K`,
 * and both truncate rather than round.
 * @param {number|undefined} value - the count.
 * @returns {string} the abbreviated count.
 */
function abbreviate(value) {
  if (typeof value !== 'number') return '(none)'
  if (value > 1000000) return `${Math.floor(value / 100000) / 10}M`
  if (value > 1000) return `${Math.floor(value / 1000)}K`
  return String(value)
}

console.log(`query : ${JSON.stringify(query)}`)
console.log('')

console.log('== Microsoft Marketplace (POST /_apis/public/gallery/extensionquery)')
const marketplace = await searchMarketplace(query, limit)
console.log(`   total: ${marketplace.total}`)
for (const entry of marketplace.entries) {
  console.log(`   ${entry.publisher}.${entry.name}@${entry.version}`)
  console.log(`     downloads       : ${entry.downloads} (${abbreviate(entry.downloads)})`)
  console.log(`     rating          : ${entry.rating ?? '(none)'}`)
  console.log(`     ratingCount     : ${entry.ratingCount ?? '(none)'}`)
  console.log(`     publisherVerified: ${entry.publisherVerified}`)
  console.log(`     lastUpdated     : ${entry.lastUpdated ?? '(none)'}`)
}

console.log('')
console.log('== Open VSX (GET /api/-/search)')
const openVsx = await searchOpenVsx(query, limit)
console.log(`   total: ${openVsx.total}`)
for (const entry of openVsx.entries) {
  console.log(`   ${entry.publisher}.${entry.name}@${entry.version}`)
  console.log(`     downloads       : ${entry.downloads} (${abbreviate(entry.downloads)})`)
  console.log(`     rating          : ${entry.rating ?? '(none)'}`)
  console.log(`     ratingCount     : ${entry.ratingCount ?? '(none)'}`)
  console.log(`     publisherVerified: ${entry.publisherVerified}`)
  console.log(`     lastUpdated     : ${entry.lastUpdated ?? '(none)'}`)
}
