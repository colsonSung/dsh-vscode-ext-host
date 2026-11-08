#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * DSH-authored (MIT).
 *
 * The extension-view tab's registration and landing-view policy. The default must be a useful
 * chat view, never whichever internal webview view happened to be registered first.
 *
 * Usage: node runtime/verify/view-tab.mjs
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const jsx = (type, props, key) => ({ type, props, key });
const react = {
	useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => undefined],
	useEffect: () => undefined,
	useCallback: (fn) => fn,
	useMemo: (fn) => fn(),
	useRef: (value) => ({ current: value }),
	createElement: jsx,
};
const requireStub = (name) => {
	if (name === 'react') return react;
	if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
	throw new Error(`unknown module ${name}`);
};

let loaded;
const window = { __ModuleLoader__: { load({ id, factory }) { loaded = { id, exports: factory(requireStub) }; } } };
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

const registered = [];
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
	locale: {
		register: (ns, dict) => { registered.push({ ns, keys: Object.keys(dict.en ?? {}).length }); return () => undefined; },
		bind: () => (key) => key,
	},
	slots: {
		inject(_name, factory) { return factory(); },
		register(definition) { bodies.push(`${definition.name}:${definition.key}`); return () => undefined; },
	},
	sidebarRightTabs: { register(definition) { tabs.push(definition); return () => undefined; } },
};

loaded.exports.apply(ctx);

const tab = tabs.find((entry) => entry.kind === 'vscode-views');
const guide = tab?.guide?.find((entry) => entry.id === 'vscode-views');
const views = [
	{ viewType: 'gitlens.views.commitDetails' },
	{ viewType: 'claude-dev.SidebarProvider' },
	{ viewType: 'continue.continueGUIView' },
];
const choose = loaded.exports.chooseInitialView;
const checks = [
	['the module loaded is this bundle', loaded.id === 'dsh-vscode-extension-host'],
	['the tab type is registered', tab !== undefined],
	['the guide card is registered', guide !== undefined && guide.order === 30],
	['the tab title is translated', tab?.title?.() === 'title'],
	['the tab body is bound to the type id', bodies.includes('sidebar.right.pane.tab:dsh-vscode-extension-host/views')],
	['the dictionaries are registered', registered.some((entry) => entry.ns === 'vscodeExtensionViews')],
	['Cline is the default instead of the first GitLens view', choose(views, undefined) === 'claude-dev.SidebarProvider'],
	['Continue is the fallback chat view', choose([views[0], views[2]], undefined) === 'continue.continueGUIView'],
	['an explicit user selection survives a refresh', choose(views, views[0].viewType) === views[0].viewType],
	['several non-chat views require an explicit choice', choose([views[0], { viewType: 'other.view' }], undefined) === ''],
	['one available view can open directly', choose([views[0]], undefined) === views[0].viewType],
];
let failed = 0;
for (const [what, ok] of checks) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
	if (!ok) failed += 1;
}
console.log(failed === 0 ? 'RESULT: ok' : `RESULT: ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
