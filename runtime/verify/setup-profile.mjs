#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  DSH S1 production — build a throwaway DSH profile with the VSIX store's install pipeline.
 *
 *  DSH-authored (MIT).
 *
 *  The point of this script is that it uses the VSIX STORE's own modules
 *  (`vsix-store/src/install.js`, `records.js`, `state.js`), so the profile it writes has
 *  exactly the shape the store writes:
 *
 *      <profile>/extensions.json          { extensions: [ ExtensionRecord ] }
 *      <profile>/extensions-trust.json    { publishers: { "<publisher>": true } }
 *      <profile>/extensions/<publisher>.<name>-<version>/
 *      ├── extension/                     the unpacked VSIX `extension/` subtree
 *      ├── dsh-extension.json             the store's own metadata
 *      └── global-storage/
 *
 *  Only the DOWNLOAD and the SIGNATURE VERIFICATION are skipped: the `.vsix` file is read
 *  from disk, so the verification does not depend on the network. Everything else — the
 *  unpacking, the two-stage commit, the metadata, the record shape, the two state files — is
 *  the store's own code.
 *
 *  Usage: node setup-profile.mjs <profileDir> <vsixPath> [--untrusted <publisher>]
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
	commitDirectory,
	createStagingDirectory,
	discardStagingDirectory,
	unpackExtension,
	writeExtensionMetadata,
} from '../../../vsix-store/src/install.js';
import { readRecord } from '../../../vsix-store/src/records.js';
import { writeState, writeTrust } from '../../../vsix-store/src/state.js';

const [profileArg, ...rest] = process.argv.slice(2);
if (!profileArg) {
	console.error('usage: node setup-profile.mjs <profileDir> <vsixPath> [...] [--untrusted <publisher>]');
	process.exit(1);
}

const profileDir = resolve(profileArg);
const vsixPaths = [];
let untrustedPublisher;
for (let index = 0; index < rest.length; index++) {
	if (rest[index] === '--untrusted') {
		untrustedPublisher = rest[index + 1];
		index += 1;
		continue;
	}
	vsixPaths.push(rest[index]);
}
if (vsixPaths.length === 0) {
	console.error('usage: node setup-profile.mjs <profileDir> <vsixPath> [...]');
	process.exit(1);
}

const extensionsDir = join(profileDir, 'extensions');
mkdirSync(extensionsDir, { recursive: true });

const ctx = { get: () => undefined };
const records = [];
const publishers = {};

for (const vsixPath of vsixPaths) {
	const bytes = readFileSync(resolve(vsixPath));
	const staging = createStagingDirectory(extensionsDir);
	try {
		const manifest = unpackExtension(bytes, staging);
		const directoryName = `${manifest.publisher}.${manifest.name}-${manifest.version}`;
		const target = join(extensionsDir, directoryName);
		writeExtensionMetadata(staging, {
			publisher: manifest.publisher,
			name: manifest.name,
			version: manifest.version,
			source: 'offline-verification',
			targetPlatform: null,
			sha256: null,
			installedTimestamp: new Date().toISOString(),
		});
		commitDirectory(staging, target);

		const record = readRecord(target, {
			locale: 'en',
			trustedPublishers: { [manifest.publisher]: true },
			enabled: true,
		});
		records.push(record);
		publishers[manifest.publisher] = true;
		console.log(`[setup] unpacked ${manifest.publisher}.${manifest.name}@${manifest.version} -> ${target}`);
	} catch (error) {
		discardStagingDirectory(staging);
		throw error;
	}
}

if (untrustedPublisher !== undefined) {
	delete publishers[untrustedPublisher];
	console.log(`[setup] the publisher "${untrustedPublisher}" was left OUT of extensions-trust.json`);
}

await writeState(ctx, join(profileDir, 'extensions.json'), { extensions: records });
await writeTrust(ctx, join(profileDir, 'extensions-trust.json'), publishers);
console.log(`[setup] wrote ${join(profileDir, 'extensions.json')} (${records.length} extension(s))`);
console.log(`[setup] wrote ${join(profileDir, 'extensions-trust.json')} (${Object.keys(publishers).join(', ') || 'no trusted publisher'})`);

// The profile directory must not carry the store's staging leftovers.
for (const name of ['.staging']) {
	rmSync(join(extensionsDir, name), { recursive: true, force: true });
}
