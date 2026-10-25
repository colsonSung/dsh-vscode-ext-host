/**
 * Host half of the VS Code Extension Host bundle.
 *
 * DSH runs third-party VS Code extension packages as real extension code: the packages stay
 * VSIX packages, they are not converted into Cordis bundles, and they run inside a real
 * (vendored, open source) VS Code extension host in a child process.
 *
 * This file is the thin Host half:
 *
 * - it reads the profile's `extensions.json` and `extensions-trust.json` (the seam the VSIX
 *   store owns), keeps the extensions that are enabled AND whose publisher is trusted, and
 *   loads them into the extension host;
 * - it supervises the host process: a crash restarts it with a backoff, and three crashes
 *   within five minutes stop the automatic restart, exactly as VS Code does;
 * - it exposes the host's live state on `POST /vscode-extension-host`, so the Extensions page
 *   can tell "installed", "enabled" and "loaded by the host" apart;
 * - it exposes the same five actions to the model through the `vscode_extension_host` tool.
 *
 * The heavy lifting lives in `main-host.js` (the main side of the VS Code extension host
 * protocol) and `dist/extension-host.js` (the vendored extension host itself).
 */

import { ExtensionHostRuntime, createExtensionHostTool } from './main-host.js'
// The webview surface is PART of the extension host: the main side of the protocol and the
// surface that shows what the extension produced must share one context, because a service
// provided by one bundle is NOT visible to a sibling bundle (each fiber provides into its
// own store). One bundle, one context, no seam.
import { apply as applyWebviewSurface } from './webview-surface.js'

/** Services this plugin needs. */
export const inject = ['profileContext', 'webServer', 'connection', 'tools']

/** The exact route the Extensions page reads. */
export const ROUTE = '/vscode-extension-host'

/** The id of this bundle's browser half, as the module table knows it. */
const CLIENT_MODULE_ID = 'dsh-vscode-extension-host'

/**
 * Apply the plugin.
 *
 * @param {object} ctx - the Host plugin context.
 * @returns {void}
 */
export function apply(ctx) {
  const runtime = new ExtensionHostRuntime(ctx)
  ctx.provide('vscodeExtensionHost', runtime)
  // The surface publishes `vscodeWebviewSurface` into THIS context, so the main side
  // (which reads it) finds it.
  applyWebviewSurface(ctx, (message) => runtime.log(message))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: (req, res) => handle(ctx, runtime, req, res),
  }), 'dsh-vscode-extension-host: route')

  ctx.effect(() => ctx.tools.register(createExtensionHostTool(runtime)), 'dsh-vscode-extension-host: tool')

  // The browser half of this bundle is CODE, and a page that is already open still runs
  // the code it loaded. The HMR transport can replace a rebuilt browser bundle in place,
  // so the page picks the new code up without a window reload — which is the difference
  // between "the fix is live" and "the fix is on disk".
  ctx.effect(() => {
    const modules = ctx.get('clientModules');
    if (modules === undefined || typeof modules.rebuilt !== 'function') {
      return;
    }
    try {
      modules.rebuilt(CLIENT_MODULE_ID);
    } catch {
      // A page that has not loaded the module yet has nothing to replace.
    }
  }, 'dsh-vscode-extension-host: client reload')

  // The host starts with the profile: an enabled, trusted extension is supposed to RUN, not
  // to sit on the disk. A failure to start is recorded in the host's own log and reported
  // through `status`, it never takes the profile down.
  ctx.effect(() => {
    runtime.start().catch(() => undefined)
    return () => {
      runtime.dispose().catch(() => undefined)
    }
  }, 'dsh-vscode-extension-host: autostart')
}

/**
 * Answer one HTTP request.
 *
 * @param {object} ctx - the Host plugin context.
 * @param {ExtensionHostRuntime} runtime - the extension host service.
 * @param {object} req - the Node request.
 * @param {object} res - the Node response.
 * @returns {Promise<void>} after the response is written.
 */
async function handle(ctx, runtime, req, res) {
  if (!ctx.connection.authorizeIndex(req, res)) return
  try {
    const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {}
    const action = String(body.action ?? '')
    switch (action) {
      case 'status': {
        const payload = runtime.payload()
        json(res, 200, {
          ok: true,
          host: payload.host,
          extensions: payload.extensions,
          commands: runtime.registeredCommands(),
          skipped: runtime.skippedExtensions(),
        })
        return
      }
      case 'start': {
        json(res, 200, { ok: true, host: await runtime.start() })
        return
      }
      case 'stop': {
        json(res, 200, { ok: true, host: await runtime.stop() })
        return
      }
      case 'restart': {
        json(res, 200, { ok: true, host: await runtime.restart() })
        return
      }
      case 'log': {
        const lines = typeof body.lines === 'number' ? Math.min(Math.max(body.lines, 1), 5000) : 200
        json(res, 200, { ok: true, lines: runtime.logLines(lines) })
        return
      }
      case 'theme': {
        // Which colour scheme DSH's interface is showing. The extension host's theming
        // starts on Dark, so without this every extension believes the editor is dark.
        const colorScheme = String(body.colorScheme ?? '')
        if (!runtime.setColorScheme(colorScheme)) {
          json(res, 400, { ok: false, error: `unknown colour scheme "${colorScheme}"` })
          return
        }
        json(res, 200, { ok: true, colorScheme })
        return
      }
      default:
        json(res, 400, { ok: false, error: `unknown action "${action}"` })
    }
  } catch (error) {
    json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Write a JSON response.
 *
 * @param {object} res - the Node response.
 * @param {number} status - the HTTP status.
 * @param {unknown} payload - the body.
 */
function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Read a request body as text.
 *
 * @param {object} req - the Node request.
 * @returns {Promise<string>} the body.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = ''
    req.setEncoding?.('utf8')
    req.on('data', (chunk) => {
      text += chunk
      if (text.length > 1_000_000) reject(new Error('dsh-vscode-extension-host: request body too large'))
    })
    req.on('end', () => resolve(text))
    req.on('error', reject)
  })
}
