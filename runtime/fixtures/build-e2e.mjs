/*---------------------------------------------------------------------------------------------
 *  DSH D-class probe — the build of the end-to-end driver and of its own child bundle.
 *
 *  DSH-authored (MIT).
 *
 *  The driver is TypeScript that imports the vendored upstream tree, so it needs the same
 *  esbuild configuration the extension host bundle uses (the absolute `vs/...` specifier plugin,
 *  the npm stubs and the MIT header rewrite).
 *
 *  WHY THE PROBE BUILDS ITS OWN CHILD BUNDLE
 *  -----------------------------------------
 *  The probe builds the child from the SHARED esbuild configuration, so it exercises exactly the
 *  bundle the production main side spawns — no private copy of the child.
 *
 *  (The probe used to override the `@vscode/proxy-agent` stub. It did so because the shared
 *  configuration returned the `http` module itself from `createHttpPatch()`, which made the
 *  vendored `proxyResolver.ts` run `Object.assign(http, http)` and throw on Node's getter-only
 *  `http.maxHeaderSize` — a defect that hung `$startExtensionHost` and blocked EVERY extension
 *  from activating. The shared configuration now returns `{}` and the override is gone.)
 *
 *  Usage: node runtime/fixtures/build-e2e.mjs && node runtime/fixtures/ai-dclass-e2e.mjs
 *--------------------------------------------------------------------------------------------*/

import { build } from 'esbuild';
import { resolve } from 'node:path';

import { ROOT, cjsBanner, sharedOptions } from '../esbuild-config.mjs';

// 1. the child bundle (the extension host), with the corrected stub.
const childOptions = sharedOptions({ format: 'cjs', withImportMetaShim: true });
const child = await build({
	...childOptions,
	// The CommonJS child needs the import.meta shims the banner defines.
	banner: { js: cjsBanner() },
	entryPoints: [resolve(ROOT, 'runtime/child/ext-host-main.ts')],
	outfile: resolve(ROOT, 'runtime/fixtures/extension-host-probe.js'),
	metafile: true,
});
console.log(`built runtime/fixtures/extension-host-probe.js — ${Object.keys(child.metafile.inputs).length} inputs`);

// 2. the driver.
const driverOptions = sharedOptions({ format: 'esm', withImportMetaShim: false });
const driver = await build({
	...driverOptions,
	entryPoints: [resolve(ROOT, 'runtime/fixtures/ai-dclass-e2e.ts')],
	outfile: resolve(ROOT, 'runtime/fixtures/ai-dclass-e2e.mjs'),
	metafile: true,
});
const inputs = Object.keys(driver.metafile.inputs);
const vendored = inputs.filter(input => input.includes('vendor/src/vs/')).length;
console.log(`built runtime/fixtures/ai-dclass-e2e.mjs — ${inputs.length} inputs, ${vendored} from the vendored upstream tree`);
