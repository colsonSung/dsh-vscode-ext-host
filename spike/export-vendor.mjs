#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  DSH S1 spike — export the exact vendored closure.
 *
 *  The closure is taken from esbuild's metafile (`dist/*.inputs.json`), i.e. the files that
 *  ACTUALLY ended up in the bundle — not a hand-maintained directory list.
 *
 *  Output:
 *    vendor/src/vs/**            verbatim upstream sources (original copyright headers kept)
 *    vendor/LICENSE.vscode.txt   upstream MIT licence (must be kept verbatim)
 *    vendor/ATTRIBUTION.md       attribution + brand obligations
 *    vendor/FILELIST.txt         per-file line counts
 *    vendor/closure-summary.json per-directory file/line counts
 *
 *  Usage: node spike/export-vendor.mjs
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, relative, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const UPSTREAM = resolve(ROOT, 'upstream');
const VENDOR = resolve(ROOT, 'vendor');

const inputs = new Set();
for (const f of ['dist/extension-host.inputs.json', 'dist/main-host.inputs.json']) {
	const p = resolve(ROOT, f);
	if (!existsSync(p)) { continue; }
	for (const rel of JSON.parse(readFileSync(p, 'utf8'))) {
		if (rel.startsWith('upstream/')) { inputs.add(rel); }
	}
}

rmSync(VENDOR, { recursive: true, force: true });
mkdirSync(VENDOR, { recursive: true });

const byDir = new Map();
const fileLines = [];
let totalFiles = 0;
let totalLines = 0;

for (const rel of [...inputs].sort()) {
	const src = resolve(ROOT, rel);
	const dst = resolve(VENDOR, 'src', relative(resolve(UPSTREAM, 'src'), src));
	mkdirSync(dirname(dst), { recursive: true });
	copyFileSync(src, dst);
	const n = readFileSync(src, 'utf8').split('\n').length;
	fileLines.push(`${String(n).padStart(7)}  ${relative(VENDOR, dst)}`);
	totalFiles++;
	totalLines += n;

	const key = relative(resolve(UPSTREAM, 'src/vs'), src).split('/').slice(0, 2).join('/');
	const cur = byDir.get(key) ?? { files: 0, lines: 0 };
	cur.files++; cur.lines += n;
	byDir.set(key, cur);
}

// licence — the upstream checkout is sparse, so LICENSE.txt may not be on disk.
// Fetch it verbatim from the pinned commit if needed.
const licenceSrc = resolve(UPSTREAM, 'LICENSE.txt');
const licenceDst = resolve(VENDOR, 'LICENSE.vscode.txt');
if (existsSync(licenceSrc)) {
	copyFileSync(licenceSrc, licenceDst);
} else {
	const commit = execFileSync('git', ['-C', UPSTREAM, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	// The blob is in the git object store even though the sparse checkout does not
	// materialise it — read it straight from git (no network needed).
	const text = execFileSync('git', ['-C', UPSTREAM, 'show', `${commit}:LICENSE.txt`], { encoding: 'utf8' });
	writeFileSync(licenceDst, text);
	console.log(`[export-vendor] extracted LICENSE.txt from git object store (${commit})`);
}

writeFileSync(resolve(VENDOR, 'FILELIST.txt'), fileLines.join('\n') + '\n');

const summary = {
	upstreamCommit: execFileSync('git', ['-C', UPSTREAM, 'log', '-1', '--format=%H %ad', '--date=iso'], { encoding: 'utf8' }).trim(),
	generatedBy: 'spike/export-vendor.mjs',
	closure: 'transitive import closure of the vendored extension host + main host (esbuild metafile)',
	totalFiles,
	totalLines,
	byDirectory: Object.fromEntries([...byDir].sort((a, b) => b[1].lines - a[1].lines)),
};
writeFileSync(resolve(VENDOR, 'closure-summary.json'), JSON.stringify(summary, null, 2) + '\n');

const attribution = `# Third-party attribution — vendored Microsoft VS Code extension host

This directory contains **verbatim sources from the Microsoft VS Code repository**, vendored so
that DSH can run real VS Code extensions inside its own extension host process.

## Microsoft VS Code

* Upstream repository: <https://github.com/microsoft/vscode>
* Vendored commit: \`${summary.upstreamCommit}\`
* Vendored subset: \`src/vs/**\` — the transitive import closure of
  * \`src/vs/workbench/api/common/extensionHostMain.ts\` (the extension host bootstrap),
  * \`src/vs/workbench/api/node/extHost.node.services.ts\` (the Node service registrations),
  * \`src/vs/workbench/api/common/extHost.api.impl.ts\` (the \`vscode\` API factory),
  * \`src/vs/workbench/services/extensions/common/rpcProtocol.ts\` (the RPC framework),
  * \`src/vs/base/parts/ipc/common/ipc.net.ts\` (\`PersistentProtocol\` — the wire transport).
* Licence: MIT. The verbatim licence text is in [\`LICENSE.vscode.txt\`](./LICENSE.vscode.txt).

Every vendored file keeps its original copyright header:

\`\`\`
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
\`\`\`

### MIT obligations that DSH must honour

1. **Keep the copyright notice and the full MIT licence text** in every copy or substantial
   portion of the Software. \`vendor/LICENSE.vscode.txt\` + the per-file headers satisfy this.
2. Do **not** strip or rewrite the upstream headers.

### Trademark obligations (separate from the licence)

* "Visual Studio Code" / "VS Code" and the VS Code logo are **Microsoft trademarks**.
  DSH must not use them as its own product name or imply official affiliation.
  DSH describes this capability as *"compatible with the VS Code extension format"* /
  *"runs the open-source VS Code extension host"*.
* The upstream \`product.json\` brand fields are **replaced** in the DSH build
  (see \`spike/build.mjs\`): \`nameShort\` / \`nameLong\` = "DeepSeek Harness",
  \`applicationName\` = "deepseek-harness", \`dataFolderName\` = ".dsh",
  \`urlProtocol\` = "dsh" (NOT \`vscode://\`), \`win32AppUserModelId\` = "DeepSeek.Harness".

## Third-party npm packages

The bundled extension host has **no runtime npm dependency**: every upstream npm package that
is reachable from the vendored closure is replaced by a local stub
(see \`spike/build.mjs\` → \`NPM_STUBS\`). Each stub is listed with its justification in
\`vscode-extension-support/exthost-spike.md\`.
`;

writeFileSync(resolve(VENDOR, 'ATTRIBUTION.md'), attribution);

console.log(`[export-vendor] ${totalFiles} files / ${totalLines} lines -> ${VENDOR}`);
console.log(`[export-vendor] summary -> ${resolve(VENDOR, 'closure-summary.json')}`);
