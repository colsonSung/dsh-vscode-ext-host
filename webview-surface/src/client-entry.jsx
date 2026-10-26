/**
 * Webview surface, browser half: the document preview that renders a VS Code webview.
 *
 * DSH-authored (MIT). No Microsoft code.
 *
 * WHAT THIS DOES
 * ---------------
 * A VS Code extension can contribute a CUSTOM EDITOR: a webview bound to a file. The
 * extension host bundle resolves it (the extension produces the HTML) and this half renders
 * the result where DSH shows documents — the right sidebar's document preview.
 *
 * The contract with the Host is four HTTP calls:
 *
 *      GET  /vscode-ext-host/webview/manifest   which extensions claim which file suffixes
 *      POST /vscode-ext-host/webview/open       resolve the custom editor of a file
 *      GET  /vscode-ext-host/webview/panel/<h>  the HTML the extension produced
 *      GET  /vscode-ext-host/webview/messages   the messages the extension sent to the webview
 *      POST /vscode-ext-host/webview/message    a message the webview sent to its extension
 *
 * THE IFRAME
 * ----------
 * The HTML runs in an iframe with `sandbox="allow-scripts"` and WITHOUT
 * `allow-same-origin`. The extension's script therefore runs in an OPAQUE origin: it cannot
 * reach the application's DOM, its cookies or its storage. The only channel out of the
 * iframe is `postMessage`, and both directions are checked:
 *
 *      iframe -> app   the app checks `event.source === iframe.contentWindow`
 *      app    -> iframe the app posts to that exact WindowProxy
 *
 * The extension's `acquireVsCodeApi()` is injected by the Host, because the iframe is a
 * plain document and the extension expects the global to exist.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Services this plugin reads. */
export const inject = ['slots', 'locale'];

/** The dictionary namespace owned by this plugin. */
const NS = 'vscodeWebviewSurface';

/** The route prefix the Host half serves. */
const ROUTE = '/vscode-ext-host/webview';

/** The stable identity of this preview implementation. */
const BODY_ID = '@local/dsh-vscode-webview-surface/webview';

/** How often the panel's HTML is polled while it is still empty. */
const PANEL_POLL_MS = 300;

/** How often the extension's messages are polled. */
const MESSAGE_POLL_MS = 500;

/** The English dictionary. */
const en = {
	title: 'VS Code webview',
	loading: 'Starting the VS Code webview…',
	empty: 'This file has no VS Code webview.',
	failed: 'The VS Code webview could not be started: {message}',
	unclaimed: 'No installed VS Code extension claims this file.',
};

/** The Chinese dictionary. */
const zh = {
	title: 'VS Code webview',
	loading: '正在启动 VS Code webview…',
	empty: '这个文件没有 VS Code webview。',
	failed: 'VS Code webview 启动失败：{message}',
	unclaimed: '没有已安装的 VSCode 扩展接管这个文件。',
};

/**
 * The absolute URL of a Host route.
 *
 * @param {string} path - the path below the route prefix.
 * @returns {string} the URL.
 */
function routeUrl(path) {
	const base = typeof document === 'undefined' ? undefined : document.baseURI;
	return new URL(`${ROUTE}${path}`, base ?? 'http://127.0.0.1/').toString();
}

/**
 * Read a service off the context, tolerating a missing one.
 *
 * @param {object} ctx - the plugin context.
 * @param {string} name - the service name.
 * @returns {unknown} the service, or undefined.
 */
function serviceOf(ctx, name) {
	try {
		if (typeof ctx.get === 'function') {
			return ctx.get(name) ?? undefined;
		}
		return ctx[name];
	} catch {
		return undefined;
	}
}

/**
 * Fetch the manifest of the custom editors the installed extensions declare.
 *
 * @returns {Promise<object>} the manifest.
 */
async function fetchManifest() {
	const response = await fetch(routeUrl('/manifest'), { headers: { accept: 'application/json' } });
	if (!response.ok) {
		throw new Error(`the Host answered ${response.status}`);
	}
	return await response.json();
}

/**
 * Ask the Host to resolve the custom editor of a file.
 *
 * @param {string} path - the absolute path of the file.
 * @param {string} title - the title the panel should carry.
 * @returns {Promise<object>} the panel's identity.
 */
async function openPanel(path, title) {
	const response = await fetch(routeUrl('/open'), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ path, title }),
	});
	const payload = await response.json().catch(() => ({}));
	if (!response.ok || payload.ok !== true) {
		throw new Error(payload.error ?? `the Host answered ${response.status}`);
	}
	return payload;
}

/**
 * Read the HTML the extension produced.
 *
 * @param {string} handle - the webview's handle.
 * @returns {Promise<string>} the HTML, empty when the extension has not produced it yet.
 */
async function fetchPanel(handle) {
	const response = await fetch(routeUrl(`/panel/${encodeURIComponent(handle)}`), {
		headers: { accept: 'text/html' },
	});
	if (!response.ok) {
		return '';
	}
	return await response.text();
}

/**
 * Take the messages the extension sent to the webview.
 *
 * @param {string} handle - the webview's handle.
 * @returns {Promise<Array<object>>} the messages.
 */
async function fetchMessages(handle) {
	const response = await fetch(routeUrl(`/messages?handle=${encodeURIComponent(handle)}`), {
		headers: { accept: 'application/json' },
	});
	if (!response.ok) {
		return [];
	}
	const payload = await response.json().catch(() => ({}));
	return Array.isArray(payload?.messages) ? payload.messages : [];
}

/**
 * Hand a message the webview sent to its extension.
 *
 * @param {string} handle - the webview's handle.
 * @param {unknown} message - the message.
 * @returns {Promise<void>} after the Host took it.
 */
async function deliverMessage(handle, message) {
	await fetch(routeUrl('/message'), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ handle, message }),
	});
}

/**
 * The preview body: the webview of the file, in an iframe.
 *
 * @param {object} props - the composed slot props.
 * @returns {React.ReactElement} the body.
 */
function WebviewBody(props) {
	const { useTabInfo, useResource, content, t } = props;
	const { tab } = useTabInfo();
	const meta = useResource('file')(tab.contentId);
	const absolutePath = meta?.value?.absolutePath;

	const frameRef = useRef(null);
	const [state, setState] = useState({ status: 'loading', handle: undefined, html: '' });
	const [failure, setFailure] = useState(undefined);

	const revision = content?.revision ?? 0;

	// 1. Resolve the custom editor of the file.
	useEffect(() => {
		if (typeof absolutePath !== 'string' || absolutePath.length === 0) {
			return undefined;
		}
		let cancelled = false;
		setState({ status: 'loading', handle: undefined, html: '' });
		openPanel(absolutePath, absolutePath.slice(absolutePath.lastIndexOf('/') + 1))
			.then((opened) => {
				if (!cancelled) {
					setState({ status: 'loading', handle: opened.handle, html: '' });
				}
			})
			.catch((error) => {
				if (!cancelled) {
					setFailure(error instanceof Error ? error.message : String(error));
					setState({ status: 'failed', handle: undefined, html: '' });
				}
			});
		return () => {
			cancelled = true;
		};
	}, [absolutePath, revision]);

	// 2. Wait for the HTML the extension produces.
	useEffect(() => {
		const handle = state.handle;
		if (handle === undefined) {
			return undefined;
		}
		let cancelled = false;
		const tick = async () => {
			if (cancelled) {
				return;
			}
			const html = await fetchPanel(handle);
			if (!cancelled && html.length > 0) {
				setState((current) => (current.handle === handle ? { ...current, status: 'ready', html } : current));
				return;
			}
			if (!cancelled) {
				timer = setTimeout(tick, PANEL_POLL_MS);
			}
		};
		let timer = setTimeout(tick, 0);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [state.handle]);

	// 3. The extension's messages to the webview.
	useEffect(() => {
		const handle = state.handle;
		if (handle === undefined) {
			return undefined;
		}
		const timer = setInterval(() => {
			void (async () => {
				const messages = await fetchMessages(handle);
				const frame = frameRef.current;
				if (frame === null) {
					return;
				}
				for (const message of messages) {
					let payload = null;
					try {
						payload = JSON.parse(message.value);
					} catch {
						payload = message.value;
					}
					frame.contentWindow?.postMessage({ __dsh: 'reply', payload }, '*');
				}
			})();
		}, MESSAGE_POLL_MS);
		return () => clearInterval(timer);
	}, [state.handle]);

	// 4. The webview's messages to the extension.
	useEffect(() => {
		const handle = state.handle;
		const onMessage = (event) => {
			const frame = frameRef.current;
			if (frame === null || event.source !== frame.contentWindow) {
				return;
			}
			const data = event.data;
			if (data === null || typeof data !== 'object' || data.__dsh !== 'message') {
				return;
			}
			if (handle !== undefined) {
				void deliverMessage(handle, data.payload);
			}
		};
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, [state.handle]);

	const srcDoc = useMemo(() => state.html, [state.html]);

	if (state.status === 'failed') {
		return (
			<div className="dsh-webview-preview" data-dsh-webview-state="failed">
				<p role="alert">{t('failed', { message: failure ?? '' })}</p>
			</div>
		);
	}
	if (state.status !== 'ready') {
		return (
			<div className="dsh-webview-preview" data-dsh-webview-state="loading">
				<p>{t('loading')}</p>
			</div>
		);
	}
	return (
		<div className="dsh-webview-preview" data-dsh-webview-state="ready">
			<iframe
				ref={frameRef}
				title={t('title')}
				srcDoc={srcDoc}
				sandbox="allow-scripts"
				className="dsh-webview-frame"
			/>
		</div>
	);
}

/**
 * Apply the plugin.
 *
 * @param {object} ctx - the plugin context.
 */
export function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'vscode-webview-surface: dictionaries');
	const t = ctx.locale.bind(NS);

	ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
		name: 'sidebar.right.tab.document',
		key: BODY_ID,
	}, WebviewBody)), 'vscode-webview-surface: body');

	// The preview claims the suffixes the INSTALLED extensions claim. The manifest is read
	// from the Host, and re-read when it changes: an extension can be installed while DSH
	// runs.
	ctx.effect(() => {
		const previews = serviceOf(ctx, 'documentPreviews');
		if (previews === undefined || typeof previews.register !== 'function') {
			return undefined;
		}
		let disposed = false;
		let unregister = undefined;
		let signature = '';
		const tick = async () => {
			if (disposed) {
				return;
			}
			try {
				const manifest = await fetchManifest();
				const suffixes = Array.isArray(manifest?.suffixes) ? manifest.suffixes : [];
				const next = suffixes.join(',');
				if (next !== signature) {
					signature = next;
					unregister?.();
					unregister = undefined;
					if (suffixes.length > 0) {
						unregister = previews.register({
							id: BODY_ID,
							extensions: suffixes,
							priority: 'extension',
							title: () => t('title'),
							loading: 'renderer',
							wrap: false,
						});
					}
				}
			} catch {
				/* the extension host bundle is not installed; the plain-text fallback stays */
			}
			if (!disposed) {
				timer = setTimeout(tick, 10_000);
			}
		};
		let timer = setTimeout(tick, 0);
		return () => {
			disposed = true;
			clearTimeout(timer);
			unregister?.();
		};
	}, 'vscode-webview-surface: preview');
}
