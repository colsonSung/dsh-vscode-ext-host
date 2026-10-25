/*---------------------------------------------------------------------------------------------
 *  DSH S1 production — the shared esbuild configuration.
 *
 *  DSH-authored (MIT).
 *
 *  Four things live here, and each of them exists because of a concrete failure:
 *
 *  1. `vsAbsolutePlugin` — the upstream tree occasionally uses the absolute `vs/...` specifier.
 *     esbuild cannot resolve it, so it is mapped back into the vendored tree.
 *
 *  2. `npmStubs` — twelve npm packages are reachable from the vendored closure but are either
 *     native modules or capabilities DSH does not implement (proxy, kerberos, ripgrep). They
 *     are stubbed OUTSIDE the upstream sources, so the upstream tree stays byte-identical.
 *
 *  3. `headerPlugin` — the MIT licence requires the upstream copyright notice to travel with the
 *     code. esbuild's `legalComments: 'inline'` only keeps comments that look like a licence
 *     (they carry `@license` / `@preserve` or start with a bang), and VS Code's header is a
 *     plain block comment, so esbuild drops it. This plugin rewrites the leading header of
 *     every vendored module into the bang form; `legalComments: 'inline'` then keeps it.
 *
 *  4. `importMetaShim` — upstream is ESM and uses `import.meta.url` / `import.meta.dirname`.
 *     The extension host is bundled to CommonJS (the upstream tree mixes `import` and
 *     `require`), where `import.meta` does not exist and the child process dies on start-up.
 *     For the ESM outputs the shim is NOT applied: `import.meta` is native there.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** `<repo>/vscode-ext-host` */
export const ROOT = resolve(__dirname, '..');
/** The vendored upstream closure. */
export const VENDOR = resolve(ROOT, 'vendor');
/** The shared DSH protocol package. */
export const PROTOCOL_PACKAGE = resolve(ROOT, 'packages/dsh-vscode-protocol');

/**
 * The product brand, read from the single source of truth.
 * @returns {object} the brand block.
 */
export function readBrand() {
	return JSON.parse(readFileSync(resolve(PROTOCOL_PACKAGE, 'brand.json'), 'utf8'));
}

/**
 * The banner the CommonJS extension-host bundle needs.
 *
 * It injects the runtime globals upstream's own build injects, plus the two `import.meta`
 * shims the CommonJS output cannot provide.
 * @returns {string} the banner source.
 */
export function cjsBanner() {
	const brand = readBrand();
	return `
globalThis._VSCODE_PRODUCT_JSON = ${JSON.stringify(brand)};
globalThis._VSCODE_PACKAGE_JSON = ${JSON.stringify({ version: brand.version, dependencies: {} })};
globalThis._VSCODE_NLS_MESSAGES = [];
globalThis._VSCODE_NLS_LANGUAGE = undefined;
var __dshImportMetaUrl = require('url').pathToFileURL(__filename).href;
var __dshImportMetaDirname = __dirname;
`;
}

/**
 * Resolve the absolute `vs/...` specifiers upstream uses back into the vendored tree.
 * @returns {object} an esbuild plugin.
 */
export function vsAbsolutePlugin() {
	return {
		name: 'vs-absolute',
		setup(build) {
			build.onResolve({ filter: /^vs\// }, (args) => {
				const relative = args.path.slice(3);
				return { path: resolve(VENDOR, 'src/vs', relative) };
			});
		},
	};
}

/**
 * Turn every vendored module's leading copyright header into an esbuild legal comment.
 * @returns {object} an esbuild plugin.
 */
export function headerPlugin() {
	return {
		name: 'upstream-header',
		setup(build) {
			build.onLoad({ filter: /\.ts$/ }, (args) => {
				const text = readFileSync(args.path, 'utf8');
				const rewritten = text.replace(
					/^\/\*(-{5,})([\s\S]*?)\*\//,
					(_match, dashes, body) => `/*!${dashes}${body}*/`,
				);
				return { contents: rewritten, loader: 'ts' };
			});
		},
	};
}

/**
 * The npm packages upstream pulls in that the extension host does not need.
 *
 * Each stub is a documented gap: a native module that cannot be ported, or a capability DSH
 * does not implement. `@vscode/proxy-agent` MUST NOT throw: `connectProxyResolver()` is awaited
 * inside `_beforeAlmostReadyToRunExtensions()`, and a throw there keeps the
 * `_almostReadyToRunExtensions` / `_readyToStartExtensionHost` barriers closed forever, so
 * `$startExtensionHost` hangs and not a single extension activates.
 */
export const NPM_STUBS = {
	'@vscode/native-watchdog': `export function start() {} export function stop() {}`,
	// `minimist` must return the `_` array: upstream's `parseArgs` does
	// `cleanedArgs._ = parsedArgs._.map(...)`, so a stub without `_` crashes the caller with
	// "Cannot read properties of undefined (reading 'map')".
	'minimist': `export default function minimist(args, opts) {
		const result = { _: [] };
		const strings = new Set((opts && opts.string) || []);
		const booleans = new Set((opts && opts.boolean) || []);
		const alias = (opts && opts.alias) || {};
		const assign = (key, value) => {
			result[key] = value;
			for (const other of alias[key] || []) { result[other] = value; }
		};
		const list = Array.isArray(args) ? args.map((entry) => String(entry)) : [];
		for (let index = 0; index < list.length; index++) {
			const argument = list[index];
			if (argument === '--') { for (const rest of list.slice(index + 1)) { result._.push(rest); } break; }
			if (!argument.startsWith('-') || argument === '-') { result._.push(argument); continue; }
			const body = argument.replace(/^--?/, '');
			const equals = body.indexOf('=');
			if (equals >= 0) { assign(body.slice(0, equals), body.slice(equals + 1)); continue; }
			if (argument.startsWith('--no-')) { assign(body.slice(3), false); continue; }
			if (booleans.has(body)) { assign(body, true); continue; }
			const next = list[index + 1];
			if (next !== undefined && !next.startsWith('-') && !strings.has(body)) { assign(body, next); index += 1; continue; }
			assign(body, true);
		}
		return result;
	}`,
	'http-proxy-agent': `export default { HttpProxyAgent: class HttpProxyAgent { constructor() { throw new Error('NotSupported: http-proxy-agent is not available in DeepSeek Harness'); } } };`,
	'https-proxy-agent': `export default { HttpsProxyAgent: class HttpsProxyAgent { constructor() { throw new Error('NotSupported: https-proxy-agent is not available in DeepSeek Harness'); } } };`,
	'kerberos': `export default { initializeClient: async () => { throw new Error('NotSupported: kerberos is not available in DeepSeek Harness'); } };`,
	'@vscode/proxy-agent': `
		export const LogLevel = { Trace: 0, Debug: 1, Info: 2, Warn: 3, Error: 4 };
		export const ProxySupportSetting = { Off: 'off', On: 'on', Fallback: 'fallback', Override: 'override' };
		export function createProxyResolver() {
			// MUST NOT throw: connectProxyResolver() is awaited inside
			// AbstractExtHostExtensionService._beforeAlmostReadyToRunExtensions(); a throw there
			// keeps the _almostReadyToRunExtensions / _readyToStartExtensionHost barriers closed
			// -> $startExtensionHost hangs forever and NO extension ever activates.
			return {
				resolveProxyWithRequest: async () => undefined,
				resolveProxyURL: async () => undefined,
				resolveProxyByURL: async () => undefined,
			};
		}
		// The http/net/tls patch functions return a PATCH OBJECT that upstream merges into
		// Node's module with Object.assign(module, patch). Returning the module itself makes
		// Object.assign copy the getter-only properties (http.maxHeaderSize) and throw
		// "Cannot set property maxHeaderSize of #<Object> which has only a getter" — inside
		// _beforeAlmostReadyToRunExtensions(), which leaves the extension host's start-up
		// barriers closed forever and hangs $startExtensionHost.
		export function createHttpPatch() { return {}; }
		export function createTlsPatch() { return {}; }
		export function createNetPatch() { return {}; }
		// The fetch and WebSocket patches return the ORIGINAL implementation.
		export function createFetchPatch(_params, originalFetch) { return originalFetch; }
		export function createWebSocketPatch(_params, originalWebSocket) { return originalWebSocket; }
		export function patchUndici(_undici) { /* no proxy support in DSH */ }
		export function createProxyAuthorizationLookup() { return async () => undefined; }
		export async function loadSystemCertificates() { return []; }
		export default { createProxyResolver, createHttpPatch, createTlsPatch, createNetPatch, createFetchPatch, createWebSocketPatch, patchUndici, createProxyAuthorizationLookup, loadSystemCertificates };
	`,
	'vscode-regexpp': `export const AST = {}; export class RegExpParser { parsePattern() { throw new Error('NotSupported: vscode-regexpp is not available in DeepSeek Harness'); } } export class RegExpVisitor { visitPattern() {} }`,
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

/**
 * Stub out the npm packages the closure reaches but DSH does not implement.
 * @returns {object} an esbuild plugin.
 */
export function npmStubsPlugin() {
	const names = Object.keys(NPM_STUBS);
	const filter = new RegExp(`^(${names.map((name) => name.replace(/[/@]/g, (m) => '\\' + m)).join('|')})$`);
	return {
		name: 'npm-stubs',
		setup(build) {
			build.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
				contents: NPM_STUBS[args.path],
				loader: 'js',
				resolveDir: ROOT,
			}));
		},
	};
}

/**
 * The TypeScript compiler options the upstream tree is compiled with.
 *
 * Upstream's own `tsconfig.base.json` targets their monorepo; DSH only needs the tree to run,
 * so the strictness flags are off. The `.js` -> `.ts` specifier rewriting is esbuild's own
 * TypeScript support, which is why no upstream file has to be touched.
 * @returns {object} the `tsconfigRaw` block.
 */
export function tsconfigRaw() {
	return {
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
	};
}

/**
 * Build the shared esbuild options.
 *
 * @param {object} options - the build options.
 * @param {'cjs'|'esm'} options.format - the output module format.
 * @param {boolean} [options.withImportMetaShim] - apply the CommonJS `import.meta` shim.
 * @param {{ js: string }} [options.banner] - the banner prepended to the output.
 * @returns {object} the esbuild options.
 */
export function sharedOptions({ format, withImportMetaShim = false, banner }) {
	return {
		bundle: true,
		platform: 'node',
		format,
		target: 'node20',
		sourcemap: false,
		minify: false,
		logLevel: 'info',
		// MIT: the upstream copyright notice has to travel with the code.
		legalComments: 'inline',
		...(banner === undefined ? {} : { banner }),
		plugins: [vsAbsolutePlugin(), npmStubsPlugin(), headerPlugin()],
		define: {
			'process.env.VSCODE_DEV': 'undefined',
			...(withImportMetaShim
				? {
					// Upstream ships as ESM and uses `import.meta.url` / `import.meta.dirname`.
					// The extension host is bundled to CommonJS, where `import.meta` does not
					// exist and the child process dies on start-up.
					'import.meta.url': '__dshImportMetaUrl',
					'import.meta.dirname': '__dshImportMetaDirname',
				}
				: {}),
		},
		loader: { '.ts': 'ts' },
		tsconfigRaw: tsconfigRaw(),
	};
}
