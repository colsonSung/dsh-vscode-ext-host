/**
 * The two extension catalogs DSH can search.
 *
 * Both are public and need no login ([vsix-runtime-and-trust.md] §3.3):
 *
 * - **Open VSX** — `GET https://open-vsx.org/api/-/search?size=N&query=…`
 *   answers 200 with `totalSize` and `extensions`
 *   ([vsix-runtime-and-trust.md] §3.2 and the live probe in
 *   `scripts/search-open-vsx.mjs`);
 * - **Microsoft Marketplace** — `POST
 *   https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery`
 *   with an `extensionquery` body; a GET answers 405, so the POST is
 *   mandatory ([vsix-runtime-and-trust.md] §3.1).
 *
 * Both sources also publish the extension's own `package.json` as a
 * downloadable asset (`files.manifest` on Open VSX, the
 * `Microsoft.VisualStudio.Code.Manifest` asset on the Marketplace), so the
 * catalog can say whether DSH can actually run an extension without
 * downloading the VSIX at all.
 */

import { classifyContributes } from './capabilities.js'

const OPEN_VSX_SEARCH = 'https://open-vsx.org/api/-/search'
const OPEN_VSX_EXTENSION = 'https://open-vsx.org/api'
const MARKETPLACE_QUERY = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery'

/** Marketplace filter type for a free-text query. */
const FILTER_TEXT = 10
/** Marketplace filter type for an exact `publisher.name` identifier. */
const FILTER_NAME = 7

/**
 * Marketplace query flags: files, version properties, statistics, asset URIs
 * and metadata. The research notes use 950 for a name lookup
 * ([vsix-runtime-and-trust.md] §3.1); this adds the category/tag flag so the
 * catalog can classify an extension without its manifest.
 */
const MARKETPLACE_FLAGS = 950

/** How long one catalog request may take. */
const REQUEST_TIMEOUT_MS = 15_000

/** How many times one request is retried before the failure is reported. */
const REQUEST_ATTEMPTS = 6

/**
 * How long an INTERACTIVE catalog search may take.
 *
 * The download path waits hard — a package that is worth downloading is worth
 * waiting for — but a search is a thing a person is looking at. The hard
 * policy (six tries of fifteen seconds, plus the backoff between them) can
 * keep a search unanswered for well over a minute, which is exactly what
 * "the list takes forever to show" feels like. A search therefore fails fast:
 * two tries of six seconds.
 */
export const SEARCH_TIMEOUT_MS = 6_000

/** How many times an interactive catalog search is tried. */
export const SEARCH_ATTEMPTS = 2

/**
 * Run a request, retrying the failures a flaky network causes.
 *
 * The Open VSX registry serves its files from a redirecting CDN
 * (`openvsx.eclipsecontent.org`) whose connect step times out intermittently
 * from some networks; a retry turns that flakiness into a slower success
 * instead of a failed install.
 *
 * A failure that `shouldRetry` rejects is NOT retried: a host that cannot be
 * connected to does not answer on the sixth try either.
 * @template T
 * @param {() => Promise<T>} run - the request.
 * @param {number} [attempts] - how many times the request is tried.
 * @param {(error: unknown) => boolean} [shouldRetry] - whether a failure is worth another try.
 * @returns {Promise<T>} the answer.
 */
async function withRetry(run, attempts = REQUEST_ATTEMPTS, shouldRetry = () => true) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      lastError = error
      if (!shouldRetry(error)) break
      if (attempt < attempts - 1) {
        await new Promise((resolve) => { setTimeout(resolve, 500 * (attempt + 1)) })
      }
    }
  }
  throw lastError
}

/**
 * Whether a failure means "this host cannot be reached at all".
 *
 * A host that refuses the connection does not answer on the sixth try either:
 * the connect step times out in ten seconds, and six of those are a MINUTE of
 * silence before the store gives up on that registry. A connection-level
 * failure is therefore reported at once, so the other registry — which
 * publishes the same extension from a different file host — is asked
 * immediately.
 *
 * A failure that happened AFTER the connection was established (a truncated
 * download, a reset mid-transfer) is a different thing: it is worth another
 * try.
 * @param {unknown} error - the failure.
 * @returns {boolean} whether the host is unreachable.
 */
export function isUnreachableHost(error) {
  const cause = error?.cause
  if (cause?.code === 'UND_ERR_CONNECT_TIMEOUT') return true
  const message = cause?.message ?? error?.message ?? ''
  return /connect timeout|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message)
}

/**
 * Whether a failed request is worth another try.
 *
 * A **definitive answer** is not: a registry that answers `404` or `403` has
 * answered, and asking it six times with a backoff between the tries turns a
 * fact into twelve seconds of waiting — a version one registry does not
 * publish is a normal fact, not a fluke. The same goes for a host that cannot
 * be connected to: it will not answer on the sixth try either.
 *
 * What IS worth another try: a server that was busy (5xx), a request that
 * timed out on a slow connection, and a connection that broke while the
 * answer was on its way.
 * @param {unknown} error - the failure.
 * @returns {boolean} whether the request should be tried again.
 */
export function shouldRetryRequest(error) {
  if (isUnreachableHost(error)) return false
  const message = error instanceof Error ? error.message : String(error)
  const answered = message.match(/answered HTTP (\d{3})/)
  if (answered === null) return true
  const status = Number(answered[1])
  if (status === 408 || status === 429) return true
  return status >= 500
}

/**
 * Fetch one URL as JSON.
 * @param {string} url - the absolute URL.
 * @param {object} [options] - the request options.
 * @param {string} [options.method] - the HTTP method.
 * @param {object} [options.body] - a JSON body.
 * @param {number} [options.timeoutMs] - the request timeout.
 * @param {number} [options.attempts] - how many times the request is tried.
 * @returns {Promise<any>} the parsed JSON body.
 */
export async function fetchJson(url, { method = 'GET', body, timeoutMs = REQUEST_TIMEOUT_MS, attempts = REQUEST_ATTEMPTS } = {}) {
  return withRetry(async () => {
    const response = await fetch(url, {
      method,
      headers: {
        accept: 'application/json;api-version=7.2-preview.1, application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      throw new Error(`${url} answered HTTP ${response.status}`)
    }
    return response.json()
  }, attempts, shouldRetryRequest)
}

/**
 * A host that could not be reached.
 *
 * The two registries publish the same extensions from different file hosts:
 * Open VSX serves packages from `openvsx.eclipsecontent.org` and the
 * Marketplace from `<publisher>.gallerycdn.vsassets.io`. A network that can
 * reach one may not reach the other, so a reachability failure is worth
 * retrying against the other registry — while an integrity failure (a bad
 * signature, a size that does not match) is a fact about the package and must
 * never be retried elsewhere.
 */
export class TransportError extends Error {
  /**
   * @param {string} url - the URL that could not be reached.
   * @param {unknown} cause - the underlying failure.
   */
  constructor(url, cause) {
    super(`could not reach ${url}: ${cause?.message ?? String(cause)}`)
    this.name = 'TransportError'
    this.url = url
  }
}

/**
 * Whether a failure means "this host did not serve it", so the other registry
 * is worth asking.
 * @param {unknown} error - the failure.
 * @returns {boolean} whether another registry should be tried.
 */
export function isReachabilityFailure(error) {
  if (error instanceof TransportError) return true
  const message = error instanceof Error ? error.message : String(error)
  return /answered HTTP (404|410|403)\b/.test(message)
}

/**
 * Fetch one URL as bytes.
 * @param {string} url - the absolute URL.
 * @param {number} [timeoutMs] - the request timeout.
 * @param {AbortSignal} [signal] - a signal that stops the download.
 * @returns {Promise<Buffer>} the response body.
 */
export async function fetchBytes(url, timeoutMs = 120_000, signal = undefined) {
  return withRetry(async () => {
    let response
    try {
      const timeout = AbortSignal.timeout(timeoutMs)
      response = await fetch(url, {
        signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
      })
    } catch (error) {
      throw new TransportError(url, error)
    }
    if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }, REQUEST_ATTEMPTS, shouldRetryRequest)
}

/**
 * Detect the target platform VS Code would name for this machine.
 * @returns {string} a platform tag such as `darwin-arm64`.
 */
export function hostTargetPlatform() {
  const platform = process.platform === 'win32' ? 'win32' : process.platform
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch
  return `${platform}-${arch}`
}

/**
 * Build the URL of an extension's own manifest on Open VSX.
 *
 * The search answer does not carry the `manifest` asset, but the registry
 * serves the extension's `package.json` at a fixed place below its version
 * ([vsix-runtime-and-trust.md] §3.2).
 * @param {string} namespace - the publisher namespace.
 * @param {string} name - the extension name.
 * @param {string} version - the extension version.
 * @returns {string} the manifest URL.
 */
export function openVsxManifestUrl(namespace, name, version) {
  return `${OPEN_VSX_EXTENSION}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/file/package.json`
}

/**
 * Search Open VSX.
 * @param {string} query - the free-text query.
 * @param {number} limit - the maximum number of results.
 * @returns {Promise<{ total: number, entries: Array<object> }>} the raw search facts.
 */
export async function searchOpenVsx(query, limit) {
  const url = `${OPEN_VSX_SEARCH}?size=${limit}&query=${encodeURIComponent(query)}`
  const data = await fetchJson(url, { timeoutMs: SEARCH_TIMEOUT_MS, attempts: SEARCH_ATTEMPTS })
  const extensions = Array.isArray(data?.extensions) ? data.extensions : []
  return {
    total: typeof data?.totalSize === 'number' ? data.totalSize : extensions.length,
    entries: extensions.map((extension) => ({
      publisher: extension.namespace,
      name: extension.name,
      version: extension.version,
      displayName: extension.displayName ?? extension.name,
      description: extension.description ?? '',
      iconUrl: extension.files?.icon ?? null,
      downloadUrl: extension.files?.download ?? null,
      signatureUrl: extension.files?.signature ?? null,
      publicKeyUrl: extension.files?.publicKey ?? null,
      manifestUrl: openVsxManifestUrl(extension.namespace, extension.name, extension.version),
      publisherVerified: extension.verified === true,
      deprecated: extension.deprecated === true,
      targetPlatform: null,
      downloads: typeof extension.downloadCount === 'number' ? extension.downloadCount : undefined,
      rating: typeof extension.averageRating === 'number' ? extension.averageRating : undefined,
      ratingCount: typeof extension.reviewCount === 'number' ? extension.reviewCount : undefined,
      lastUpdated: typeof extension.timestamp === 'string' ? extension.timestamp : undefined,
      source: 'open-vsx',
    })),
  }
}

/**
 * Run one Marketplace query.
 * @param {object} criteria - the filter criteria.
 * @param {number} pageSize - the page size.
 * @param {object} [options] - the request policy.
 * @param {number} [options.timeoutMs] - the request timeout.
 * @param {number} [options.attempts] - how many times the request is tried.
 * @returns {Promise<Array<object>>} the matching extensions.
 */
async function marketplaceQuery(criteria, pageSize, options = {}) {
  const body = {
    filters: [{ criteria, pageNumber: 1, pageSize, sortBy: 0, sortOrder: 0 }],
    assetTypes: [],
    flags: MARKETPLACE_FLAGS,
  }
  const data = await fetchJson(MARKETPLACE_QUERY, { method: 'POST', body, ...options })
  const extensions = data?.results?.[0]?.extensions
  return Array.isArray(extensions) ? extensions : []
}

/**
 * Pick the version build to install from a Marketplace version list.
 *
 * The Marketplace publishes one entry per platform build, and the universal
 * build carries no `targetPlatform`; the platform builds carry one
 * (`darwin-arm64`, `win32-x64`, `web`, …). The universal build wins; a
 * platform build is used only when it matches this machine.
 * @param {Array<object>} versions - the extension's versions.
 * @returns {object|undefined} the chosen version.
 */
export function pickMarketplaceVersion(versions) {
  const list = Array.isArray(versions) ? versions : []
  const universal = list.find((version) => version.targetPlatform === undefined || version.targetPlatform === null)
  if (universal !== undefined) return universal
  const host = hostTargetPlatform()
  const matching = list.find((version) => version.targetPlatform === host)
  if (matching !== undefined) return matching
  return list.find((version) => marketplaceVsixUrl(version) !== undefined)
}

/**
 * Find the VSIX asset of one Marketplace version.
 * @param {object} version - the version entry.
 * @returns {string|undefined} the asset URL.
 */
function marketplaceVsixUrl(version) {
  const asset = version?.files?.find((file) => file.assetType === 'Microsoft.VisualStudio.Services.VSIXPackage')
  return asset?.source
}

/**
 * Find the extension manifest asset of one Marketplace version.
 * @param {object} version - the version entry.
 * @returns {string|undefined} the asset URL.
 */
function marketplaceManifestUrl(version) {
  const asset = version?.files?.find((file) => file.assetType === 'Microsoft.VisualStudio.Code.Manifest')
  return asset?.source
}

/**
 * Find the default icon asset of one Marketplace version.
 * @param {object} version - the version entry.
 * @returns {string|undefined} the asset URL.
 */
function marketplaceIconUrl(version) {
  const asset = version?.files?.find((file) => file.assetType === 'Microsoft.VisualStudio.Services.Icons.Default')
  return asset?.source
}

/**
 * Read one statistic from a Marketplace extension.
 *
 * The `statistics` array names its entries in a mixed case: the rating ones
 * are lower case (`averagerating`, `ratingcount`) while the counters are
 * camel case (`updateCount`, `weightedRating`, `downloadCount`), so the
 * name has to be matched exactly.
 *
 * `install` is the number the VS Code extension list shows next to the
 * cloud icon; `downloadCount` is a different, smaller counter.
 * @param {object} extension - the Marketplace extension.
 * @param {string} name - the statistic's name.
 * @returns {number|undefined} the value, when the registry published it.
 */
export function marketplaceStatistic(extension, name) {
  const statistics = extension?.statistics
  if (!Array.isArray(statistics)) return undefined
  const found = statistics.find((entry) => entry?.statisticName === name)
  return typeof found?.value === 'number' ? found.value : undefined
}

/**
 * Search the Microsoft Marketplace.
 * @param {string} query - the free-text query.
 * @param {number} limit - the maximum number of results.
 * @returns {Promise<{ total: number, entries: Array<object> }>} the raw search facts.
 */
export async function searchMarketplace(query, limit) {
  const extensions = await marketplaceQuery(
    [{ filterType: FILTER_TEXT, value: query }],
    limit,
    { timeoutMs: SEARCH_TIMEOUT_MS, attempts: SEARCH_ATTEMPTS },
  )
  const total = extensions.length
  return {
    total,
    entries: extensions.map((extension) => {
      const version = pickMarketplaceVersion(extension.versions)
      return {
        publisher: extension.publisher?.publisherName ?? '',
        name: extension.extensionName ?? '',
        version: version?.version ?? '',
        displayName: extension.displayName ?? extension.extensionName ?? '',
        description: extension.shortDescription ?? '',
        iconUrl: marketplaceIconUrl(version) ?? null,
        downloadUrl: marketplaceVsixUrl(version) ?? null,
        signatureUrl: null,
        publicKeyUrl: null,
        manifestUrl: marketplaceManifestUrl(version) ?? null,
        publisherVerified: extension.publisher?.flags?.includes('verified') === true,
        deprecated: false,
        targetPlatform: version?.targetPlatform ?? null,
        downloads: marketplaceStatistic(extension, 'install'),
        rating: marketplaceStatistic(extension, 'averagerating'),
        ratingCount: marketplaceStatistic(extension, 'ratingcount'),
        lastUpdated: typeof extension.lastUpdated === 'string' ? extension.lastUpdated : undefined,
        source: 'marketplace',
      }
    }),
  }
}

/**
 * Look one extension up by its exact `publisher.name` identifier.
 * @param {string} publisher - the publisher id.
 * @param {string} name - the extension name.
 * @returns {Promise<object|undefined>} the catalog entry, when the extension exists.
 */
export async function lookupMarketplace(publisher, name, options = {}) {
  const extensions = await marketplaceQuery([{ filterType: FILTER_NAME, value: `${publisher}.${name}` }], 10, options)
  for (const extension of extensions) {
    if (extension.publisher?.publisherName !== publisher || extension.extensionName !== name) continue
    const version = pickMarketplaceVersion(extension.versions)
    return {
      publisher: extension.publisher.publisherName,
      name: extension.extensionName,
      version: version?.version ?? '',
      displayName: extension.displayName ?? extension.extensionName,
      description: extension.shortDescription ?? '',
      iconUrl: marketplaceIconUrl(version) ?? null,
      downloadUrl: marketplaceVsixUrl(version) ?? null,
      signatureUrl: null,
      publicKeyUrl: null,
      manifestUrl: marketplaceManifestUrl(version) ?? null,
      publisherVerified: extension.publisher?.flags?.includes('verified') === true,
      deprecated: false,
      targetPlatform: version?.targetPlatform ?? null,
      downloads: marketplaceStatistic(extension, 'install'),
      rating: marketplaceStatistic(extension, 'averagerating'),
      ratingCount: marketplaceStatistic(extension, 'ratingcount'),
      lastUpdated: typeof extension.lastUpdated === 'string' ? extension.lastUpdated : undefined,
      source: 'marketplace',
    }
  }
  return undefined
}

/**
 * Look one extension up on Open VSX.
 * @param {string} publisher - the namespace.
 * @param {string} name - the extension name.
 * @param {string} [version] - the version; the latest when omitted.
 * @param {object} [options] - the request policy.
 * @param {number} [options.timeoutMs] - the request timeout.
 * @param {number} [options.attempts] - how many times the request is tried.
 * @returns {Promise<object|undefined>} the catalog entry, when the extension exists.
 */
export async function lookupOpenVsx(publisher, name, version, options = {}) {
  const base = `${OPEN_VSX_EXTENSION}/${encodeURIComponent(publisher)}/${encodeURIComponent(name)}`
  const listing = await fetchJson(`${base}/${encodeURIComponent(version ?? 'latest')}`, options).catch(() => undefined)
  if (listing === undefined) return undefined
  return {
    publisher: listing.namespace ?? publisher,
    name: listing.name ?? name,
    version: listing.version ?? version ?? '',
    displayName: listing.displayName ?? name,
    description: listing.description ?? '',
    iconUrl: listing.files?.icon ?? null,
    downloadUrl: listing.files?.download ?? null,
    signatureUrl: listing.files?.signature ?? null,
    publicKeyUrl: listing.files?.publicKey ?? null,
    manifestUrl: listing.files?.manifest ?? null,
    publisherVerified: listing.verified === true,
    deprecated: listing.deprecated === true,
    targetPlatform: null,
    // The version endpoint publishes the download and review counters but no
    // average rating, so the rating stays undefined rather than invented.
    downloads: typeof listing.downloadCount === 'number' ? listing.downloadCount : undefined,
    rating: typeof listing.averageRating === 'number' ? listing.averageRating : undefined,
    ratingCount: typeof listing.reviewCount === 'number' ? listing.reviewCount : undefined,
    lastUpdated: typeof listing.timestamp === 'string' ? listing.timestamp : undefined,
    source: 'open-vsx',
  }
}

/**
 * The timeout a manifest inspection uses.
 *
 * The inspection answers a QUESTION ("what could DSH do with this?"), and the
 * registries serve their manifests from a CDN that a network may not reach at
 * all. The download path retries hard because a flaky CDN is worth waiting
 * for; the inspection does not, because a manifest that has not answered in
 * six seconds is not coming, and every second it waits is a second the LIST
 * waits with it.
 */
export const MANIFEST_INSPECT_TIMEOUT_MS = 6_000

/** How many times a manifest inspection is tried. */
export const MANIFEST_INSPECT_ATTEMPTS = 2

/**
 * Read one extension's manifest and decide what DSH can do with it.
 *
 * The manifest is the extension's own `package.json`; its `contributes` block
 * is the contract DSH classifies ([capabilities.js]).
 * @param {string|null} manifestUrl - the manifest asset URL.
 * @param {object} [options] - the request options.
 * @param {number} [options.timeoutMs] - the request timeout.
 * @param {number} [options.attempts] - how many times the request is tried.
 * @returns {Promise<object>} the capability verdict.
 */
export async function inspectManifest(manifestUrl, { timeoutMs = MANIFEST_INSPECT_TIMEOUT_MS, attempts = MANIFEST_INSPECT_ATTEMPTS } = {}) {
  if (manifestUrl === null || manifestUrl === undefined) {
    return {
      status: 'unknown',
      basis: 'no-manifest',
      detail: 'The catalog did not publish this extension manifest, so its DSH support is unknown.',
      contributes: [],
      supported: [],
      degraded: [],
      unsupported: [],
      entries: [],
      runtime: { verdict: 'unknown', usable: false, pendingTracks: [] },
      problems: [],
    }
  }
  let manifest
  try {
    manifest = await fetchJson(manifestUrl, { timeoutMs, attempts })
  } catch {
    return {
      status: 'unknown',
      basis: 'manifest-unreachable',
      detail: 'The extension manifest could not be read, so its DSH support is unknown.',
      contributes: [],
      supported: [],
      degraded: [],
      unsupported: [],
      entries: [],
      runtime: { verdict: 'unknown', usable: false, pendingTracks: [] },
      problems: [],
    }
  }
  const executesCode = typeof manifest?.main === 'string' || typeof manifest?.browser === 'string'
  const classification = classifyContributes(manifest?.contributes, { executesCode })
  const { contributes, supported, degraded, unsupported, entries, status, runtime, problems } = classification
  return {
    status,
    basis: 'manifest',
    detail: status === 'supported'
      ? 'Every contribution point this extension declares is supported by DSH.'
      : status === 'partial'
        ? 'DSH supports part of this extension; the degraded and unsupported parts are listed.'
        : status === 'code-only'
          ? 'This extension declares no contribution point: it only ships code, so it needs an extension host to run.'
          : 'DSH cannot run this extension: none of its contribution points are supported.',
    contributes,
    supported,
    degraded,
    unsupported,
    entries,
    runtime,
    problems,
    executesCode,
  }
}
