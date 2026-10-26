/**
 * Where the bundle finds things inside a DSH profile.
 *
 * The profile directory comes from `ctx.profileContext.dir`, the same source the VSIX
 * store uses (`vsix-store/src/paths.js`), so both bundles agree on one layout:
 *
 * ```text
 * <profile>/
 * ├── extensions.json                 installed VSIX extensions + their enabled flag
 * ├── extensions-trust.json           publisher-level trust list
 * └── extensions/<publisher>.<name>-<version>/
 *     ├── extension/                  the unpacked VSIX `extension/` subtree
 *     └── dsh-extension.json          the store's own metadata
 * ```
 *
 * @module @local/dsh-lsp-stdio/paths
 */

import { join } from 'node:path'

/**
 * Resolve the profile paths this bundle reads.
 *
 * @param {object} ctx - the Host plugin context.
 * @returns {{ profileDir: string, stateFile: string, trustFile: string }|undefined} the paths,
 *   or `undefined` when the composition has no profile context.
 */
export function profilePaths(ctx) {
  const profileContext = ctx.get('profileContext')
  const profileDir = profileContext?.dir
  if (typeof profileDir !== 'string' || profileDir.length === 0) return undefined
  return {
    profileDir,
    stateFile: join(profileDir, 'extensions.json'),
    trustFile: join(profileDir, 'extensions-trust.json'),
  }
}

/**
 * Build the directory name VS Code uses for one installed extension.
 *
 * @param {string} publisher - the extension's publisher.
 * @param {string} name - the extension's name.
 * @param {string} version - the extension's version.
 * @param {string} [targetPlatform] - the platform-specific build, when the source has one.
 * @returns {string} the directory name.
 */
export function extensionDirectoryName(publisher, name, version, targetPlatform) {
  const base = `${publisher}.${name}-${version}`
  return targetPlatform === undefined || targetPlatform === null || targetPlatform === ''
    ? base
    : `${base}-${targetPlatform}`
}
