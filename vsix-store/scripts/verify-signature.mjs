/**
 * The Open VSX signature path, proved with a real package.
 *
 * Run: `node scripts/verify-signature.mjs [publisher] [name] [version]`
 *
 * It downloads one real VSIX and its `.sigzip`, then runs the store's own
 * `verifyOpenVsxPackage` four times:
 *
 * 1. on the untouched bytes — it must pass;
 * 2. on a truncated download — it must fail with the *integrity* message,
 *    not with a misleading "bad signature" (the trap the research notes
 *    record);
 * 3. on a tampered download — it must fail on the sha256;
 * 4. on a tampered signature — it must fail on the signature itself.
 *
 * The public key is the registry's own, fetched live.
 */

import { fetchBytes } from '../src/catalog.js'
import { lookupOpenVsx } from '../src/catalog.js'
import { verifyOpenVsxPackage, verifyOpenVsxEntries } from '../src/install.js'
import { extractZip } from '../src/zip.js'

const publisher = process.argv[2] ?? 'secureannex'
const name = process.argv[3] ?? 'hello-world'
const version = process.argv[4] ?? '0.0.1'

/**
 * Compute a CRC-32.
 * @param {Buffer} bytes - the bytes.
 * @returns {number} the checksum.
 */
function crc32(bytes) {
  let crc = -1
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff]
  }
  return (crc ^ -1) >>> 0
}

/** The CRC-32 table. */
const table = new Int32Array(256)
for (let index = 0; index < 256; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  table[index] = value
}
await main()

/**
 * Run the four checks.
 * @returns {Promise<void>} after the checks have run.
 */
async function main() {
const entry = await lookupOpenVsx(publisher, name, version)
const vsixBytes = await fetchBytes(entry.downloadUrl)
const sigzipBytes = await fetchBytes(entry.signatureUrl)
const publicKeyPem = (await fetchBytes(entry.publicKeyUrl)).toString('utf8')

console.log(`package      : ${publisher}.${name}@${entry.version}`)
console.log(`size         : ${vsixBytes.length} bytes`)
console.log(`public key   : ${publicKeyPem.trim().split('\n')[0]} … (${publicKeyPem.trim().split('\n').length} lines)`)

const archive = extractZip(sigzipBytes, { prefix: '' })
console.log(`sigzip holds : ${[...archive.keys()].map((name) => `${name} (${archive.get(name).length} B)`).join(', ')}`)

console.log('')
console.log('1) untouched package')
try {
  const report = verifyOpenVsxPackage(vsixBytes, sigzipBytes, publicKeyPem)
  console.log(`   result        : VALID (${report.algorithm}, payload: ${report.signedPayload})`)
  console.log(`   package sha256: ${report.packageSha256}`)
  const entries = verifyOpenVsxEntries(vsixBytes, sigzipBytes)
  console.log(`   entry digests : ${entries.checked} checked, ${entries.mismatched.length} mismatched`)
} catch (error) {
  console.log(`   result        : FAILED — ${error.message}`)
}

console.log('')
console.log('2) truncated download (one byte short)')
try {
  verifyOpenVsxPackage(vsixBytes.subarray(0, vsixBytes.length - 1), sigzipBytes, publicKeyPem)
  console.log('   result        : UNEXPECTEDLY PASSED')
} catch (error) {
  console.log(`   result        : rejected — ${error.message}`)
}

console.log('')
console.log('3) tampered download (one byte flipped in the middle)')
try {
  const tampered = Buffer.from(vsixBytes)
  tampered[Math.floor(tampered.length / 2)] ^= 0x01
  verifyOpenVsxPackage(tampered, sigzipBytes, publicKeyPem)
  console.log('   result        : UNEXPECTEDLY PASSED')
} catch (error) {
  console.log(`   result        : rejected — ${error.message}`)
}

console.log('')
console.log('4) tampered signature (one byte flipped)')
try {
  const archiveCopy = extractZip(sigzipBytes, { prefix: '' })
  const signature = Buffer.from(archiveCopy.get('.signature.sig'))
  signature[0] ^= 0x01
  const rebuilt = rebuildSigzip(archiveCopy, signature)
  verifyOpenVsxPackage(vsixBytes, rebuilt, publicKeyPem)
  console.log('   result        : UNEXPECTEDLY PASSED')
} catch (error) {
  console.log(`   result        : rejected — ${error.message}`)
}
}

/**
 * Rebuild a `.sigzip` with a different signature.
 *
 * The store only reads `.signature.manifest`, `.signature.sig` and
 * `.signature.p7s` out of the archive, so the rebuilt archive holds exactly
 * those three entries.
 * @param {Map<string, Buffer>} archive - the original archive's entries.
 * @param {Buffer} signature - the new signature.
 * @returns {Buffer} the rebuilt archive.
 */
function rebuildSigzip(archive, signature) {
  const files = new Map([
    ['.signature.sig', signature],
    ['.signature.manifest', archive.get('.signature.manifest')],
    ['.signature.p7s', archive.get('.signature.p7s') ?? Buffer.alloc(0)],
  ])
  return buildZip(files)
}

/**
 * Build a zip archive from a map of entries.
 * @param {Map<string, Buffer>} files - the entries.
 * @returns {Buffer} the archive.
 */
function buildZip(files) {
  const locals = []
  const central = []
  let offset = 0
  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30 + nameBytes.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt16LE(0, 14)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    nameBytes.copy(local, 30)
    locals.push(local, data)
    const header = Buffer.alloc(46 + nameBytes.length)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(0, 12)
    header.writeUInt16LE(0, 14)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(data.length, 20)
    header.writeUInt32LE(data.length, 24)
    header.writeUInt16LE(nameBytes.length, 28)
    header.writeUInt32LE(offset, 42)
    nameBytes.copy(header, 46)
    central.push(header)
    offset += local.length + data.length
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.size, 8)
  end.writeUInt16LE(files.size, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBytes, end])
}


