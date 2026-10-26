/**
 * The VSIX store's Host service.
 *
 * It owns four things:
 *
 * - the **catalog**: what Open VSX and the Microsoft Marketplace publish, and
 *   whether DSH can actually run each extension;
 * - the **install pipeline**: download, verify, unpack, commit;
 * - the **installed-extension state**: which extensions exist, whether they
 *   are enabled, and whether their publisher is trusted;
 * - the **extension-host boundary**: a narrow interface the future
 *   extension-host bundle implements, so that "disable" really means "do not
 *   load this extension into the host process" once such a host exists.
 */

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  inspectManifest,
  lookupMarketplace,
  lookupOpenVsx,
  SEARCH_ATTEMPTS,
  SEARCH_TIMEOUT_MS,
  searchMarketplace,
  searchOpenVsx,
} from './catalog.js'
import {
  commitDirectory,
  createStagingDirectory,
  discardStagingDirectory,
  resolveAndDownload,
  unpackExtension,
  writeExtensionMetadata,
} from './install.js'
import { extensionDirectoryName, storePaths } from './paths.js'
import {
  detectLocale,
  listExtensionDirectories,
  readRecord,
} from './records.js'
import { readState, readTrust, writeState, writeTrust } from './state.js'

/** How many catalog manifests are inspected per query. */
const MANIFEST_INSPECT_LIMIT = 24

/**
 * The default extension-host backend.
 *
 * The extension host itself is a separate bundle that has not landed yet, so
 * this backend records what the host would have to do and says so plainly.
 * Replacing it is the only change the host needs: the store never starts a
 * process itself.
 * @type {{ enable: (record: object) => Promise<object>, disable: (record: object) => Promise<object> }}
 */
export const PENDING_HOST_BACKEND = {
  async enable(record) {
    return { started: false, extension: record.id, reason: 'no extension host is running yet' }
  },
  async disable(record) {
    return { stopped: false, extension: record.id, reason: 'no extension host is running yet' }
  },
}

/**
 * Run a mapper over a list with a bounded number of concurrent requests.
 * @param {Array<any>} items - the items.
 * @param {number} limit - the concurrency limit.
 * @param {(item: any) => Promise<any>} mapper - the async mapper.
 * @returns {Promise<Array<any>>} the mapped items, in order.
 */
async function mapWithLimit(items, limit, mapper) {
  const results = new Array(items.length)
  let next = 0
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await mapper(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * The store's Host service.
 */
export class VsixStore {
  /**
   * @param {object} ctx - the Host plugin context.
   */
  constructor(ctx) {
    this.ctx = ctx
    this.paths = storePaths(ctx)
    this.locale = detectLocale()
    /** The extension-host boundary; replaced by the host bundle when it lands. */
    this.hostBackend = PENDING_HOST_BACKEND
    /** The running installs, by job id; the page polls them for progress. */
    this.jobs = new Map()
    /**
     * The registries whose FILE HOST this network could not reach.
     *
     * The two registries publish their packages from different hosts, and one
     * of them can be unreachable while the other answers. Once a registry's
     * host has failed to connect, the next install asks the other one first
     * instead of waiting for the connect timeout again.
     */
    this.unreachableHosts = new Set()
  }

  /**
   * The order the registries are tried in.
   * @param {string} source - the registry the person chose.
   * @returns {Array<string>} the order.
   */
  installOrder(source) {
    if (this.unreachableHosts.has('open-vsx') && !this.unreachableHosts.has('marketplace')) {
      return ['marketplace', 'open-vsx']
    }
    if (this.unreachableHosts.has('marketplace') && !this.unreachableHosts.has('open-vsx')) {
      return ['open-vsx', 'marketplace']
    }
    return source === 'open-vsx' ? ['open-vsx', 'marketplace'] : ['marketplace', 'open-vsx']
  }

  /**
   * Install the extension-host backend.
   * @param {object} backend - an object with `enable` and `disable`.
   * @returns {void}
   */
  setHostBackend(backend) {
    this.hostBackend = backend
  }

  /**
   * Read the publisher trust list.
   * @returns {Promise<Record<string, boolean>>} the trusted publishers.
   */
  async trustedPublishers() {
    return readTrust(this.ctx, this.paths.trustFile)
  }

  /**
   * List the installed extensions.
   * @returns {Promise<Array<object>>} the records.
   */
  async list() {
    const state = await readState(this.ctx, this.paths.stateFile)
    const trust = await this.trustedPublishers()
    const stored = new Map(state.extensions.map((entry) => [entry.id, entry]))
    const records = []
    for (const name of listExtensionDirectories(this.paths.extensionsDir)) {
      const directory = join(this.paths.extensionsDir, name)
      const manifestRecord = readRecord(directory, {
        locale: this.locale,
        trustedPublishers: trust,
        enabled: true,
      })
      if (manifestRecord === undefined) continue
      const previous = stored.get(manifestRecord.id)
      const record = {
        ...manifestRecord,
        enabled: previous?.enabled !== false,
      }
      records.push(record)
    }
    records.sort((a, b) => a.id.localeCompare(b.id))
    await this.syncState(records)
    return records
  }

  /**
   * Write the state file when it no longer matches the installed extensions.
   * @param {Array<object>} records - the records to store.
   * @returns {Promise<void>} after the file is written.
   */
  async syncState(records) {
    const state = await readState(this.ctx, this.paths.stateFile)
    const before = JSON.stringify(state.extensions)
    const after = JSON.stringify(records)
    if (before !== after) await writeState(this.ctx, this.paths.stateFile, { extensions: records })
  }

  /**
   * Search the catalogs.
   * @param {object} options - the query options.
   * @param {string} options.query - the free-text query.
   * @param {string} [options.source] - `open-vsx`, `marketplace` or `both`; both when omitted.
   * @param {number} [options.limit] - the maximum number of results per source.
   * @param {boolean} [options.inspect] - read each manifest to decide DSH support.
   * @returns {Promise<object>} the catalog answer.
   */
  async catalog({ query, source, limit = 50, inspect = true }) {
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new Error('a search query is required')
    }
    const sources = source === undefined || source === null || source === 'both'
      ? ['open-vsx', 'marketplace']
      : [source]
    const installed = await this.list()
    const installedIds = new Set(installed.map((record) => `${record.publisher}.${record.name}`))
    const results = []
    const sourceReports = []
    // The registries are asked at the SAME time: they answer in a second each,
    // and asking them one after the other doubles the wait for the list.
    const answers = await Promise.all(sources.map(async (name) => {
      try {
        const found = name === 'open-vsx'
          ? await searchOpenVsx(query.trim(), limit)
          : await searchMarketplace(query.trim(), limit)
        return { source: name, ok: true, total: found.total, entries: found.entries }
      } catch (error) {
        return {
          source: name,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }))
    for (const answer of answers) {
      if (answer.ok !== true) {
        sourceReports.push({ source: answer.source, ok: false, error: answer.error })
        continue
      }
      sourceReports.push({
        source: answer.source,
        ok: true,
        total: answer.total,
        returned: answer.entries.length,
      })
      for (const entry of answer.entries) {
        results.push({
          id: `${entry.publisher}.${entry.name}`,
          publisher: entry.publisher,
          name: entry.name,
          version: entry.version,
          displayName: entry.displayName,
          description: entry.description,
          icon: entry.iconUrl,
          downloadUrl: entry.downloadUrl,
          manifestUrl: entry.manifestUrl ?? null,
          source: entry.source,
          installed: installedIds.has(`${entry.publisher}.${entry.name}`),
          publisherVerified: entry.publisherVerified,
          deprecated: entry.deprecated,
          targetPlatform: entry.targetPlatform,
          downloads: entry.downloads,
          rating: entry.rating,
          ratingCount: entry.ratingCount,
          lastUpdated: entry.lastUpdated,
          capability: {
            status: 'unknown',
            basis: 'not-inspected',
            detail: '',
            contributes: [],
            supported: [],
            degraded: [],
            unsupported: [],
            entries: [],
            runtime: { verdict: 'unknown', usable: false, pendingTracks: [] },
          },
          problems: [],
        })
      }
    }
    if (inspect) {
      const inspectable = results.slice(0, MANIFEST_INSPECT_LIMIT)
      await mapWithLimit(inspectable, 8, async (entry) => {
        entry.capability = await inspectManifest(entry.manifestUrl ?? null)
        return entry
      })
      // How many manifests could not be read: a registry whose file CDN this
      // network cannot reach answers the search but publishes no manifest, and
      // the page has to say that ONCE instead of on every card.
      for (const report of sourceReports) {
        if (report.ok !== true) continue
        const unreadable = results.filter((entry) => entry.source === report.source
          && entry.capability.basis === 'manifest-unreachable').length
        if (unreadable > 0) {
          report.manifestsUnreadable = unreadable
        }
      }
      for (const entry of results.slice(MANIFEST_INSPECT_LIMIT)) {
        entry.capability = {
          status: 'unknown',
          basis: 'not-inspected',
          detail: 'This result was beyond the per-query manifest inspection budget; inspect it individually for an exact verdict.',
          contributes: [],
          supported: [],
          degraded: [],
          unsupported: [],
          entries: [],
          runtime: { verdict: 'unknown', usable: false, pendingTracks: [] },
        }
      }
    }
    return { results, sources: sourceReports }
  }

  /**
   * Decide what DSH can do with ONE extension.
   *
   * The catalog search does NOT inspect every result before answering: a
   * registry answers its search in a second, while a manifest hosted on a CDN
   * the network cannot reach takes a timeout PER RESULT — twenty-four of them
   * turn a one-second search into four minutes. So the list comes first and the
   * verdict comes after, one extension at a time, and the page shows the list
   * while it waits.
   *
   * @param {object} options - the options.
   * @param {string} options.publisher - the publisher id.
   * @param {string} options.name - the extension name.
   * @param {string} [options.version] - the version.
   * @param {string} [options.source] - `open-vsx` or `marketplace`.
   * @returns {Promise<object>} the capability verdict.
   */
  async inspect({ publisher, name, version, source, manifestUrl }) {
    if (typeof publisher !== 'string' || publisher.length === 0) throw new Error('a publisher is required')
    if (typeof name !== 'string' || name.length === 0) throw new Error('an extension name is required')
    const registry = source === 'marketplace' ? 'marketplace' : 'open-vsx'
    let entry
    try {
      // The SEARCH already published the manifest URL, so the caller can hand it
      // over: one request per extension instead of two.
      if (typeof manifestUrl === 'string' && manifestUrl.length > 0) {
        const verdict = await inspectManifest(manifestUrl)
        if (verdict.basis === 'manifest-unreachable') {
          return await this._inspectOnTheOtherRegistry(verdict, publisher, name, version, registry)
        }
        return verdict
      }
      entry = registry === 'marketplace'
        ? await lookupMarketplace(publisher, name)
        : await lookupOpenVsx(publisher, name, version)
    } catch (error) {
      return {
        status: 'unknown',
        basis: 'lookup-failed',
        detail: `The registry could not be asked about this extension: ${error instanceof Error ? error.message : String(error)}`,
        contributes: [],
        supported: [],
        degraded: [],
        unsupported: [],
        entries: [],
        runtime: { verdict: 'unknown', usable: false, pendingTracks: [] },
        problems: [],
      }
    }
    if (entry === undefined) {
      return {
        status: 'unknown',
        basis: 'not-found',
        detail: 'The registry does not publish this extension under that name.',
        contributes: [],
        supported: [],
        degraded: [],
        unsupported: [],
        entries: [],
        runtime: { verdict: 'unknown', usable: false, pendingTracks: [] },
        problems: [],
      }
    }
    const verdict = await inspectManifest(entry.manifestUrl ?? null)
    if (verdict.basis === 'manifest-unreachable') {
      return await this._inspectOnTheOtherRegistry(verdict, publisher, name, version, registry)
    }
    return verdict
  }

  /**
   * Read the same extension's manifest from the OTHER registry.
   *
   * The two registries publish the same extensions from different file hosts,
   * and a network that can reach one may not reach the other. A manifest that
   * could not be READ is a reachability fact, not a fact about the extension,
   * so the other registry's copy of the same extension is a fair second try —
   * unlike a package whose INTEGRITY failed, which is never retried anywhere.
   *
   * @param {object} verdict - the verdict the first registry produced.
   * @param {string} publisher - the publisher id.
   * @param {string} name - the extension name.
   * @param {string} version - the version.
   * @param {string} registry - the registry that was tried first.
   * @returns {Promise<object>} the other registry's verdict, or the first one.
   */
  async _inspectOnTheOtherRegistry(verdict, publisher, name, version, registry) {
    const other = registry === 'marketplace' ? 'open-vsx' : 'marketplace'
    try {
      const entry = other === 'marketplace'
        ? await lookupMarketplace(publisher, name, { timeoutMs: SEARCH_TIMEOUT_MS, attempts: SEARCH_ATTEMPTS })
        : await lookupOpenVsx(publisher, name, version, { timeoutMs: SEARCH_TIMEOUT_MS, attempts: SEARCH_ATTEMPTS })
      if (entry === undefined || !entry.manifestUrl) return verdict
      const fallback = await inspectManifest(entry.manifestUrl)
      if (fallback.basis === 'manifest-unreachable') return verdict
      return {
        ...fallback,
        detail: `${fallback.detail} (read from ${other}, because ${registry}'s own manifest file could not be reached)`,
      }
    } catch {
      return verdict
    }
  }

  /**
   * Install one extension.
   * @param {object} options - the install options.
   * @param {string} options.publisher - the publisher id.
   * @param {string} options.name - the extension name.
   * @param {string} [options.version] - the version; the latest when omitted.
   * @param {string} options.source - `open-vsx` or `marketplace`.
   * @param {boolean} options.trust - the caller's explicit trust confirmation.
   * @param {(stage: string) => void} [options.onStage] - the stage reporter.
   * @returns {Promise<object>} the installed record.
   */
  async install({ publisher, name, version, source, trust, onStage = () => {} }) {
    if (trust !== true) {
      throw new Error(
        'installing a third-party extension runs its code; the caller must confirm the user\'s explicit approval with trust: true',
      )
    }
    if (typeof publisher !== 'string' || publisher.length === 0) throw new Error('a publisher is required')
    if (typeof name !== 'string' || name.length === 0) throw new Error('an extension name is required')
    const { entry, bytes, report, fellBack, unreachableHosts } = await resolveAndDownload(
      source,
      publisher,
      name,
      version,
      onStage,
      this.installOrder(source),
    )
    for (const host of unreachableHosts) this.unreachableHosts.add(host)
    const staging = createStagingDirectory(this.paths.extensionsDir)
    try {
      onStage('unpack')
      const manifest = unpackExtension(bytes, staging)
      const manifestPublisher = typeof manifest.publisher === 'string' ? manifest.publisher : publisher
      const manifestName = typeof manifest.name === 'string' ? manifest.name : name
      const manifestVersion = typeof manifest.version === 'string' ? manifest.version : entry.version
      if (typeof manifest.name !== 'string' || typeof manifest.publisher !== 'string' || typeof manifest.version !== 'string') {
        throw new Error('the package manifest is missing name, publisher or version')
      }
      const targetPlatform = entry.targetPlatform ?? null
      const directoryName = extensionDirectoryName(manifestPublisher, manifestName, manifestVersion, targetPlatform)
      const directory = join(this.paths.extensionsDir, directoryName)
      writeExtensionMetadata(staging, {
        id: `${manifestPublisher}.${manifestName}@${manifestVersion}`,
        publisher: manifestPublisher,
        name: manifestName,
        version: manifestVersion,
        source: entry.source,
        requestedSource: source,
        servedByOtherRegistry: fellBack === true,
        requestedVersion: version ?? null,
        catalogVersion: entry.version ?? null,
        targetPlatform,
        installedAt: new Date().toISOString(),
        size: report.size,
        sha256: report.sha256,
        signature: report.signature,
        entryDigests: report.entries ?? null,
        publisherVerified: report.publisherVerified,
        downloadUrl: entry.downloadUrl,
        executesCode: typeof manifest.main === 'string' || typeof manifest.browser === 'string',
        enginesVscode: manifest.engines?.vscode ?? null,
      })
      commitDirectory(staging, directory)
      const publishers = await this.trustedPublishers()
      publishers[manifestPublisher] = true
      await writeTrust(this.ctx, this.paths.trustFile, publishers)
      const record = readRecord(directory, {
        locale: this.locale,
        trustedPublishers: publishers,
        enabled: true,
      })
      const records = await this.list()
      const stored = records.find((entryRecord) => entryRecord.id === record?.id)
      await this.syncState(records.map((entryRecord) => (entryRecord.id === record?.id
        ? { ...entryRecord, enabled: true }
        : entryRecord)))
      return stored ?? record
    } catch (error) {
      discardStagingDirectory(staging)
      throw error
    }
  }

  /**
   * Start an install and report its progress while it runs.
   *
   * An install downloads a package of several megabytes, verifies a signature
   * over it and unpacks it — a wait that is long enough that a page which only
   * shows a spinner looks broken. The work therefore runs in the background
   * and reports its stage (`resolve`, `download`, `verify`, `unpack`), so the
   * page can say what is happening instead of nothing.
   *
   * @param {object} options - the install options.
   * @returns {object} the job, with its id and its first stage.
   */
  startInstall(options) {
    const job = {
      id: randomUUID(),
      state: 'running',
      stage: 'resolve',
      record: undefined,
      error: undefined,
    }
    this.jobs.set(job.id, job)
    void (async () => {
      try {
        job.record = await this.install({
          ...options,
          onStage: (stage) => { job.stage = stage },
        })
        job.state = 'done'
        job.stage = 'done'
      } catch (error) {
        job.state = 'failed'
        job.stage = 'failed'
        job.error = error instanceof Error ? error.message : String(error)
      }
    })()
    return job
  }

  /**
   * Read one install job's progress.
   * @param {object} options - the query options.
   * @param {string} options.jobId - the job id.
   * @returns {object} the job's state.
   */
  installStatus({ jobId }) {
    if (typeof jobId !== 'string' || jobId.length === 0) throw new Error('a job id is required')
    const job = this.jobs.get(jobId)
    if (job === undefined) throw new Error('that install job is unknown')
    return job
  }

  /**
   * Remove one installed extension.
   * @param {object} options - the remove options.
   * @param {string} options.id - the extension id, `publisher.name@version`.
   * @returns {Promise<{ id: string, removed: boolean }>} the outcome.
   */
  async remove({ id }) {
    if (typeof id !== 'string' || id.length === 0) throw new Error('an extension id is required')
    const records = await this.list()
    const record = records.find((entry) => entry.id === id)
    if (record === undefined) throw new Error(`no extension "${id}" is installed`)
    rmSync(record.directory, { recursive: true, force: true })
    await this.hostBackend.disable(record)
    const remaining = records.filter((entry) => entry.id !== id)
    await writeState(this.ctx, this.paths.stateFile, { extensions: remaining })
    return { id, removed: true }
  }

  /**
   * Enable or disable one installed extension.
   *
   * Disabling an extension means the extension host must not load it; the
   * host backend owns that decision, and the flag lives in the state file so
   * the host can read it without asking the store.
   * @param {object} options - the enable options.
   * @param {string} options.id - the extension id.
   * @param {boolean} options.enabled - the wanted state.
   * @returns {Promise<object>} the outcome.
   */
  async setEnabled({ id, enabled }) {
    if (typeof id !== 'string' || id.length === 0) throw new Error('an extension id is required')
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean')
    const records = await this.list()
    const record = records.find((entry) => entry.id === id)
    if (record === undefined) throw new Error(`no extension "${id}" is installed`)
    const updated = records.map((entry) => (entry.id === id ? { ...entry, enabled } : entry))
    await writeState(this.ctx, this.paths.stateFile, { extensions: updated })
    const host = enabled ? await this.hostBackend.enable(record) : await this.hostBackend.disable(record)
    return { id, enabled, host }
  }

  /**
   * Trust or untrust a publisher.
   * @param {object} options - the trust options.
   * @param {string} options.publisher - the publisher id.
   * @param {boolean} options.trusted - the wanted state.
   * @returns {Promise<object>} the outcome.
   */
  async setTrust({ publisher, trusted }) {
    if (typeof publisher !== 'string' || publisher.length === 0) throw new Error('a publisher is required')
    if (typeof trusted !== 'boolean') throw new Error('trusted must be a boolean')
    const trust = await this.trustedPublishers()
    if (trusted) trust[publisher] = true
    else delete trust[publisher]
    await writeTrust(this.ctx, this.paths.trustFile, trust)
    const records = await this.list()
    const updated = records.map((entry) => (entry.publisher === publisher
      ? { ...entry, trusted: trusted }
      : entry))
    await writeState(this.ctx, this.paths.stateFile, { extensions: updated })
    return { publisher, trusted }
  }
}

/**
 * Whether an extension directory exists.
 * @param {string} directory - the directory's path.
 * @returns {boolean} true when the directory exists.
 */
export function directoryExists(directory) {
  return existsSync(directory)
}
