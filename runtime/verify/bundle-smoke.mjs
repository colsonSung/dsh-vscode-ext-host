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
