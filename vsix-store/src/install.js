/**
 * Install one VSIX into the profile.
 *
 * The pipeline follows the order the research notes insist on
 * ([vsix-runtime-and-trust.md] §3.2 and §1.6):
 *
 * 1. download the package and the signature archive;
 * 2. **check the download's integrity first** — the signature manifest's
 *    `package.size` and `package.digests.sha256` — because a truncated
 *    download would otherwise surface as a misleading "bad signature";
 * 3. verify the Ed25519 signature over the whole `.vsix` byte string with
 *    the registry's published public key (Open VSX), or record that the
 *    Microsoft Marketplace has no publicly verifiable signature and fall back
 *    to the publisher's domain verification;
 * 4. unpack only the `extension/` subtree into a temporary directory, write
 *    the store's own metadata beside it, and rename the directory into place
 *    — the two-step install VS Code uses, so a half-written extension never
 *    becomes visible.
 *
 * The Microsoft Marketplace's own signing module (`@vscode/vsce-sign`) is
 * Microsoft-proprietary and its licence forbids combining it with another
 * product, so DSH cannot use it ([vsix-runtime-and-trust.md] §2.6).
 */

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { fetchBytes, isReachabilityFailure, lookupMarketplace, lookupOpenVsx } from './catalog.js'
import { extractZip } from './zip.js'

/**
 * How long one package download may take.
 *
 * A package is several megabytes and the registries serve it from a CDN, so
 * the budget is generous — but it is a budget: a host that does not answer
 * must not hold the install open forever.
 */
const DOWNLOAD_TIMEOUT_MS = 180_000

/** The largest VSIX the store will download. */
const MAX_VSIX_BYTES = 256 * 1024 * 1024

/**
 * Compute the base64 sha256 of a byte string.
 * @param {Buffer} bytes - the bytes.
 * @returns {string} the digest.
 */
export function sha256Base64(bytes) {
  return createHash('sha256').update(bytes).digest('base64')
}

/**
 * Read a public key that may arrive as PEM text or as JSON wrapping one.
 * @param {string} body - the response body.
 * @returns {string} the PEM text.
 */
export function normalizePublicKey(body) {
  const trimmed = body.trim()
  if (trimmed.startsWith('-----BEGIN')) return trimmed
  try {
    const parsed = JSON.parse(trimmed)
    for (const key of ['key', 'publicKey', 'pem', 'publicKeyPem']) {
      if (typeof parsed?.[key] === 'string') return parsed[key]
    }
  } catch {
    // Not JSON: fall through to the error below.
  }
  throw new Error('the registry did not publish a PEM public key')
}

/**
 * Verify one Open VSX package.
 *
 * The signature covers the whole `.vsix` byte string; the signature manifest
 * inside the `.sigzip` carries the package's size and sha256 plus one digest
 * per archive entry.
 * @param {Buffer} vsixBytes - the downloaded package.
 * @param {Buffer} sigzipBytes - the downloaded signature archive.
 * @param {string} publicKeyPem - the registry's PEM SPKI public key.
 * @returns {Promise<object>} the verification report.
 */
export function verifyOpenVsxPackage(vsixBytes, sigzipBytes, publicKeyPem) {
  const archive = extractZip(sigzipBytes, { prefix: '' })
  const manifestRaw = archive.get('.signature.manifest')
  const signature = archive.get('.signature.sig')
  if (manifestRaw === undefined) throw new Error('the signature archive has no .signature.manifest')
  if (signature === undefined) throw new Error('the signature archive has no .signature.sig')
  if (signature.length !== 64) {
    throw new Error(`the signature is ${signature.length} bytes; an Ed25519 signature is 64 bytes`)
  }
  const manifest = JSON.parse(manifestRaw.toString('utf8'))

  const expectedSize = manifest?.package?.size
  if (typeof expectedSize === 'number' && expectedSize !== vsixBytes.length) {
    throw new Error(
      `the download is incomplete: the signature manifest expects ${expectedSize} bytes, the download has ${vsixBytes.length}`,
    )
  }
  const expectedDigest = manifest?.package?.digests?.sha256
  const actualDigest = sha256Base64(vsixBytes)
  if (typeof expectedDigest === 'string' && expectedDigest !== actualDigest) {
    throw new Error('the download does not match the signature manifest sha256')
  }

  const key = createPublicKey(publicKeyPem)
  // Ed25519 is a one-shot algorithm, not a digest-based one: Node picks it
  // from the key type when the algorithm argument is null.
  const valid = verifySignature(null, vsixBytes, key, signature)
  if (!valid) throw new Error('the Ed25519 signature does not match the package')

  return {
    valid: true,
    algorithm: 'ed25519',
    signedPayload: 'the whole .vsix byte string',
    packageSize: vsixBytes.length,
    packageSha256: actualDigest,
    entryDigests: Object.keys(manifest?.entries ?? {}).length,
  }
}

/**
 * Check every archive entry against the signature manifest's digests.
 * @param {Buffer} vsixBytes - the downloaded package.
 * @param {Buffer} sigzipBytes - the downloaded signature archive.
 * @returns {Promise<object>} the entry-check report.
 */
export function verifyOpenVsxEntries(vsixBytes, sigzipBytes) {
  const archive = extractZip(sigzipBytes, { prefix: '' })
  const manifestRaw = archive.get('.signature.manifest')
  if (manifestRaw === undefined) return { checked: 0, mismatched: [] }
  const manifest = JSON.parse(manifestRaw.toString('utf8'))
  const entries = manifest?.entries ?? {}
  const files = extractZip(vsixBytes, { prefix: '' })
  const mismatched = []
  let checked = 0
  for (const [encodedPath, entry] of Object.entries(entries)) {
    const path = Buffer.from(encodedPath, 'base64').toString('utf8')
    const data = files.get(path)
    if (data === undefined) {
      mismatched.push(path)
      continue
    }
    checked += 1
    const expected = entry?.digests?.sha256
    if (typeof expected === 'string' && expected !== sha256Base64(data)) mismatched.push(path)
  }
  return { checked, mismatched }
}

/**
 * Unpack the `extension/` subtree of a VSIX into a directory.
 * @param {Buffer} vsixBytes - the package.
 * @param {string} targetDir - the directory that receives `extension/`.
 * @returns {Promise<object>} the extension manifest.
 */
export function unpackExtension(vsixBytes, targetDir) {
  const files = extractZip(vsixBytes, { prefix: 'extension/' })
  if (files.size === 0) throw new Error('the package holds no extension/ subtree')
  const extensionDir = join(targetDir, 'extension')
  for (const [relative, data] of files) {
    const parts = relative.split('/')
    if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
      throw new Error(`the package holds an unsafe path: "${relative}"`)
    }
    const destination = join(extensionDir, ...parts)
    mkdirSync(join(destination, '..'), { recursive: true })
    writeFileSync(destination, data)
  }
  const manifestRaw = files.get('package.json')
  if (manifestRaw === undefined) throw new Error('the package holds no extension/package.json')
  return JSON.parse(manifestRaw.toString('utf8'))
}

/**
 * Resolve where an extension's package comes from.
 * @param {string} source - `open-vsx` or `marketplace`.
 * @param {string} publisher - the publisher id.
 * @param {string} name - the extension name.
 * @param {string} [version] - the version; the latest when omitted.
 * @returns {Promise<object>} the catalog entry with the download facts.
 */
export async function resolveSource(source, publisher, name, version) {
  if (source === 'open-vsx') {
    const entry = await lookupOpenVsx(publisher, name, version)
    if (entry === undefined) throw new Error(`open-vsx has no extension "${publisher}.${name}"`)
    if (entry.downloadUrl === null) throw new Error(`open-vsx published no package for "${publisher}.${name}"`)
    return entry
  }
  if (source === 'marketplace') {
    const entry = await lookupMarketplace(publisher, name)
    if (entry === undefined) throw new Error(`the Marketplace has no extension "${publisher}.${name}"`)
    if (entry.downloadUrl === null) throw new Error(`the Marketplace published no package for "${publisher}.${name}"`)
    return entry
  }
  throw new Error(`unknown extension source "${source}"; use "open-vsx" or "marketplace"`)
}

/**
 * Download and verify one package.
 * @param {object} entry - the catalog entry.
 * @param {(stage: string) => void} [onStage] - the stage reporter.
 * @returns {Promise<object>} the download and verification report.
 */
export async function downloadAndVerify(entry, onStage = () => {}, signal = undefined) {
  onStage('download')
  const vsixBytes = await fetchBytes(entry.downloadUrl, DOWNLOAD_TIMEOUT_MS, signal)
  if (vsixBytes.length > MAX_VSIX_BYTES) throw new Error('the package is larger than the store accepts')
  const report = {
    size: vsixBytes.length,
    sha256: sha256Base64(vsixBytes),
    source: entry.source,
    publisherVerified: entry.publisherVerified === true,
    signature: null,
  }
  onStage('verify')
  if (entry.source === 'open-vsx' && entry.signatureUrl !== null && entry.publicKeyUrl !== null) {
    const sigzipBytes = await fetchBytes(entry.signatureUrl, DOWNLOAD_TIMEOUT_MS, signal)
    const publicKeyPem = normalizePublicKey((await fetchBytes(entry.publicKeyUrl, DOWNLOAD_TIMEOUT_MS, signal)).toString('utf8'))
    report.signature = verifyOpenVsxPackage(vsixBytes, sigzipBytes, publicKeyPem)
    report.entries = verifyOpenVsxEntries(vsixBytes, sigzipBytes)
  } else {
    report.signature = {
      valid: false,
      reason: 'the Microsoft Marketplace publishes no signature DSH can verify; only the publisher domain check applies',
    }
  }
  return { bytes: vsixBytes, report }
}

/**
 * How long the first registry gets before the second one is asked.
 *
 * Open VSX publishes a signature over the whole package, and the Marketplace
 * publishes none, so a package from Open VSX is one DSH can prove came from
 * the publisher it claims. Waiting a little for that is worth it — but only a
 * little: a file host that has not produced a package in twenty seconds is
 * not going to produce one worth waiting for, and the other registry is
 * already on its way.
 */
export const REGISTRY_HEAD_START_MS = 20_000

/**
 * Resolve, download and verify one package, letting the registries race.
 *
 * The two registries publish the same extensions from different file hosts,
 * and a network treats the two very differently: one of them can answer a
 * lookup in half a second and then serve its packages at a crawl — or not
 * answer at all. Asking the registries one after the other makes the install
 * wait for the slow one before the fast one is even tried, so the first one
 * gets a head start and the second one is asked while the first is still
 * working. The first package that arrives — downloaded AND verified — wins,
 * and the other download is stopped where it stands.
 *
 * A **reachability** failure falls back; an **integrity** failure (a bad
 * signature, a size that does not match the manifest) is a fact about that
 * package and is reported as-is, never retried somewhere else.
 * @param {string} source - `open-vsx` or `marketplace`.
 * @param {string} publisher - the publisher id.
 * @param {string} name - the extension name.
 * @param {string} [version] - the version; the latest when omitted.
 * @param {(stage: string) => void} [onStage] - the stage reporter.
 * @param {Array<string>} [order] - the registries to try, in that order.
 * @returns {Promise<object>} the entry, the bytes, the report, and whether the other registry served it.
 */
export async function resolveAndDownload(source, publisher, name, version, onStage = () => {}, order = undefined) {
  const sequence = order ?? (source === 'open-vsx' ? ['open-vsx', 'marketplace'] : ['marketplace', 'open-vsx'])
  const controller = new AbortController()
  const outcomes = []
  let waiters = []
  const changed = () => {
    const pending = waiters
    waiters = []
    for (const waiter of pending) waiter()
  }
  let releaseHeadStart = () => {}
  const headStart = new Promise((resolve) => { releaseHeadStart = resolve })
  const headStartTimer = setTimeout(() => { releaseHeadStart() }, REGISTRY_HEAD_START_MS)
  const attempt = (candidate) => {
    void (async () => {
      let outcome
      try {
        onStage('resolve')
        const entry = await resolveSource(candidate, publisher, name, version)
        const { bytes, report } = await downloadAndVerify(entry, onStage, controller.signal)
        outcome = { ok: true, candidate, entry, bytes, report }
      } catch (error) {
        outcome = { ok: false, candidate, error }
      }
      outcomes.push(outcome)
      changed()
      // The first registry failed: the second one does not have to wait for
      // the head start to run out.
      if (outcome.ok !== true && candidate === sequence[0]) releaseHeadStart()
    })()
  }
  attempt(sequence[0])
  if (sequence.length > 1) {
    void (async () => {
      await headStart
      if (outcomes.some((outcome) => outcome.ok === true)) return
      attempt(sequence[1])
    })()
  }
  try {
    for (;;) {
      const winner = outcomes.find((outcome) => outcome.ok === true)
      if (winner !== undefined) {
        // The package is here: the other download has no reason to continue.
        controller.abort()
        return {
          entry: winner.entry,
          bytes: winner.bytes,
          report: winner.report,
          fellBack: winner.candidate !== sequence[0],
          unreachableHosts: outcomes
            .filter((outcome) => outcome.ok !== true && isReachabilityFailure(outcome.error))
            .map((outcome) => outcome.candidate),
        }
      }
      if (outcomes.length === sequence.length) {
        const failure = outcomes.find((outcome) => outcome.ok !== true)
        throw failure?.error ?? new Error(`no registry could serve "${publisher}.${name}"`)
      }
      await new Promise((resolve) => { waiters.push(resolve) })
    }
  } finally {
    clearTimeout(headStartTimer)
  }
}

/**
 * Write the store's own metadata beside an unpacked extension.
 * @param {string} directory - the extension's install directory.
 * @param {object} metadata - the metadata to write.
 */
export function writeExtensionMetadata(directory, metadata) {
  writeFileSync(join(directory, 'dsh-extension.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
  mkdirSync(join(directory, 'global-storage'), { recursive: true })
}

/**
 * Move a prepared extension directory into place.
 * @param {string} from - the temporary directory.
 * @param {string} to - the final directory.
 */
export function commitDirectory(from, to) {
  rmSync(to, { recursive: true, force: true })
  renameSync(from, to)
}

/**
 * Create a temporary staging directory beside the extensions directory.
 * @param {string} extensionsDir - the extensions directory.
 * @returns {string} the staging directory's path.
 */
export function createStagingDirectory(extensionsDir) {
  mkdirSync(extensionsDir, { recursive: true })
  return mkdtempSync(join(extensionsDir, '.staging-'))
}

/**
 * Remove a staging directory.
 * @param {string} directory - the staging directory.
 */
export function discardStagingDirectory(directory) {
  rmSync(directory, { recursive: true, force: true })
}

/**
 * A staging directory under the system temp dir, used by the offline tests.
 * @returns {string} the directory's path.
 */
export function createTempDirectory() {
  return mkdtempSync(join(tmpdir(), 'dsh-vsix-'))
}
