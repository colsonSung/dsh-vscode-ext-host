#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  DSH — the extension-view surface and the browser opener an extension's login needs.
 *
 *  DSH-authored (MIT).
 *
 *  Two things are checked, because both were broken in the same afternoon:
 *
 *    1. `MainThreadWindow.$openUri` used to answer `true` without opening anything, so
 *       Cline's device-code login produced a code and then nothing happened. The handler now
 *       opens `http(s)` URLs with the operating system's own opener, refuses every other
 *       scheme, and reports a real failure.
 *    2. The Extension views tab must open a chat view by default and must not present the
 *       extension's internal views as if they were products.
 *
 *  Usage: node runtime/verify/open-external.mjs
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { isOpenableUrl, openExternal, openerFor, uriToString } from '../../plugin/main-host.js';

const failures = [];
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

console.log('DSH — browser opener / extension views');

// --- 1. the URL behind the wire value -----------------------------------------------------
const clineLogin = {
	scheme: 'https',
	authority: 'authkit.cline.bot',
	path: '/device',
	query: 'user_code=FGZX-FVRR',
};
check(
	'the wire URI becomes the URL the extension meant',
	uriToString(clineLogin) === 'https://authkit.cline.bot/device?user_code=FGZX-FVRR',
	uriToString(clineLogin),
);
check(
	'a plain string passes through',
	uriToString('https://example.com/a?b=1') === 'https://example.com/a?b=1',
	uriToString('https://example.com/a?b=1'),
);
check(
	'an empty value has no URL',
	uriToString(undefined) === '' && uriToString({}) === '',
	JSON.stringify([uriToString(undefined), uriToString({})]),
);

// --- 2. what may be opened ----------------------------------------------------------------
check('an https URL may be opened', isOpenableUrl('https://authkit.cline.bot/device'));
check('an http URL may be opened', isOpenableUrl('http://127.0.0.1:3080/x'));
check(
	'a file URL is refused',
	!isOpenableUrl('file:///etc/passwd'),
	'a third-party extension must not launch a local handler',
);
check(
	'a custom scheme is refused',
	!isOpenableUrl('vscode://callback?code=1'),
	'a custom scheme is refused',
);
check('a URL with no host is refused', !isOpenableUrl('https:///device'));

// --- 3. the opener per platform -----------------------------------------------------------
check(
	'macOS opens with `open`',
	openerFor('darwin', 'https://a.test/x').command === 'open',
	JSON.stringify(openerFor('darwin', 'https://a.test/x')),
);
check(
	'Linux opens with `xdg-open`',
	openerFor('linux', 'https://a.test/x').command === 'xdg-open',
	JSON.stringify(openerFor('linux', 'https://a.test/x')),
);
check(
	'Windows opens through `cmd /c start`',
	openerFor('win32', 'https://a.test/x').args.join(' ') === '/c start  https://a.test/x',
	JSON.stringify(openerFor('win32', 'https://a.test/x')),
);

// --- 4. the handler actually launches, and reports the truth ------------------------------
const launches = [];
const logs = [];
const launch = async (command, args) => { launches.push([command, ...args]); };
const opened = await openExternal('https://authkit.cline.bot/device?user_code=FGZX-FVRR', {
	platform: 'darwin',
	log: (line) => logs.push(line),
	launch,
});
check(
	'$openUri launches the opener with the URL',
	opened === true && launches.length === 1 && launches[0][1] === 'https://authkit.cline.bot/device?user_code=FGZX-FVRR',
	JSON.stringify(launches),
);
check(
	'the opened URL is written to the log',
	logs.some((line) => line.includes('authkit.cline.bot')),
	logs.join(' | '),
);
const refusedLaunches = [];
const refused = await openExternal('file:///etc/passwd', {
	platform: 'darwin',
	log: (line) => logs.push(line),
	launch: async (command, args) => { refusedLaunches.push([command, ...args]); },
});
check(
	'a refused URL is not launched and answers false',
	refused === false && refusedLaunches.length === 0,
	JSON.stringify(refusedLaunches),
);
check(
	'the refusal is written to the log',
	logs.some((line) => line.includes('refused')),
	logs.join(' | '),
);
const failed = await openExternal('https://a.test/x', {
	platform: 'darwin',
	log: (line) => logs.push(line),
	launch: async () => { throw new Error('no browser'); },
});
check('a launch that fails answers false', failed === false);
check(
	'a failed launch is written to the log',
	logs.some((line) => line.includes('could not open')),
	logs.filter((line) => line.includes('could not open')).join(' | '),
);

// --- 5. the Extension views tab -----------------------------------------------------------
const jsx = (type, props, key) => ({ type, props, key });
const react = {
	useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => undefined],
	useEffect: () => undefined,
	useCallback: (fn) => fn,
	useMemo: (fn) => fn(),
	useRef: (value) => ({ current: value }),
	createElement: jsx,
};
let loaded;
const window = {
	__ModuleLoader__: {
		load({ id, factory }) {
			loaded = {
				id,
				exports: factory((name) => {
					if (name === 'react') return react;
					if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
					throw new Error(`unknown module ${name}`);
				}),
			};
		},
	},
};
globalThis.window = window;
globalThis.document = { baseURI: 'http://127.0.0.1:51582/' };
globalThis.fetch = async () => ({
	ok: true,
	status: 200,
	json: async () => ({ ok: true, editors: [], viewers: [] }),
	headers: { get: () => null },
	text: async () => '',
});
new Function('window', readFileSync(resolve(import.meta.dirname, '../../plugin/client.js'), 'utf8'))(window);

const tabs = [];
const bodies = [];
const ctx = {
	effect(fn) { const dispose = fn(); return () => dispose?.(); },
	get(name) {
		if (name === 'documentPreviews') return { register: () => () => undefined };
		if (name === 'theme') return { getTheme: () => ({ active: { colorScheme: 'dark' } }) };
		return undefined;
	},
	on() { return () => undefined; },
	locale: { register: () => () => undefined, bind: () => (key) => key },
	slots: {
		inject(_name, factory) { return factory(); },
		register(definition) { bodies.push(`${definition.name}:${definition.key}`); return () => undefined; },
	},
	sidebarRightTabs: { register(definition) { tabs.push(definition); return () => undefined; } },
};
loaded.exports.apply(ctx);

const views = [
	{ viewType: 'gitlens.views.graph', extensionName: 'GitLens', chat: false },
	{ viewType: 'claude-dev.SidebarProvider', extensionName: 'Cline', chat: true },
	{ viewType: 'jupyter-data-wrangler-summary-view', extensionName: 'Data Wrangler', chat: false },
];
check(
	'the Extension views tab is registered',
	tabs.some((entry) => entry.kind === 'vscode-views'),
	tabs.map((entry) => entry.kind).join(', '),
);
check(
	'the tab body is bound to its type id',
	bodies.includes('sidebar.right.pane.tab:dsh-vscode-extension-host/views'),
	bodies.join(', '),
);
check(
	'Cline is the default, not the first GitLens view',
	loaded.exports.chooseInitialView(views, undefined) === 'claude-dev.SidebarProvider',
	loaded.exports.chooseInitialView(views, undefined),
);
check(
	'only chat-like views are offered when one exists',
	(loaded.exports.offerableViews?.(views) ?? views).every((view) => view.chat === true),
	JSON.stringify((loaded.exports.offerableViews?.(views) ?? views).map((view) => view.viewType)),
);

console.log(failures.length === 0 ? '\n=== RESULT ===\n  all checks passed' : `\n=== RESULT ===\n  ${failures.length} failure(s)`);
process.exit(failures.length === 0 ? 0 : 1);
