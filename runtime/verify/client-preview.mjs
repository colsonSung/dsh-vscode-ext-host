#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  DSH — the executable verification of the BROWSER half of the custom-editor surface.
 *
 *  DSH-authored (MIT).
 *
 *  WHAT IT PROVES
 *  --------------
 *  The Host half of the webview surface already proves it can resolve a `.drawio` file to
 *  the Draw.io custom editor and make the extension produce the panel
 *  (`runtime/verify/webview-e2e.mjs`). What a person SEES depends on the other half: the
 *  browser module has to register a renderer into the document preview for every custom
 *  editor the installed extensions declare, and a body into the right Sidebar's document
 *  slot. Without that registration the file falls back to plain text.
 *
 *  So this script:
 *
 *    1. starts the real extension host with the real Draw.io VSIX,
 *    2. reads the REAL manifest the surface serves,
 *    3. loads the BUILT browser module (`bundle/client.js`) against a fake module table and a
 *       fake client context,
 *    4. asserts what it registered: one renderer per editor, the real suffixes, the right
 *       band, and one document body per renderer.
 *
 *  Usage: node runtime/verify/client-preview.mjs
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { ExtensionHostRuntime } from '../../plugin/main-host.js';
// The surface the BUNDLE ships, not the legacy standalone package: the bundle's copy is
// the one the plugin mounts, and it is the one that carries per-editor suffixes.
import { apply as applyWebviewSurface } from '../../plugin/webview-surface.js';

const HERE = resolve(import.meta.dirname, '.');
const BUNDLE = resolve(HERE, '../../plugin');
const VSIX = resolve(HERE, 'vendor/hediet.vscode-drawio-1.17.261024055.vsix');

const failures = [];

/** Assert one condition. */
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

/** The fake DSH Host context the surface and the host need. */
function fakeHostCtx(profileDir, registered) {
	const services = new Map();
	const routes = [];
	return {
		profileContext: { dir: profileDir, name: 'verification', patchPath: join(profileDir, 'cordis.patch.yml') },
		commands: { register: (definition) => { registered.push(definition); return () => undefined; } },
		webServer: {
			register(route) { routes.push(route); return () => undefined; },
			getOrigin() { return 'http://127.0.0.1:3080'; },
		},
		connection: { authorizeIndex() { return true; } },
		provide(name, value) { services.set(name, value); return () => services.delete(name); },
		effect(fn) { const disposer = fn(); return () => disposer?.(); },
		get(name) { return services.get(name); },
		routes,
	};
}

console.log('DSH — custom editor, browser half');

// ---------------------------------------------------------------------------------------
// 1. the real host + surface, so the manifest is the extension's own
// ---------------------------------------------------------------------------------------
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-client-preview-'));
execFileSync('node', [join(HERE, 'setup-profile.mjs'), profileDir, VSIX], { stdio: 'inherit' });

const registered = [];
const hostCtx = fakeHostCtx(profileDir, registered);
applyWebviewSurface(hostCtx, () => undefined);
const runtime = new ExtensionHostRuntime(hostCtx);
await runtime.start();

/** Read the manifest the surface serves, the same way the browser does. */
async function readManifest() {
	return await new Promise((resolveManifest, rejectManifest) => {
		const route = hostCtx.routes.find((entry) => entry.path === '/vscode-ext-host/webview/manifest');
		if (route === undefined) {
			rejectManifest(new Error('the surface did not register its manifest route'));
			return;
		}
		const res = {
			writeHead() { return res; },
			end(payload) { resolveManifest(JSON.parse(payload)); },
		};
		route.handler({ method: 'GET', headers: {} }, res);
	});
}

const manifest = await readManifest();
console.log(`  manifest: ${JSON.stringify(manifest.editors?.map((editor) => ({ viewType: editor.viewType, priority: editor.priority, suffixes: editor.suffixes })))}`);

// ---------------------------------------------------------------------------------------
// 2. the built browser module, against the real manifest
// ---------------------------------------------------------------------------------------
const jsx = (type, props, key) => ({ type, props, key });
const requireStub = (name) => {
	if (name === 'react') {
		return {
			useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => undefined],
			useEffect: () => undefined,
			useCallback: (fn) => fn,
			useMemo: (fn) => fn(),
			useRef: (value) => ({ current: value }),
			createElement: jsx,
		};
	}
	if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
	throw new Error(`the module table asked for an unknown module: ${name}`);
};

let loaded;
const window = { __ModuleLoader__: { load({ id, factory }) { loaded = { id, exports: factory(requireStub) }; } } };
globalThis.window = window;
globalThis.document = { baseURI: 'http://127.0.0.1:51582/' };
let fetchCount = 0;
globalThis.fetch = async (url) => { fetchCount += 1; return ({
	ok: true,
	status: 200,
	json: async () => (String(url).includes('/manifest')
		? { editors: manifest.editors, origin: manifest.origin ?? '', views: manifest.views ?? [] }
		: {}),
});
};
globalThis.setTimeout = ((original) => (fn, ms) => original(fn, ms))(setTimeout);

// eslint-disable-next-line no-new-func
new Function('window', readFileSync(join(BUNDLE, 'client.js'), 'utf8'))(window);

const previews = [];
const bodies = [];
const clientCtx = {
	effect(fn) { const disposer = fn(); return () => disposer?.(); },
	get(name) {
		if (name === 'documentPreviews') {
			return { register: (spec) => { previews.push(spec); return () => undefined; } };
		}
		if (name === 'theme') {
			return { getTheme: () => ({ active: { colorScheme: 'dark' } }) };
		}
		return undefined;
	},
	on() { return () => undefined; },
	locale: { register: () => () => undefined, bind: () => (key) => key },
	slots: {
		inject(_name, factory) { return factory(); },
		register(definition, component) {
			bodies.push({ name: definition.name, key: definition.key, component });
			return () => undefined;
		},
	},
};

loaded.exports.apply(clientCtx);
await new Promise((resolveWait) => setTimeout(resolveWait, 150));


check(
	'the browser module loaded is the one this bundle ships',
	loaded.id === 'dsh-vscode-extension-host',
	loaded.id,
);

// ---------------------------------------------------------------------------------------
// The ranking the SHIPPED preview applies, copied verbatim from
// @deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js (suffix.js + registry.js).
// Running it over OUR registrations answers the question the user actually asks: when the
// file is clicked, does the extension editor win?
// ---------------------------------------------------------------------------------------
function normalizeSuffix(extension) {
	return extension.toLowerCase().replace(/^\./u, '');
}
function documentFileName(path) {
	const normalized = path.replaceAll('\\', '/').toLowerCase();
	return normalized.slice(normalized.lastIndexOf('/') + 1);
}
function matchedSuffixLength(name, extensions) {
	return Math.max(0, ...extensions.map(normalizeSuffix).filter((extension) => name.endsWith(`.${extension}`)).map((extension) => extension.length));
}
function matchingDocumentPreviews(definitions, path) {
	const name = documentFileName(path);
	return definitions.map((definition, order) => ({
		definition,
		order,
		rank: definition.priority === 'builtin' ? 0 : 1,
		length: matchedSuffixLength(name, definition.extensions),
	})).filter((candidate) => candidate.length > 0).sort((left, right) => right.rank - left.rank || right.length - left.length || left.order - right.order).map((candidate) => candidate.definition);
}

const expected = (manifest.editors ?? []).filter((editor) => (editor.suffixes ?? []).length > 0);
check(
	'one preview renderer is registered per custom editor',
	previews.length === expected.length && expected.length > 0,
	`renderers: ${JSON.stringify(previews.map((spec) => ({ id: spec.id, extensions: spec.extensions, priority: spec.priority })))}`,
);
check(
	'every renderer claims a suffix of the real extension',
	previews.every((spec) => Array.isArray(spec.extensions) && spec.extensions.length > 0),
	previews.map((spec) => `${spec.id}: ${(spec.extensions ?? []).join(',')}`).join(' | '),
);
check(
	'the .drawio suffix is claimed',
	previews.some((spec) => (spec.extensions ?? []).includes('.drawio')),
	previews.map((spec) => (spec.extensions ?? []).join(' ')).join(' | '),
);
const drawioDefault = (manifest.editors ?? []).filter((editor) => editor.priority !== 'option').length;
check(
	'a default-priority editor wins the file automatically',
	previews.filter((spec) => spec.priority === 'extension').length === drawioDefault,
	`extension-band renderers: ${previews.filter((spec) => spec.priority === 'extension').length} of ${previews.length}, default editors: ${drawioDefault}`,
);
check(
	'an option-priority editor stays available but not automatic',
	previews.some((spec) => spec.priority === 'builtin'),
	`builtin-band renderers: ${previews.filter((spec) => spec.priority === 'builtin').length}`,
);
check(
	'every renderer has a body in the right sidebar document slot',
	previews.every((spec) => bodies.some((body) => body.name === 'sidebar.right.tab.document' && body.key === spec.id)),
	`bodies: ${JSON.stringify(bodies.map((body) => `${body.name}:${body.key}`))}`,
);
check(
	'a renderer title is the extension editor name, not a file name',
	previews.every((spec) => typeof spec.title === 'function' && spec.title().length > 0),
	previews.map((spec) => spec.title()).join(' | '),
);

// The built-in text/markdown viewers the shipped frontend registers, as the baseline the
// extension editors have to beat (band "builtin").
const builtinText = { id: '@deepseek-ai/document-preview/text', title: () => 'Text', extensions: ['txt', 'json', 'yaml'], priority: 'builtin' };
const builtinMarkdown = { id: '@deepseek-ai/document-preview/markdown', title: () => 'Markdown', extensions: ['md', 'markdown'], priority: 'builtin' };
// The shipped frontend registers its built-in viewers as the app boots, so they come
// FIRST in registration order; the plugin's renderers are appended when it activates.
const registry = [builtinText, builtinMarkdown, ...previews];

const drawioPick = matchingDocumentPreviews(registry, 'drawio-preview-sample.drawio');
check(
	'a .drawio file opens in the extension editor by default',
	drawioPick[0]?.id === previews.find((spec) => (spec.extensions ?? []).includes('.drawio') && spec.priority === 'extension')?.id,
	`candidates: ${drawioPick.map((spec) => `${spec.id}${spec === drawioPick[0] ? ' (default)' : ''}`).join(' | ')}`,
);
check(
	'the built-in text viewer stays as the alternative for that file',
	drawioPick.length > 1,
	`candidates: ${drawioPick.map((spec) => spec.id).join(' | ')}`,
);

const pngPick = matchingDocumentPreviews(registry, 'diagram.drawio.png');
check(
	'a compound .drawio.png file also opens in the extension editor',
	pngPick[0]?.id === previews.find((spec) => (spec.extensions ?? []).includes('.drawio.png'))?.id,
	`candidates: ${pngPick.map((spec) => spec.id).join(' | ')}`,
);

const mdPick = matchingDocumentPreviews(registry, 'notes.md');
check(
	'a .md file keeps the built-in markdown viewer by default',
	mdPick[0]?.id === builtinMarkdown.id,
	`candidates: ${mdPick.map((spec) => spec.id).join(' | ')}`,
);
check(
	'but the extension editor is offered in "Open with" for that .md file',
	mdPick.some((spec) => previews.some((ours) => ours.id === spec.id)),
	`candidates: ${mdPick.map((spec) => spec.id).join(' | ')}`,
);
check(
	'every candidate the menu would show has a distinct title',
	new Set(mdPick.map((spec) => spec.title())).size === mdPick.length,
	`titles: ${mdPick.map((spec) => spec.title()).join(' | ')}`,
);

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
