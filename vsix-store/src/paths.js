/**
 * Where the store keeps things inside a DSH profile.
 *
 * The profile directory comes from `ctx.profileContext.dir` — the object the
 * Host publishes with `dir`, `patchPath`, `installAnchor` and `home`
 * ([dsh-mainthread-mapping.md] §0). Everything this bundle owns lives in
 * three places under that directory:
 *
 * - `extensions/<publisher>.<name>-<version>[-<targetPlatform>]/` — the
 *   unpacked extension, mirroring VS Code's own install layout
 *   ([vsix-runtime-and-trust.md] §1.6);
 * - `extensions.json` — the installed-extension list and each entry's
 *   enabled flag;
 * - `extensions-trust.json` — the publisher-level trust list.
 *
 * The layout deliberately has no `node_modules`: pnpm prunes it
 * ([vsix-runtime-and-trust.md] §6), and a VSIX normally ships its
 * dependencies bundled anyway.
 */

import { join } from 'node:path'

/**
 * Resolve the store's paths for the current profile.
 * @param {object} ctx - the Host plugin context.
 * @returns {{ profileDir: string, extensionsDir: string, stateFile: string, trustFile: string }} the paths.
 */
export function storePaths(ctx) {
  const profileDir = ctx.profileContext?.dir
  if (typeof profileDir !== 'string' || profileDir.length === 0) {
    throw new Error('vsix-store: the current profile has no directory; nothing can be stored')
  }
  return {
    profileDir,
    extensionsDir: join(profileDir, 'extensions'),
    stateFile: join(profileDir, 'extensions.json'),
    trustFile: join(profileDir, 'extensions-trust.json'),
  }
}

/**
 * Build the directory name VS Code uses for one installed extension.
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
