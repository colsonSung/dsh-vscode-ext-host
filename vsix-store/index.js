/**
 * Host half of the VSIX Extension Store bundle.
 *
 * DSH cannot install VS Code extensions through its own plugin manager:
 * `parseInstallSpec` only understands `registry`, `tarball`, `git` and
 * `path` ([vscode-extension-research/README.md] §6), and a VSIX must not be
 * converted into a Cordis bundle anyway — the whole point of a VSIX is the
 * `require('vscode')` contract, the activation events and the contribution
 * points, and converting it would destroy exactly those
 * ([vsix-runtime-and-trust.md] §5.4).
 *
 * So this bundle manages VSIX extensions as a second kind of install unit,
 * beside DSH bundles:
 *
 * ```
 * ~/.dsh/profiles/<profile>/extensions/<publisher>.<name>-<version>[-<platform>]/
 * ├── extension/          the unpacked extension subtree
 * ├── dsh-extension.json  the store's own metadata
 * └── global-storage/     the extension's global state
 * ~/.dsh/profiles/<profile>/extensions.json          the installed extensions
 * ~/.dsh/profiles/<profile>/extensions-trust.json    the trusted publishers
 * ```
 *
 * The browser half of the Extensions page reads exactly one route, because a
 * third-party bundle cannot contribute a typed Remote namespace of its own.
 */

import { VsixStore } from './src/service.js'
import { createExtensionTool } from './src/tool.js'

/** Services this plugin needs. */
export const inject = ['profileContext', 'webServer', 'connection', 'tools']

/** The exact route the Extensions page reads and writes. */
export const ROUTE = '/vscode-extensions'

/**
 * Apply the plugin.
 * @param {object} ctx - the Host plugin context.
 * @returns {void}
 */
export function apply(ctx) {
  const service = new VsixStore(ctx)
  ctx.provide('vsixStore', service)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: (req, res) => handle(ctx, service, req, res),
  }), 'vsix-store: route')
  ctx.effect(() => ctx.tools.register(createExtensionTool(service)), 'vsix-store: tool')
}

/**
 * Answer one HTTP request.
 *
 * The route carries the profile's extension facts, so it answers only to a
 * browser the Connection has already admitted; Connection owns the 401.
 * @param {object} ctx - the Host plugin context.
 * @param {VsixStore} service - the store's service.
 * @param {object} req - the Node request.
 * @param {object} res - the Node response.
 * @returns {Promise<void>} after the response is written.
 */
async function handle(ctx, service, req, res) {
  if (!ctx.connection.authorizeIndex(req, res)) return
  try {
    const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {}
    const action = String(body.action ?? '')
    switch (action) {
      case 'list': {
        const extensions = await service.list()
        json(res, 200, { ok: true, extensions })
        return
      }
      case 'catalog': {
        const answer = await service.catalog({
          query: body.query,
          source: body.source,
          limit: body.limit,
          inspect: body.inspect,
        })
        json(res, 200, { ok: true, results: answer.results, sources: answer.sources })
        return
      }
      case 'inspect': {
        // One extension's verdict, fetched AFTER the list is on screen: the
        // registry answers its search in a second, a manifest on an unreachable
        // CDN does not.
        const capability = await service.inspect({
          publisher: body.publisher,
          name: body.name,
          version: body.version,
          source: body.source,
          manifestUrl: body.manifestUrl,
        })
        json(res, 200, { ok: true, capability })
        return
      }
      case 'install': {
        const record = await service.install({
          publisher: body.publisher,
          name: body.name,
          version: body.version,
          source: body.source ?? 'open-vsx',
          trust: body.trust === true,
        })
        json(res, 200, { ok: true, record })
        return
      }
      case 'installStart': {
        // The install runs in the background and reports its stage, so the page
        // can say what is happening instead of showing a spinner for a minute.
        const job = service.startInstall({
          publisher: body.publisher,
          name: body.name,
          version: body.version,
          source: body.source ?? 'open-vsx',
          trust: body.trust === true,
        })
        json(res, 200, { ok: true, job })
        return
      }
      case 'installStatus': {
        const job = service.installStatus({ jobId: body.jobId })
        json(res, 200, { ok: true, job })
        return
      }
      case 'remove': {
        const outcome = await service.remove({ id: body.id })
        json(res, 200, { ok: true, ...outcome })
        return
      }
      case 'enable': {
        const outcome = await service.setEnabled({ id: body.id, enabled: body.enabled === true })
        json(res, 200, { ok: true, ...outcome })
        return
      }
      case 'trust': {
        const outcome = await service.setTrust({ publisher: body.publisher, trusted: body.trusted === true })
        json(res, 200, { ok: true, ...outcome })
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
 * @param {object} req - the Node request.
 * @returns {Promise<string>} the body.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = ''
    req.setEncoding?.('utf8')
    req.on('data', (chunk) => {
      text += chunk
      if (text.length > 1_000_000) reject(new Error('vsix-store: request body too large'))
    })
    req.on('end', () => resolve(text))
    req.on('error', reject)
  })
}
