/**
 * Turn an installed extension directory into an `ExtensionRecord`.
 *
 * The record shape is a contract with the Extensions page and with the
 * extension host that will read `extensions.json`:
 *
 * ```
 * { id, kind, publisher, name, version, displayName, description, icon,
 *   enabled, trusted, installed, source, contributes, supported, unsupported,
 *   problems, directory }
 * ```
 *
 * Two rules shape the code:
 *
 * - the display name and the description are resolved to plain strings here,
 *   never to a language map, so the page never has to know about a second
 *   localization format;
 * - `__metadata` never reaches a record: VS Code writes that key into the
 *   installed manifest and deletes it again when it reads the manifest
 *   ([vsix-runtime-and-trust.md] §1.6), so DSH keeps the equivalent facts
 *   in `dsh-extension.json` instead of mutating the extension's own file.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { classifyContributes } from './capabilities.js'

/** The icon mime types the store can inline as a data URL. */
const ICON_MIME_TYPES = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/**
 * Detect the UI language from the environment.
 * @returns {string} a language tag, defaulting to `en`.
 */
export function detectLocale() {
  const raw = process.env.DSH_LOCALE ?? process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG ?? ''
  const tag = String(raw).split('.')[0].split('@')[0].replace('_', '-').trim()
  return tag.length === 0 ? 'en' : tag.toLowerCase()
}

/**
 * Pick one language out of a localized value.
 * @param {unknown} value - a string or a language map.
 * @param {string} locale - the wanted language.
 * @returns {string|undefined} the picked text.
 */
export function pickLocalized(value, locale) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null || typeof value !== 'object') return undefined
  const map = /** @type {Record<string, unknown>} */ (value)
  const candidates = [locale, locale.split('-')[0], 'en']
  for (const candidate of candidates) {
    if (typeof map[candidate] === 'string') return map[candidate]
  }
  const first = Object.values(map).find((entry) => typeof entry === 'string')
  return typeof first === 'string' ? first : undefined
}

/**
 * Read one JSON file, tolerating a missing or broken file.
 * @param {string} path - the file's path.
 * @returns {object|undefined} the parsed object.
 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Resolve a `%placeholder%` against the extension's NLS bundles.
 * @param {string} value - the possibly-placeholder text.
 * @param {string} extensionDir - the extension's directory.
 * @param {string} locale - the wanted language.
 * @returns {string} the resolved text, or the original value.
 */
function resolvePlaceholder(value, extensionDir, locale) {
  if (!value.startsWith('%') || !value.endsWith('%')) return value
  const key = value.slice(1, -1)
  const bundles = ['package.nls.json', `package.nls.${locale}.json`]
  for (const bundle of bundles) {
    const parsed = readJson(join(extensionDir, bundle))
    const text = pickLocalized(parsed?.[key], locale)
    if (text !== undefined) return text
  }
  return value
}

/**
 * Resolve the extension's display name.
 * @param {object} manifest - the extension's package.json.
 * @param {string} extensionDir - the extension's directory.
 * @param {string} locale - the wanted language.
 * @returns {string} the display name.
 */
export function resolveDisplayName(manifest, extensionDir, locale) {
  const raw = pickLocalized(manifest?.displayName, locale) ?? manifest?.name ?? ''
  return resolvePlaceholder(raw, extensionDir, locale)
}

/**
 * Resolve the extension's description.
 * @param {object} manifest - the extension's package.json.
 * @param {string} extensionDir - the extension's directory.
 * @param {string} locale - the wanted language.
 * @returns {string} the description.
 */
export function resolveDescription(manifest, extensionDir, locale) {
  const raw = pickLocalized(manifest?.description, locale) ?? ''
  return resolvePlaceholder(raw, extensionDir, locale)
}

/**
 * Inline the extension's icon as a data URL.
 * @param {object} manifest - the extension's package.json.
 * @param {string} extensionDir - the extension's directory.
 * @returns {string|null} the data URL, or null when there is no icon.
 */
export function resolveIcon(manifest, extensionDir) {
  const candidates = []
  if (typeof manifest?.icon === 'string' && !/^[a-z]+:/i.test(manifest.icon)) {
    candidates.push(manifest.icon)
  }
  candidates.push('icon.png', 'icon.svg', 'resources/icon.png', 'images/icon.png')
  for (const candidate of candidates) {
    const path = join(extensionDir, ...candidate.split('/'))
    if (!existsSync(path)) continue
    let mime = ICON_MIME_TYPES[path.slice(path.lastIndexOf('.')).toLowerCase()]
    if (mime === undefined) continue
    try {
      const bytes = readFileSync(path)
      if (bytes.length > 512 * 1024) continue
      return `data:${mime};base64,${bytes.toString('base64')}`
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

/**
 * List the extension directories under the extensions directory.
 * @param {string} extensionsDir - the extensions directory.
 * @returns {Array<string>} the directory names.
 */
export function listExtensionDirectories(extensionsDir) {
  let names
  try {
    names = readdirSync(extensionsDir)
  } catch {
    return []
  }
  return names.filter((name) => !name.startsWith('.')).filter((name) => {
    try {
      return statSync(join(extensionsDir, name)).isDirectory()
    } catch {
      return false
    }
  }).sort()
}

/**
 * Build one record from an installed extension directory.
 * @param {string} directory - the extension's install directory.
 * @param {object} options - the record options.
 * @param {string} options.locale - the wanted language.
 * @param {Record<string, boolean>} options.trustedPublishers - the trusted publishers.
 * @param {boolean} options.enabled - the stored enabled flag.
 * @returns {object|undefined} the record, when the directory holds an extension.
 */
export function readRecord(directory, { locale, trustedPublishers, enabled }) {
  const manifest = readJson(join(directory, 'extension', 'package.json'))
  if (manifest === undefined) return undefined
  const metadata = readJson(join(directory, 'dsh-extension.json')) ?? {}
  const publisher = typeof manifest.publisher === 'string' ? manifest.publisher : metadata.publisher ?? ''
  const name = typeof manifest.name === 'string' ? manifest.name : metadata.name ?? ''
  const version = typeof manifest.version === 'string' ? manifest.version : metadata.version ?? ''
  const trusted = trustedPublishers?.[publisher] === true
  const executesCode = typeof manifest.main === 'string' || typeof manifest.browser === 'string'
  const classification = classifyContributes(manifest.contributes, { executesCode })
  const { contributes, supported, degraded, unsupported, entries, status, runtime, problems } = classification
  const allProblems = [...problems]
  if (!trusted) {
    allProblems.push({
      code: 'untrusted-publisher',
      severity: 'error',
      message: `the publisher "${publisher}" is not trusted, so the extension host will not load this extension`,
    })
  }
  if (executesCode) {
    allProblems.push({
      code: 'executes-code',
      severity: 'warning',
      message: 'this extension ships executable code; installing it runs third-party Node code inside the extension host',
    })
  }
  if (typeof manifest.engines?.vscode !== 'string') {
    allProblems.push({
      code: 'missing-engines',
      severity: 'warning',
      message: 'the manifest declares no engines.vscode, so DSH cannot tell which VS Code version it expects',
    })
  }
  return {
    id: `${publisher}.${name}@${version}`,
    kind: 'vsix',
    publisher,
    name,
    version,
    displayName: resolveDisplayName(manifest, join(directory, 'extension'), locale),
    description: resolveDescription(manifest, join(directory, 'extension'), locale),
    icon: resolveIcon(manifest, join(directory, 'extension')),
    enabled: enabled !== false,
    trusted: trusted === true,
    installed: true,
    source: typeof metadata.source === 'string' ? metadata.source : 'open-vsx',
    contributes,
    supported,
    degraded,
    unsupported,
    // The same capability shape the catalog publishes, so a page can read an
    // installed extension and a catalog entry with one code path.
    capability: {
      status,
      basis: 'installed',
      detail: '',
      contributes,
      supported,
      degraded,
      unsupported,
      entries,
      runtime,
      problems,
    },
    problems: allProblems,
    directory,
    targetPlatform: metadata.targetPlatform ?? null,
    executesCode,
  }
}
