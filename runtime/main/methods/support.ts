/*---------------------------------------------------------------------------------------------
 *  A-class main-thread services — shared helpers.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  WHAT IS IN HERE
 *  ---------------
 *  The pieces every A-class module needs and that must not be re-derived per module:
 *
 *    - the DSH command-name mapping (VS Code command ids vs DSH command names),
 *    - the credential-key encoding (VS Code secret keys vs DSH `CredentialRef`),
 *    - the `UriComponents` <-> path conversion,
 *    - the "this is not supported here" error, and
 *    - the generic RPC/logging helpers, which are re-exported from the D-class helper module
 *      rather than copied, so there is ONE implementation of them.
 *
 *  EVERYTHING HERE DEGRADES, IT NEVER CRASHES
 *  ------------------------------------------
 *  A wrong-shaped answer takes the WHOLE extension host down (the spike measured it: a stub
 *  that answered `undefined` for a list made the host crash with "tools is not iterable").
 *  So every helper in this file answers with a type-correct empty value when it cannot do
 *  the real thing, and only the *write* operations — the ones VS Code also refuses — throw.
 *--------------------------------------------------------------------------------------------*/

import { hostCall, log, toExtensionIdentifier, toFileUriComponents, toVsCancellationToken } from './ai-support.js';

export { hostCall, log, toExtensionIdentifier, toFileUriComponents, toVsCancellationToken };

/**
 * The error a "this capability does not exist in DSH" call throws.
 *
 * VS Code's own ext host raises `NotSupportedError` for the same situation
 * (`vendor/src/vs/base/common/errors.ts`), and the vendored ext host catches it in
 * `extHostApiFactory` for the API commands. Throwing a plain `Error` with the same message
 * keeps the behaviour observable without depending on the vendored error classes.
 *
 * @param what - the capability that is missing.
 * @param detail - what DSH offers instead, when there is something.
 * @returns the error to throw.
 */
export function notSupported(what: string, detail?: string): Error {
	return new Error(`NotSupported: ${what}${detail ? ` (${detail})` : ''}`);
}

/**
 * Map a VS Code command id onto a DSH command name.
 *
 * DSH command names must match `/^[a-z][a-z0-9_-]*$/u`
 * (`@deepseek-ai/dsh-commands/lib/index.js:78`, enforced at `:150`). VS Code command ids are
 * `publisher.extension.action` — mixed case, dots, and they may start with a digit or an
 * underscore (`_setContext`, `_executeHoverProvider`).
 *
 * The mapping is:
 *   1. lower-case the id;
 *   2. replace every character outside `[a-z0-9_-]` with `-`;
 *   3. collapse a run of `-` into one;
 *   4. drop a leading `-`/`_`; if nothing is left, prefix `cmd-`;
 *   5. if the result does not start with a lowercase letter, prefix `c-`.
 *
 * The mapping is NOT reversible (many ids collapse onto the same name), so the module keeps
 * its own id -> name table and never tries to invert it.
 *
 * @param id - the VS Code command id.
 * @returns the DSH command name.
 */
export function dshCommandName(id: string): string {
	const lowered = id.toLowerCase();
	const replaced = lowered.replace(/[^a-z0-9_-]+/g, '-').replace(/-{2,}/g, '-');
	const trimmed = replaced.replace(/^[-_]+/, '').replace(/-+$/, '');
	const base = trimmed.length > 0 ? trimmed : 'cmd';
	return /^[a-z]/.test(base) ? base : `c-${base}`;
}

/**
 * Build the DSH credential reference that holds one extension secret.
 *
 * DSH's `CredentialRef` must match `/^[A-Za-z_][A-Za-z0-9_]*$/`
 * (`@deepseek-ai/dsh-credentials/lib/index.js:13`) — a POSIX shell identifier. A VS Code
 * secret key is an arbitrary string (`"my api key"`), so it cannot be used verbatim.
 *
 * The encoding is: `DSH_VSCODE_<publisher>_<name>_<sha256(key) first 16 hex chars>`, where
 * `<publisher>_<name>` is sanitized to `[A-Za-z0-9_]`. The hash keeps two different keys of
 * the same extension apart even when their sanitized forms collide.
 *
 * @param extensionId - the protocol extension id, `publisher.name`.
 * @param key - the VS Code secret key.
 * @returns the credential reference, and the plain key it was derived from.
 */
export function credentialRefFor(extensionId: string, key: string): { ref: string; key: string } {
	const owner = extensionId.replace(/[^A-Za-z0-9_]/g, '_');
	const digest = sha256Hex(key).slice(0, 16);
	return { ref: `DSH_VSCODE_${owner}_${digest}`, key };
}

/**
 * The sha256 of a string, as lowercase hex.
 *
 * Implemented here rather than imported from `node:crypto` so the module stays usable in a
 * bundle that has no Node built-ins available (the method modules are also loaded by the
 * offline tooling). The implementation is the FIPS 180-4 SHA-256.
 *
 * The padding block ends with the message length **in bits** (FIPS 180-4 §5.1.1), not in
 * bytes. The two differ for every non-empty message, so a byte length here silently yields
 * a digest that is not SHA-256 — which is stable, and therefore invisible, until somebody
 * compares it with `node:crypto`. The digest was verified against `node:crypto` for the
 * empty string, ASCII, multi-byte UTF-8 and a 1 KiB input.
 *
 * @param text - the text to hash.
 * @returns the lowercase hex digest.
 */
export function sha256Hex(text: string): string {
	const bytes = new TextEncoder().encode(text);
	const K = SHA256_K;
	const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
	// The length is measured in BITS.
	const bitLength = bytes.length * 8;
	const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
	padded.set(bytes);
	padded[bytes.length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
	view.setUint32(padded.length - 4, bitLength >>> 0);
	const w = new Uint32Array(64);
	for (let offset = 0; offset < padded.length; offset += 64) {
		for (let i = 0; i < 16; i++) { w[i] = view.getUint32(offset + i * 4); }
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
			const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
		}
		let [a, b, c, d, e, f, g, h] = H;
		for (let i = 0; i < 64; i++) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
			const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (S0 + maj) >>> 0;
			h = g; g = f; f = e; e = (d + temp1) >>> 0;
			d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
		}
		H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
		H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
	}
	return H.map((value) => value.toString(16).padStart(8, '0')).join('');
}

/** The SHA-256 round constants. */
const SHA256_K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Rotate a 32-bit word right. */
function rotr(value: number, bits: number): number {
	return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/**
 * The `UriComponents` a VS Code RPC call carries, as far as DSH cares.
 *
 * The ext host sends the marshalled `Uri` (`{ $mid: MarshalledId.Uri, scheme, path, ... }`),
 * which the RPC layer restores into a `Uri` instance on the callee side. DSH only reads the
 * plain members, so the helper accepts both the marshalled and the plain shape.
 */
export interface VsUri {
	readonly scheme?: string;
	readonly authority?: string;
	readonly path?: string;
	readonly query?: string;
	readonly fragment?: string;
	readonly fsPath?: string;
}

/**
 * Read the filesystem path out of a VS Code URI.
 *
 * Only the `file:` scheme has one. A URI with any other scheme (a custom file-system
 * provider, `untitled:`, `git:`) has no path DSH can act on.
 *
 * @param uri - the URI components.
 * @returns the absolute path, or `undefined` when the URI is not a `file:` URI.
 */
export function uriToPath(uri: VsUri | undefined): string | undefined {
	if (!uri) { return undefined }
	if (uri.scheme !== 'file') { return undefined }
	if (typeof uri.fsPath === 'string' && uri.fsPath.length > 0) { return uri.fsPath }
	return typeof uri.path === 'string' ? uri.path : undefined;
}

/**
 * Build the `UriComponents` for an absolute path.
 *
 * `URI.revive()` on the ext-host side needs `scheme` + `path`; on POSIX the path *is* the
 * filesystem path.
 *
 * @param filePath - an absolute path.
 * @returns the URI components.
 */
export function pathToUri(filePath: string): VsUri {
	return { scheme: 'file', path: filePath };
}

/**
 * Whether a value is a plain JSON object (and not an array or `null`).
 *
 * @param value - the value to test.
 * @returns true for a plain object.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a DSH service off the context, tolerating both the property and the `get` form.
 *
 * A DSH service is reachable as `ctx.<name>` (the context proxy) and as `ctx.get('<name>')`.
 * The method modules receive the plugin context, so both spellings are valid depending on
 * how the caller wired the service.
 *
 * @param ctx - the DSH Host plugin context.
 * @param name - the service name.
 * @returns the service, or `undefined`.
 */
export function service(ctx: any, name: string): any {
	if (!ctx) { return undefined }
	try {
		const direct = ctx[name]
		if (direct !== undefined && direct !== null) { return direct }
	} catch { /* an unmounted service throws on the proxy */ }
	try {
		const found = typeof ctx.get === 'function' ? ctx.get(name) : undefined
		return found ?? undefined
	} catch { return undefined }
}
