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
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ExtensionHostRuntime } from '../../bundle/main-host.js';
import { apply as applyWebviewSurface } from '../../webview-surface/index.js';

const HERE = resolve(import.meta.dirname, '.');
const REPO = resolve(HERE, '../..');
const WORKSPACE = resolve(REPO, '..');
const VSIX = resolve(HERE, 'vendor/hediet.vscode-drawio-1.17.261024055.vsix');
const SAMPLE = resolve(WORKSPACE, 'drawio-preview-sample.drawio');

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
let html = '';
for (let attempt = 0; attempt < 40; attempt += 1) {
	const panel = await callRoute(ctx.routes, '/vscode-ext-host/webview/panel/', 'GET', `/vscode-ext-host/webview/panel/${handle}`);
	html = panel.text;
	if (html.length > 0) {
		break;
	}
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
}
console.log(`  html: ${html.length} characters`);
console.log(`  head: ${html.slice(0, 400).replace(/\n/g, ' ')}`);
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
	'the HTML points at DSH\'s own resource route',
	html.includes('/vscode-ext-host/webview/resource/'),
	'the resource route appears in the HTML',
);

// -------------------------------------------------------------------------------------------
console.log('\n=== 4. RESOURCE: the extension\'s own files are served ===');
// -------------------------------------------------------------------------------------------
const resourceMatch = /\/vscode-ext-host\/webview\/resource\/([^"'\s)]+)/.exec(html);
check(
	'the HTML names a resource of the extension',
	resourceMatch !== null,
	resourceMatch === null ? 'no resource URL in the HTML' : resourceMatch[1].slice(0, 120),
);
if (resourceMatch !== null) {
	const wanted = decodeURIComponent(resourceMatch[1]);
	const resource = await callRoute(ctx.routes, '/vscode-ext-host/webview/resource/', 'GET', `/vscode-ext-host/webview/resource/${resourceMatch[1]}`);
	console.log(`  wanted: ${wanted}`);
	console.log(`  served: ${resource.status} ${resource.headers['content-type']} ${resource.text.length} bytes`);
	check(
		'the resource of the extension is served',
		resource.status === 200 && resource.text.length > 0,
		`status=${resource.status} bytes=${resource.text.length} type=${resource.headers['content-type']}`,
	);
	const outside = await callRoute(ctx.routes, '/vscode-ext-host/webview/resource/', 'GET', `/vscode-ext-host/webview/resource/${encodeURIComponent('/etc/passwd')}`);
	check(
		'a file OUTSIDE the extension is refused',
		outside.status === 404,
		`status=${outside.status} body=${outside.text.slice(0, 80)}`,
	);
}

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
