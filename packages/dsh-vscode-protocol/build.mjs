/*---------------------------------------------------------------------------------------------
 *  Build `dsh-vscode-protocol` — a pure ESM library with zero third-party runtime dependencies.
 *
 *  The package compiles the DSH-authored glue AND the vendored VS Code transport into one
 *  self-contained ESM file. The vendored sources stay where they are (read-only, with their
 *  copyright headers); the build inlines them.
 *
 *  Usage: node build.mjs
 *--------------------------------------------------------------------------------------------*/

import { build } from 'esbuild';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sharedOptions } from '../../runtime/esbuild-config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE = __dirname;
const OUT = resolve(PACKAGE, 'dist');

await mkdirSync(OUT, { recursive: true });

const result = await build({
	...sharedOptions({ format: 'esm' }),
	entryPoints: [resolve(PACKAGE, 'src/index.ts')],
	outfile: resolve(OUT, 'index.js'),
	metafile: true,
	tsconfig: undefined,
});

const inputs = Object.keys(result.metafile.inputs);
const vendored = inputs.filter((input) => input.includes('vendor/src/vs/')).length;
const text = readFileSync(resolve(OUT, 'index.js'), 'utf8');

console.log('[dsh-vscode-protocol] dist/index.js', (statSync(resolve(OUT, 'index.js')).size / 1024).toFixed(0) + ' KiB');
console.log('[dsh-vscode-protocol] inputs', inputs.length, 'total,', vendored, 'from the vendored upstream tree');
console.log('[dsh-vscode-protocol] upstream copyright headers kept:', (text.match(/Copyright \(c\) Microsoft Corporation/g) ?? []).length);
