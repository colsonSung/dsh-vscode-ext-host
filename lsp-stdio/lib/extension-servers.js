/**
 * Route (a): language servers declared by an installed VSIX extension.
 *
 * ## The honest finding
 *
 * **VS Code's extension manifest has no field that declares a language server.** The
 * manifest schema generated into `extensionsRegistry.ts` defines `contributes.languages`
 * with `id`, `aliases`, `extensions`, `configuration`, `icon` and `colorizedBracketPairs`
 * — and nothing that points at a server binary. Real language extensions (`ms-python.python`,
 * `dbaeumer.vscode-eslint`, …) bundle the server *inside the extension folder* and spawn it
 * from their own `main` code at activation time. That server is therefore a child of the
 * extension host process, and a separate LSP client cannot reach it.
 *
 * So the task's route (a) — "the extension exposes the server's launch command" — has **no
 * standard field to read**. This bundle therefore defines a small, explicit convention and
 * reads it in a fixed order:
 *
 * 1. `<extension-dir>/dsh-lsp.json` — a sibling file inside the unpacked extension, the
 *    most explicit form:
 *    ```json
 *    { "command": "node", "args": ["server.js"], "extensions": [".ts"], "languageIds": ["typescript"] }
 *    ```
 * 2. `<extension-dir>/extension/package.json` → `dsh.lspServer` — the same object under a
 *    `dsh` key of the extension manifest.
 *
 * The convention is deliberately **not** invented out of thin air: `dsh` is already the
 * namespace DSH uses for its own extension metadata, and a sibling file keeps the upstream
 * manifest untouched (an extension's `package.json` is signed content).
 *
 * ## What the extension's own manifest still contributes
 *
 * When the declaration omits `extensions`/`languageIds`, they are derived from the
 * extension's `contributes.languages`: each declared language id contributes its
 * `extensions` list, and the language id is the language. That is the closest thing VS
 * Code has to a server description, and it is what makes "install the language extension
 * and the language works" true.
 *
 * @module @local/dsh-lsp-stdio/extension-servers
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { normalizeExtension } from './lsp-service.js'
import { extensionDirectoryName, profilePaths } from './paths.js'

/**
 * Read a UTF-8 file, tolerating absence.
 *
 * @param {string} path - the absolute path.
 * @returns {Promise<string|undefined>} the text, or undefined when unreadable.
 */
async function readTextIfPresent(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Read and parse a JSON file, tolerating absence and malformed content.
 *
 * @param {string} path - the absolute path.
 * @returns {Promise<any|undefined>} the parsed value, or undefined.
 */
async function readJsonIfPresent(path) {
  const text = await readTextIfPresent(path)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Derive an extension to language map from an extension manifest's `contributes.languages`.
 *
 * @param {any} manifest - the extension manifest.
 * @returns {Record<string, string>} the map, with normalized extension keys.
 */
export function languagesFromManifest(manifest) {
  const map = {}
  const languages = manifest?.contributes?.languages
  if (!Array.isArray(languages)) return map
  for (const language of languages) {
    if (typeof language?.id !== 'string' || language.id.length === 0) continue
    if (!Array.isArray(language.extensions)) continue
    for (const extension of language.extensions) {
      const normalized = normalizeExtension(extension)
      if (normalized.length === 0) continue
      map[normalized] = language.id
    }
  }
  return map
}

/**
 * Normalize one server declaration into this bundle's server shape.
 *
 * @param {any} declaration - the raw declaration.
 * @param {string} id - the provider id to use.
 * @param {Record<string, string>} fallbackMap - the map derived from the manifest.
 * @returns {any|undefined} the server specification, or undefined when unusable.
 */
export function normalizeDeclaration(declaration, id, fallbackMap) {
  if (declaration === null || typeof declaration !== 'object') return undefined
  if (typeof declaration.command !== 'string' || declaration.command.length === 0) return undefined

  let extensionToLanguage = {}
  if (declaration.extensionToLanguage !== null && typeof declaration.extensionToLanguage === 'object') {
    for (const [key, languageId] of Object.entries(declaration.extensionToLanguage)) {
      const normalized = normalizeExtension(key)
      if (normalized.length === 0 || typeof languageId !== 'string' || languageId.length === 0) continue
      extensionToLanguage[normalized] = languageId
    }
  }
  if (Object.keys(extensionToLanguage).length === 0) {
    const extensions = Array.isArray(declaration.extensions) ? declaration.extensions : []
    const languages = Array.isArray(declaration.languageIds) ? declaration.languageIds : []
    extensions.forEach((extension, index) => {
      const normalized = normalizeExtension(extension)
      if (normalized.length === 0) return
      const languageId = languages.length === extensions.length ? languages[index] : languages[0]
      extensionToLanguage[normalized] = languageId ?? fallbackMap[normalized] ?? normalized
    })
  }
  if (Object.keys(extensionToLanguage).length === 0) {
    // No explicit extension list: fall back to what the manifest declares about its languages.
    extensionToLanguage = { ...fallbackMap }
  }
  if (Object.keys(extensionToLanguage).length === 0) return undefined

  return {
    id,
    enabled: true,
    command: declaration.command,
    args: Array.isArray(declaration.args) ? declaration.args.filter((a) => typeof a === 'string') : [],
    cwd: typeof declaration.cwd === 'string' ? declaration.cwd : '',
    env: declaration.env !== null && typeof declaration.env === 'object' ? { ...declaration.env } : {},
    extensions: Object.keys(extensionToLanguage),
    languageIds: [...new Set(Object.values(extensionToLanguage))],
    extensionToLanguage,
    initOptions: declaration.initOptions ?? {},
  }
}

/**
 * Collect the language servers declared by the installed VSIX extensions.
 *
 * Only extensions that are installed, enabled and (optionally) trusted contribute, so an
 * untrusted publisher cannot smuggle a server into the profile.
 *
 * @param {object} ctx - the Host plugin context.
 * @param {object} options - the options.
 * @param {boolean} [options.requireTrusted] - whether to require publisher trust.
 * @returns {Promise<Array<any>>} the server specifications, in installation order.
 */
export async function collectExtensionServers(ctx, options = {}) {
  const requireTrusted = options.requireTrusted !== false
  const paths = profilePaths(ctx)
  if (paths === undefined) return []

  const state = await readJsonIfPresent(paths.stateFile)
  const records = Array.isArray(state?.extensions) ? state.extensions : []
  const trust = await readJsonIfPresent(paths.trustFile)
  // The store writes `{ "publishers": { "<publisher>": true } }` (`vsix-store/src/state.js`).
  const trustedPublishers =
    trust !== null &&
    typeof trust === 'object' &&
    trust !== null &&
    typeof trust.publishers === 'object' &&
    trust.publishers !== null
      ? trust.publishers
      : {}

  /**
   * Resolve whether a publisher is trusted.
   *
   * The store writes the fact twice: `extensions-trust.json` is the source of truth and
   * each record carries the resolved `trusted` flag. The record wins when it says
   * something explicit; otherwise the trust file decides; a publisher that appears in
   * neither is **not** trusted.
   *
   * @param {any} record - the extension record.
   * @param {string|undefined} publisher - the publisher id.
   * @returns {boolean} whether the publisher is trusted.
   */
  const isTrusted = (record, publisher) => {
    if (typeof record.trusted === 'boolean') return record.trusted
    if (publisher !== undefined && typeof trustedPublishers[publisher] === 'boolean') {
      return trustedPublishers[publisher]
    }
    return false
  }

  const servers = []
  for (const record of records) {
    if (record?.kind !== undefined && record.kind !== 'vsix') continue
    if (record.installed === false) continue
    if (record.enabled === false) continue

    const publisher = typeof record.publisher === 'string' ? record.publisher : undefined
    const name = typeof record.name === 'string' ? record.name : undefined
    const version = typeof record.version === 'string' ? record.version : undefined
    if (requireTrusted && !isTrusted(record, publisher)) continue

    const directory =
      typeof record.directory === 'string' && record.directory.length > 0
        ? record.directory
        : publisher !== undefined && name !== undefined && version !== undefined
          ? join(paths.profileDir, 'extensions', extensionDirectoryName(publisher, name, version, record.targetPlatform))
          : undefined
    if (directory === undefined) continue

    const manifest = await readJsonIfPresent(join(directory, 'extension', 'package.json'))
    if (manifest === undefined) continue

    const fallbackMap = languagesFromManifest(manifest)
    const sibling = await readJsonIfPresent(join(directory, 'dsh-lsp.json'))
    const inline = manifest.dsh?.lspServer
    const declaration = sibling !== undefined ? sibling : inline
    if (declaration === undefined) continue

    const id = `${publisher ?? 'unknown'}.${name ?? 'unknown'}`
    const server = normalizeDeclaration(declaration, id, fallbackMap)
    if (server === undefined) continue
    servers.push(server)
  }

  return servers
}
