/*---------------------------------------------------------------------------------------------
 *  DSH — opening an extension's URL in the person's browser.
 *
 *  DSH-authored (MIT). No Microsoft code.
 *
 *  WHY THIS EXISTS
 *  ---------------
 *  An extension asks for a browser tab through `MainThreadWindow.$openUri` — that is the wire
 *  method behind `vscode.env.openExternal(uri)` and behind every OAuth-style login an extension
 *  performs. The handler used to answer `true` without doing anything, which is the worst of
 *  both worlds: the extension believes the browser opened, so it stops telling the person what
 *  to do, and no browser opens, so the login can never complete.
 *
 *  Cline made this visible: clicking "Login to Cline" produced a device code
 *  (`Enter this code in your browser: FGZX-FVRR`) and asked for `authkit.cline.bot/device`, the
 *  caller answered `true`, and nothing happened anywhere.
 *
 *  WHAT IT DOES
 *  ------------
 *  It opens the URL with the operating system's own opener. Only `http` and `https` are
 *  accepted: an extension is third-party code, and handing it a `file:` or a custom scheme
 *  could launch a local handler on the person's machine.
 *
 *  The launch is injectable (`launch`) so the behaviour is testable without opening a real tab.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';

/** How long the operating system's opener may take before it is given up on. */
const LAUNCH_TIMEOUT_MS = 10_000;

/**
 * The string behind a URI the extension asked DSH to open.
 *
 * The wire form is a `UriComponents` DTO (`{ scheme, authority, path, query, fragment }`), not a
 * string, and `toString()` on our own object would print `[object Object]`.
 *
 * @param uri - the DTO, or a plain string in the tests.
 * @returns the URL, or an empty string when the value is not a URL this host can open.
 */
export function uriToString(uri: unknown): string {
	if (typeof uri === 'string') {
		return uri;
	}
	if (uri === null || typeof uri !== 'object') {
		return '';
	}
	const parts = uri as Record<string, any>;
	const scheme = typeof parts.scheme === 'string' ? parts.scheme : '';
	if (scheme.length === 0) {
		return '';
	}
	const authority = typeof parts.authority === 'string' ? parts.authority : '';
	const path = typeof parts.path === 'string' ? parts.path : '';
	const query = typeof parts.query === 'string' ? parts.query : '';
	const fragment = typeof parts.fragment === 'string' ? parts.fragment : '';
	const search = query.length > 0 ? `?${query}` : '';
	const hash = fragment.length > 0 ? `#${fragment}` : '';
	return `${scheme}://${authority}${path}${search}${hash}`;
}

/**
 * Whether a URL may be handed to the operating system's opener.
 *
 * @param url - the URL.
 * @returns true for an http(s) URL with a host.
 */
export function isOpenableUrl(url: string): boolean {
	// The authority must come before the first slash: `https:///device` has no host at all, and
	// the URL parser silently moves the path into the hostname.
	if (!/^https?:\/\/[^/?#\s]+/i.test(url)) {
		return false;
	}
	try {
		const parsed = new URL(url);
		return parsed.hostname.length > 0;
	} catch {
		return false;
	}
}

/**
 * The command an operating system uses to open a URL in its default handler.
 *
 * @param platform - `process.platform`.
 * @param url - the URL to open.
 * @returns the command and its arguments.
 */
export function openerFor(platform: string, url: string): { command: string; args: string[] } {
	if (platform === 'darwin') {
		return { command: 'open', args: [url] };
	}
	if (platform === 'win32') {
		// `start` is a shell builtin; `cmd /c start "" <url>` is the supported spelling.
		return { command: 'cmd', args: ['/c', 'start', '', url] };
	}
	return { command: 'xdg-open', args: [url] };
}

/**
 * Open one URL in the person's browser.
 *
 * @param url - the URL the extension asked for.
 * @param options - the platform, a logger, and an injectable launcher.
 * @returns whether the URL was accepted and handed to the opener.
 */
export async function openExternal(
	url: string,
	options: {
		platform?: string;
		log?: (message: string) => void;
		launch?: (command: string, args: string[]) => Promise<void>;
	} = {},
): Promise<boolean> {
	const platform = options.platform ?? process.platform;
	const log = options.log ?? (() => undefined);
	if (!isOpenableUrl(url)) {
		// Refused, and said so: silently accepting would leave the extension waiting for a
		// browser tab that will never appear.
		log(`MainThreadWindow.$openUri refused a URL this host will not open: ${JSON.stringify(url).slice(0, 300)}`);
		return false;
	}
	const { command, args } = openerFor(platform, url);
	log(`MainThreadWindow.$openUri opening ${url}`);
	const launch = options.launch ?? ((file: string, argv: string[]) => new Promise<void>((resolve, reject) => {
		execFile(file, argv, { timeout: LAUNCH_TIMEOUT_MS }, (error) => {
			if (error === null) resolve();
			else reject(error);
		});
	}));
	try {
		await launch(command, args);
		return true;
	} catch (error) {
		// The person still has the URL in the log, so a failed opener is recoverable.
		log(`MainThreadWindow.$openUri could not open ${url}: ${(error as Error).message}`);
		return false;
	}
}
