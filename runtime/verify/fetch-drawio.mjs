#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  DSH — fetch the drawio extension the webview verification runs against.
 *
 *  DSH-authored (MIT).
 *
 *  The verification needs a REAL extension that contributes a CUSTOM EDITOR. The one used
 *  here is `hediet.vscode-drawio` ("Draw.io Integration"), which contributes FOUR custom
 *  editors (`hediet.vscode-drawio`, `hediet.vscode-drawio-text`,
 *  `drawio-inline-editor.drawioEditor`, `drawio-inline-editor.markdownEditor`) and claims
 *  `*.drawio`, `*.dio`, `*.dio.svg`, `*.drawio.svg`, `*.drawio.png`, `*.dio.png` and `*.md`.
 *
 *  The package is fetched from the MICROSOFT MARKETPLACE, not from Open VSX: the Marketplace's
 *  asset CDN (`<publisher>.gallerycdn.vsassets.io`) is reachable from this machine, while
 *  Open VSX's file CDN is not.
 *
 *  Usage: node runtime/verify/fetch-drawio.mjs
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const HERE = resolve(import.meta.dirname, '.');
const VENDOR = resolve(HERE, 'vendor');

const PUBLISHER = 'hediet';
const NAME = 'vscode-drawio';
const VERSION = '1.17.261024055';
const ASSET_TIMESTAMP = '1792820073061';
const TARGET = resolve(VENDOR, `${PUBLISHER}.${NAME}-${VERSION}.vsix`);

const QUERY_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const ASSET_URL = `https://${PUBLISHER}.gallerycdn.vsassets.io/extensions/${PUBLISHER}/${NAME}/${VERSION}/${ASSET_TIMESTAMP}/Microsoft.VisualStudio.Services.VSIXPackage`;

mkdirSync(VENDOR, { recursive: true });

try {
	const stats = statSync(TARGET);
	console.log(`[fetch] ${TARGET} is already there (${stats.size} bytes)`);
	process.exit(0);
} catch {
	/* not there yet */
}

console.log(`[fetch] asking the Marketplace for the asset URL of ${PUBLISHER}.${NAME}`);
const query = await fetch(QUERY_URL, {
	method: 'POST',
	headers: {
		'content-type': 'application/json',
		'accept': 'application/json;api-version=7.2-preview.1',
	},
	body: JSON.stringify({
		filters: [{
			criteria: [{ filterType: 7, value: `${PUBLISHER}.${NAME}` }],
			pageNumber: 1,
			pageSize: 1,
			sortBy: 0,
			sortOrder: 0,
		}],
		assetTypes: ['Microsoft.VisualStudio.Services.VSIXPackage'],
		flags: 950,
	}),
});
const payload = await query.json();
const extension = payload?.results?.[0]?.extensions?.[0];
if (extension === undefined) {
	throw new Error(`the Marketplace does not know "${PUBLISHER}.${NAME}"`);
}
const version = extension.versions?.find((entry) => entry.version === VERSION);
if (version === undefined) {
	throw new Error(`the Marketplace does not have version ${VERSION} of "${PUBLISHER}.${NAME}"`);
}
const asset = version.files?.find((file) => file.assetType === 'Microsoft.VisualStudio.Services.VSIXPackage');
const url = asset?.source ?? ASSET_URL;
console.log(`[fetch] downloading ${url}`);

const response = await fetch(url);
if (!response.ok) {
	throw new Error(`the download answered ${response.status}`);
}
const bytes = Buffer.from(await response.arrayBuffer());
if (bytes.length < 100_000 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
	throw new Error(`the download is not a ZIP archive (${bytes.length} bytes)`);
}
writeFileSync(TARGET, bytes);
console.log(`[fetch] wrote ${TARGET} (${bytes.length} bytes)`);
