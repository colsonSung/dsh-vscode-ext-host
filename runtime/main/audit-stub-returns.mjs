#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  DSH S1 production — audit the coverage of `stub-returns.ts` against the protocol.
 *
 *  DSH-authored (MIT).
 *
 *  The generator (`gen-stub-returns.mjs`) and this audit DERIVE THE METHOD LIST IN DIFFERENT
 *  WAYS on purpose:
 *
 *  - the generator scans with a brace-matching scanner;
 *  - the audit walks the source LINE BY LINE and uses the fact that every interface in the
 *    protocol closes with a `}` in the first column.
 *
 *  When the two agree, the table covers every main-thread method. When they disagree, one of
 *  them has a hole — and a hole means the extension host receives `undefined` where it
 *  expects a list, which crashes the WHOLE host. So this script exits non-zero on any
 *  difference and is meant to run in CI after every upstream bump.
 *
 *  Usage: node runtime/main/audit-stub-returns.mjs
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const PROTOCOL = resolve(ROOT, 'vendor/src/vs/workbench/api/common/extHost.protocol.ts');
const TABLE = resolve(__dirname, 'stub-returns.ts');

const source = readFileSync(PROTOCOL, 'utf8');
const lines = source.split('\n');

/** The proxy identifier tables. */
const contextRe = /(\w+):\s*createProxyIdentifier<([\w]+)>\('([^']+)'\)/g;
const contextToShape = new Map();
let match;
while ((match = contextRe.exec(source))) {
	contextToShape.set(match[1], match[2]);
}

/** The channel of each shape. */
const shapeToChannel = new Map();
for (const [context, shape] of contextToShape) {
	shapeToChannel.set(shape, context);
}

/** The protocol's method list, derived line by line. */
const protocolMethods = new Set();
let currentChannel;
let inside = false;
for (const line of lines) {
	if (!inside) {
		const declaration = /^export interface (MainThread\w*)\b/.exec(line);
		if (declaration === null) { continue; }
		currentChannel = shapeToChannel.get(declaration[1]);
		inside = true;
		continue;
	}
	if (line.startsWith('}')) {
		inside = false;
		currentChannel = undefined;
		continue;
	}
	if (currentChannel === undefined) { continue; }
	const method = /^\s*\$([A-Za-z0-9_]+)\s*\(/.exec(line);
	if (method === null) { continue; }
	protocolMethods.add(`${currentChannel}.$${method[1]}`);
}

/** The generated table's keys. */
const table = readFileSync(TABLE, 'utf8');
const tableMethods = new Set([...table.matchAll(/'(MainThread\w+\.\$[A-Za-z0-9_]+)':/g)].map((entry) => entry[1]));

const missing = [...protocolMethods].filter((key) => !tableMethods.has(key)).sort();
const extra = [...tableMethods].filter((key) => !protocolMethods.has(key)).sort();

console.log(`[audit] the protocol declares ${protocolMethods.size} main-thread methods`);
console.log(`[audit] the table holds ${tableMethods.size} method defaults`);
if (missing.length > 0) {
	console.log(`[audit] MISSING ${missing.length}:`);
	for (const key of missing) { console.log(`        ${key}`); }
}
if (extra.length > 0) {
	console.log(`[audit] EXTRA ${extra.length}:`);
	for (const key of extra) { console.log(`        ${key}`); }
}
if (missing.length === 0 && extra.length === 0) {
	console.log('[audit] the table covers every main-thread method of the protocol');
	process.exit(0);
}
process.exit(1);
