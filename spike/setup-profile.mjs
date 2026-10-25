#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  DSH S1 spike — build the DSH profile directory that the extension host reads.
 *
 *  This mirrors the contract the VSIX-storage bundle owns:
 *    <profile>/extensions.json              -> { extensions: [ ExtensionRecord ] }
 *    <profile>/extensions-trust.json        -> { publishers: { "<publisher>": true } }
 *    <profile>/extensions/<dir>/extension/  -> the unpacked VSIX `extension/` subtree
 *
 *  Usage: node setup-profile.mjs <profileDir> <vsixPath> [<vsixPath> ...]
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const [profileArg, ...vsixPaths] = process.argv.slice(2);
if (!profileArg) {
	console.error('usage: node setup-profile.mjs <profileDir> <vsixPath> [...]');
	process.exit(1);
}
const profileDir = resolve(profileArg);

const records = [];
const publishers = {};

for (const vsixPath of vsixPaths) {
	const tmp = join(tmpdir(), `dsh-spike-unpack-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tmp, { recursive: true });
	execFileSync('unzip', ['-o', '-q', resolve(vsixPath), '-d', tmp]);

	const manifest = JSON.parse(readFileSync(join(tmp, 'extension', 'package.json'), 'utf8'));
	const id = `${manifest.publisher}.${manifest.name}`;
	const dirName = `${id}-${manifest.version}`;
	const target = join(profileDir, 'extensions', dirName);
	mkdirSync(target, { recursive: true });
	rmSync(join(target, 'extension'), { recursive: true, force: true });
	cpSync(join(tmp, 'extension'), join(target, 'extension'), { recursive: true });
	rmSync(tmp, { recursive: true, force: true });

	records.push({
		id,
		publisher: manifest.publisher,
		name: manifest.name,
		version: manifest.version,
		directory: dirName,
		enabled: true,
	});
	publishers[manifest.publisher] = true;
	console.log(`[setup] unpacked ${id}@${manifest.version} -> ${target}`);
}

mkdirSync(profileDir, { recursive: true });
writeFileSync(join(profileDir, 'extensions.json'), JSON.stringify({ extensions: records }, null, 2) + '\n');
writeFileSync(join(profileDir, 'extensions-trust.json'), JSON.stringify({ publishers }, null, 2) + '\n');
console.log(`[setup] wrote ${join(profileDir, 'extensions.json')} (${records.length} extension(s))`);
console.log(`[setup] wrote ${join(profileDir, 'extensions-trust.json')}`);
