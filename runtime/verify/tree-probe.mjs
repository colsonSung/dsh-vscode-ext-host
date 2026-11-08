#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Probe: does an extension's TreeDataProvider reach the DSH side, and in what shape?
 *
 *  DSH-authored (MIT).
 *
 *  The probe builds a throwaway profile by hand (the shape the VSIX store writes), starts the
 *  real extension host against it, and asks for the tree view's children — first the root,
 *  then one expanded row. It prints the ROWS EXACTLY as the extension host answered them, so
 *  the browser half can be written against the real DTO instead of a guess.
 *--------------------------------------------------------------------------------------------*/

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ExtensionHostRuntime } from '../../plugin/main-host.js';

const HERE = new URL('.', import.meta.url).pathname;
const FIXTURE = join(HERE, '..', 'fixtures', 'tree-view-extension');
const PROFILE = mkdtempSync(join(tmpdir(), 'dsh-exthost-tree-'));

/** Install the fixture the way the store would. */
function installFixture() {
	const directory = join(PROFILE, 'extensions', 'dsh-probe.tree-probe-1.0.0');
	mkdirSync(join(directory, 'extension'), { recursive: true });
	cpSync(FIXTURE, join(directory, 'extension'), { recursive: true });
	writeFileSync(join(PROFILE, 'extensions.json'), JSON.stringify({
		extensions: [{
			id: 'dsh-probe.tree-probe@1.0.0',
			kind: 'vsix',
			publisher: 'dsh-probe',
			name: 'tree-probe',
			version: '1.0.0',
			directory,
			enabled: true,
			trusted: true,
			installed: true,
		}],
	}, null, 2));
	writeFileSync(join(PROFILE, 'extensions-trust.json'), JSON.stringify({ publishers: { 'dsh-probe': true } }, null, 2));
}

const fakeCtx = {
	profileContext: { dir: PROFILE, name: 'verification', patchPath: join(PROFILE, 'cordis.patch.yml') },
	commands: { register: () => () => undefined },
	get: () => undefined,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until a condition holds. */
async function waitFor(condition, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await sleep(200);
	}
	return condition();
}

installFixture();
const runtime = new ExtensionHostRuntime(fakeCtx);
await runtime.start();

const ready = await waitFor(() => runtime.treeViewList().length > 0, 20_000);
console.log(`tree views registered: ${ready ? JSON.stringify(runtime.treeViewList()) : 'NONE'}`);

if (ready) {
	const root = await runtime.treeChildren('dshProbe.tree');
	console.log(`root rows: ${JSON.stringify(root, null, 2)}`);
	const handle = root.rows.find((row) => row?.collapsibleState > 0)?.handle ?? root.rows[0]?.handle;
	if (handle !== undefined) {
		const expanded = await runtime.treeChildren('dshProbe.tree', handle);
		console.log(`children of ${JSON.stringify(handle)}: ${JSON.stringify(expanded, null, 2)}`);
	}
}

// Settings probe: what does the RUNNING extension see?
const settings = runtime.configurationList();
console.log(`settings: ${JSON.stringify(settings).slice(0, 600)}`);
try {
	const value = await runtime.runCommand('dshProbe.readSetting');
	console.log(`readSetting -> ${JSON.stringify(value)}`);
} catch (error) {
	console.log(`readSetting threw: ${error instanceof Error ? error.message : String(error)}`);
}
await runtime.stop();
