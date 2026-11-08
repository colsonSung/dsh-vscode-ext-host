#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  DSH S1 production — smoke test of the BUNDLE's own surface.
 *
 *  DSH-authored (MIT).
 *
 *  The bundle is what the profile actually loads, so its route and its model tool are checked
 *  here against a fake Host context:
 *
 *  - `apply(ctx)` registers the route `/vscode-extension-host` and the tool
 *    `vscode_extension_host`;
 *  - the route answers `status` with the agreed shape;
 *  - the route answers `log` with the host log;
 *  - the tool answers `status` and `log` with the same facts.
 *
 *  Usage: node runtime/verify/bundle-smoke.mjs
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { apply } = await import('../../plugin/index.js');

const profileDir = mkdtempSync(join(tmpdir(), 'dsh-exthost-bundle-'));

/** The routes the bundle registered. */
const routes = [];
/** The tools the bundle registered. */
const tools = [];

const ctx = {
	profileContext: { dir: profileDir, name: 'verification' },
	// The bundle asks the Host for the client module table so it can reload a
	// rebuilt browser bundle. A verification profile has no open page, so the
	// table is absent — the bundle treats that as "nothing to reload".
	get: () => undefined,
	webServer: {
		register(route) {
			routes.push(route);
			return () => undefined;
		},
	},
	connection: {
		authorizeIndex() {
			return true;
		},
	},
	tools: {
		register(definition) {
			tools.push(definition);
			return () => undefined;
		},
	},
	provide() {},
	effect(fn) {
		fn();
		return () => undefined;
	},
};

apply(ctx);

const failures = [];

/**
 * Assert one condition.
 *
 * @param {string} what - what is asserted.
 * @param {boolean} condition - the condition.
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
 * Call the route handler and read the JSON body it writes.
 *
 * @param {object} route - the registered route.
 * @param {object} body - the request body.
 * @returns {Promise<object>} the parsed answer.
 */
async function call(route, body) {
	return await new Promise((resolve) => {
		const chunks = [];
		const res = {
			writeHead(status, headers) {
				this.status = status;
				this.headers = headers;
				return this;
			},
			end(payload) {
				chunks.push(payload ?? '');
				resolve({ status: res.status, body: JSON.parse(chunks.join('')) });
			},
		};
		const req = {
			method: 'POST',
			setEncoding() {},
			on(event, handler) {
				if (event === 'data') { handler(JSON.stringify(body)); }
				if (event === 'end') { handler(); }
				return this;
			},
		};
		route.handler(req, res);
	});
}

console.log('DSH S1 — bundle smoke test');

check(
	'the bundle registered the route /vscode-extension-host',
	routes.some((route) => route.path === '/vscode-extension-host'),
	`routes: ${JSON.stringify(routes.map((route) => route.path))}`,
);
check(
	'the bundle registered the tool vscode_extension_host',
	tools.some((tool) => tool.name === 'vscode_extension_host'),
	`tools: ${JSON.stringify(tools.map((tool) => tool.name))}`,
);

const route = routes.find((entry) => entry.path === '/vscode-extension-host');
const status = await call(route, { action: 'status' });
check(
	'the status action answers the agreed shape',
	status.body.ok === true
		&& typeof status.body.host?.running === 'boolean'
		&& typeof status.body.host?.restarts === 'number'
		&& Array.isArray(status.body.extensions),
	`status: ${JSON.stringify(status.body).slice(0, 400)}`,
);
check(
	'the status payload carries the status bar entries',
	Array.isArray(status.body.statusBar),
	`statusBar: ${JSON.stringify(status.body.statusBar)}`,
);
check(
	'the status action names the extensions with publisher.name@version',
	status.body.extensions.every((entry) => /^[^@]+@[^@]+$/.test(entry.id)),
	`extensions: ${JSON.stringify(status.body.extensions)}`,
);

const log = await call(route, { action: 'log', lines: 20 });
check(
	'the log action answers with the log lines',
	log.body.ok === true && Array.isArray(log.body.lines),
	`log lines: ${log.body.lines?.length ?? 'none'}`,
);

// A command id is required, and an unknown one is refused with the extension
// host's own message: this profile has no extension to register any.
const noId = await call(route, { action: 'command', id: '' });
check(
	'the command action refuses an empty id',
	noId.body.ok === false && typeof noId.body.error === 'string',
	`answer: ${JSON.stringify(noId.body)}`,
);
const unknownCommand = await call(route, { action: 'command', id: 'acme.not.registered' });
check(
	'the command action reports an unregistered command',
	unknownCommand.body.ok === false && String(unknownCommand.body.error).includes('no extension registered'),
	`answer: ${JSON.stringify(unknownCommand.body)}`,
);

// The webview views an extension registers: none here, and resolving one is
// refused by the extension host rather than answered with an empty view.
const views = await call(route, { action: 'views' });
check(
	'the views action answers with the registered views',
	views.body.ok === true && Array.isArray(views.body.views),
	`answer: ${JSON.stringify(views.body)}`,
);
const noViewType = await call(route, { action: 'resolveView', viewType: '' });
check(
	'the resolveView action refuses an empty view type',
	noViewType.body.ok === false && typeof noViewType.body.error === 'string',
	`answer: ${JSON.stringify(noViewType.body)}`,
);
const unknownView = await call(route, { action: 'resolveView', viewType: 'acme.nothing' });
check(
	'the resolveView action reports an unregistered view',
	unknownView.body.ok === false && String(unknownView.body.error).includes('no extension registered the webview view'),
	`answer: ${JSON.stringify(unknownView.body)}`,
);

// Tree views: the page pulls one level at a time; with no extension registering
// one, both the empty id and an unknown view are refused rather than answered.
const noViewId = await call(route, { action: 'treeChildren', viewId: '' });
check(
	'the treeChildren action refuses an empty view id',
	noViewId.body.ok === false && typeof noViewId.body.error === 'string',
	`answer: ${JSON.stringify(noViewId.body)}`,
);
const unknownTree = await call(route, { action: 'treeChildren', viewId: 'acme.tree' });
check(
	'the treeChildren action reports an unregistered tree view',
	unknownTree.body.ok === false && String(unknownTree.body.error).includes('no extension registered the tree view'),
	`answer: ${JSON.stringify(unknownTree.body)}`,
);

const panels = await call(route, { action: 'panels' });
check(
	'the panels action answers with the open panels',
	panels.body.ok === true && Array.isArray(panels.body.panels) && typeof panels.body.origin === 'string',
	`answer: ${JSON.stringify(panels.body).slice(0, 200)}`,
);

const unknown = await call(route, { action: 'nonsense' });
check(
	'an unknown action is refused',
	unknown.body.ok === false && typeof unknown.body.error === 'string',
	`answer: ${JSON.stringify(unknown.body)}`,
);

const tool = tools.find((entry) => entry.name === 'vscode_extension_host');
const toolStatus = await tool.execute({ action: 'status' }, {});
check(
	'the model tool answers the status action',
	toolStatus.ok === true && typeof toolStatus.summary === 'string',
	`summary: ${toolStatus.summary}`,
);
const toolCommand = await tool.execute({ action: 'command' }, {});
check(
	'the model tool refuses the command action without an id',
	toolCommand.ok === false && typeof toolCommand.summary === 'string',
	`summary: ${toolCommand.summary}`,
);

// The harness rejects a tool result that is not lossless JSON: no `undefined`
// members, no functions, no NaN. The status payload is exactly where optional
// host fields would leak `undefined` in, so it is the one that has to be clean.
const lossless = (value) => {
	try {
		const round = JSON.parse(JSON.stringify(value));
		return JSON.stringify(round) === JSON.stringify(value);
	} catch {
		return false;
	}
};
check(
	'the model tool\'s status result is lossless JSON',
	toolStatus.ok === true && lossless(toolStatus),
	`strength: ${lossless(toolStatus)} value: ${JSON.stringify(toolStatus).slice(0, 240)}`,
);

const toolLog = await tool.execute({ action: 'log', lines: 5 }, {});
check(
	'the model tool answers the log action',
	toolLog.ok === true && Array.isArray(toolLog.data?.lines),
	`lines: ${toolLog.data?.lines?.length ?? 'none'}`,
);

await new Promise((resolve) => setTimeout(resolve, 500));
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
