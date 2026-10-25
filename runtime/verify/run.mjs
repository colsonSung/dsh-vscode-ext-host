#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  DSH S1 production — the executable verification of the extension host.
 *
 *  DSH-authored (MIT).
 *
 *  Three checks, each of them an assertion with a printed proof:
 *
 *    1. END TO END   a real Marketplace extension (`redhat.vscode-yaml`) is installed with the
 *                    VSIX store's own install pipeline into a THROWAWAY profile, the host
 *                    loads it, the extension activates, and the command it contributes
 *                    (`jumpToSchema`) shows up on the DSH side.
 *    2. CRASH        an extension that calls `process.exit(1)` inside `activate()` kills the
 *                    host process; the host restarts it, with the backoff and the crash cap
 *                    written into the log.
 *    3. TRUST        the same extension with its publisher removed from
 *                    `extensions-trust.json` is NOT loaded at all.
 *
 *  Usage: node runtime/verify/run.mjs
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ExtensionHostRuntime } from '../../bundle/main-host.js';

const HERE = resolve(import.meta.dirname, '.');
const REPO = resolve(HERE, '../..');
const WORKSPACE = resolve(REPO, '..');
const VSIX = resolve(REPO, 'spike/vendor-ext/vscode-yaml.vsix');

/** The failures collected during the run. */
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
 * Wait until a condition holds.
 *
 * @param {() => boolean} condition - the condition.
 * @param {number} timeoutMs - how long to wait.
 * @returns {Promise<boolean>} whether the condition held in time.
 */
async function waitFor(condition, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return condition();
}

/**
 * Build the fake DSH Host context the host needs.
 *
 * @param {string} profileDir - the profile directory.
 * @param {Array<object>} registered - collects the DSH command registrations.
 * @returns {object} the context.
 */
function fakeCtx(profileDir, registered) {
	return {
		profileContext: { dir: profileDir, name: 'verification', patchPath: join(profileDir, 'cordis.patch.yml') },
		commands: {
			register(definition) {
				registered.push(definition);
				return () => undefined;
			},
		},
		get() {
			return undefined;
		},
	};
}

/**
 * Run the end-to-end check.
 *
 * @returns {Promise<void>} after the check.
 */
async function endToEnd() {
	console.log('\n=== 1. END TO END: a real Marketplace extension activates in a throwaway profile ===');
	const profileDir = mkdtempSync(join(tmpdir(), 'dsh-exthost-e2e-'));
	console.log(`  profile: ${profileDir}`);
	execFileSync('node', [join(HERE, 'setup-profile.mjs'), profileDir, VSIX], { stdio: 'inherit' });

	const registered = [];
	const runtime = new ExtensionHostRuntime(fakeCtx(profileDir, registered));
	await runtime.start();
	const payload = runtime.payload();
	console.log(`  host: running=${payload.host.running} pid=${payload.host.pid} restarts=${payload.host.restarts}`);
	console.log(`  extensions: ${JSON.stringify(payload.extensions)}`);

	const activated = payload.extensions.find((entry) => entry.id === 'redhat.vscode-yaml@2.1.2026102308');
	check(
		'the extension host loaded redhat.vscode-yaml',
		payload.extensions.some((entry) => entry.publisher === 'redhat'),
		`loaded extensions: ${JSON.stringify(payload.extensions.map((entry) => entry.id))}`,
	);
	check(
		'redhat.vscode-yaml activated',
		activated?.active === true,
		`active=${activated?.active} activatedAt=${activated?.activatedAt ?? 'none'} error=${activated?.error ?? 'none'}`,
	);

	const commands = runtime.registeredCommands();
	console.log(`  registered commands: ${JSON.stringify(commands)}`);
	check(
		'the command "jumpToSchema" reached the DSH side',
		commands.includes('jumpToSchema'),
		`registered commands: ${JSON.stringify(commands)}`,
	);
	const dshCommand = registered.find((definition) => definition.name === 'jumptoschema');
	check(
		'the command "jumpToSchema" is registered in the DSH command registry',
		dshCommand !== undefined,
		`DSH command registry: ${JSON.stringify(registered.map((definition) => definition.name))}`,
	);

	await runtime.stop();
	rmSync(profileDir, { recursive: true, force: true });
}

/**
 * Run the crash-recovery check.
 *
 * @returns {Promise<void>} after the check.
 */
async function crashRecovery() {
	console.log('\n=== 2. CRASH RECOVERY: the host restarts a crashing extension host ===');
	const profileDir = mkdtempSync(join(tmpdir(), 'dsh-exthost-crash-'));
	console.log(`  profile: ${profileDir}`);

	// A tiny local extension that kills the host process from inside activate().
	const extensionDir = join(profileDir, 'extensions', 'dsh-probe.crash-1.0.0');
	mkdirSync(join(extensionDir, 'extension'), { recursive: true });
	writeFileSync(join(extensionDir, 'extension', 'package.json'), JSON.stringify({
		name: 'crash',
		displayName: 'Crash probe',
		publisher: 'dsh-probe',
		version: '1.0.0',
		engines: { vscode: '*' },
		activationEvents: ['onStartupFinished'],
		main: './index.js',
	}, null, 2));
	writeFileSync(join(extensionDir, 'extension', 'index.js'), [
		"const vscode = require('vscode');",
		'exports.activate = function () {',
		"  console.log('[dsh-probe] crashing the extension host on purpose');",
		'  process.exit(1);',
		'};',
	].join('\n'));
	writeFileSync(join(profileDir, 'extensions.json'), JSON.stringify({
		extensions: [{
			id: 'dsh-probe.crash@1.0.0',
			publisher: 'dsh-probe',
			name: 'crash',
			version: '1.0.0',
			directory: extensionDir,
			enabled: true,
			trusted: true,
		}],
	}, null, 2));
	writeFileSync(join(profileDir, 'extensions-trust.json'), JSON.stringify({ publishers: { 'dsh-probe': true } }, null, 2));

	const registered = [];
	const runtime = new ExtensionHostRuntime(fakeCtx(profileDir, registered));
	await runtime.start();

	const restarted = await waitFor(() => runtime.status().restarts > 0, 20_000);
	const status = runtime.status();
	const log = runtime.logLines(500);
	const crashLine = log.find((line) => line.includes('the extension host exited with code'));
	const restartLine = log.find((line) => line.includes('restarting the extension host in'));

	check(
		'the host noticed the crash',
		crashLine !== undefined,
		crashLine ?? 'no crash line in the log',
	);
	check(
		'the host restarted the extension host',
		restarted && status.restarts > 0,
		`restarts=${status.restarts} running=${status.running} lastError=${status.lastError ?? 'none'}`,
	);
	check(
		'the restart used a backoff',
		restartLine !== undefined,
		restartLine ?? 'no backoff line in the log',
	);

	await runtime.stop();
	rmSync(profileDir, { recursive: true, force: true });
}

/**
 * Run the trust-gate check.
 *
 * @returns {Promise<void>} after the check.
 */
async function trustGate() {
	console.log('\n=== 3. TRUST GATE: an untrusted publisher is never loaded ===');
	const profileDir = mkdtempSync(join(tmpdir(), 'dsh-exthost-trust-'));
	console.log(`  profile: ${profileDir}`);
	execFileSync('node', [join(HERE, 'setup-profile.mjs'), profileDir, VSIX, '--untrusted', 'redhat'], { stdio: 'inherit' });

	const registered = [];
	const runtime = new ExtensionHostRuntime(fakeCtx(profileDir, registered));
	await runtime.start();
	const payload = runtime.payload();
	console.log(`  extensions: ${JSON.stringify(payload.extensions)}`);
	console.log(`  skipped:    ${JSON.stringify(runtime.skippedExtensions())}`);

	check(
		'no extension was loaded',
		payload.extensions.length === 0,
		`loaded: ${JSON.stringify(payload.extensions.map((entry) => entry.id))}`,
	);
	check(
		'the reason is the untrusted publisher',
		runtime.skippedExtensions().some((entry) => entry.reason === 'untrusted-publisher'),
		`skipped: ${JSON.stringify(runtime.skippedExtensions())}`,
	);
	// The extension host always registers one internal command of its own (`__vsc<uuid>`),
	// so the assertion is about the COMMAND THE EXTENSION CONTRIBUTED, not about the count.
	check(
		'the command "jumpToSchema" was not registered',
		!runtime.registeredCommands().includes('jumpToSchema'),
		`registered commands: ${JSON.stringify(runtime.registeredCommands())}`,
	);

	await runtime.stop();
	rmSync(profileDir, { recursive: true, force: true });
}

/**
 * Run the enable-state check: the host must notice that `extensions.json` changed and drop
 * the disabled extension WITHOUT restarting the process.
 *
 * @returns {Promise<void>} after the check.
 */
async function enableStateChange() {
	console.log('\n=== 4. ENABLE STATE: a change in extensions.json takes effect without a restart ===');
	const profileDir = mkdtempSync(join(tmpdir(), 'dsh-exthost-enable-'));
	console.log(`  profile: ${profileDir}`);
	execFileSync('node', [join(HERE, 'setup-profile.mjs'), profileDir, VSIX], { stdio: 'pipe' });

	const registered = [];
	const runtime = new ExtensionHostRuntime(fakeCtx(profileDir, registered));
	await runtime.start();
	const before = runtime.payload();
	const pidBefore = before.host.pid;
	console.log(`  before: ${JSON.stringify(before.extensions)}`);

	// The VSIX store writes the `enabled` flag into the state file; the host watches it.
	const stateFile = join(profileDir, 'extensions.json');
	const state = JSON.parse(readFileSync(stateFile, 'utf8'));
	state.extensions = state.extensions.map((entry) => ({ ...entry, enabled: false }));
	writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
	console.log('  wrote extensions.json with enabled: false');

	const settled = await waitFor(() => runtime.payload().extensions.length === 0, 15_000);
	const after = runtime.payload();
	console.log(`  after:  ${JSON.stringify(after.extensions)}`);

	check(
		'the disabled extension left the host',
		settled && after.extensions.length === 0,
		`extensions after the change: ${JSON.stringify(after.extensions.map((entry) => entry.id))}`,
	);
	check(
		'the host process was NOT restarted',
		after.host.pid === pidBefore && after.host.restarts === 0,
		`pid before=${pidBefore} after=${after.host.pid} restarts=${after.host.restarts}`,
	);

	await runtime.stop();
	rmSync(profileDir, { recursive: true, force: true });
}

console.log('DSH S1 — extension host verification');
console.log(`node ${process.version} on ${process.platform}/${process.arch}`);
console.log(`workspace: ${WORKSPACE}`);

await endToEnd();
await crashRecovery();
await trustGate();
await enableStateChange();

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
