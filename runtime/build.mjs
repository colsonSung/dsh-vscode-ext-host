/*---------------------------------------------------------------------------------------------
 *  DSH S1 production — the build of the extension host bundle.
 *
 *  DSH-authored (MIT).
 *
 *  Two artefacts:
 *
 *    plugin/dist/extension-host.js   the CHILD process (CommonJS). It carries the whole
 *                                     vendored extension host: 4.4 MiB, zero external runtime
 *                                     dependency.
 *    plugin/main-host.js              the MAIN side (ESM). It carries the RPC framework, the
 *                                     profile seam, the method registry and the DSH service.
 *
 *  The upstream sources are never modified: every patch lives in `runtime/**` or in
 *  `packages/dsh-vscode-protocol/**`.
 *
 *  Usage: node runtime/build.mjs
 *--------------------------------------------------------------------------------------------*/

import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ROOT, cjsBanner, sharedOptions } from './esbuild-config.mjs';

const BUNDLE = resolve(ROOT, 'plugin');
const DIST = resolve(BUNDLE, 'dist');

mkdirSync(DIST, { recursive: true });

const targets = [
	{
		name: 'extension-host',
		entry: resolve(ROOT, 'runtime/child/ext-host-main.ts'),
		outfile: resolve(DIST, 'extension-host.js'),
		options: {
			format: 'cjs',
			withImportMetaShim: true,
			banner: { js: cjsBanner() },
		},
	},
	{
		name: 'main-host',
		entry: resolve(ROOT, 'runtime/main/index.ts'),
		outfile: resolve(BUNDLE, 'main-host.js'),
		options: {
			format: 'esm',
			withImportMetaShim: false,
		},
	},
];

for (const target of targets) {
	const result = await build({
		...sharedOptions(target.options),
		entryPoints: [target.entry],
		outfile: target.outfile,
		metafile: true,
	});

	const inputs = Object.keys(result.metafile.inputs);
	const vendored = inputs.filter((input) => input.includes('vendor/src/vs/')).length;
	const text = readFileSync(target.outfile, 'utf8');
	const headers = (text.match(/Copyright \(c\) Microsoft Corporation/g) ?? []).length;

	console.log(`\n=== ${target.name} ===`);
	console.log('bundle:   ', target.outfile);
	console.log('size:     ', (statSync(target.outfile).size / 1024 / 1024).toFixed(2), 'MiB', `(${text.split('\n').length} lines)`);
	console.log('inputs:   ', inputs.length, 'total,', vendored, 'from the vendored upstream tree');
	console.log('licence:  ', headers, 'upstream copyright headers kept in the artefact');
}

// `dist/` holds the CommonJS child process. The bundle itself is an ES module, so Node would
// otherwise read `dist/extension-host.js` as ESM and the child would die with
// "module is not defined in ES module scope". This one-line scope marker fixes it.
writeFileSync(resolve(DIST, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);

// The upstream licence and the attribution travel with the bundle: the MIT licence requires
// the copyright notice and the permission notice to be included in every copy.
copyFileSync(resolve(ROOT, 'vendor/LICENSE.vscode.txt'), resolve(BUNDLE, 'vendor/LICENSE.vscode.txt'));
copyFileSync(resolve(ROOT, 'vendor/ATTRIBUTION.md'), resolve(BUNDLE, 'vendor/ATTRIBUTION.md'));
console.log('\ncopied vendor/LICENSE.vscode.txt and vendor/ATTRIBUTION.md into the bundle');
