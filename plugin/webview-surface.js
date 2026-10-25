import { createServer } from 'node:http';
/**
 * Host half of the VS Code webview surface.
 *
 * DSH-authored (MIT). No Microsoft code.
 *
 * WHAT THIS BUNDLE IS
 * -------------------
 * The extension host bundle owns the PROTOCOL side of the webview family: the panels the
 * extensions produced, the HTML they put in them and the messages they sent. This bundle
 * owns the DSH side: the HTTP surface a browser half can read, and the rendering contract
 * with the document preview.
 *
 * The two halves meet at ONE Cordis service:
 *
 *      this bundle:  ctx.provide('vscodeWebviewSurface', surface)
 *      ext host:     ctx.get('vscodeWebviewSurface')
 *
 * A Cordis service lives in the root store, so a sibling plugin can read it
 * (`cordis/src/reflect.ts`: `provide()` writes `this.store[key]`, `get()` reads it back for
 * the isolate symbol every non-isolating scope shares).
 *
 * THE ROUTES
 * ----------
 *      GET  /vscode-ext-host/webview/manifest        the custom editors of the loaded extensions
 *      POST /vscode-ext-host/webview/open            resolve the custom editor of a file
 *      GET  /vscode-ext-host/webview/panel/<handle>  the HTML the extension produced
 *      GET  /vscode-ext-host/webview/messages        the messages the extension sent to the webview
 *      POST /vscode-ext-host/webview/message         a message the webview sent to its extension
 *      GET  /vscode-ext-host/webview/resource        a static file of an extension
 *
 * EVERY route is behind `ctx.connection.authorizeIndex`, the same gate the extension host
 * bundle and the VSIX store use.
 *
 * THE HTML REWRITE
 * ----------------
 * `webview.asWebviewUri(...)` produces an `https://file+.vscode-resource.vscode-cdn.net/...`
 * URL. That host does not exist in DSH, so the surface rewrites those URLs to its own
 * resource route, and relaxes the extension's own CSP just enough for the
 * `acquireVsCodeApi` shim to run.
 *
 * THE WEBVIEW'S OWN ORIGIN
 * ------------------------
 * The panel is served from a SECOND loopback listener, not from the DSH page's origin. The
 * iframe therefore loads from an origin of its own, which is what lets it run with
 * `allow-same-origin` (and so keep its `localStorage`) while still being unable to reach
 * the application's DOM, cookies or storage.
 */

import { readFileSync, statSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';

/** Services this plugin needs. */
export const inject = ['profileContext', 'webServer', 'connection'];

/** The name of the service the extension host bundle reads. */
export const SURFACE_SERVICE = 'vscodeWebviewSurface';

/** The route prefix every route of this bundle lives under. */
export const ROUTE = '/vscode-ext-host/webview';

/**
 * The path the extension's own static files are served from.
 *
 * It is a PATH PREFIX, not a query: the webview's own HTML carries a `<base href>` that
 * points at one of the extension's files, and every relative URL inside the webview
 * resolves against it. With a path prefix the relative URLs keep resolving into the same
 * directory, exactly as they do in VS Code.
 */
export const RESOURCE_PATH = `${ROUTE}/resource/`;
/** The route prefix: the web server matches a prefix WITHOUT a trailing slash. */
const RESOURCE_ROUTE = `${ROUTE}/resource`;

/**
 * The URL the `acquireVsCodeApi` shim is injected as.
 *
 * TWO DIRECTIONS
 * --------------
 * OUT (the webview to its extension): `acquireVsCodeApi().postMessage(value)` posts an
 * envelope to DSH, which forwards the value to the extension host. The envelope never
 * reaches the extension's own page: it travels to DSH.
 *
 * IN (the extension to the webview): DSH posts the extension's message to the frame AS
 * IT IS — the extension's VALUE, not the wire format and not an envelope of ours — so the
 * page's own `message` listener sees `event.data` exactly as VS Code delivers it. A
 * webview that parses `event.data` (draw.io's editor does: `JSON.parse(event.data)`) only
 * works that way: the value the extension posted was itself a JSON text, and a frame that
 * re-wraps it — or hands it over still encoded — breaks the page.
 */
const SHIM = `<script>(function(){
  if (typeof window.acquireVsCodeApi === 'function') { return; }
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (message) {
        window.parent.postMessage({ __dsh: 'message', payload: message }, '*');
      },
      getState: function () { return undefined; },
      setState: function (state) { /* DSH keeps no webview state */ },
    };
  };
})();</script>`;

/**
 * Rewrite the `asWebviewUri` URLs of an extension's HTML to DSH's resource route.
 *
 * @param {string} html - the extension's HTML.
 * @returns {string} the rewritten HTML.
 */
export function rewriteResourceUrls(html, origin = RESOURCE_PATH) {
	if (typeof html !== 'string') {
		return '';
	}
	const base = String(origin).replace(/\/$/, '');
	let out = html.replace(
		/https:\/\/[a-z0-9+.%-]*\.vscode-resource\.vscode-cdn\.net([^"'()\s]*)/gi,
		(_match, tail) => {
			const withoutQuery = String(tail).split('?')[0];
			let decoded = withoutQuery;
			try {
				decoded = decodeURIComponent(withoutQuery);
			} catch {
				/* keep the encoded form when it is not valid percent-encoding */
			}
			// `encodeURI` keeps the slashes, so the directory structure survives and the
			// relative URLs of the webview still resolve into the extension's own tree.
			return `${base}/resource/${encodeURI(decoded).replace(/^\//, '')}`;
		},
	);
	// The CSP source of a webview (`webview.cspSource`) points at `https://<id>.vscode-cdn.net`.
	// There is no such host in DSH, so it becomes the webview's own origin.
	out = out.replace(/https:\/\/[a-z0-9.%-]*\.vscode-cdn\.net/gi, `${base}/resource`);
	return out;
}

/**
 * Let the extension's own CSP run the injected shim.
 *
 * The iframe runs on the WEBVIEW'S OWN ORIGIN, a second loopback listener the Host owns:
 * the extension's script therefore cannot reach the application's DOM, cookies or storage.
 * The CSP relaxation only lets the SHIM run.
 *
 * @param {string} html - the extension's HTML.
 * @returns {string} the relaxed HTML.
 */
export function relaxCsp(html) {
	if (typeof html !== 'string') {
		return '';
	}
	return html.replace(
		/(<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=["'])([^"']*)(["'])/gi,
		(match, open, policy, close) => {
			if (/script-src/i.test(policy)) {
				return `${open}${policy.replace(/script-src([^;]*)/i, (_m, rest) => `script-src${rest} 'unsafe-inline'`)}${close}`;
			}
			return `${open}${policy}; script-src 'unsafe-inline'${close}`;
		},
	);
}

/**
 * Put the shim in front of the extension's own content.
 *
 * @param {string} html - the extension's HTML.
 * @returns {string} the HTML with the shim in it.
 */
export function injectShim(html) {
	if (typeof html !== 'string' || html.length === 0) {
		return html;
	}
	const head = /<head[^>]*>/i.exec(html);
	if (head !== null) {
		const at = head.index + head[0].length;
		return `${html.slice(0, at)}${SHIM}${html.slice(at)}`;
	}
	const body = /<body[^>]*>/i.exec(html);
	if (body !== null) {
		const at = body.index + body[0].length;
		return `${html.slice(0, at)}${SHIM}${html.slice(at)}`;
	}
	return `${SHIM}${html}`;
}

/**
 * The DSH side of the webview surface.
 */
class WebviewSurface {
	/**
	 * @param ctx - the DSH Host plugin context.
	 */
	constructor(ctx) {
		this.ctx = ctx
		/** The bridge the extension host bundle installs. */
		this.bridge = undefined
		/** The webview's own origin: a second loopback listener, so the webview is a
	 * DIFFERENT origin from the DSH page. That is what lets the iframe use
	 * `allow-same-origin` (and therefore localStorage) without being able to
	 * reach the DSH page's DOM, cookies, or storage. */
		this._server = undefined;
		this._origin = '';

	/** The panels the extensions produced, by handle. */
		this.panels = new Map()
		/** The messages the extensions sent to their webviews, by handle. */
		this.outbound = new Map()
		/** The webview views the extensions registered, by view type. */
		this.views = new Map()
	}

	/**
	 * Install the bridge the extension host bundle provides.
	 *
	 * @param {object} bridge - the bridge.
	 */
	setBridge(bridge) {
		this.bridge = bridge
	}

	/**
	 * The extensions the host loaded.
	 *
	 * @returns {Array<object>} the extensions.
	 */
	extensions() {
		return this.bridge?.extensions?.() ?? []
	}

	/**
	 * Record that a webview panel exists.
	 *
	 * @param {string} handle - the webview's handle.
	 * @param {string} viewType - the webview's view type.
	 * @param {string} extensionId - the owning extension.
	 * @param {string} title - the panel's title.
	 */
	announcePanel(handle, viewType, extensionId, title) {
		// MERGE, never replace: the custom editor path produces the HTML BEFORE the panel is
		// announced, so the record already carries the HTML when the announcement arrives.
		const existing = this.panels.get(handle)
		if (existing !== undefined) {
			if (viewType) { existing.viewType = viewType }
			if (extensionId) { existing.extensionId = extensionId }
			if (title) { existing.title = title }
			return
		}
		this.panels.set(handle, { handle, viewType, extensionId, title })
	}

	/**
	 * The HTML the extension produced for a webview.
	 *
	 * @param {string} handle - the webview's handle.
	 * @param {string} html - the extension's HTML.
	 */
	setHtml(handle, html) {
		const panel = this.panels.get(handle) ?? { handle, viewType: '', extensionId: '', title: '' }
		panel.html = injectShim(relaxCsp(rewriteResourceUrls(html, this.origin())))
		// The revision counts the rewrites: an extension replaces the HTML of a webview it
		// already has (draw.io does it when the colour scheme changes), and the browser
		// half has to notice that the panel it shows is no longer the one it fetched.
		panel.revision = (panel.revision ?? 0) + 1
		this.panels.set(handle, panel)
	}

	/**
	 * The revision of a panel's HTML.
	 *
	 * @param {string} handle - the webview's handle.
	 * @returns the revision, 0 when the extension never produced HTML.
	 */
	panelRevision(handle) {
		return this.panels.get(handle)?.revision ?? 0
	}

	/**
	 * The content options the extension set.
	 *
	 * @param {string} handle - the webview's handle.
	 * @param {unknown} options - the options.
	 */
	setOptions(handle, options) {
		const panel = this.panels.get(handle) ?? { handle, viewType: '', extensionId: '', title: '' }
		panel.options = options
		this.panels.set(handle, panel)
	}

	/**
	 * Queue a message the extension sent to its webview.
	 *
	 * @param {string} handle - the webview's handle.
	 * @param {string} value - the JSON serialized message.
	 * @param {Array<unknown>} buffers - the binary buffers.
	 */
	queueMessage(handle, value, buffers) {
		const queue = this.outbound.get(handle) ?? []
		queue.push({ value, buffers: buffers ?? [] })
		this.outbound.set(handle, queue)
	}

	/**
	 * Forget a webview.
	 *
	 * @param {string} handle - the webview's handle.
	 */
	disposePanel(handle) {
		this.panels.delete(handle)
		this.outbound.delete(handle)
	}

	/**
	 * A webview was asked to be shown; DSH renders it where the file is previewed.
	 *
	 * @param {string} handle - the webview's handle.
	 */
	revealPanel(handle) {
		const panel = this.panels.get(handle)
		if (panel !== undefined) {
			panel.revealed = true
		}
	}

	/**
	 * The panel's title changed.
	 *
	 * @param {string} handle - the webview's handle.
	 * @param {string} title - the new title.
	 */
	setPanelTitle(handle, title) {
		const panel = this.panels.get(handle)
		if (panel !== undefined) {
			panel.title = title
		}
	}

	/**
	 * The panel's icon changed.
	 *
	 * @param {string} handle - the webview's handle.
	 * @param {unknown} icon - the icon.
	 */
	setPanelIcon(handle, icon) {
		const panel = this.panels.get(handle)
		if (panel !== undefined) {
			panel.icon = icon
		}
	}

	/**
	 * A webview view provider was registered.
	 *
	 * @param {string} viewType - the view type.
	 * @param {string} extensionId - the owning extension.
	 */
	registerView(viewType, extensionId) {
		this.views.set(viewType, { viewType, extensionId })
	}

	/**
	 * A webview view provider was unregistered.
	 *
	 * @param {string} viewType - the view type.
	 */
	unregisterView(viewType) {
		this.views.delete(viewType)
	}

	/**
	 * The view's title changed.
	 *
	 * @param {string} handle - the webview's handle.
	 */
	setViewTitle(handle) {
		void handle
	}

	/**
	 * The view's description changed.
	 *
	 * @param {string} handle - the webview's handle.
	 */
	setViewDescription(handle) {
		void handle
	}

	/**
	 * The view's badge changed.
	 *
	 * @param {string} handle - the webview's handle.
	 */
	setViewBadge(handle) {
		void handle
	}

	/**
	 * The extension asked for its view to be shown; DSH has no view container.
	 *
	 * @param {string} handle - the webview's handle.
	 */
	showView(handle) {
		void handle
	}

	/**
	 * The custom editors the loaded extensions declare.
	 *
	 * The MANIFEST is the source of truth: a file can be opened before the extension ever
	 * ran, and VS Code itself picks the editor from `contributes.customEditors` alone.
	 *
	 * @returns {object} the manifest.
	 */
	manifest() {
		const editors = []
		const suffixes = new Set()
		for (const extension of this.extensions()) {
			const contributed = extension.manifest?.contributes?.customEditors ?? []
			for (const editor of contributed) {
				if (typeof editor?.viewType !== 'string') {
					continue
				}
				const patterns = (Array.isArray(editor?.selector) ? editor.selector : [])
					.map((selector) => selector?.filenamePattern)
					.filter((pattern) => typeof pattern === 'string')
				for (const pattern of patterns) {
					for (const suffix of suffixesOf(pattern)) {
						suffixes.add(suffix)
					}
				}
				editors.push({
					viewType: editor.viewType,
					extensionId: extension.extensionId,
					displayName: typeof editor?.displayName === 'string' ? editor.displayName : editor.viewType,
					priority: typeof editor?.priority === 'string' ? editor.priority : 'default',
					patterns,
					// The suffixes THIS editor claims: one editor may claim fewer files
					// than another (draw.io has a text editor and a binary one), and the
					// browser half registers one renderer per editor.
					suffixes: patterns.flatMap((pattern) => suffixesOf(pattern)),
				})
			}
		}
		return { editors, suffixes: [...suffixes]}
	}

	/**
	 * Resolve the custom editor of a file and remember the panel it produced.
	 *
	 * @param {string} path - the absolute path of the file.
	 * @param {string} title - the title the panel should carry.
	 * @returns {Promise<object>} the panel's identity.
	 */
	async open(path, title, viewType) {
		if (this.bridge === undefined) {
			throw new Error('the extension host is not running')
		}
		const opened = await this.bridge.resolveCustomEditor(path, title, viewType)
		if (opened === undefined) {
			throw new Error(`no VSCode extension claims "${path}"`)
		}
		this.announcePanel(opened.handle, opened.viewType, opened.extensionId, title)
		return opened
	}

	/**
	 * Start the webview's own origin: a second loopback listener that serves the
	 * webview's HTML and the extension's files, and nothing else.
	 * @returns {Promise<string>} the origin.
	 */
	startOrigin() {
		if (this._server !== undefined) {
			return Promise.resolve(this._origin);
		}
		return new Promise((resolve, reject) => {
			const server = createServer((req, res) => {
				try {
					this._serveOrigin(req, res);
				} catch (error) {
					res.statusCode = 500;
					res.end(String(error instanceof Error ? error.message : error));
				}
			});
			server.on('error', reject);
			server.listen(0, '127.0.0.1', () => {
				const address = server.address();
				const port = typeof address === 'object' && address !== null ? address.port : 0;
				this._server = server;
				this._origin = `http://127.0.0.1:${port}`;
				resolve(this._origin);
			});
		});
	}

	/**
	 * The webview's own origin.
	 * @returns {string} the origin, empty before the listener is up.
	 */
	origin() {
		return this._origin;
	}

	/**
	 * Stop the webview's own origin.
	 * @returns {Promise<void>} after the listener is closed.
	 */
	stopOrigin() {
		const server = this._server;
		this._server = undefined;
		this._origin = '';
		return new Promise((resolve) => {
			if (server === undefined) {
				resolve();
				return;
			}
			server.close(() => resolve());
		});
	}

	/**
	 * Answer one request on the webview's own origin.
	 * @param {object} req - the Node request.
	 * @param {object} res - the Node response.
	 */
	_serveOrigin(req, res) {
		const pathname = new URL(String(req.url ?? '/'), 'http://127.0.0.1').pathname;
		if (pathname.startsWith('/panel/')) {
			const handle = decodeURIComponent(pathname.slice('/panel/'.length));
			const html = this.panelHtml(handle);
			if (html.length === 0) {
				res.statusCode = 404;
				res.setHeader('content-type', 'text/plain; charset=utf-8');
				res.end('no such webview');
				return;
			}
			res.statusCode = 200;
			res.setHeader('content-type', 'text/html; charset=utf-8');
			res.setHeader('cache-control', 'no-store');
			res.end(html);
			return;
		}
		if (pathname.startsWith('/resource/')) {
			let path = decodeURIComponent(pathname.slice('/resource/'.length));
			if (!path.startsWith('/')) {
				path = `/${path}`;
			}
			const file = this.resource(path);
			if (file === undefined) {
				res.statusCode = 404;
				res.setHeader('content-type', 'text/plain; charset=utf-8');
				res.end('no such resource');
				return;
			}
			res.statusCode = 200;
			res.setHeader('content-type', file.contentType);
			res.setHeader('cache-control', 'no-store');
			res.end(file.bytes);
			return;
		}
		res.statusCode = 404;
		res.end('not found');
	}

	/**
	 * The HTML of a panel.
	 *
	 * @param {string} handle - the webview's handle.
	 * @returns {string} the HTML.
	 */
	panelHtml(handle) {
		return this.panels.get(handle)?.html ?? ''
	}

	/**
	 * Take the queued messages of a webview.
	 *
	 * @param {string} handle - the webview's handle.
	 * @returns {Array<object>} the messages.
	 */
	drainMessages(handle) {
		const queue = this.outbound.get(handle) ?? []
		this.outbound.delete(handle)
		return queue
	}

	/**
	 * Deliver a message the webview sent to its extension.
	 *
	 * @param {string} handle - the webview's handle.
	 * @param {unknown} message - the message.
	 * @returns {Promise<void>} after the message was handed over.
	 */
	async deliverMessage(handle, message) {
		if (this.bridge === undefined) {
			throw new Error('the extension host is not running')
		}
		const json = JSON.stringify(message ?? null)
		await this.bridge.postFromWebview(handle, json, [])
	}

	/**
	 * Read a static file of an extension.
	 *
	 * The file has to live inside the `extension/` subtree of a LOADED extension. Anything
	 * else is refused: the route takes an absolute path, and without this check it would be
	 * a read-any-file primitive.
	 *
	 * @param {string} absolutePath - the absolute path of the file.
	 * @returns {{ bytes: Buffer, contentType: string } | undefined} the file, or undefined.
	 */
	resource(absolutePath) {
		const target = resolve(String(absolutePath))
		for (const extension of this.extensions()) {
			const root = resolve(extension.extensionPath)
			if (target !== root && !target.startsWith(root + sep)) {
				continue
			}
			try {
				const stats = statSync(target)
				if (!stats.isFile()) {
					return undefined
				}
				return { bytes: readFileSync(target), contentType: contentTypeOf(target) }
			} catch {
				return undefined
			}
		}
		return undefined
	}
}

/**
 * The suffixes a `filenamePattern` claims.
 *
 * A selector may carry several patterns in one - `{*.csv,*.tsv,*.xls}` - and every
 * alternative claims its own suffix.
 *
 * @param {string} pattern - the glob.
 * @returns {Array<string>} the suffixes.
 */
function suffixesOf(pattern) {
	const suffixes = []
	for (const expanded of expandBraces(pattern)) {
		const star = expanded.indexOf('*')
		if (star < 0) {
			continue
		}
		const suffix = expanded.slice(star + 1).replace(/^\*\*\/?/, '').toLowerCase()
		if (suffix.length === 0 || suffix.includes('*') || suffix.includes('?')) {
			continue
		}
		suffixes.push(suffix)
	}
	return suffixes
}

/**
 * Expand the brace form of a `filenamePattern`.
 *
 * @param {string} pattern - the glob.
 * @returns {Array<string>} the patterns the brace form stands for.
 */
function expandBraces(pattern) {
	const open = pattern.indexOf('{')
	if (open < 0) {
		return [pattern]
	}
	const close = pattern.indexOf('}', open)
	if (close < 0) {
		return [pattern]
	}
	const prefix = pattern.slice(0, open)
	const suffix = pattern.slice(close + 1)
	const expanded = []
	for (const alternative of pattern.slice(open + 1, close).split(',')) {
		expanded.push(...expandBraces(prefix + alternative + suffix))
	}
	return expanded
}

/**
 * The content type of a static file.
 *
 * @param {string} path - the file's path.
 * @returns {string} the content type.
 */
function contentTypeOf(path) {
	const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
	const types = {
		'.css': 'text/css; charset=utf-8',
		'.gif': 'image/gif',
		'.html': 'text/html; charset=utf-8',
		'.jpeg': 'image/jpeg',
		'.jpg': 'image/jpeg',
		'.js': 'text/javascript; charset=utf-8',
		'.json': 'application/json; charset=utf-8',
		'.mjs': 'text/javascript; charset=utf-8',
		'.png': 'image/png',
		'.svg': 'image/svg+xml',
		'.wasm': 'application/wasm',
		'.webp': 'image/webp',
		'.woff': 'font/woff',
		'.woff2': 'font/woff2',
	}
	return types[extension] ?? 'application/octet-stream'
}

/**
 * Apply the plugin.
 *
 * @param {object} ctx - the Host plugin context.
 */
export function apply(ctx, log) {
	const surface = new WebviewSurface(ctx)
	const note = (message) => { try { log?.(message) } catch { /* the log is best effort */ } }
	// The webview gets its OWN origin: a second loopback listener serves the
	// webview's HTML and the extension's files. The iframe is then cross-origin
	// from the DSH page, so it can be given `allow-same-origin` (and therefore
	// localStorage) without ever reaching the page's DOM or cookies.
	const originReady = surface.startOrigin().catch(() => '')
	ctx.provide(SURFACE_SERVICE, surface)

	ctx.effect(() => {
		void originReady;
		return () => { void surface.stopOrigin(); };
	}, 'vscode-webview-surface: origin')

	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: `${ROUTE}/manifest`,
		handler: (req, res) => {
			if (!ctx.connection.authorizeIndex(req, res)) return
			const answer = { ...surface.manifest(), origin: surface.origin() }
			note(`the webview manifest was asked for: ${answer.editors.length} editor(s), suffixes ${JSON.stringify(answer.suffixes)}`)
			sendJson(res, 200, answer)
		},
	}), 'vscode-webview-surface: manifest')

	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: `${ROUTE}/open`,
		handler: async (req, res) => {
			if (!ctx.connection.authorizeIndex(req, res)) return
			try {
				const body = await readJson(req)
				const path = typeof body?.path === 'string' ? body.path : ''
				const title = typeof body?.title === 'string' ? body.title : ''
				// The editor the person chose (VS Code's `openWith`); the best match
				// when it is omitted.
				const viewType = typeof body?.viewType === 'string' ? body.viewType : undefined
				if (path.length === 0) {
					sendJson(res, 400, { ok: false, error: 'no path' })
					return
				}
				const opened = await surface.open(path, title, viewType)
				sendJson(res, 200, { ok: true, ...opened })
			} catch (error) {
				sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
			}
		},
	}), 'vscode-webview-surface: open')

	ctx.effect(() => ctx.webServer.register({
		kind: 'prefix',
		path: `${ROUTE}/panel`,
		handler: (req, res) => {
			if (!ctx.connection.authorizeIndex(req, res)) return
			const pathname = new URL(String(req.url), 'http://localhost').pathname
			const handle = pathname.slice(`${ROUTE}/panel/`.length)
			const html = surface.panelHtml(decodeURIComponent(handle))
			if (html.length === 0) {
				res.statusCode = 404
				res.setHeader('content-type', 'text/plain; charset=utf-8')
				res.end('no such webview')
				return
			}
			res.statusCode = 200
			res.setHeader('content-type', 'text/html; charset=utf-8')
			res.setHeader('cache-control', 'no-store')
			// The revision of the HTML: the browser half loads the frame with it, so a
			// panel the extension rewrote is loaded again instead of shown stale.
			res.setHeader('x-dsh-panel-revision', String(surface.panelRevision(decodeURIComponent(handle))))
			res.end(html)
		},
	}), 'vscode-webview-surface: panel')

	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: `${ROUTE}/messages`,
		handler: (req, res) => {
			if (!ctx.connection.authorizeIndex(req, res)) return
			const query = new URL(String(req.url), 'http://localhost').searchParams
			const handle = query.get('handle') ?? ''
			sendJson(res, 200, {
				ok: true,
				messages: surface.drainMessages(handle),
				// The panel's revision, so the browser half learns that the extension
				// rewrote the HTML and the frame has to be loaded again.
				panelRevision: surface.panelRevision(handle),
			})
		},
	}), 'vscode-webview-surface: messages')

	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: `${ROUTE}/message`,
		handler: async (req, res) => {
			if (!ctx.connection.authorizeIndex(req, res)) return
			try {
				const body = await readJson(req)
				const handle = typeof body?.handle === 'string' ? body.handle : ''
				await surface.deliverMessage(handle, body?.message)
				sendJson(res, 200, { ok: true })
			} catch (error) {
				sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
			}
		},
	}), 'vscode-webview-surface: message')

	ctx.effect(() => ctx.webServer.register({
		kind: 'prefix',
		path: RESOURCE_ROUTE,
		handler: (req, res) => {
			if (!ctx.connection.authorizeIndex(req, res)) return
			const pathname = new URL(String(req.url), 'http://localhost').pathname
			let path = pathname.slice(RESOURCE_ROUTE.length)
			try {
				path = decodeURIComponent(path)
			} catch {
				/* keep the encoded form when it is not valid percent-encoding */
			}
			// The rewrite keeps the leading slash out of the URL path, so it is restored
			// here: the resource is an ABSOLUTE path on the Host.
			const file = surface.resource(path.startsWith('/') ? path : `/${path}`)
			if (file === undefined) {
				res.statusCode = 404
				res.setHeader('content-type', 'text/plain; charset=utf-8')
				res.end('no such resource')
				return
			}
			res.statusCode = 200
			res.setHeader('content-type', file.contentType)
			res.setHeader('cache-control', 'public, max-age=3600')
			res.end(file.bytes)
		},
	}), 'vscode-webview-surface: resource')
}

/**
 * Write a JSON response.
 *
 * @param {object} res - the Node response.
 * @param {number} status - the status code.
 * @param {unknown} payload - the body.
 */
function sendJson(res, status, payload) {
	const body = JSON.stringify(payload)
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(body),
		'cache-control': 'no-store',
	})
	res.end(body)
}

/**
 * Read a JSON request body.
 *
 * @param {object} req - the Node request.
 * @returns {Promise<object>} the body.
 */
function readJson(req) {
	return new Promise((resolvePromise, reject) => {
		let text = ''
		req.setEncoding?.('utf8')
		req.on('data', (chunk) => {
			text += chunk
			if (text.length > 5_000_000) reject(new Error('the request body is too large'))
		})
		req.on('end', () => {
			try {
				resolvePromise(text.length === 0 ? {} : JSON.parse(text))
			} catch (error) {
				reject(new Error(`the request body is not JSON: ${error instanceof Error ? error.message : String(error)}`))
			}
		})
		req.on('error', reject)
	})
}
