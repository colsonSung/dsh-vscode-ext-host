/*---------------------------------------------------------------------------------------------
 *  DSH S1 spike — esbuild bundler for the vendored VS Code extension host.
 *
 *  Toolchain: esbuild 0.24.x (single-file bundle, platform=node, format=cjs).
 *  Why esbuild: the upstream tree is TypeScript with ESM-style `./x.js` specifiers that map to
 *  `./x.ts` on disk. esbuild implements TypeScript's `.js` -> `.ts` resolution rewriting, so
 *  the tree bundles without touching a single upstream file.
 *--------------------------------------------------------------------------------------------*/

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const UPSTREAM = resolve(ROOT, 'upstream');
const DIST = resolve(ROOT, 'dist');

/**
 * Runtime globals that upstream's build injects at build time.
 *
 * - `_VSCODE_PRODUCT_JSON` / `_VSCODE_PACKAGE_JSON`: read by
 *   `src/vs/platform/product/common/product.ts` at module-evaluation time.
 * - `_VSCODE_NLS_MESSAGES` / `_VSCODE_NLS_LANGUAGE`: read by `src/vs/nls.ts`.
 *
 * [FINDING] brand fields must not say "VS Code" (Microsoft trademark) — the DSH spike uses
 * "DeepSeek Harness" / "dsh" / "dsh-insiders".
 */
const PRODUCT_JSON = {
	nameShort: 'DeepSeek Harness',
	nameLong: 'DeepSeek Harness',
	applicationName: 'deepseek-harness',
	dataFolderName: '.dsh',
	urlProtocol: 'dsh',
	win32AppUserModelId: 'DeepSeek.Harness',
	win32AppName: 'DeepSeek Harness',
	quality: 'stable',
	commit: 'spike',
	version: '1.104.0-spike',
	licenseName: 'MIT',
	licenseUrl: 'https://github.com/microsoft/vscode/blob/main/LICENSE.txt',
	extensionsGallery: {
		serviceUrl: 'https://open-vsx.org',
		servicePPEUrl: 'https://open-vsx.org',
		searchUrl: 'https://open-vsx.org/api/-/search',
		itemUrl: 'https://open-vsx.org/api/{publisher}/{name}/{version}/file/{publisher}.{name}-{version}.vsix',
		publisherUrl: 'https://open-vsx.org/api/-/publisher/{publisher}',
		resourceUrl: 'https://open-vsx.org/api/{publisher}/{name}/{version}/file/*',
		controlUrl: '',
	},
	extensionGalleryBanner: undefined,
};

const PACKAGE_JSON = { version: '1.104.0-spike', dependencies: {} };

const banner = `
globalThis._VSCODE_PRODUCT_JSON = ${JSON.stringify(PRODUCT_JSON)};
globalThis._VSCODE_PACKAGE_JSON = ${JSON.stringify(PACKAGE_JSON)};
globalThis._VSCODE_NLS_MESSAGES = [];
globalThis._VSCODE_NLS_LANGUAGE = undefined;
var __dshImportMetaUrl = require('url').pathToFileURL(__filename).href;
var __dshImportMetaDirname = __dirname;
`;

/**
 * esbuild plugin: resolve the absolute `vs/...` specifiers that upstream uses in a handful of
 * places, back to `upstream/src/vs/...`.
 */
const vsAbsolutePlugin = {
	name: 'vs-absolute',
	setup(build) {
		build.onResolve({ filter: /^vs\// }, (args) => {
			const rel = args.path.slice(3); // strip "vs/"
			return { path: resolve(UPSTREAM, 'src/vs', rel) };
		});
		build.onResolve({ filter: /^vs\/nls$/ }, () => ({ path: resolve(UPSTREAM, 'src/vs/nls.ts') }));
	},
};

/**
 * esbuild plugin: stub out npm packages upstream pulls in that the ext host does not need.
 *
 * Each stub is a documented "patch": a package reachable from the vendored closure but only
 * used by a capability DSH does not implement (proxy / kerberos / ripgrep / search).
 */
const NPM_STUBS = {
	'@vscode/native-watchdog': `export function start() {} export function stop() {}`,
	'minimist': `export default function minimist(args) { const o = {}; for (let i = 0; i < args.length; i++) { const a = args[i]; if (a.startsWith('--')) { const k = a.slice(2); const eq = k.indexOf('='); if (eq >= 0) { o[k.slice(0, eq)] = k.slice(eq + 1); } else { const n = args[i + 1]; if (n !== undefined && !n.startsWith('-')) { o[k] = n; i++; } else { o[k] = true; } } } } return o; }`,
	'http-proxy-agent': `export default { HttpProxyAgent: class HttpProxyAgent { constructor() { throw new Error('NotSupported: http-proxy-agent is stubbed out in the DSH spike'); } } };`,
	'https-proxy-agent': `export default { HttpsProxyAgent: class HttpsProxyAgent { constructor() { throw new Error('NotSupported: https-proxy-agent is stubbed out in the DSH spike'); } } };`,
	'kerberos': `export default { initializeClient: async () => { throw new Error('NotSupported: kerberos is stubbed out in the DSH spike'); } };`,
	'@vscode/proxy-agent': `
		export const LogLevel = { Trace: 0, Debug: 1, Info: 2, Warn: 3, Error: 4 };
		export const ProxySupportSetting = { Off: 'off', On: 'on', Fallback: 'fallback', Override: 'override' };
		export function createProxyResolver() {
			// PATCH #6: must NOT throw. connectProxyResolver() is awaited inside
			// AbstractExtHostExtensionService._beforeAlmostReadyToRunExtensions(); if it throws,
			// the ext host never opens the _almostReadyToRunExtensions / _readyToStartExtensionHost
			// barriers -> $startExtensionHost hangs forever and NO extension ever activates.
			return {
				resolveProxyWithRequest: async () => undefined,
				resolveProxyURL: async () => undefined,
				resolveProxyByURL: async () => undefined,
			};
		}
		export function createHttpPatch() { return (a) => a; }
		export function createTlsPatch() { return (a) => a; }
		export function createNetPatch() { return (a) => a; }
		export function createFetchPatch() { return (a) => a; }
		export function createWebSocketPatch() { return (a) => a; }
		export function createProxyAuthorizationLookup() { return async () => undefined; }
		export async function loadSystemCertificates() { return []; }
	`,
	'vscode-regexpp': `export const AST = {}; export class RegExpParser { parsePattern() { throw new Error('NotSupported: vscode-regexpp is stubbed out in the DSH spike'); } } export class RegExpVisitor { visitPattern() {} }`,
	'@vscode/ripgrep-universal': `export const rgPath = '';`,
	'undici': `export default {};`,
	'undici-types': `export type RequestInit = any; export type Dispatcher = any; export type Agent = any;`,
	'@vscode/windows-process-tree': `export function getProcessTree() { throw new Error('NotSupported'); }`,
	'@vscode/spdlog': `
		export function setFlushOn() {}
		export async function createAsyncRotatingLogger() {
			const noop = () => {};
			return { trace: noop, debug: noop, info: noop, warn: noop, error: noop, critical: noop, setLevel: noop, clearFormatters: noop, setPattern: noop, flush: noop };
		}
	`,
};

const npmStubs = {
	name: 'npm-stubs',
	setup(build) {
		const names = Object.keys(NPM_STUBS);
		const filter = new RegExp(`^(${names.map(n => n.replace(/[/@]/g, m => '\\' + m)).join('|')})$`);
		build.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'stub' }));
		build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
			contents: NPM_STUBS[args.path],
			loader: 'js',
			resolveDir: ROOT,
		}));
	},
};

const common = {
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node20',
	sourcemap: false,
	minify: false,
	logLevel: 'info',
	legalComments: 'none',
	banner: { js: banner },
	plugins: [vsAbsolutePlugin, npmStubs],
	define: {
		// upstream guards these with `typeof` checks; keep them off
		'process.env.VSCODE_DEV': 'undefined',
		// PATCH #1: upstream ships as ESM and uses `import.meta.url` / `import.meta.dirname`
		// (createRequire + ESM require hooks). We bundle to CommonJS, where `import.meta` does
		// not exist. Substitute a banner-provided shim instead of patching upstream sources.
		'import.meta.url': '__dshImportMetaUrl',
		'import.meta.dirname': '__dshImportMetaDirname',
	},
	loader: { '.ts': 'ts' },
	tsconfigRaw: {
		compilerOptions: {
			target: 'ES2022',
			useDefineForClassFields: false,
			experimentalDecorators: true,
			verbatimModuleSyntax: false,
			importsNotUsedAsValues: 'remove',
			preserveValueImports: false,
			allowSyntheticDefaultImports: true,
			esModuleInterop: true,
			module: 'esnext',
			moduleResolution: 'bundler',
			skipLibCheck: true,
			strict: false,
		},
	},
};

async function run() {
	mkdirSync(DIST, { recursive: true });

	const targets = [
		{ name: 'extension-host', entry: resolve(ROOT, 'spike/src/ext-host-main.ts') },
		{ name: 'main-host', entry: resolve(ROOT, 'spike/src/main-host.ts') },
	];

	for (const t of targets) {
		const result = await build({
			...common,
			entryPoints: [t.entry],
			outfile: resolve(DIST, `${t.name}.js`),
			metafile: true,
		});
		const meta = result.metafile;
		const inputs = Object.keys(meta.inputs);
		const out = meta.outputs[Object.keys(meta.outputs)[0]];
		const outPath = resolve(DIST, `${t.name}.js`);
		const text = readFileSync(outPath, 'utf8');
		const lines = text.split('\n').length;

		// Which vendored upstream files made it into the bundle?
		const upstreamInputs = inputs.filter(p => p.includes('upstream/src/vs/'));
		writeFileSync(resolve(DIST, `${t.name}.inputs.json`), JSON.stringify(upstreamInputs.sort(), null, 2));

		console.log(`\n=== ${t.name} ===`);
		console.log(`bundle: ${outPath}`);
		console.log(`size:   ${(text.length / 1024).toFixed(0)} KiB (${lines} lines)`);
		console.log(`inputs: ${inputs.length} total, ${upstreamInputs.length} from upstream/src/vs`);
		console.log(`upstream inputs listed in: ${resolve(DIST, `${t.name}.inputs.json`)}`);
	}
}

run().catch(err => {
	console.error(err);
	process.exit(1);
});
