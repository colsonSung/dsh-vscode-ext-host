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
 * The contract with the Host is five HTTP calls:
 *
 *      GET  /vscode-ext-host/webview/manifest   which extensions claim which file suffixes
 *      POST /vscode-ext-host/webview/open       resolve the custom editor of a file
 *      GET  /vscode-ext-host/webview/panel/<h>  the HTML the extension produced
 *      GET  /vscode-ext-host/webview/messages   the messages the extension sent to the webview
 *      POST /vscode-ext-host/webview/message    a message the webview sent to its extension
 *
 * THE IFRAME
 * ----------
 * The HTML runs in an iframe that loads from the WEBVIEW ORIGIN — a second loopback
 * listener the Host owns, separate from the DSH page's own origin. The iframe is
 * therefore cross-origin from the application, so `allow-same-origin` keeps it on the
 * webview's own origin instead of an opaque one, and the extension's `localStorage`
 * and cookies work. The extension's script still cannot reach the application's DOM:
 * the two origins differ, and only `postMessage` crosses between them.
 *
 *      iframe -> app   the app checks `event.source === iframe.contentWindow`
 *      app    -> iframe the app posts to that exact WindowProxy
 *
 * The extension's `acquireVsCodeApi()` is injected by the Host, because the iframe is a
 * plain document and the extension expects the global to exist.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

/** Services this plugin reads. */
// `documentPreviews` is a HARD dependency: the preview registry must exist
// before this module registers its renderer into it. Without the declaration the
// tree may activate this module first, the registry lookup comes back empty, and
// the renderer is never registered — the file then falls back to plain text.
export const inject = ['slots', 'locale', 'documentPreviews'];

/** The dictionary namespace owned by this plugin. */
const NS = 'vscodeWebviewSurface';

/** The route prefix the Host half serves. */
const ROUTE = '/vscode-ext-host/webview';

/** The route of the extension host itself. */
const HOST_ROUTE = '/vscode-extension-host';

/**
 * The stylesheet of the preview.
 *
 * The document body is a flex column; the webview takes the rest of it. Without these
 * rules the iframe keeps the HTML default size (300x150) and the preview looks empty.
 */
const CSS = `
.dsh-webview-preview {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.dsh-webview-frame {
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: block;
  border: 0;
  background: #fff;
}
`;

/** The stable identity of this preview implementation. */
const BODY_ID = '@local/dsh-vscode-extension-host/webview';

/**
 * The suffixes an editor REFUSED to open.
 *
 * An extension can take a file and then refuse it: the Data Wrangler only opens the
 * files IT opened, so in DSH — where the file is opened by the preview, not by the
 * extension — it refuses every file. Such an editor stops offering that kind of
 * file, and the preview falls back to the built-in viewer on its own.
 */
const refusedSuffixes = new Map();

/**
 * Re-register the editors of the last manifest.
 *
 * The registration lives in `apply()` (it needs the preview registry and the slot),
 * and a refusal has to reach it from the body — hence this seam.
 */
let resyncEditors = () => {};

/** The editors of the last manifest, so a refusal can re-register them. */
let lastEditors = [];

/**
 * The suffix of a file path, in the manifest's spelling.
 *
 * @param {string} path - the file's path.
 * @returns {string} the suffix, `.xls` for `a/b.xls`.
 */
function suffixOf(path) {
	const at = String(path ?? '').lastIndexOf('.');
	if (at < 0) {
		return '';
	}
	return String(path).slice(at).toLowerCase();
}

/**
 * The identity of ONE custom editor's renderer.
 *
 * Every custom editor gets its own renderer, under its own name: VS Code's "Open
 * With…" lists the extensions' editors by name, and so does DSH's preview. One
 * renderer for all of them (the lump this bundle started with) could only ever
 * answer "VS Code webview".
 *
 * @param {object} editor - the manifest entry of the editor.
 * @returns {string} the renderer's identity.
 */
function editorId(editor) {
  return `${BODY_ID}:${editor.extensionId}:${editor.viewType}`;
}

/** How often the panel's HTML is polled while it is still empty. */
const PANEL_POLL_MS = 300;

/**
 * How long the extension gets to produce its webview.
 *
 * An extension that refuses the file (draw.io's editor opens what it knows, the
 * Data Wrangler only opens the files IT opened) produces nothing at all. The
 * preview then says so instead of waiting forever.
 */
const PANEL_BUDGET_MS = 8_000;

/** How often the extension's messages are polled. */
const MESSAGE_POLL_MS = 500;

/**
 * The webview origin, shared by the plugin body and the plugin's poll.
 *
 * The Host owns a second loopback listener for webviews; its port is ephemeral, so it
 * changes whenever the Host restarts. The poll reads it and the body subscribes, which
 * keeps a live preview pointed at the running Host.
 */
const originState = { current: '', listeners: new Set() };

/**
 * Record the webview origin and tell the bodies.
 *
 * @param {string} origin - the origin the Host reported.
 */
function publishOrigin(origin) {
	if (originState.current === origin) {
		return;
	}
	originState.current = origin;
	for (const listener of originState.listeners) {
		listener(origin);
	}
}

/** The English dictionary. */
const en = {
	title: 'VS Code webview',
	loading: 'Starting the VS Code webview…',
	empty: 'This file has no VS Code webview.',
	failed: 'The VS Code webview could not be started: {message}',
	refused: 'This VS Code extension did not produce a webview for the file — it only opens the files it opened itself. Try another editor.',
	unclaimed: 'No installed VS Code extension claims this file.',
};

/** The Chinese dictionary. */
const zh = {
	title: 'VS Code webview',
	loading: '正在启动 VS Code webview…',
	empty: '这个文件没有 VS Code webview。',
	failed: 'VS Code webview 启动失败：{message}',
	refused: '这个 VSCode 扩展没有为该文件生成 webview —— 它只肯打开自己认领过的文件。换一个打开方式试试。',
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
 * @param {string} [viewType] - the editor the person chose; the best match when
 * it is omitted.
 * @returns {Promise<object>} the panel's identity.
 */
async function openPanel(path, title, viewType) {
	const response = await fetch(routeUrl('/open'), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ path, title, ...(viewType === undefined ? {} : { viewType }) }),
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
 * @returns {Promise<{ html: string, revision: number }>} the HTML (empty when the
 * extension has not produced it yet) and the revision of that HTML.
 */
async function fetchPanel(handle) {
	const response = await fetch(routeUrl(`/panel/${encodeURIComponent(handle)}`), {
		headers: { accept: 'text/html' },
	});
	if (!response.ok) {
		return { html: '', revision: 0 };
	}
	const header = response.headers.get('x-dsh-panel-revision');
	const revision = header === null ? 0 : Number.parseInt(header, 10);
	return {
		html: await response.text(),
		revision: Number.isSafeInteger(revision) ? revision : 0,
	};
}

/**
 * Take the messages the extension sent to the webview.
 *
 * @param {string} handle - the webview's handle.
 * @returns {Promise<{ messages: Array<object>, panelRevision: number }>} the messages and
 * the revision of the panel's HTML.
 */
async function fetchMessages(handle) {
	const response = await fetch(routeUrl(`/messages?handle=${encodeURIComponent(handle)}`), {
		headers: { accept: 'application/json' },
	});
	if (!response.ok) {
		return { messages: [], panelRevision: 0 };
	}
	const payload = await response.json().catch(() => ({}));
	return {
		messages: Array.isArray(payload?.messages) ? payload.messages : [],
		panelRevision: typeof payload?.panelRevision === 'number' ? payload.panelRevision : 0,
	};
}

/**
 * Tell the extension host which colour scheme DSH's interface is showing.
 *
 * The extension host's theming starts on Dark and only changes when the main thread says
 * so, so without this every extension believes the editor is dark — and the ones that
 * follow the editor's theme (draw.io draws a dark canvas) do not match the interface.
 *
 * @param {string} colorScheme - `light` or `dark`.
 * @returns {Promise<void>} after the Host took it.
 */
async function reportColorScheme(colorScheme) {
	await fetch(new URL(`${HOST_ROUTE}`, document.baseURI).toString(), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ action: 'theme', colorScheme }),
	});
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
 * The preview body of ONE custom editor: the webview of the file, in an iframe.
 *
 * @param {object} editor - the editor this body opens the file with.
 * @returns {Function} the body component.
 */
function webviewBodyFor(editor) {
  const viewType = editor.viewType;
  /**
   * @param {object} props - the composed slot props.
   * @returns {React.ReactElement} the body.
   */
  function WebviewBody(props) {
	const { useTabInfo, useResource, content } = props;
	const { tab } = useTabInfo();
	// `useResource` takes the resource address and answers the source's snapshot.
	const meta = useResource(tab.contentId);
	const absolutePath = meta?.value?.absolutePath;

	const frameRef = useRef(null);
	// The state of the webview. `revision` is the revision of the HTML the frame shows:
	// an extension replaces the HTML of a webview it already has (draw.io does it when
	// the colour scheme changes), and the frame has to be loaded again to show the new
	// one.
	const [state, setState] = useState({ status: 'loading', handle: undefined, html: '', revision: 0 });
	// The webview's own origin: a second loopback listener on the Host. The iframe
	// loads from THERE, so it is cross-origin from the DSH page — which is what
	// makes `allow-same-origin` (and localStorage) safe.
	const [origin, setOrigin] = useState(originState.current);
	const [failure, setFailure] = useState(undefined);

	const revision = content?.revision ?? 0;

	// The owner's dictionary function. The slot entry declares `locale: NS`, so the
	// runtime hands one over; the fallback keeps the body readable if it does not.
	const t = typeof props.t === 'function'
		? props.t
		: (key, values) => values?.message ?? key;

	// The origin follows the Host: its port is ephemeral and changes on a restart.
	useEffect(() => {
		const listener = (next) => { setOrigin(next); };
		originState.listeners.add(listener);
		setOrigin(originState.current);
		return () => { originState.listeners.delete(listener); };
	}, []);

	// 1. Resolve the custom editor of the file.
	useEffect(() => {
		if (typeof absolutePath !== 'string' || absolutePath.length === 0) {
			return undefined;
		}
		// This editor already refused this kind of file: do not ask again. The
		// re-registration that follows a refusal mounts this body once more, and
		// asking again would start the same wait over and over.
		const refused = refusedSuffixes.get(editorId(editor));
		if (refused?.has(suffixOf(absolutePath)) === true) {
			setFailure('refused');
			setState({ status: 'failed', handle: undefined, html: '' });
			return undefined;
		}
		let cancelled = false;
		setState({ status: 'loading', handle: undefined, html: '' });
		openPanel(absolutePath, absolutePath.slice(absolutePath.lastIndexOf('/') + 1), viewType)
			.then((opened) => {
				if (!cancelled) {
					setState({ status: 'loading', handle: opened.handle, html: '' });
				}
			})
			.catch((error) => {
				if (!cancelled) {
					// The reason is written down: an empty message here once left the
					// preview saying "could not be started: " and nothing else.
					const message = error instanceof Error ? error.message : String(error);
					console.warn(`[dsh-vscode-webview] the webview could not be started: ${message}`);
					// The failure is a CODE the render translates: an empty message
					// means the extension took the file and produced nothing.
					setFailure(message === '' ? 'refused' : message);
					setState({ status: 'failed', handle: undefined, html: '' });
				}
			});
		return () => {
			cancelled = true;
		};
	}, [absolutePath, revision]);

	// 1b. Tell the owner what happened. The owner's store waits for this before it
	// treats the preview as loaded, and it ignores a report for a stale revision.
	useEffect(() => {
		if (state.status === 'ready') {
			content?.loaded?.(meta?.value?.version);
		} else if (state.status === 'failed') {
			content?.failed?.();
		}
	}, [state.status, state.handle, content, meta?.value?.version]);

	// 2. Wait for the HTML the extension produces.
	useEffect(() => {
		const handle = state.handle;
		if (handle === undefined) {
			return undefined;
		}
		let cancelled = false;
		const started = Date.now();
		const tick = async () => {
			if (cancelled) {
				return;
			}
			const panel = await fetchPanel(handle);
			if (!cancelled && panel.html.length > 0) {
				setState((current) => (current.handle === handle
					? { ...current, status: 'ready', html: panel.html, revision: panel.revision }
					: current));
				return;
			}
			if (!cancelled && Date.now() - started > PANEL_BUDGET_MS) {
				// The extension took the file and produced nothing: it refused it.
				// The failure lives in the SAME state the render reads - a field of
				// the state object would be invisible to it.
				setFailure('refused');
				setState((current) => (current.handle === handle
					? { ...current, status: 'failed', html: '' }
					: current));
				// The editor does not open this kind of file: it stops offering it, and
				// the preview falls back to the built-in viewer on its own.
				const id = editorId(editor);
				const refused = refusedSuffixes.get(id) ?? new Set();
				refused.add(suffixOf(absolutePath));
				refusedSuffixes.set(id, refused);
				resyncEditors();
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
				const { messages, panelRevision: revision } = await fetchMessages(handle);
				// The extension rewrote the panel: the HTML on screen is not the HTML the
				// extension produced any more, so it is read again and the frame is loaded
				// again with it.
				if (revision !== 0 && revision !== state.revision) {
					const panel = await fetchPanel(handle);
					if (!cancelled && panel.html.length > 0) {
						setState((current) => (current.handle === handle
							? { ...current, status: 'ready', html: panel.html, revision: panel.revision }
							: current));
					}
				}
				const frame = frameRef.current;
				if (frame === null) {
					return;
				}
				for (const message of messages) {
					// VS Code hands the webview the extension's VALUE, not the wire format:
					// the extension host serializes it, the main thread deserializes it, and
					// the page sees the value itself. So the value is parsed here — and it is
					// posted as it is, without an envelope of ours: a page that parses
					// `event.data` (draw.io's editor does: `JSON.parse(event.data)`) only
					// works when the envelope is not there.
					let value = message.value;
					try {
						value = JSON.parse(message.value);
					} catch {
						/* a message that is not JSON travels as it is */
					}
					frame.contentWindow?.postMessage(
						value,
						origin === '' ? '*' : origin,
					);
				}
			})();
		}, MESSAGE_POLL_MS);
		return () => clearInterval(timer);
	}, [state.handle, state.revision]);

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
	const frameSrc = origin !== '' && state.handle !== undefined
		? `${origin}/panel/${state.handle}?rev=${state.revision}`
		: undefined;

	if (state.status === 'failed') {
		return (
			<div className="dsh-webview-preview" data-dsh-webview-state="failed">
				<p role="alert">
					{failure === 'refused'
						? t('refused')
						: t('failed', { message: failure ?? '' })}
				</p>
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
			<style>{CSS}</style>
			<iframe
				ref={frameRef}
				title={t('title')}
				{...(frameSrc === undefined ? { srcDoc } : { src: frameSrc })}
				sandbox={frameSrc === undefined
					? 'allow-scripts'
					: 'allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads'}
				className="dsh-webview-frame"
			/>
		</div>
	);
  }

  return WebviewBody;
}

/**
 * Apply the plugin.
 *
 * @param {object} ctx - the plugin context.
 */
export function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'vscode-webview-surface: dictionaries');
	const t = ctx.locale.bind(NS);

	// The colour scheme of the interface. The extension host's theming starts on Dark, so
	// an extension that follows the editor's theme draws a dark canvas on a light
	// interface until it is told otherwise.
	ctx.effect(() => {
		const theme = serviceOf(ctx, 'theme');
		if (theme === undefined || typeof theme.getTheme !== 'function') {
			console.warn('[dsh-vscode-webview] the theme service is not available; the extensions will believe the interface is dark');
			return undefined;
		}
		const report = () => {
			// The snapshot's ACTIVE theme carries the scheme; the preference may be
			// `system`, in which case the theme service has already resolved it.
			const snapshot = theme.getTheme();
			const colorScheme = snapshot?.active?.colorScheme === 'light' ? 'light' : 'dark';
			void reportColorScheme(colorScheme).catch((error) => {
				console.warn(`[dsh-vscode-webview] the colour scheme could not be reported: ${error instanceof Error ? error.message : String(error)}`);
			});
		};
		report();
		const off = ctx.on('theme/change', report);
		return () => { off(); };
	}, 'vscode-webview-surface: theme');

	// Every custom editor of every INSTALLED extension becomes a renderer of its
	// own, under the extension's own name: the preview's "Open with" list then
	// reads "Draw.io", "Data Wrangler", … the way VS Code's does, and choosing
	// one opens the file WITH that editor.
	//
	// The manifest is read from the Host and re-read when it changes: an
	// extension can be installed while DSH runs.
	ctx.effect(() => {
		let disposed = false;
		let signature = '';
		/** The disposers of the registrations of the current manifest. */
		let registrations = [];
		/**
		 * Register the editors of the manifest — one renderer each.
		 *
		 * An editor that refused a kind of file is registered WITHOUT that kind of
		 * file, so the preview stops offering it and falls back to the built-in
		 * viewer on its own.
		 *
		 * @param {Array<object>} editors - the manifest's editors.
		 */
		const sync = (editors) => {
			const previews = serviceOf(ctx, 'documentPreviews');
			if (previews === undefined || typeof previews.register !== 'function') {
				return;
			}
			for (const dispose of registrations) {
				dispose();
			}
			registrations = [];
			for (const editor of editors) {
				const id = editorId(editor);
				const refused = refusedSuffixes.get(id);
				const suffixes = (Array.isArray(editor.suffixes) ? editor.suffixes : [])
					.filter((suffix) => refused === undefined || !refused.has(suffix));
				if (suffixes.length === 0) {
					continue;
				}
				const displayName = typeof editor.displayName === 'string' && editor.displayName.length > 0
					? editor.displayName
					: editor.viewType;
				// VS Code's own rule: an editor with priority `default` is used
				// automatically, one with priority `option` only when the person
				// asks for it. The preview registry has two bands - `builtin` and
				// everything else - and the external one wins the automatic
				// selection, so an `option` editor joins the built-in band: it is
				// still LISTED (the person can pick it) but it does not take the
				// file away from the built-in viewer.
				const priority = editor.priority === 'option' ? 'builtin' : 'extension';
				registrations.push(previews.register({
					id,
					extensions: suffixes,
					priority,
					title: () => displayName,
					loading: 'renderer',
					wrap: false,
				}));
				registrations.push(ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
					name: 'sidebar.right.tab.document',
					key: id,
					locale: NS,
				}, webviewBodyFor(editor))));
			}
		};
		// A refusal reaches the registration from the body through this seam.
		resyncEditors = () => { sync(lastEditors); };
		const tick = async () => {
			if (disposed) {
				return;
			}
			try {
				// The registry is looked up on EVERY tick, not once at start: a service
				// that arrives later must still be found.
				const previews = serviceOf(ctx, 'documentPreviews');
				if (previews === undefined || typeof previews.register !== 'function') {
					console.warn('[dsh-vscode-webview] the document preview registry is not available yet');
					return;
				}
				const manifest = await fetchManifest();
				const editors = Array.isArray(manifest?.editors) ? manifest.editors : [];
				lastEditors = editors;
				// The webview's origin is an ephemeral loopback port: it changes when the
				// Host restarts, so the iframe's source is refreshed from every poll.
				publishOrigin(typeof manifest?.origin === 'string' ? manifest.origin : '');
				const next = editors
					.map((editor) => `${editor.extensionId}:${editor.viewType}:${(editor.suffixes ?? []).join(',')}`)
					.join('|');
				if (next !== signature) {
					signature = next;
					sync(editors);
				}
			} catch (error) {
				// The plain-text fallback stays, but the reason is written down: a
				// silent catch here once hid the renderer for a whole session.
				console.warn(`[dsh-vscode-webview] the preview registry could not be updated: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (!disposed) {
				timer = setTimeout(tick, 10_000);
			}
		};
		let timer = setTimeout(tick, 0);
		return () => {
			disposed = true;
			clearTimeout(timer);
			resyncEditors = () => {};
			for (const dispose of registrations) {
				dispose();
			}
			registrations = [];
		};
	}, 'vscode-webview-surface: preview');
}
