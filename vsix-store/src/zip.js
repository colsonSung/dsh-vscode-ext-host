/**
 * A minimal, dependency-free zip reader.
 *
 * A VSIX file is a plain zip archive, so reading one needs only the central
 * directory and the deflate/stored decoders that Node already ships
 * (`node:zlib`). This module implements exactly that surface:
 *
 * - `readZipEntries(buffer)` lists the archive's entries;
 * - `readZipEntry(buffer, entry)` decodes one entry's bytes;
 * - `extractZip(buffer, { prefix })` decodes every entry under one prefix.
 *
 * Everything else about the zip format is out of scope on purpose: the
 * research notes ([vsix-runtime-and-trust.md] §1.1) that a VSIX holds three
 * top-level items — `extension.vsixmanifest`, `[Content_Types].xml` and the
 * `extension/` subtree — and that the runtime only ever reads
 * `extension/package.json` ([§1.6]). So the reader is deliberately narrow,
 * and deliberately strict: an encrypted entry, an unsupported compression
 * method, a broken CRC or a path that escapes the archive is an error, never
 * a silent pass-through.
 */

import { inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50
const EOCD64_SIGNATURE = 0x06064b50
const CENTRAL_HEADER_SIGNATURE = 0x02014b50
const LOCAL_HEADER_SIGNATURE = 0x04034b50

const METHOD_STORED = 0
const METHOD_DEFLATE = 8

const FLAG_ENCRYPTED = 0x0001

/** CRC-32 lookup table, built once for the IEEE polynomial zip uses. */
const CRC_TABLE = new Int32Array(256)
for (let index = 0; index < 256; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  CRC_TABLE[index] = value
}

/**
 * Compute the CRC-32 of a byte range.
 * @param {Uint8Array} bytes - the bytes to checksum.
 * @returns {number} the unsigned CRC-32.
 */
export function crc32(bytes) {
  let crc = -1
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

/**
 * Find the end-of-central-directory record.
 * @param {Buffer} buffer - the archive.
 * @returns {number} the record's offset, or -1 when the archive is not a zip.
 */
function findEndOfCentralDirectory(buffer) {
  const minimum = 22
  if (buffer.length < minimum) return -1
  const limit = Math.min(buffer.length - minimum, 0xffff)
  for (let offset = buffer.length - minimum; offset >= buffer.length - minimum - limit; offset -= 1) {
    if (offset < 0) break
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  return -1
}

/**
 * Read the central directory location, following the zip64 records when the
 * 32-bit fields are saturated.
 * @param {Buffer} buffer - the archive.
 * @returns {{ total: number, size: number, offset: number }} the directory location.
 */
function readCentralDirectoryLocation(buffer) {
  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd < 0) throw new Error('not a zip archive: no end-of-central-directory record')
  let total = buffer.readUInt16LE(eocd + 10)
  let size = buffer.readUInt32LE(eocd + 12)
  let offset = buffer.readUInt32LE(eocd + 16)
  if (total !== 0xffff && size !== 0xffffffff && offset !== 0xffffffff) {
    return { total, size, offset }
  }
  const locator = eocd - 20
  if (locator < 0 || buffer.readUInt32LE(locator) !== EOCD64_LOCATOR_SIGNATURE) {
    throw new Error('corrupt zip archive: zip64 locator is missing')
  }
  const zip64 = Number(buffer.readBigUInt64LE(locator + 8))
  if (buffer.readUInt32LE(zip64) !== EOCD64_SIGNATURE) {
    throw new Error('corrupt zip archive: zip64 end-of-central-directory record is missing')
  }
  total = Number(buffer.readBigUInt64LE(zip64 + 32))
  size = Number(buffer.readBigUInt64LE(zip64 + 40))
  offset = Number(buffer.readBigUInt64LE(zip64 + 48))
  return { total, size, offset }
}

/**
 * Apply a zip64 extended-information field to one central-directory entry.
 * @param {Buffer} buffer - the archive.
 * @param {object} entry - the entry to complete.
 * @param {number} extraStart - the extra field's first byte.
 * @param {number} extraLength - the extra field's length.
 */
function applyZip64Extra(buffer, entry, extraStart, extraLength) {
  let cursor = extraStart
  const end = extraStart + extraLength
  while (cursor + 4 <= end) {
    const headerId = buffer.readUInt16LE(cursor)
    const dataSize = buffer.readUInt16LE(cursor + 2)
    if (headerId === 0x0001) {
      let field = cursor + 4
      if (entry.size === 0xffffffff) {
        entry.size = Number(buffer.readBigUInt64LE(field))
        field += 8
      }
      if (entry.compressedSize === 0xffffffff) {
        entry.compressedSize = Number(buffer.readBigUInt64LE(field))
        field += 8
      }
      if (entry.localOffset === 0xffffffff) {
        entry.localOffset = Number(buffer.readBigUInt64LE(field))
      }
      return
    }
    cursor += 4 + dataSize
  }
}

/**
 * List the archive's entries.
 * @param {Buffer} buffer - the zip archive.
 * @returns {Array<object>} one entry per archive member.
 */
export function readZipEntries(buffer) {
  const { total, offset } = readCentralDirectoryLocation(buffer)
  const entries = []
  let cursor = offset
  for (let index = 0; index < total; index += 1) {
    if (cursor + 46 > buffer.length) throw new Error('corrupt zip archive: central directory is truncated')
    if (buffer.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error('corrupt zip archive: bad central directory header')
    }
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const crc = buffer.readUInt32LE(cursor + 16)
    let compressedSize = buffer.readUInt32LE(cursor + 20)
    let size = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    let localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    const entry = { name, method, flags, crc, compressedSize, size, localOffset }
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      applyZip64Extra(buffer, entry, cursor + 46 + nameLength, extraLength)
    }
    entries.push(entry)
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * Decode one entry's bytes.
 * @param {Buffer} buffer - the zip archive.
 * @param {object} entry - the entry to decode.
 * @returns {Buffer} the decoded bytes.
 */
export function readZipEntry(buffer, entry) {
  if ((entry.flags & FLAG_ENCRYPTED) !== 0) {
    throw new Error(`zip entry "${entry.name}" is encrypted`)
  }
  const start = entry.localOffset
  if (start + 30 > buffer.length || buffer.readUInt32LE(start) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error(`corrupt zip archive: bad local header for "${entry.name}"`)
  }
  const nameLength = buffer.readUInt16LE(start + 26)
  const extraLength = buffer.readUInt16LE(start + 28)
  const dataStart = start + 30 + nameLength + extraLength
  const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize)
  if (entry.method === METHOD_STORED) return Buffer.from(raw)
  if (entry.method === METHOD_DEFLATE) return inflateRawSync(raw)
  throw new Error(`zip entry "${entry.name}" uses unsupported compression method ${entry.method}`)
}

/**
 * Check that an entry name stays inside the archive.
 * @param {string} name - the entry name.
 */
function assertSafeName(name) {
  if (name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/.test(name)) {
    throw new Error(`zip entry "${name}" uses an absolute path`)
  }
  if (name.split('/').includes('..')) {
    throw new Error(`zip entry "${name}" escapes the archive`)
  }
}

/**
 * Decode every entry under one prefix.
 * @param {Buffer} buffer - the zip archive.
 * @param {object} options - the extraction options.
 * @param {string} options.prefix - the entry-name prefix to keep, e.g. `extension/`.
 * @param {boolean} [options.verifyCrc] - verify each entry's CRC-32.
 * @returns {Map<string, Buffer>} the decoded entries, keyed by their relative path.
 */
export function extractZip(buffer, { prefix, verifyCrc = true }) {
  const files = new Map()
  for (const entry of readZipEntries(buffer)) {
    if (entry.name.endsWith('/')) continue
    assertSafeName(entry.name)
    if (prefix !== undefined && !entry.name.startsWith(prefix)) continue
    const relative = prefix === undefined ? entry.name : entry.name.slice(prefix.length)
    if (relative.length === 0) continue
    const data = readZipEntry(buffer, entry)
    if (verifyCrc && crc32(data) !== entry.crc) {
      throw new Error(`zip entry "${entry.name}" failed its CRC-32 check`)
    }
    files.set(relative, data)
  }
  return files
}
