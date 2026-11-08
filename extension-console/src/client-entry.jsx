/**
 * Extension Console, browser half: the **Extensions** tab on the Plugins page.
 *
 * The tab shows only VS Code extensions: the installed VSIX records and the VS Code
 * registries. DSH bundles and built-in plugin rows belong to the Plugins page's own
 * Installed / Updates / Discover tabs and are deliberately not appended here.
 *
 * The facts come from the Host over one exact route, because a plugin cannot
 * add a typed Remote namespace of its own; the mutations go back the same
 * way.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { en, zh } from './locale.js';

/** Dictionary namespace owned by this plugin. */
const NS = 'extensionConsole';

/** Services the plugin reads. */
export const inject = ['slots', 'locale', 'remote'];

/** The exact route the Host half serves. */
const ROUTE = '/extensions-console';

/** The exact route the VSCode extension store serves, when that bundle is installed. */
const VSIX_ROUTE = '/vscode-extensions';

/** The exact route the extension host serves, when that bundle is installed. */
const HOST_ROUTE = '/vscode-extension-host';

/**
 * The absolute URL of the Host route.
 * @returns {string} the URL to fetch.
 */
function routeUrl() {
  const base = typeof document === 'undefined' ? undefined : document.baseURI;
  return new URL(ROUTE, base ?? 'http://127.0.0.1/').toString();
}

/**
 * The view's shared state: the snapshot, the selection, and the filter.
 */
const store = {
  listeners: new Set(),
  state: {
    /** `loading` before the first read, `ready` with a snapshot, `error` after a failed read. */
    status: 'loading',
    /** Whether the VS Code list has completed its first read. */
    initialized: false,
    /** The installed VSCode extensions, empty when that backend is absent. */
    vsix: [],
    /** The extension host's live state, or undefined when that bundle is absent. */
    host: undefined,
    /** `installed` lists what is here; `browse` searches the VSCode catalog. */
    mode: 'installed',
    /** The catalog answer: `idle`, `loading`, `ready`, `error`, or `absent`. */
    catalogStatus: 'idle',
    /** The catalog results, merged across the registries. */
    catalog: [],
    /** The raw results of each registry, keyed by registry name. */
    catalogBySource: {},
    /** What each searched registry answered. */
    catalogSources: [],
    /**
     * Which catalog to search: `both`, `open-vsx` or `marketplace`.
     *
     * The default is **both**: the page searches the two registries at the
     * same time and shows each answer as it arrives, so the list is never
     * held back by the slower one, and neither registry is quietly left out.
     * The choice is not remembered between visits — a page that opens on a
     * registry nobody picked is a page that searches somewhere surprising.
     */
    catalogSource: 'both',
    /** The extensions whose verdict is still being fetched. */
    catalogInspecting: [],
    /** The install progress per catalog entry. */
    installProgress: {},
    /** The unit id shown in the detail view, or null for the list. */
    selected: null,
    /** The list filter text. */
    query: '',
    /** The last failure message. */
    message: '',
    /** The action in flight, as a unit id, or null. */
    busy: null,
  },
  /**
   * Replace part of the state and tell the listeners.
   * @param {object} patch - the fields to replace.
   */
  set: (patch) => {
    store.state = { ...store.state, ...patch };
    for (const listener of store.listeners) listener();
  },
  /**
   * Subscribe to state changes.
   * @param {() => void} listener - the change listener.
   * @returns {() => void} the disposer.
   */
  subscribe: (listener) => {
    store.listeners.add(listener);
    return () => { store.listeners.delete(listener); };
  },
  /** @returns {object} the current state. */
  snapshot: () => store.state,
};

/**
 * Read the shared state.
 * @returns {object} the current state.
 */
function useStore() {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

/**
 * Read the Host's snapshot.
 * @returns {Promise<object>} the snapshot.
 */
async function readSnapshot() {
  const response = await fetch(routeUrl(), { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`the Host answered ${response.status}`);
  return response.json();
}

/**
 * Send one mutation to the Host.
 * @param {object} payload - the action to run.
 * @returns {Promise<object>} the Host's answer.
 */
async function sendAction(payload) {
  const response = await fetch(routeUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) {
    throw new Error(body.error ?? `the Host answered ${response.status}`);
  }
  return body;
}

/**
 * The URL of the VSCode extension store's route.
 * @returns {string} the URL.
 */
function vsixUrl() {
  const base = typeof document === 'undefined' ? undefined : document.baseURI;
  return new URL(VSIX_ROUTE, base ?? 'http://127.0.0.1/').toString();
}

/**
 * Send one action to the VSCode extension store.
 * @param {object} payload - the action to run.
 * @returns {Promise<object>} the store's answer.
 */
async function vsixAction(payload) {
  const response = await fetch(vsixUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (response.status === 404) throw new VsixAbsentError()
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    // An unmatched path may be answered by the SPA fallback with a page; that
    // means the store's route is not registered here.
    throw new VsixAbsentError()
  }
  if (!response.ok || body.ok !== true) {
    throw new Error(body.error ?? `the Host answered ${response.status}`);
  }
  return body;
}

/**
 * The VSCode extension store is not installed in this profile.
 */
class VsixAbsentError extends Error {
  constructor() {
    super('the VSCode extension store is not installed')
    this.name = 'VsixAbsentError'
  }
}

/**
 * Send one action to a backend route and read its answer.
 * @param {string} path - the route path.
 * @param {object} payload - the action to run.
 * @returns {Promise<object>} the answer.
 */
async function routeAction(path, payload) {
  const base = typeof document === 'undefined' ? undefined : document.baseURI;
  const response = await fetch(new URL(path, base ?? 'http://127.0.0.1/').toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (response.status === 404) throw new VsixAbsentError()
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new VsixAbsentError()
  }
  if (!response.ok || body.ok !== true) {
    throw new Error(body.error ?? `the Host answered ${response.status}`);
  }
  return body;
}

/**
 * Read the extension host's live state.
 * @returns {Promise<object|undefined>} the status, or undefined when the host bundle is absent.
 */
async function readHostStatus() {
  try {
    const body = await routeAction(HOST_ROUTE, { action: 'status' })
    return body
  } catch (error) {
    if (error instanceof VsixAbsentError) return undefined
    throw error
  }
}

/**
 * Read the installed VSCode extensions.
 * @returns {Promise<Array<object>>} the records; empty when the store is absent.
 */
async function readVsix() {
  try {
    const body = await vsixAction({ action: 'list' })
    return Array.isArray(body.extensions) ? body.extensions : []
  } catch (error) {
    if (error instanceof VsixAbsentError) return []
    throw error
  }
}

/**
 * Map the extension host's live state onto the installed extensions.
 * @param {object|undefined} status - the host's status answer.
 * @returns {Map<string, object>} the loaded state per extension id.
 */
function hostStates(status) {
  const states = new Map()
  for (const entry of status?.extensions ?? []) states.set(entry.id, entry)
  return states
}

/**
 * The Extensions tab's installed list is VS Code-only.
 *
 * DSH bundles already have the Plugins page's own Installed / Updates / Discover tabs. They
 * must not be appended here: this tab's two views are the VSIX installed list and the VS Code
 * registries. Keep this projection independent of the DSH snapshot so the two systems cannot
 * be mixed back together accidentally.
 *
 * @param {object} state - the view state, including VSIX records and the extension host status.
 * @returns {Array<object>} the VS Code extension units.
 */
export function installedUnits(state) {
  const states = hostStates(state.host)
  return (state.vsix ?? []).map((record) => vsixUnit(record, states.get(record.id)))
}

/**
 * The tab body.
 * @param {object} props - the slot props.
 * @returns {JSX.Element} the rendered tab.
 */
function ExtensionsSection(props) {
  const { t, resolveText } = props
  const state = useStore()
  const units = useMemo(() => installedUnits(state), [state.vsix, state.host])
  const selected = units.find((unit) => unit.id === state.selected)
  const titleOf = useCallback((unit) => textOf(resolveText, unit.title, unit.name), [resolveText])

  const refresh = useCallback(async () => {
    store.set({ status: 'loading', message: '' })
    try {
      // This tab is independent of the DSH bundle graph: its installed list and its catalog
      // both come from VS Code backends only.
      const [vsix, host] = await Promise.all([readVsix(), readHostStatus()])
      store.set({ status: 'ready', initialized: true, vsix, host, message: '' })
    } catch (error) {
      store.set({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (state.status === 'loading' && !state.initialized) {
    return (
      <>
        <style>{STYLES}</style>
        <div className="ec-loading">{t('loading')}</div>
      </>
    )
  }
  if (state.status === 'error' && !state.initialized) {
    return (
      <>
        <style>{STYLES}</style>
        <div className="ec-failure">
          <p className="ec-error" role="alert">{t('loadFailed', { message: state.message })}</p>
          <button type="button" className="ec-button" onClick={() => { void refresh() }}>{t('retry')}</button>
        </div>
      </>
    )
  }
  if (selected !== undefined) {
    return (
      <>
        <style>{STYLES}</style>
        {state.status === 'error' && (
          <p className="ec-notice" role="alert">{t('loadFailed', { message: state.message })}</p>
        )}
        <ExtensionDetail unit={selected} t={t} state={state} refresh={refresh} titleOf={titleOf} resolveText={resolveText} />
      </>
    )
  }
  return (
    <>
      <style>{STYLES}</style>
      {state.status === 'error' && (
        <p className="ec-notice" role="alert">{t('loadFailed', { message: state.message })}</p>
      )}
      {state.host !== undefined && state.host.host !== undefined && (
        <HostNotice host={state.host.host} t={t} />
      )}
      <div className="ec-modes" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={state.mode === 'installed'}
          className={`ec-mode${state.mode === 'installed' ? ' ec-mode-on' : ''}`}
          onClick={() => { store.set({ mode: 'installed' }) }}
        >
          {t('modeInstalled')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={state.mode === 'browse'}
          className={`ec-mode${state.mode === 'browse' ? ' ec-mode-on' : ''}`}
          onClick={() => { store.set({ mode: 'browse' }) }}
        >
          {t('modeBrowse')}
        </button>
      </div>
      {state.mode === 'browse' ? (
        <BrowseSection t={t} state={state} />
      ) : (
        <ExtensionList units={units} t={t} state={state} refresh={refresh} titleOf={titleOf} resolveText={resolveText} />
      )}
    </>
  )
}

/**
 * Resolve a localized text value to a display string.
 * @param {Function} resolveText - the locale service's text resolver.
 * @param {unknown} value - the localized text, a literal string, or a map.
 * @param {string} fallback - the text to use when nothing resolves.
 * @returns {string} the display text.
 */
function textOf(resolveText, value, fallback) {
  if (value === undefined || value === null) return fallback
  let resolved
  try {
    resolved = resolveText(value)
  } catch {
    resolved = undefined
  }
  if (typeof resolved === 'string' && resolved !== '') return resolved
  if (typeof value === 'string' && value !== '') return value
  return fallback
}

/**
 * Map one installed VSCode extension onto this view's unit shape.
 *
 * The record comes from the VSCode extension store, which owns that backend's
 * facts; the shape here is the contract both backends share. The host state
 * says whether the extension host actually loaded it.
 * @param {object} record - the store's extension record.
 * @param {object|undefined} host - the extension host's state for it.
 * @returns {object} the unit.
 */
function vsixUnit(record, host) {
  return {
    id: record.id,
    backend: 'vsix',
    kind: 'vsix',
    name: record.name,
    title: record.displayName ?? record.name,
    description: record.description ?? '',
    icon: record.icon ?? null,
    version: record.version,
    enabled: record.enabled === true,
    installed: true,
    official: false,
    optional: false,
    removable: record.removable !== false,
    source: record.source,
    trusted: record.trusted === true,
    publisher: record.publisher,
    contributes: record.contributes ?? [],
    supported: record.supported ?? [],
    degraded: record.degraded ?? [],
    unsupported: record.unsupported ?? [],
    problems: record.problems ?? [],
    loaded: host?.active === true,
    loadError: host?.error,
    rows: [],
    dependencies: [],
    dependents: [],
  }
}

/**
 * The extension host's state, shown above the list.
 * @param {object} props - the component props.
 * @returns {JSX.Element} the rendered notice.
 */
function HostNotice({ host, t }) {
  if (host.running === true) {
    return (
      <p className="ec-meta">
        {t('hostRunning', { count: host.restarts ?? 0 })}
      </p>
    )
  }
  return (
    <p className="ec-notice" role="alert">
      {host.lastError !== undefined
        ? t('hostFailed', { message: host.lastError })
        : t('hostStopped', { reason: host.reason ?? '' })}
    </p>
  )
}

/**
 * Read one catalog entry's capability, whether the store reported it as a
 * nested object or as flat fields.
 * @param {object} entry - the catalog entry.
 * @returns {object} the capability: status, supported, degraded, unsupported.
 */
function capabilityOf(entry) {
  const capability = entry?.capability ?? entry ?? {}
  return {
    status: capability.status,
    basis: capability.basis ?? 'not-inspected',
    supported: capability.supported ?? [],
    degraded: capability.degraded ?? [],
    unsupported: capability.unsupported ?? [],
    runtime: capability.runtime ?? { verdict: 'unknown', usable: null, pendingTracks: [] },
  }
}

/**
 * Format an install count the way the VS Code extension list does.
 *
 * The rule is VS Code's own (`extensionsWidgets.ts`, `getInstallLabel`):
 * more than a million becomes `1.2M`, more than a thousand becomes `176K`,
 * and both truncate rather than round — so 176,674 reads as `176K`, exactly
 * as the marketplace list shows it.
 * @param {number} count - the install count.
 * @returns {string} the abbreviated count.
 */
function formatInstallCount(count) {
  if (count > 1000000) return `${Math.floor(count / 100000) / 10}M`
  if (count > 1000) return `${Math.floor(count / 1000)}K`
  return String(count)
}

/**
 * Format a rating the way the VS Code extension list does.
 *
 * VS Code rounds a rating to the nearest half star
 * (`extensionsWidgets.ts`, `RatingsWidget.render`).
 * @param {number} rating - the rating, from 0 to 5.
 * @returns {string} the formatted rating.
 */
function formatRating(rating) {
  return String(Math.round(rating * 2) / 2)
}

/**
 * The market metrics of one catalog entry: the install count and the rating.
 *
 * A rating without any rating is not shown at all, and neither is an absent
 * number — the list never shows a zero it does not have.
 * @param {object} props - the component props.
 * @returns {JSX.Element} the rendered metrics.
 */
function MarketMetrics({ entry, t }) {
  const downloads = typeof entry.downloads === 'number' ? entry.downloads : undefined;
  const rating = typeof entry.rating === 'number' ? entry.rating : undefined;
  const ratingCount = typeof entry.ratingCount === 'number' ? entry.ratingCount : undefined;
  return (
    <>
      {downloads !== undefined && (
        <span className="ec-metric" title={t('browseDownloads', { count: downloads })}>
          <CloudGlyph />
          <span>{formatInstallCount(downloads)}</span>
        </span>
      )}
      {rating !== undefined && ratingCount !== undefined && ratingCount > 0 && (
        <span className="ec-metric" title={t('browseRating', { rating: formatRating(rating), count: ratingCount })}>
          <StarGlyph />
          <span>{formatRating(rating)}</span>
        </span>
      )}
    </>
  );
}

/**
 * The cloud glyph the marketplace puts in front of the install count.
 * @returns {JSX.Element} the rendered glyph.
 */
function CloudGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4.4 12.6h6.9a2.7 2.7 0 0 0 .35-5.37 4 4 0 0 0-7.72-1.06A2.9 2.9 0 0 0 4.4 12.6Z" />
    </svg>
  );
}

/**
 * The full star the marketplace puts in front of a rating.
 * @returns {JSX.Element} the rendered glyph.
 */
function StarGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 1.4l1.94 3.92 4.33.63-3.13 3.05.74 4.31L8 11.24l-3.88 2.04.74-4.31L1.73 5.95l4.33-.63L8 1.4Z" />
    </svg>
  );
}

/**
 * The gear the marketplace shows instead of an install button.
 * @returns {JSX.Element} the rendered glyph.
 */
function GearGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="8" cy="8" r="5" />
      <path d="M8 1.2v1.8M8 13v1.8M1.2 8h1.8M13 8h1.8M3.2 3.2l1.3 1.3M11.5 11.5l1.3 1.3M12.8 3.2l-1.3 1.3M4.5 11.5l-1.3 1.3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The seal a verified publisher carries.
 * @returns {JSX.Element} the rendered glyph.
 */
function VerifiedGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <path d="M8 1.5l1.5 1.05 1.78-.2.58 1.72 1.5.98-.4 1.72.92 1.5-1.1 1.36.1 1.8-1.72.57-1 1.5-1.72-.4-1.5.9-1.36-1.1-1.8.1-.57-1.72-1.5-1 .4-1.72-.92-1.5L2.2 7.46l-.1-1.8 1.72-.57 1-1.5 1.72.4L8 1.5Z" strokeLinejoin="round" />
      <path d="M5.4 8.1l1.8 1.8 3.4-3.6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The list of extensions.
 * @param {object} props - the component props.
 * @returns {JSX.Element} the rendered list.
 */
function ExtensionList({ units, t, state, refresh, titleOf, resolveText }) {
  const query = state.query.trim().toLowerCase()
  const visible = useMemo(() => {
    if (query === '') return units
    return units.filter((unit) =>
      `${titleOf(unit)} ${unit.name}`.toLowerCase().includes(query))
  }, [units, query, titleOf])

  return (
    <div className="ec-section">
      <div className="ec-toolbar">
        <input
          className="ec-search"
          type="search"
          value={state.query}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchPlaceholder')}
          onChange={(event) => { store.set({ query: event.target.value }) }}
        />
        <button type="button" className="ec-button" onClick={() => { void refresh() }}>{t('refresh')}</button>
      </div>
      {visible.length === 0 ? (
        <p className="ec-empty">{t('empty')}</p>
      ) : (
        <ul className="ec-cards">
          {visible.map((unit) => (
            <ExtensionCard key={unit.id} unit={unit} t={t} state={state} refresh={refresh} titleOf={titleOf} resolveText={resolveText} />
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * How many manifests are inspected at the same time.
 *
 * The inspection is one HTTP request per extension, and the registry answers
 * it in a moment — but a registry whose file CDN cannot be reached answers
 * with a TIMEOUT, so the number has to stay small enough that a page of
 * unreachable manifests does not become a page of minutes.
 */
const INSPECT_CONCURRENCY = 4

/**
 * The generation of the newest search.
 *
 * A search that is already on the way may not write into the store once a
 * newer search started: otherwise the slower answer of the old query would
 * overwrite the newer one.
 */
let searchGeneration = 0

/**
 * Wait for a while.
 * @param {number} ms - the milliseconds to wait.
 * @returns {Promise<void>} after the wait.
 */
function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * The key that identifies one catalog entry for the verdict inspection.
 * @param {object} entry - the catalog entry.
 * @param {string} [source] - the registry the entry came from.
 * @returns {string} the key.
 */
function inspectKey(entry, source) {
  return `${source ?? entry.source}:${entry.id}@${entry.version}`
}

/**
 * Merge the per-registry results into one list.
 *
 * The two registries publish the same extensions, so a search that asks both
 * answers with the same extension twice. One entry has to survive: the one
 * from the registry whose package DSH can **verify** — Open VSX publishes an
 * Ed25519 signature over the whole `.vsix`, the Marketplace publishes none —
 * because that is the one the install will use.
 *
 * The numbers come from the Marketplace when both registries published the
 * same version, because the Marketplace's install counter is the one VS Code
 * shows next to the cloud icon.
 *
 * @param {Record<string, Array<object>>} bySource - the raw results per registry.
 * @returns {Array<object>} the merged list.
 */
function mergeCatalog(bySource) {
  const groups = new Map()
  for (const entries of Object.values(bySource ?? {})) {
    for (const entry of entries) {
      const id = `${entry.publisher}.${entry.name}`
      let group = groups.get(id)
      if (group === undefined) {
        group = []
        groups.set(id, group)
      }
      group.push(entry)
    }
  }
  const merged = []
  for (const group of groups.values()) {
    const representative = group.find((entry) => entry.source === 'open-vsx') ?? group[0]
    const other = group.find((entry) => entry !== representative)
    const sameVersion = other !== undefined && other.version === representative.version
    merged.push({
      ...representative,
      key: `${representative.publisher}.${representative.name}@${representative.version}`,
      downloads: sameVersion ? (other.downloads ?? representative.downloads) : representative.downloads,
      rating: sameVersion ? (other.rating ?? representative.rating) : representative.rating,
      ratingCount: sameVersion ? (other.ratingCount ?? representative.ratingCount) : representative.ratingCount,
    })
  }
  return merged
}

/**
 * Merge the reports of the registries into one list, one report per registry.
 * @param {Array<object>} current - the reports so far.
 * @param {Array<object>} incoming - the reports just read.
 * @returns {Array<object>} the merged reports.
 */
function mergeSourceReports(current, incoming) {
  const bySource = new Map(current.map((report) => [report.source, report]))
  for (const report of incoming) bySource.set(report.source, report)
  return [...bySource.values()]
}

/**
 * Search one registry and put its answer on screen.
 *
 * The registries are asked at the same time, and each one is shown as soon as
 * it answers: a registry that needs three seconds must not hold back the one
 * that needed one.
 *
 * @param {string} source - the registry to search.
 * @param {string} text - the query.
 * @param {number} generation - the search generation this answer belongs to.
 * @returns {Promise<void>} after the answer is on screen.
 */
async function searchRegistry(source, text, generation) {
  try {
    // WITHOUT the manifest inspection: the registry answers its search in a
    // second, while a manifest on a CDN this network cannot reach costs a
    // timeout PER RESULT. The list is the answer the person is waiting for;
    // the verdicts follow it.
    const body = await vsixAction({
      action: 'catalog',
      query: text,
      source,
      inspect: false,
    })
    if (generation !== searchGeneration) return
    const results = body.results ?? []
    const bySource = { ...store.state.catalogBySource, [source]: results }
    store.set({
      catalogStatus: 'ready',
      catalogBySource: bySource,
      catalog: mergeCatalog(bySource),
      catalogSources: mergeSourceReports(store.state.catalogSources, body.sources ?? []),
      catalogInspecting: [
        ...store.state.catalogInspecting,
        ...results.map((entry) => inspectKey(entry, source)),
      ],
    })
    void inspectResults(results, source)
  } catch (error) {
    if (generation !== searchGeneration) return
    if (error instanceof VsixAbsentError) {
      store.set({ catalogStatus: 'absent', catalog: [], catalogBySource: {}, catalogSources: [], message: '' })
      return
    }
    // One registry failing is not a failed search: the other one still has
    // answers, and the report says which one did not answer.
    store.set({
      catalogSources: mergeSourceReports(store.state.catalogSources, [{
        source,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }]),
    })
  }
}

/**
 * Fetch the verdict of every result, one extension at a time.
 *
 * The list is already on screen; this fills in what DSH can do with each
 * extension, as the answers arrive. A result whose manifest cannot be read
 * keeps the verdict the Host already gave it.
 *
 * @param {Array<object>} results - the catalog results.
 * @param {string} source - the registry the results came from.
 * @returns {Promise<void>} after the last verdict is in.
 */
async function inspectResults(results, source) {
  const queue = [...results]
  const worker = async () => {
    for (;;) {
      const entry = queue.shift();
      if (entry === undefined) return;
      const key = inspectKey(entry, source)
      try {
        const body = await vsixAction({
          action: 'inspect',
          publisher: entry.publisher,
          name: entry.name,
          version: entry.version,
          source: entry.source ?? source,
          // The search already published the manifest URL: handing it over saves
          // the Host a second lookup per extension.
          manifestUrl: entry.manifestUrl ?? undefined,
        });
        if (body.capability !== undefined) {
          const bySource = store.state.catalogBySource ?? {}
          const entries = bySource[source]
          if (entries !== undefined) {
            const next = entries.map((current) => (
              current.id === entry.id && current.version === entry.version
                ? { ...current, capability: body.capability }
                : current
            ))
            const merged = { ...bySource, [source]: next }
            store.set({ catalogBySource: merged, catalog: mergeCatalog(merged) })
          }
        }
      } catch {
        // A failed inspection is not a failed search: the entry keeps the
        // verdict the Host already gave it.
      } finally {
        store.set({ catalogInspecting: store.state.catalogInspecting.filter((id) => id !== key) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(INSPECT_CONCURRENCY, queue.length) }, worker));
}

/**
 * The catalog view: search the VSCode extension registries.
 *
 * The search runs against the VSCode extension store's route; when that
 * bundle is not installed the view says so instead of failing.
 *
 * Both registries are asked at the same time and each answer is shown as soon
 * as it arrives, and the list that is already on screen stays on screen while
 * the next one is on the way — so the results are there sooner, and never
 * vanish while they are being replaced.
 * @param {object} props - the component props.
 * @returns {JSX.Element} the rendered catalog.
 */
function BrowseSection({ t, state }) {
  const [query, setQuery] = useState('')
  const timer = useRef(null)
  const inspecting = useMemo(() => new Set(state.catalogInspecting ?? []), [state.catalogInspecting]);

  const search = useCallback(async (text) => {
    const needle = String(text ?? '').trim()
    if (needle === '') return
    const sources = state.catalogSource === 'both' ? ['open-vsx', 'marketplace'] : [state.catalogSource]
    const generation = searchGeneration + 1
    searchGeneration = generation
    // The results that are already on screen STAY on screen: the person keeps
    // reading them while the next ones are on the way.
    store.set({
      catalogStatus: 'loading',
      message: '',
      catalogBySource: {},
      catalogSources: [],
      catalogInspecting: [],
    })
    await Promise.all(sources.map((source) => searchRegistry(source, needle, generation)))
    if (generation !== searchGeneration) return
    const reports = store.state.catalogSources
    const everySourceFailed = reports.length > 0 && reports.every((report) => report.ok !== true)
    if (everySourceFailed) {
      store.set({ catalogStatus: 'error', message: reports[0]?.error ?? '' })
      return
    }
    store.set({ catalogStatus: 'ready' })
  }, [state.catalogSource])

  // The search runs while the person types: waiting for Enter is waiting for
  // a second keystroke that does not have to happen.
  useEffect(() => {
    const needle = query.trim()
    if (needle === '') return undefined
    const handle = setTimeout(() => { void search(needle) }, 300)
    timer.current = handle
    return () => { clearTimeout(handle) }
  }, [query, search])

  const searchNow = useCallback((text) => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    void search(text)
  }, [search])

  const install = useCallback(async (entry) => {
    const key = entry.key ?? `${entry.publisher}.${entry.name}@${entry.version}`
    store.set({
      installProgress: { ...store.state.installProgress, [key]: { state: 'running', stage: 'resolve' } },
    })
    try {
      // The install runs in the background and reports its stage, so the card
      // can say what is happening instead of showing a spinner for a minute.
      const started = await vsixAction({
        action: 'installStart',
        publisher: entry.publisher,
        name: entry.name,
        version: entry.version,
        source: entry.source,
        trust: true,
      })
      const jobId = started.job?.id
      if (typeof jobId !== 'string') throw new Error('the store did not start the install')
      for (;;) {
        const body = await vsixAction({ action: 'installStatus', jobId })
        const job = body.job ?? {}
        if (job.state === 'done') break
        if (job.state === 'failed') throw new Error(job.error ?? 'the install failed')
        store.set({
          installProgress: {
            ...store.state.installProgress,
            [key]: { state: 'running', stage: job.stage ?? 'resolve' },
          },
        })
        await delay(250)
      }
      const body = await readVsix()
      const bySource = { ...store.state.catalogBySource }
      for (const [source, entries] of Object.entries(bySource)) {
        bySource[source] = entries.map((current) => (
          current.id === `${entry.publisher}.${entry.name}` ? { ...current, installed: true } : current
        ))
      }
      store.set({
        vsix: body,
        catalogBySource: bySource,
        catalog: mergeCatalog(bySource),
        installProgress: { ...store.state.installProgress, [key]: { state: 'done' } },
      })
    } catch (error) {
      store.set({
        installProgress: {
          ...store.state.installProgress,
          [key]: {
            state: 'failed',
            error: error instanceof Error ? error.message : String(error),
          },
        },
      })
    }
  }, [])

  const catalog = state.catalog ?? []
  const searching = state.catalogStatus === 'loading'
  return (
    <div className="ec-section">
      <div className="ec-toolbar">
        <input
          className="ec-search"
          type="search"
          value={query}
          placeholder={t('browsePlaceholder')}
          aria-label={t('browsePlaceholder')}
          onChange={(event) => { setQuery(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Enter') { searchNow(query) } }}
        />
        <select
          className="ec-select"
          value={state.catalogSource}
          aria-label={t('browseSource')}
          onChange={(event) => { store.set({ catalogSource: event.target.value }) }}
        >
          <option value="both">{t('browseSourceBoth')}</option>
          <option value="open-vsx">{t('browseSourceOpenVsx')}</option>
          <option value="marketplace">{t('browseSourceMarketplace')}</option>
        </select>
        <button type="button" className="ec-button" onClick={() => { searchNow(query) }}>{t('browseSearch')}</button>
      </div>
      <div className="ec-toolbar">
        {searching ? (
          <span className="ec-meta" role="status">
            <span className="ec-spinner" aria-hidden="true" />
            <span>{t('browseSearching')}</span>
          </span>
        ) : (
          <span className="ec-meta">{t('browseResultCount', { count: catalog.length })}</span>
        )}
      </div>
      {state.catalogSources.length > 0 && (
        <p className="ec-meta">
          {state.catalogSources.map((source) => (
            source.ok === true
              ? t('browseSourceOk', { source: source.source, total: source.total })
              : t('browseSourceFailed', { source: source.source, error: source.error ?? '' })
          )).join(' · ')}
        </p>
      )}
      {state.catalogSources
        .filter((source) => typeof source.manifestsUnreadable === 'number' && source.manifestsUnreadable > 0)
        .map((source) => (
          <p key={source.source} className="ec-warning">
            {t('browseManifestsUnreadable', { source: source.source, count: source.manifestsUnreadable })}
          </p>
        ))}
      {state.message !== '' && (
        <p className="ec-error" role="alert">{t('loadFailed', { message: state.message })}</p>
      )}
      {state.catalogStatus === 'idle' && <p className="ec-empty">{t('browseIdle')}</p>}
      {state.catalogStatus === 'absent' && <p className="ec-empty">{t('browseAbsent')}</p>}
      {state.catalogStatus === 'error' && (
        <div className="ec-failure">
          <p className="ec-error" role="alert">{t('loadFailed', { message: state.message })}</p>
          <button type="button" className="ec-button" onClick={() => { searchNow(query) }}>{t('retry')}</button>
        </div>
      )}
      {searching && catalog.length === 0 && (
        <ul className="ec-cards" aria-hidden="true">
          {Array.from({ length: 6 }, (_, index) => (
            <li key={index} className="ec-card ec-skeleton" />
          ))}
        </ul>
      )}
      {catalog.length > 0 && (
        <ul className="ec-cards">
          {catalog.map((entry) => (
            <MarketCard
              key={entry.key}
              entry={entry}
              t={t}
              progress={state.installProgress?.[entry.key]}
              inspecting={inspecting.has(inspectKey(entry, entry.source))}
              onInstall={() => { void install(entry) }}
              onConfirm={() => {
                store.set({
                  installProgress: {
                    ...store.state.installProgress,
                    [entry.key]: { state: 'confirm' },
                  },
                })
              }}
              onCancel={() => {
                const progress = { ...store.state.installProgress }
                delete progress[entry.key]
                store.set({ installProgress: progress })
              }}
            />
          ))}
        </ul>
      )}
      {state.catalogStatus === 'ready' && catalog.length === 0 && (
        <p className="ec-empty">{t('browseEmpty')}</p>
      )}
    </div>
  )
}

/**
 * The artwork one entry shows.
 *
 * A registry publishes the icon of an extension as a URL on its own file
 * host, and that host does not exist for every publisher — the Marketplace
 * serves `<publisher>.gallerycdn.vsassets.io`, and a publisher without a
 * marketplace presence has no such name. A picture that cannot be loaded
 * shows the drawing it failed to load, so the fallback glyph takes its place.
 * @param {object} props - the component props.
 * @returns {JSX.Element} the rendered artwork.
 */
function CatalogIcon({ entry }) {
  const [failed, setFailed] = useState(false)
  if (entry.icon === null || entry.icon === undefined || entry.icon === '' || failed) {
    return <FallbackGlyph />
  }
  return (
    <img
      className="ec-image"
      src={entry.icon}
      alt=""
      onError={() => { setFailed(true) }}
    />
  )
}

/**
 * One extension of the catalog, with its install button.
 *
 * The button is always clickable: pressing it turns the card into the
 * question "this runs third-party code on this machine — still?", and the
 * answer is what starts the install. A button that is silently disabled
 * because a checkbox somewhere above was not ticked is a button that looks
 * broken.
 *
 * @param {object} props - the component props.
 * @returns {JSX.Element} the rendered card.
 */
function MarketCard({ entry, t, progress, inspecting, onInstall, onConfirm, onCancel }) {
  const stage = progress?.state === 'running' ? t(`installStage.${progress.stage ?? 'resolve'}`) : ''
  return (
    <li className="ec-card ec-market">
      <span className="ec-icon" aria-hidden="true">
        <CatalogIcon entry={entry} />
      </span>
      <span className="ec-main">
        <span className="ec-title-row">
          <span className="ec-title">{entry.displayName ?? entry.name}</span>
          <MarketMetrics entry={entry} t={t} />
        </span>
        {entry.description !== undefined && entry.description !== '' && (
          <span className="ec-description ec-ellipsis">{entry.description}</span>
        )}
        <span className="ec-sub-row">
          <span className="ec-publisher">
            <span className="ec-publisher-name">{entry.publisher}</span>
            {entry.publisherVerified === true && (
              <span className="ec-verified" title={t('browseVerified')}>
                <VerifiedGlyph />
              </span>
            )}
          </span>
          {inspecting ? (
            <span className="ec-meta">{t('browseInspecting')}</span>
          ) : (
            <>
              {capabilityOf(entry).status !== undefined && (
                <span className="ec-tag">{t(`capability.${capabilityOf(entry).status}`)}</span>
              )}
              {capabilityOf(entry).supported.length > 0 && (
                <span className="ec-meta">{t('browseSupported', { list: capabilityOf(entry).supported.join(', ') })}</span>
              )}
              {capabilityOf(entry).degraded.length > 0 && (
                <span className="ec-meta">{t('browseDegraded', { list: capabilityOf(entry).degraded.join(', ') })}</span>
              )}
              {capabilityOf(entry).unsupported.length > 0 && (
                <span className="ec-meta">{t('browseUnsupported', { list: capabilityOf(entry).unsupported.join(', ') })}</span>
              )}
              {capabilityOf(entry).runtime.verdict === 'none' && (
                <span className="ec-warning">{t('runtime.none')}</span>
              )}
              {capabilityOf(entry).runtime.verdict === 'code-only' && (
                <span className="ec-warning">{t('runtime.code-only')}</span>
              )}
              {capabilityOf(entry).basis === 'manifest-unreachable' && (
                <span className="ec-meta">{t('runtime.unknown')}</span>
              )}
            </>
          )}
          <span className="ec-tag">{entry.source === 'marketplace' ? t('browseSourceMarketplace') : t('browseSourceOpenVsx')}</span>
          <span className="ec-version">{entry.version}</span>
        </span>
        {progress?.state === 'failed' && (
          <span className="ec-error" role="alert">{t('browseInstallFailed', { message: progress.error ?? '' })}</span>
        )}
        {progress?.state === 'confirm' && (
          <span className="ec-warning">{t('browseInstallTrust', { publisher: entry.publisher })}</span>
        )}
        {stage !== '' && (
          <span className="ec-meta" role="status">
            <span className="ec-spinner" aria-hidden="true" />
            <span>{stage}</span>
          </span>
        )}
      </span>
      {entry.installed === true || progress?.state === 'done' ? (
        <span className="ec-installed" title={t('browseInstalled')}>
          <GearGlyph />
          <span>{t('browseInstalled')}</span>
        </span>
      ) : progress?.state === 'running' ? (
        <span className="ec-installing" role="status">
          <span className="ec-spinner" aria-hidden="true" />
          <span>{t('browseInstalling')}</span>
        </span>
      ) : progress?.state === 'confirm' ? (
        <span className="ec-confirm">
          <button type="button" className="ec-button" onClick={() => { onInstall() }}>
            {t('browseInstallTrustYes')}
          </button>
          <button type="button" className="ec-button" onClick={() => { onCancel() }}>
            {t('cancel')}
          </button>
        </span>
      ) : (
        <button type="button" className="ec-button" onClick={() => { onConfirm() }}>
          {t('browseInstall')}
        </button>
      )}
    </li>
  )
}

/**
 * One extension in the list.
 * @param {object} props - the component props.
 * @returns {JSX.Element} the rendered card.
 */
function ExtensionCard({ unit, t, state, refresh, titleOf, resolveText }) {
  const busy = state.busy === unit.id
  const failed = unit.problems.some((problem) => problem.severity === 'error')
  const title = titleOf(unit)
  const description = textOf(resolveText, unit.description, '')
  return (
    <li className="ec-card">
      <button
        type="button"
        className="ec-card-open"
        onClick={() => { store.set({ selected: unit.id }) }}
      >
        <span className="ec-icon" aria-hidden="true">
          <CatalogIcon entry={unit} />
        </span>
        <span className="ec-main">
          <span className="ec-title-row">
            <span className="ec-title">{title}</span>
            {unit.version !== undefined && <span className="ec-version">{unit.version}</span>}
            {unit.official && <span className="ec-tag">{t('tagOfficial')}</span>}
            {unit.optional && <span className="ec-tag">{t('tagOptional')}</span>}
          </span>
          {description !== '' && <span className="ec-description">{description}</span>}
          <span className="ec-meta">
            {unit.enabled ? t('stateEnabled') : t('stateDisabled')}
            {unit.loaded === true && <span className="ec-loaded">{t('stateLoaded')}</span>}
            {unit.loadError !== undefined && (
              <span className="ec-error-inline">{t('stateLoadFailed', { message: unit.loadError })}</span>
            )}
            {failed && <span className="ec-error-inline">{t('stateFailed')}</span>}
          </span>
        </span>
      </button>
      <ExtensionSwitch unit={unit} t={t} busy={busy} refresh={refresh} title={title} />
    </li>
  )
}

/**
 * The switch that enables or disables one extension.
 * @param {object} props - the component props.
 * @returns {JSX.Element} the rendered switch.
 */
function ExtensionSwitch({ unit, t, busy, refresh, title }) {
  const disabled = busy || unit.readOnlyReason !== undefined
  const label = unit.enabled ? t('actionDisable') : t('actionEnable')
  return (
    <button
      type="button"
      role="switch"
      aria-checked={unit.enabled}
      aria-label={`${label} — ${title ?? unit.name}`}
      className={`ec-switch${unit.enabled ? ' ec-switch-on' : ''}`}
      disabled={disabled}
      onClick={async () => {
        store.set({ busy: unit.id })
        try {
          if (unit.backend === 'vsix') {
            await vsixAction({ action: 'enable', id: unit.id, enabled: !unit.enabled })
          } else {
            await sendAction({ action: 'enable', id: unit.id, enabled: !unit.enabled })
          }
        } catch (error) {
          store.set({ message: error instanceof Error ? error.message : String(error) })
        } finally {
          store.set({ busy: null })
          void refresh()
        }
      }}
    >
      <span className="ec-switch-knob" />
    </button>
  )
}

/**
 * Run one action against the backend that owns the unit.
 * @param {object} unit - the unit.
 * @param {object} payload - the action.
 * @returns {Promise<object>} the backend's answer.
 */
async function unitAction(unit, payload) {
  if (unit.backend !== 'vsix') return sendAction(payload)
  if (payload.action === 'enable') {
    return vsixAction({ action: 'enable', id: unit.id, enabled: payload.enabled })
  }
  // A VSCode extension that failed is recovered by loading it again.
  return vsixAction({ action: 'enable', id: unit.id, enabled: true })
}

/**
 * One extension's detail view.
 * @param {object} props - the component props.
 * @returns {JSX.Element} the rendered detail.
 */
function ExtensionDetail({ unit, t, state, refresh, titleOf, resolveText }) {
  const busy = state.busy === unit.id
  const title = titleOf(unit)
  const description = textOf(resolveText, unit.description, '')
  const requires = (unit.dependencies ?? []).map((id) => state.snapshot.units.find((item) => item.id === id)).filter(Boolean)
  const requiredBy = (unit.dependents ?? []).map((id) => state.snapshot.units.find((item) => item.id === id)).filter(Boolean)
  const cycles = (state.snapshot?.cycles ?? []).filter((cycle) => cycle.includes(unit.id))
  // Uninstalling is destructive, so it asks once: the button turns into the
  // confirmation, right where the person is looking.
  const [confirming, setConfirming] = useState(false)
  const removable = unit.backend === 'vsix' && unit.removable === true
  const uninstall = async () => {
    store.set({ busy: unit.id, message: '' })
    try {
      await vsixAction({ action: 'remove', id: unit.id })
      // The extension is gone: the detail view has nothing left to show.
      store.set({ selected: null })
    } catch (error) {
      store.set({ message: error instanceof Error ? error.message : String(error) })
    } finally {
      store.set({ busy: null })
      void refresh()
    }
  }
  return (
    <div className="ec-section">
      <div className="ec-toolbar">
        <button type="button" className="ec-button" onClick={() => { store.set({ selected: null }) }}>
          {t('back')}
        </button>
        <span className="ec-spacer" />
        {removable && (confirming ? (
          <>
            <span className="ec-warning">{t('uninstallConfirm')}</span>
            <button
              type="button"
              className="ec-button ec-button-danger"
              disabled={busy}
              onClick={() => { void uninstall() }}
            >
              {t('uninstallConfirmYes')}
            </button>
            <button type="button" className="ec-button" onClick={() => { setConfirming(false) }}>
              {t('cancel')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="ec-button"
            disabled={busy}
            onClick={() => { setConfirming(true) }}
          >
            {t('uninstall')}
          </button>
        ))}
        {unit.removable && (
          <button
            type="button"
            className="ec-button"
            disabled={busy}
            onClick={async () => {
              store.set({ busy: unit.id })
              try {
                await unitAction(unit, { action: 'enable', id: unit.id, enabled: !unit.enabled })
              } finally {
                store.set({ busy: null })
                void refresh()
              }
            }}
          >
            {unit.enabled ? t('actionDisable') : t('actionEnable')}
          </button>
        )}
      </div>
      <div className="ec-detail-head">
        <span className="ec-icon" aria-hidden="true">
          <CatalogIcon entry={unit} />
        </span>
        <div className="ec-main">
          <h2 className="ec-title">{title}</h2>
          {description !== '' && <p className="ec-description">{description}</p>}
        </div>
      </div>
      <dl className="ec-facts">
        <dt>{t('factName')}</dt><dd>{unit.name}</dd>
        {unit.version !== undefined && (<><dt>{t('factVersion')}</dt><dd>{unit.version}</dd></>)}
        <dt>{t('factKind')}</dt><dd>{t(kindKey(unit.kind))}</dd>
        <dt>{t('factState')}</dt><dd>{unit.enabled ? t('stateEnabled') : t('stateDisabled')}</dd>
        {unit.source !== undefined && (<><dt>{t('factSource')}</dt><dd>{unit.source}</dd></>)}
        {unit.publisher !== undefined && (<><dt>{t('factPublisher')}</dt><dd>{unit.publisher}</dd></>)}
        {unit.trusted !== undefined && (
          <><dt>{t('factTrust')}</dt><dd>{unit.trusted ? t('trustYes') : t('trustNo')}</dd></>
        )}
      </dl>
      {unit.supported !== undefined && unit.supported.length > 0 && (
        <section className="ec-block">
          <h3 className="ec-block-title">{t('blockSupported')}</h3>
          <p className="ec-meta">{unit.supported.join(', ')}</p>
        </section>
      )}
      {unit.unsupported !== undefined && unit.unsupported.length > 0 && (
        <section className="ec-block">
          <h3 className="ec-block-title">{t('blockUnsupported')}</h3>
          <p className="ec-meta">{unit.unsupported.join(', ')}</p>
        </section>
      )}
      {unit.problems.length > 0 && (
        <section className="ec-block">
          <h3 className="ec-block-title">{t('problems')}</h3>
          {unit.problems.map((problem) => (
            <p key={problem.code} className="ec-problem">
              <span>{problem.message}</span>
              <button
                type="button"
                className="ec-button"
                disabled={busy}
                onClick={async () => {
                  store.set({ busy: unit.id })
                  try {
                    await unitAction(unit, { action: 'retry', id: unit.id })
                  } catch (error) {
                    store.set({ message: error instanceof Error ? error.message : String(error) })
                  } finally {
                    store.set({ busy: null })
                    void refresh()
                  }
                }}
              >
                {t('retry')}
              </button>
            </p>
          ))}
        </section>
      )}
      {cycles.length > 0 && (
        <section className="ec-block">
          <h3 className="ec-block-title">{t('cycles')}</h3>
          {cycles.map((cycle) => (
            <p key={cycle.join('\u0000')} className="ec-problem">
              {cycle.map((id) => {
                const item = state.snapshot.units.find((unit) => unit.id === id)
                return item === undefined ? id : titleOf(item)
              }).join(' → ')}
            </p>
          ))}
        </section>
      )}
      {unit.rows.length > 0 && (
        <section className="ec-block">
          <h3 className="ec-block-title">{t('rows')}</h3>
          <ul className="ec-rows">
            {unit.rows.map((row) => (
              <li key={row.entryId} className="ec-row">
                <span className="ec-row-name">{row.moduleName}</span>
                <span className="ec-meta">{t(phaseKey(row.phase))}</span>
                {row.enabled ? null : <span className="ec-meta">{t('stateDisabled')}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="ec-block">
        <h3 className="ec-block-title">{t('requires')}</h3>
        {requires.length === 0 ? <p className="ec-meta">{t('none')}</p> : (
          <ul className="ec-rows">
            {requires.map((item) => (
              <li key={item.id} className="ec-row">
                <button type="button" className="ec-link" onClick={() => { store.set({ selected: item.id }) }}>
                  {titleOf(item)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="ec-block">
        <h3 className="ec-block-title">{t('requiredBy')}</h3>
        {requiredBy.length === 0 ? <p className="ec-meta">{t('none')}</p> : (
          <ul className="ec-rows">
            {requiredBy.map((item) => (
              <li key={item.id} className="ec-row">
                <button type="button" className="ec-link" onClick={() => { store.set({ selected: item.id }) }}>
                  {titleOf(item)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

/**
 * The artwork a unit without an icon shows.
 * @returns {JSX.Element} the rendered glyph.
 */
function FallbackGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 7h16v12H4z" strokeLinejoin="round" />
      <path d="M8 7V5h8v2" strokeLinejoin="round" />
      <path d="M9 12h6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Apply the plugin.
 * @param {object} ctx - the browser plugin context.
 */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'extension-console: dictionaries');
  ctx.effect(() => {
    // The Remote service may not be mounted yet: subscribing to a forward event
    // must not throw, or the whole plugin fails to load.
    if (ctx.remote === undefined || typeof ctx.remote.$on !== 'function') {
      return undefined;
    }
    const dispose = ctx.remote.$on('plugin-manager/changed', () => {
      void readSnapshot().then(
        (snapshot) => { store.set({ status: 'ready', snapshot, message: '' }) },
        (error) => { store.set({ status: 'error', message: error instanceof Error ? error.message : String(error) }) },
      );
    });
    return () => { dispose?.() };
  }, 'extension-console: host invalidations');
  const t = ctx.locale.bind(NS);
  ctx.slots.inject('plugins.tab', () => ctx.slots.register({
    name: 'plugins.tab',
    id: 'extensions',
    order: 10,
    label: () => t('title'),
    locale: NS,
    inject: () => ({ t, resolveText: (text) => ctx.locale.resolveText(text) }),
  }, ExtensionsSection));
}

/**
 * The dictionary key for one Loader row's phase.
 * @param {string|null|undefined} phase - the row's fiber phase.
 * @returns {string} the key.
 */
function phaseKey(phase) {
  if (phase === 'active') return 'phaseActive'
  if (phase === 'failed') return 'phaseFailed'
  if (phase === 'pending') return 'phasePending'
  if (phase === 'loading') return 'phaseLoading'
  if (phase === 'unloading') return 'phaseUnloading'
  return 'phaseNone'
}

/**
 * The dictionary key for one extension kind.
 * @param {string} kind - the unit's kind.
 * @returns {string} the key.
 */
function kindKey(kind) {
  if (kind === 'bundle') return 'kindBundle'
  if (kind === 'built-in') return 'kindBuiltIn'
  if (kind === 'vsix') return 'kindVsix'
  return 'kindBundle'
}

/** The styles this plugin owns; only host theme tokens are referenced. */
const STYLES = `
.ec-section{display:flex;flex-direction:column;gap:16px}
.ec-toolbar{display:flex;align-items:center;gap:8px}
.ec-spacer{flex:1}
.ec-search{flex:1;min-width:120px;padding:6px 10px;border-radius:var(--dsw-radius-md);
border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}
.ec-button{padding:5px 12px;border-radius:var(--dsw-radius-md);cursor:pointer;
border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}
.ec-button:hover{background:var(--dsw-alias-bg-layer-2)}
.ec-button-danger{border-color:var(--dsw-alias-state-error-primary);
color:var(--dsw-alias-state-error-primary)}
.ec-button-danger:hover{background:var(--dsw-alias-bg-layer-2)}
.ec-button:disabled{opacity:.5;cursor:default}
.ec-loading,.ec-empty{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px;line-height:20px}
.ec-modes{display:flex;align-items:center;gap:6px}
.ec-mode{padding:5px 12px;border-radius:var(--dsw-radius-md);cursor:pointer;
border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px}
.ec-mode-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.ec-select{padding:5px 8px;border-radius:var(--dsw-radius-md);
border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}
.ec-failure{display:flex;align-items:center;gap:10px}
.ec-error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:13px;line-height:20px}
.ec-error-inline{color:var(--dsw-alias-state-error-primary);margin-left:8px}
.ec-loaded{color:var(--dsw-alias-state-success-primary);margin-left:8px}
.ec-notice{color:var(--dsw-alias-state-warn-primary);margin:0;font-size:12px;line-height:18px}
.ec-cards{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.ec-card{display:flex;align-items:center;gap:14px;padding:8px;border-radius:var(--dsw-radius-lg)}
.ec-card:hover{background:var(--dsw-alias-bg-layer-1)}
.ec-card-open{flex:1;display:flex;align-items:center;gap:14px;min-width:0;
border:none;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;padding:0}
.ec-icon{width:40px;height:40px;flex:none;display:inline-flex;align-items:center;
justify-content:center;border-radius:var(--dsw-radius-md);
border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.ec-image{width:100%;height:100%;object-fit:contain;border-radius:var(--dsw-radius-md)}
.ec-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.ec-title-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.ec-title{font-size:14px;font-weight:500;line-height:20px;overflow:hidden;
text-overflow:ellipsis;white-space:nowrap}
.ec-version{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.ec-tag{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);
padding:0 6px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.ec-market{align-items:flex-start}
.ec-metric{display:inline-flex;align-items:center;gap:3px;flex:none;
color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap}
.ec-metric svg{width:13px;height:13px;flex:none}
.ec-sub-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.ec-publisher{display:inline-flex;align-items:center;gap:3px;min-width:0;
color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.ec-publisher-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}
.ec-verified{display:inline-flex;align-items:center;flex:none;color:var(--dsw-alias-brand-primary)}
.ec-verified svg{width:13px;height:13px}
.ec-ellipsis{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ec-installed{display:inline-flex;align-items:center;gap:5px;flex:none;
color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap}
.ec-installed svg{width:14px;height:14px}
.ec-installing{display:inline-flex;align-items:center;gap:6px;flex:none;
color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap}
.ec-spinner{width:12px;height:12px;flex:none;border-radius:50%;
border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);
animation:ec-spin .7s linear infinite}
@keyframes ec-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.ec-spinner{animation-duration:2.4s}}
.ec-confirm{display:inline-flex;align-items:center;gap:6px;flex:none}
.ec-skeleton{height:56px;border-radius:var(--dsw-radius-lg);
 background:linear-gradient(90deg,var(--dsw-alias-bg-layer-1) 25%,var(--dsw-alias-bg-layer-2) 37%,var(--dsw-alias-bg-layer-1) 63%);
 background-size:400% 100%;animation:ec-shimmer 1.4s ease infinite}
@keyframes ec-shimmer{0%{background-position:100% 0}100%{background-position:0 0}}
@media (prefers-reduced-motion:reduce){.ec-skeleton{animation:none}}
.ec-warning{color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px}
.ec-description{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;
overflow-wrap:anywhere}
.ec-meta{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.ec-switch{position:relative;width:34px;height:20px;flex:none;border-radius:var(--dsw-radius-md);
border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;padding:0}
.ec-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.ec-switch:disabled{opacity:.5;cursor:default}
.ec-switch-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
background:var(--dsw-alias-bg-base)}
.ec-switch[aria-checked="true"] .ec-switch-knob{left:16px}
.ec-detail-head{display:flex;align-items:flex-start;gap:14px}
.ec-facts{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;margin:0;font-size:13px;line-height:20px}
.ec-facts dt{color:var(--dsw-alias-label-secondary)}
.ec-facts dd{margin:0;overflow-wrap:anywhere}
.ec-block{display:flex;flex-direction:column;gap:6px}
.ec-block-title{font-size:13px;font-weight:500;line-height:20px;margin:0}
.ec-rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.ec-row{display:flex;align-items:center;gap:10px;font-size:13px;line-height:20px}
.ec-row-name{overflow-wrap:anywhere}
.ec-link{border:none;background:none;color:var(--dsw-alias-brand-primary);font:inherit;
font-size:13px;line-height:20px;cursor:pointer;padding:0;text-align:left}
.ec-problem{display:flex;align-items:center;gap:10px;margin:0;font-size:13px;line-height:20px;
color:var(--dsw-alias-state-error-primary)}
`;

export { apply };
