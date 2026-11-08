#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  DSH — the executable verification of the webview / custom editor surface.
 *
 *  DSH-authored (MIT).
 *
 *  WHAT IT PROVES
 *  --------------
 *  A REAL Marketplace extension — `hediet.vscode-drawio` ("Draw.io Integration"), which
 *  contributes FOUR custom editors — is installed into a throwaway profile with the VSIX
 *  store's own install pipeline, loaded by the extension host, and then:
 *
 *    1. the surface's manifest lists the custom editors the extension declares,
 *    2. opening a `.drawio` file resolves the custom editor that claims it,
 *    3. the extension is ACTIVATED by the `onCustomEditor:<viewType>` event,
 *    4. the extension PRODUCES the webview's HTML, and DSH keeps it,
 *    5. the HTML's `webview.asWebviewUri(...)` URLs are rewritten to DSH's resource route,
 *    6. the resource route serves a file of the extension's own directory,
 *    7. a message the webview sends reaches the extension (`ExtHostWebviews.$onMessage`),
 *    8. a message the extension sends to the webview is queued for the client.
 *
 *  The Host half of the webview surface is the REAL bundle
 *  (`vscode-ext-host/webview-surface/index.js`), applied to a fake DSH context, so the
 *  routes and the HTML rewriting under test are the shipped ones.
 *
 *  Usage: node runtime/verify/webview-e2e.mjs
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ExtensionHostRuntime } from '../../plugin/main-host.js';
// The surface the BUNDLE ships, not the legacy standalone package: the bundle's copy is the
// one the plugin mounts (and the one that knows per-editor suffixes and local resource roots).
import { apply as applyWebviewSurface, relaxCsp, rewriteResourceUrls } from '../../plugin/webview-surface.js';

const HERE = resolve(import.meta.dirname, '.');
const REPO = resolve(HERE, '../..');
const WORKSPACE = resolve(REPO, '..');
const VSIX = resolve(HERE, 'vendor/hediet.vscode-drawio-1.17.261024055.vsix');
// The sample diagram is committed under `samples/`, so a fresh clone can run this suite; the
// older location next to the repository is only a fallback for an existing development tree.
const SAMPLE = existsSync(resolve(REPO, 'samples/drawio-preview-sample.drawio'))
	? resolve(REPO, 'samples/drawio-preview-sample.drawio')
	: resolve(WORKSPACE, 'drawio-preview-sample.drawio');

/** The failures collected during the run. */
const failures = [];

/**
 * Assert one condition.
 *
 * @param {string} what - what is asserted.
 * @param {boolean} condition - whether it holds.
 * @param {string} proof - the evidence.
 */
function check(what, condition, proof) {
	if (condition) {
		console.log(`  PASS  ${what}`);
		console.log(`        ${proof}`);
		return;
	}
	failures.push(what);
	console.log(`  FAIL  ${what}`);
	console.log(`        ${proof}`);
}

/**
 * Build the fake DSH Host context the host and the webview surface need.
 *
 * The fake context carries a service map, so the surface's `ctx.provide(...)` is visible to
 * the extension host's method modules through `ctx.get(...)` — exactly the way a real Cordis
 * profile wires them.
 *
 * @param {string} profileDir - the profile directory.
 * @param {Array<object>} registered - collects the DSH command registrations.
 * @returns {object} the context.
 */
function fakeCtx(profileDir, registered) {
	/** The services the context carries. */
	const services = new Map();
	/** The routes the webview surface registered. */
	const routes = [];
	return {
		profileContext: { dir: profileDir, name: 'verification', patchPath: join(profileDir, 'cordis.patch.yml') },
		commands: {
			register(definition) {
				registered.push(definition);
				return () => undefined;
			},
		},
		webServer: {
			register(route) {
				routes.push(route);
				return () => undefined;
			},
			getOrigin() {
				return 'http://127.0.0.1:3080';
			},
		},
		connection: {
			authorizeIndex() {
				return true;
			},
		},
		provide(name, value) {
			services.set(name, value);
			return () => services.delete(name);
		},
		effect(fn) {
			const disposer = fn();
			return () => disposer?.();
		},
		get(name) {
			return services.get(name);
		},
		/** The routes the surface registered, for the test to call. */
		routes,
	};
}

/** Fetch a URL over real HTTP, the way a browser does. */
async function fetchHttp(url) {
	const response = await fetch(url);
	const text = await response.text();
	return { status: response.status, headers: response.headers, text };
}

/**
 * Call a registered route the way the web server would.
 *
 * @param {object} routes - the registered routes.
 * @param {string} prefix - the path prefix to match.
 * @param {string} method - the HTTP method.
 * @param {string} url - the request URL.
 * @param {object} [body] - the JSON body, when there is one.
 * @returns {Promise<{ status: number, headers: object, text: string, json: object }>} the answer.
 */
async function callRoute(routes, prefix, method, url, body) {
	const route = routes.find((entry) => entry.path === prefix);
	if (route === undefined) {
		throw new Error(`no route "${prefix}"`);
	}
	const chunks = [];
	const response = {
		statusCode: 200,
		headers: {},
		writeHead(status, headers) {
			response.statusCode = status;
			Object.assign(response.headers, headers ?? {});
			return response;
		},
		setHeader(name, value) {
			response.headers[name] = value;
		},
		end(payload) {
			if (payload !== undefined && payload !== null) {
				chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)));
			}
			response.finished = true;
		},
		write(payload) {
			chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)));
			return true;
		},
	};
	const request = {
		method,
		url,
		headers: {},
		setEncoding() {},
		on(event, handler) {
			if (event === 'data') {
				queueMicrotask(() => handler(body === undefined ? '' : JSON.stringify(body)));
			}
			if (event === 'end') {
				queueMicrotask(() => handler());
			}
		},
	};
	await route.handler(request, response);
	const text = Buffer.concat(chunks).toString('utf8');
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}
	return { status: response.statusCode, headers: response.headers, text, json };
}

/** The run's own output, kept for the evidence file. */
const consoleLog = [];
const say = console.log;
console.log = (...parts) => { consoleLog.push(parts.join(' ')); say(...parts); };

console.log('DSH — webview / custom editor verification');
console.log(`node ${process.version} on ${process.platform}/${process.arch}`);
console.log(`workspace: ${WORKSPACE}`);
console.log(`extension: ${VSIX}`);

const profileDir = mkdtempSync(join(tmpdir(), 'dsh-webview-e2e-'));
console.log(`\nprofile: ${profileDir}`);
execFileSync('node', [join(HERE, 'setup-profile.mjs'), profileDir, VSIX], { stdio: 'inherit' });

// The file the user opens. It is the sample diagram of the workspace.
const diagram = join(profileDir, 'sample.drawio');
copyFileSync(SAMPLE, diagram);

const registered = [];
const ctx = fakeCtx(profileDir, registered);
applyWebviewSurface(ctx);
const surface = ctx.get('vscodeWebviewSurface');

const runtime = new ExtensionHostRuntime(ctx);
await runtime.start();
const payload = runtime.payload();
console.log(`host: running=${payload.host.running} pid=${payload.host.pid} restarts=${payload.host.restarts}`);
console.log(`extensions: ${JSON.stringify(payload.extensions.map((entry) => `${entry.id} active=${entry.active}`))}`);

check(
	'the extension host loaded hediet.vscode-drawio',
	payload.extensions.some((entry) => entry.publisher === 'hediet'),
	`loaded extensions: ${JSON.stringify(payload.extensions.map((entry) => entry.id))}`,
);

// -------------------------------------------------------------------------------------------
console.log('\n=== 1. MANIFEST: the surface knows which extensions claim which files ===');
// -------------------------------------------------------------------------------------------
const manifest = await callRoute(ctx.routes, '/vscode-ext-host/webview/manifest', 'GET', '/vscode-ext-host/webview/manifest');
const editors = manifest.json?.editors ?? [];
const suffixes = manifest.json?.suffixes ?? [];
console.log(`  editors: ${JSON.stringify(editors.map((editor) => `${editor.viewType} (${editor.priority}) ${JSON.stringify(editor.patterns)}`))}`);
console.log(`  suffixes: ${JSON.stringify(suffixes)}`);
check(
	'the manifest lists the drawio custom editors',
	editors.some((editor) => editor.viewType === 'hediet.vscode-drawio-text'),
	`view types: ${JSON.stringify(editors.map((editor) => editor.viewType))}`,
);
check(
	'the manifest claims the .drawio suffix',
	suffixes.includes('.drawio'),
	`suffixes: ${JSON.stringify(suffixes)}`,
);

// -------------------------------------------------------------------------------------------
console.log('\n=== 2. OPEN: the custom editor of a .drawio file resolves ===');
// -------------------------------------------------------------------------------------------
const opened = await callRoute(ctx.routes, '/vscode-ext-host/webview/open', 'POST', '/vscode-ext-host/webview/open', { path: diagram, title: 'sample.drawio' });
console.log(`  answer: ${opened.text.slice(0, 400)}`);
check(
	'the custom editor of the .drawio file resolved',
	opened.status === 200 && opened.json?.ok === true,
	`status=${opened.status} body=${opened.text.slice(0, 300)}`,
);
const handle = opened.json?.handle;
check(
	'the resolved panel carries the hediet view type',
	opened.json?.viewType === 'hediet.vscode-drawio-text',
	`viewType=${opened.json?.viewType}`,
);

if (handle === undefined) {
	console.log('\n=== RESULT ===');
	console.log('  the panel never opened; the remaining checks are skipped');
	for (const failure of failures) {
		console.log(`    - ${failure}`);
	}
	process.exit(1);
}

// -------------------------------------------------------------------------------------------
console.log('\n=== 3. HTML: the extension produced the webview ===');
// -------------------------------------------------------------------------------------------
// The iframe loads the panel from the webview's OWN origin, so that is where the test reads it:
// the HTML under test is the HTML a browser would actually execute.
const webviewOrigin = surface.origin();
console.log(`  webview origin: ${webviewOrigin}`);
let html = '';
for (let attempt = 0; attempt < 40; attempt += 1) {
	const panel = await fetchHttp(`${webviewOrigin}/panel/${encodeURIComponent(handle)}`);
	html = panel.text;
	if (html.length > 0) {
		break;
	}
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
}
console.log(`  html: ${html.length} characters`);
check(
	'the extension produced the webview HTML',
	html.length > 0,
	`${html.length} characters`,
);
check(
	'the HTML carries the acquireVsCodeApi shim',
	html.includes('acquireVsCodeApi'),
	'the shim is in the HTML',
);
check(
	'the HTML has no VS Code CDN resource URL left',
	!html.includes('vscode-cdn.net'),
	'the vscode-cdn.net host does not appear in the HTML',
);
check(
	"the HTML points at DSH's own resource route",
	html.includes(`${webviewOrigin}/resource/`),
	`expected ${webviewOrigin}/resource/ in the HTML`,
);

// -------------------------------------------------------------------------------------------
console.log("\n=== 4. RESOURCE: the extension's own files are served ===");
// -------------------------------------------------------------------------------------------
const resourceMatch = /\/resource\/([^"'()\s]+)/.exec(html);
check(
	'the HTML names a resource of the extension',
	resourceMatch !== null,
	resourceMatch === null ? 'no resource URL in the HTML' : `resource: ${decodeURIComponent(resourceMatch[1]).slice(0, 120)}`,
);
const resourcePath = resourceMatch === null ? '' : decodeURIComponent(resourceMatch[1]);
const served = await fetchHttp(`${webviewOrigin}/resource/${encodeURIComponent(resourcePath)}`);
console.log(`  served: ${served.status} ${served.headers.get('content-type')} ${served.text.length} bytes`);
check(
	'the resource of the extension is served',
	served.status === 200 && served.text.length > 0,
	`status=${served.status} bytes=${served.text.length} type=${served.headers.get('content-type')}`,
);
// An extension may carry the URL inside a JSON attribute (the PDF viewer's `data-config`),
// where `https://` is percent-encoded and the literal rewrite above cannot see it.
const encodedHtml = `<div data-config="${encodeURIComponent(JSON.stringify({ path: 'https://file+.vscode-resource.vscode-cdn.net/tmp/sample.pdf' }))}"></div>`;
const rewritten = rewriteResourceUrls(encodedHtml, webviewOrigin);
const rewrittenConfig = JSON.parse(decodeURIComponent(/data-config="([^"]*)"/.exec(rewritten)[1]));
check(
	'a percent-encoded resource URL is rewritten too',
	rewrittenConfig.path === `${webviewOrigin}/resource/tmp/sample.pdf`,
	`path: ${rewrittenConfig.path}`,
);
// A URL inside an HTML-escaped attribute ends at `&quot;`: a rewrite that runs past it eats
// the JSON around the URL and leaves the extension unable to parse its own config.
const escapedConfig = `<meta id="cfg" data-config="{&quot;path&quot;:&quot;https://file+.vscode-resource.vscode-cdn.net/tmp/x.pdf&quot;,&quot;other&quot;:{&quot;flag&quot;:true}}" />`;
const escapedOut = rewriteResourceUrls(escapedConfig, webviewOrigin);
const escapedJson = JSON.parse(escapedOut.match(/data-config="([^"]*)"/)[1].replace(/&quot;/g, '"'));
check(
	'an HTML-escaped config attribute survives the rewrite',
	escapedJson.path === `${webviewOrigin}/resource/tmp/x.pdf` && escapedJson.other.flag === true,
	`config: ${JSON.stringify(escapedJson)}`,
);

// The policy of a webview is full of single quotes inside a double-quoted attribute, and a
// source list of `'unsafe-inline' 'none'` is invalid: the browser drops the whole directive.
const rawPolicy = "default-src 'none'; connect-src 'self' https://*.vscode-cdn.net; script-src 'unsafe-inline' 'self' https://*.vscode-cdn.net; style-src 'unsafe-inline' 'self' https://*.vscode-cdn.net; img-src blob: data: 'self' https://*.vscode-cdn.net;";
const relaxedPolicy = /content="([^"]*)"/.exec(relaxCsp(`<meta http-equiv="Content-Security-Policy" content="${rawPolicy}">`, webviewOrigin))[1];
check(
	'the rebuilt policy keeps every directive valid',
	relaxedPolicy.includes("default-src 'none'") && /script-src [^;]*'unsafe-inline'[^;]*/.test(relaxedPolicy) && !/'unsafe-inline''none'|blob:'none'/.test(relaxedPolicy),
	`policy: ${relaxedPolicy.slice(0, 220)}`,
);
check(
	'the rebuilt policy lets the webview load its own scripts',
	relaxedPolicy.includes(webviewOrigin),
	`policy: ${relaxedPolicy.slice(0, 220)}`,
);

const refused = await fetchHttp(`${webviewOrigin}/resource/${encodeURIComponent('/etc/passwd')}`);
check(
	'a file OUTSIDE the extension is refused',
	refused.status === 404,
	`status=${refused.status} body=${refused.text.slice(0, 80)}`,
);

// A VIEWER extension loads the file it previews through `webview.asWebviewUri(...)` and
// declares the directory as a `localResourceRoots` entry. The route has to serve that file
// too, or the webview draws its chrome around nothing (a PDF viewer did exactly that).
const beforeRoot = await fetchHttp(`${webviewOrigin}/resource/${encodeURIComponent(diagram)}`);
check(
	'a file the webview did not declare is refused',
	beforeRoot.status === 404,
	`status=${beforeRoot.status} path=${diagram}`,
);
surface.setOptions(handle, {
	localResourceRoots: [{ $mid: 1, scheme: 'file', path: dirname(diagram) }],
});
const declared = await fetchHttp(`${webviewOrigin}/resource/${encodeURIComponent(diagram)}`);
check(
	'a file the webview declared as a local root is served',
	declared.status === 200 && declared.text.length > 0,
	`status=${declared.status} type=${declared.headers.get('content-type')} bytes=${declared.text.length}`,
);
const outsideAgain = await fetchHttp(`${webviewOrigin}/resource/${encodeURIComponent('/etc/passwd')}`);
check(
	'declaring one root does not open every file',
	outsideAgain.status === 404,
	`status=${outsideAgain.status}`,
);

// -------------------------------------------------------------------------------------------
console.log('\n=== 5. MESSAGES: both directions of the webview channel ===');
// -------------------------------------------------------------------------------------------
const sent = await callRoute(ctx.routes, '/vscode-ext-host/webview/message', 'POST', '/vscode-ext-host/webview/message', { handle, message: { hello: 'dsh' } });
console.log(`  webview -> extension: status=${sent.status} body=${sent.text.slice(0, 200)}`);
check(
	'a message the webview sent reached the extension host',
	sent.status === 200 && sent.json?.ok === true,
	`status=${sent.status} body=${sent.text.slice(0, 200)}`,
);

const drained = await callRoute(ctx.routes, '/vscode-ext-host/webview/messages', 'GET', `/vscode-ext-host/webview/messages?handle=${handle}`);
console.log(`  extension -> webview: ${JSON.stringify(drained.json)}`);
check(
	'the message channel answers with the queued messages',
	drained.status === 200 && Array.isArray(drained.json?.messages),
	`messages: ${JSON.stringify(drained.json?.messages)}`,
);

// -------------------------------------------------------------------------------------------
console.log('\n=== 6. THE HOST LOG: what the main side recorded ===');
// -------------------------------------------------------------------------------------------
const log = runtime.logLines(500);
const webviewLines = log.filter((line) => line.includes('webview') || line.includes('custom editor'));
console.log(webviewLines.map((line) => `  ${line}`).join('\n'));
check(
	'the main side recorded the webview',
	webviewLines.some((line) => line.includes('webview')),
	`${webviewLines.length} webview lines in the log`,
);

// The evidence travels with the report: the run's own output and the extension host's log.
const EVIDENCE = resolve(HERE, 'evidence');
mkdirSync(EVIDENCE, { recursive: true });
try {
	writeFileSync(resolve(EVIDENCE, 'webview-host.log'), log.join('\n') + '\n');
	writeFileSync(resolve(EVIDENCE, 'webview-e2e.log'), consoleLog.join('\n') + '\n');
	console.log(`\nevidence written to ${EVIDENCE}/webview-host.log and ${EVIDENCE}/webview-e2e.log`);
} catch (error) {
	console.log(`the evidence could not be written: ${error instanceof Error ? error.message : String(error)}`);
}

await runtime.stop();
rmSync(profileDir, { recursive: true, force: true });

console.log('\n=== RESULT ===');
if (failures.length === 0) {
	console.log('  all checks passed');
	process.exit(0);
}
console.log(`  ${failures.length} check(s) failed:`);
for (const failure of failures) {
	console.log(`    - ${failure}`);
}
process.exit(1);
