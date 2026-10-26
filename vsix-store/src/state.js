/**
 * The store's two profile-level files.
 *
 * `extensions.json` holds the installed-extension list and every entry's
 * enabled flag; `extensions-trust.json` holds the publisher-level trust list.
 * Another bundle — the extension host — reads `extensions.json` directly to
 * decide which extensions to load, so its shape is part of this bundle's
 * contract and must stay stable.
 *
 * Writes go through `ctx.fs` when the profile has a filesystem backend, and
 * fall back to `node:fs` otherwise: the state files are small UTF-8 JSON, so
 * `ctx.fs.writeText` fits, but the store must also work in a composition
 * that mounts no filesystem backend.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Read a UTF-8 text file, preferring the filesystem service.
 * @param {object} ctx - the Host plugin context.
 * @param {string} path - the absolute file path.
 * @returns {Promise<string|undefined>} the file's text, or undefined when it is absent.
 */
export async function readTextFile(ctx, path) {
  // The filesystem service is optional: a composition without one still
  // works through node:fs. `ctx.fs` throws when it was not injected, so the
  // service is looked up rather than read off the context.
  const fs = ctx.get('fs')
  if (fs !== undefined && typeof fs.resolve === 'function') {
    try {
      const target = await fs.resolve(path, { cwd: process.cwd() })
      return await fs.readText(target)
    } catch (error) {
      if (error?.code !== 'FS_NOT_FOUND' && error?.code !== 'ENOENT') {
        // A filesystem backend that cannot read this path is not fatal: the
        // store keeps its own copy in node:fs terms.
        try {
          return readFileSync(path, 'utf8')
        } catch {
          return undefined
        }
      }
    }
  }
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Write a UTF-8 text file atomically enough for our purposes, preferring the
 * filesystem service.
 * @param {object} ctx - the Host plugin context.
 * @param {string} path - the absolute file path.
 * @param {string} content - the file's new content.
 * @returns {Promise<void>} after the file is written.
 */
export async function writeTextFile(ctx, path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const fs = ctx.get('fs')
  if (fs !== undefined && typeof fs.resolve === 'function') {
    try {
      const target = await fs.resolve(path, { cwd: process.cwd() })
      await fs.writeText(target, content)
      return
    } catch {
      // Fall through to the direct write below.
    }
  }
  writeFileSync(path, content, 'utf8')
}

/**
 * Read the installed-extension state.
 * @param {object} ctx - the Host plugin context.
 * @param {string} stateFile - the state file's path.
 * @returns {Promise<{ extensions: Array<object> }>} the state.
 */
export async function readState(ctx, stateFile) {
  const text = await readTextFile(ctx, stateFile)
  if (text === undefined) return { extensions: [] }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { extensions: [] }
  }
  const extensions = Array.isArray(parsed?.extensions) ? parsed.extensions : []
  return { extensions }
}

/**
 * Write the installed-extension state.
 * @param {object} ctx - the Host plugin context.
 * @param {string} stateFile - the state file's path.
 * @param {{ extensions: Array<object> }} state - the new state.
 * @returns {Promise<void>} after the file is written.
 */
export async function writeState(ctx, stateFile, state) {
  await writeTextFile(ctx, stateFile, `${JSON.stringify(state, null, 2)}\n`)
}

/**
 * Read the publisher trust list.
 * @param {object} ctx - the Host plugin context.
 * @param {string} trustFile - the trust file's path.
 * @returns {Promise<Record<string, boolean>>} the trusted publishers.
 */
export async function readTrust(ctx, trustFile) {
  const text = await readTextFile(ctx, trustFile)
  if (text === undefined) return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  const publishers = parsed?.publishers
  if (publishers === undefined || publishers === null || typeof publishers !== 'object') return {}
  return { ...publishers }
}

/**
 * Write the publisher trust list.
 * @param {object} ctx - the Host plugin context.
 * @param {string} trustFile - the trust file's path.
 * @param {Record<string, boolean>} publishers - the trusted publishers.
 * @returns {Promise<void>} after the file is written.
 */
export async function writeTrust(ctx, trustFile, publishers) {
  await writeTextFile(ctx, trustFile, `${JSON.stringify({ publishers }, null, 2)}\n`)
}
