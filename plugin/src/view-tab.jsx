/**
 * Extension views, browser half: an extension's SIDEBAR VIEW, rendered in the right Sidebar.
 *
 * DSH-authored (MIT). No Microsoft code.
 *
 * A VS Code extension can contribute a WEBVIEW VIEW: a panel that lives in a view container.
 * AI chat extensions — Cline, Continue — are exactly this. The extension host resolves such a
 * view into a webview; this module gives that webview a home in the right Sidebar.
 *
 * The contract with the Host:
 *
 *      POST /vscode-extension-host  { action: 'views' }       the registered views
 *      POST /vscode-extension-host  { action: 'resolveView' } resolve one, answer its handle
 *      GET  /vscode-ext-host/webview/panel/<handle>          the HTML the extension produced
 *      GET  /vscode-ext-host/webview/messages?handle=<h>     messages the extension sent
 *      POST /vscode-ext-host/webview/message                 a message the webview sent
 */

import { useEffect, useRef, useState } from 'react';

/** The route of the extension host. */
const HOST_ROUTE = '/vscode-extension-host';

/** The route of the webview surface on the DSH page's own origin. */
const WEBVIEW_ROUTE = '/vscode-ext-host/webview';

/** This tab type's identity. */
const TYPE_ID = 'dsh-vscode-extension-host/views';

/** This tab type's kind, the name the Sidebar's address carries. */
const KIND = 'vscode-views';

/** The dictionary namespace. */
const NS = 'vscodeExtensionViews';

/** How often the extension's messages to the view are polled. */
const MESSAGE_POLL_MS = 400;

/** How often the panel's HTML is polled while it is still empty. */
const PANEL_POLL_MS = 300;

/** How long an extension gets to produce its view before the tab says it has no content. */
const PANEL_BUDGET_MS = 10_000;

/** Chat views are the useful landing page; an arbitrary technical view is not. */
const PREFERRED_VIEWS = ['claude-dev.SidebarProvider', 'continue.continueGUIView'];

/**
 * The extensions whose views are worth offering on their own.
 *
 * An extension's views are PARTS OF AN IDE: GitLens' commit details, Data Wrangler's summary
 * and the hex editor's data inspector are panes that only mean something next to an open file,
 * a repository, or a selection. Listing them beside a chat panel makes the tab look like a
 * random dump of internals, which is not a product.
 *
 * So the tab offers the AI/agent views it can stand on its own, and falls back to the whole
 * list when no such extension is installed — nothing silently disappears.
 */
const AGENT_EXTENSIONS = new Set(['saoudrizwan.claude-dev', 'Continue.continue']);

/** Whether a view is one this tab should offer. */
function isAgentView(view) {
	return AGENT_EXTENSIONS.has(view.extensionId) || PREFERRED_VIEWS.includes(view.viewType);
}

/**
 * The views the tab offers: the agent ones when there are any, all of them otherwise.
 *
 * @param {Array<object>} views - every registered webview view.
 * @returns {Array<object>} the views to offer.
 */
export function offerableViews(views) {
	const agents = views.filter(isAgentView);
	return agents.length > 0 ? agents : views;
}


const CSS = `
.vv-root {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #1f1f1f);
}
.vv-toolbar {
  flex: none;
  display: flex;
  align-items: center;
  min-height: 48px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.12));
  background: var(--dsw-alias-bg-layer-1, #fff);
}
.vv-select {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 32px;
  padding: 0 32px 0 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16));
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: inherit;
  font: inherit;
  font-size: 13px;
  line-height: 30px;
  cursor: pointer;
}
.vv-select:focus-visible,
.vv-retry:focus-visible {
  outline: 2px solid var(--dsw-alias-label-secondary, #555);
  outline-offset: 2px;
}
.vv-frame {
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-height: 0;
  border: 0;
  display: block;
  background: #fff;
}
.vv-state {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  font-size: 13px;
  line-height: 1.55;
  color: var(--dsw-alias-label-secondary, #5f5f5f);
}
.vv-stateTitle {
  color: var(--dsw-alias-label-primary, #1f1f1f);
  font-size: 14px;
  font-weight: 600;
}
.vv-stateDescription { max-width: 320px; }
.vv-retry {
  min-width: 64px;
  min-height: 32px;
  margin-top: 8px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16));
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: inherit;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
@media (prefers-reduced-motion: reduce) {
  .vv-root *, .vv-root *::before, .vv-root *::after { animation: none !important; transition: none !important; }
}
`;

const en = {
	guideTitle: 'Extension views',
	guideDescription: 'Use chat panels from installed VS Code extensions',
	title: 'Extension views',
	empty: 'No installed extension has a sidebar view ready.',
	failed: 'This view could not be started: {message}',
	listFailed: 'The extension views could not be read: {message}',
	loading: 'Starting the extension view…',
	select: 'Extension view',
	choose: 'Choose an extension view',
	emptyView: 'This view has no content yet',
	emptyViewHint: 'It may need an open file, a repository, or a sign-in. Choose another view or retry.',
	retry: 'Retry',
};

const zh = {
	guideTitle: '扩展视图',
	guideDescription: '使用已安装 VS Code 扩展提供的对话面板',
	title: '扩展视图',
	empty: '已安装的扩展暂时没有可用的侧栏视图。',
	failed: '这个视图没能启动：{message}',
	listFailed: '无法读取扩展视图：{message}',
	loading: '正在启动扩展视图…',
	select: '扩展视图',
	choose: '选择扩展视图',
	emptyView: '这个视图暂时没有内容',
	emptyViewHint: '它可能需要先打开文件、仓库或完成登录。可以换一个视图，或重试。',
	retry: '重试',
};

/** One absolute URL on the Host. */
function routeUrl(path) {
	return new URL(path, document.baseURI).toString();
}

/** Ask the extension host for the webview views that are actually registered. */
async function fetchViews() {
	const response = await fetch(routeUrl(HOST_ROUTE), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ action: 'views' }),
	});
	const payload = await response.json().catch(() => ({}));
	if (!response.ok || payload.ok !== true) {
		throw new Error(payload.error ?? `the Host answered ${response.status}`);
	}
	return Array.isArray(payload.views) ? payload.views.filter((view) => view.kind === 'webview') : [];
}

/** Resolve one view into a webview the surface serves. */
async function resolveView(viewType) {
	const response = await fetch(routeUrl(HOST_ROUTE), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ action: 'resolveView', viewType }),
	});
	const payload = await response.json().catch(() => ({}));
	if (!response.ok || payload.ok !== true) {
		throw new Error(payload.error ?? `the Host answered ${response.status}`);
	}
	return { handle: String(payload.handle ?? ''), origin: String(payload.origin ?? '') };
}

/**
 * Read the HTML through the DSH origin.
 *
 * The iframe must load from the webview's own origin, but this inspection request must not:
 * the second listener intentionally has no CORS permission for the DSH page.
 */
async function fetchPanel(handle) {
	const response = await fetch(routeUrl(`${WEBVIEW_ROUTE}/panel/${encodeURIComponent(handle)}`), {
		headers: { accept: 'text/html' },
	});
	if (response.status === 404) {
		return { html: '', revision: 0 };
	}
	if (!response.ok) {
		throw new Error(`the panel answered ${response.status}`);
	}
	const header = response.headers.get('x-dsh-panel-revision');
	const revision = header === null ? 0 : Number.parseInt(header, 10);
	return { html: await response.text(), revision: Number.isSafeInteger(revision) ? revision : 0 };
}

/** Take the messages the extension sent to its view. */
async function fetchMessages(handle) {
	const response = await fetch(routeUrl(`${WEBVIEW_ROUTE}/messages?handle=${encodeURIComponent(handle)}`), {
		headers: { accept: 'application/json' },
	});
	if (!response.ok) {
		return [];
	}
	const payload = await response.json().catch(() => ({}));
	return Array.isArray(payload?.messages) ? payload.messages : [];
}

/** Hand a message the view sent to its extension. */
async function postMessage(handle, message) {
	await fetch(routeUrl(`${WEBVIEW_ROUTE}/message`), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ handle, message }),
	});
}

/** Pick the useful landing view, never an arbitrary internal view. */
export function chooseInitialView(views, current) {
	if (current && views.some((view) => view.viewType === current)) {
		return current;
	}
	for (const preferred of PREFERRED_VIEWS) {
		if (views.some((view) => view.viewType === preferred)) {
			return preferred;
		}
	}
	return views.length === 1 ? views[0].viewType : '';
}

/** Group the select options by the extension that contributed them. */
function groupViews(views) {
	const groups = [];
	const byExtension = new Map();
	for (const view of views) {
		const name = view.extensionName || view.extensionId || 'VS Code';
		if (!byExtension.has(name)) {
			const group = { name, views: [] };
			byExtension.set(name, group);
			groups.push(group);
		}
		byExtension.get(name).views.push(view);
	}
	return groups;
}

/** The view's webview and its two-way message bridge. */
function ExtensionFrame({ handle, origin, title, t }) {
	const frameRef = useRef(null);
	const [status, setStatus] = useState('loading');
	const [message, setMessage] = useState('');
	const [revision, setRevision] = useState(0);
	const [attempt, setAttempt] = useState(0);
	const [frameLoaded, setFrameLoaded] = useState(false);

	// Wait for real HTML. A resolved provider is not proof that it produced a usable view.
	useEffect(() => {
		let cancelled = false;
		let timer;
		const started = Date.now();
		setStatus('loading');
		setMessage('');
		setFrameLoaded(false);
		const tick = async () => {
			try {
				const panel = await fetchPanel(handle);
				if (cancelled) return;
				if (panel.html.length > 0) {
					setRevision(panel.revision);
					setStatus('ready');
					return;
				}
				if (Date.now() - started >= PANEL_BUDGET_MS) {
					setStatus('empty');
					return;
				}
				timer = setTimeout(tick, PANEL_POLL_MS);
			} catch (error) {
				if (!cancelled) {
					setMessage(error instanceof Error ? error.message : String(error));
					setStatus('failed');
				}
			}
		};
		void tick();
		return () => { cancelled = true; clearTimeout(timer); };
	}, [handle, attempt]);

	// Do not drain the Host queue until the real document is loaded: posting into an
	// about:blank frame would lose the extension's initial state messages.
	useEffect(() => {
		if (status !== 'ready' || !frameLoaded) return undefined;
		const timer = setInterval(() => {
			void (async () => {
				const frame = frameRef.current;
				if (frame === null) return;
				for (const item of await fetchMessages(handle)) {
					let value = item.value;
					try { value = JSON.parse(item.value); } catch { /* a raw message travels as it is */ }
					frame.contentWindow?.postMessage(value, origin.length > 0 ? origin : '*');
				}
			})();
		}, MESSAGE_POLL_MS);
		return () => clearInterval(timer);
	}, [handle, origin, status, frameLoaded]);

	useEffect(() => {
		const onMessage = (event) => {
			const frame = frameRef.current;
			if (frame === null || event.source !== frame.contentWindow) return;
			const data = event.data;
			if (data === null || typeof data !== 'object' || data.__dsh !== 'message') return;
			void postMessage(handle, data.payload).catch(() => undefined);
		};
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, [handle]);

	if (status === 'ready') {
		const src = `${origin}/panel/${encodeURIComponent(handle)}?rev=${revision}`;
		return (
			<iframe
				key={`${handle}:${revision}:${attempt}`}
				ref={frameRef}
				title={title}
				src={src}
				onLoad={() => setFrameLoaded(true)}
				sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads allow-popups"
				className="vv-frame"
			/>
		);
	}
	if (status === 'empty' || status === 'failed') {
		return (
			<div className="vv-state" role={status === 'failed' ? 'alert' : undefined} data-view-state={status}>
				<div className="vv-stateTitle">{t('emptyView')}</div>
				<div className="vv-stateDescription">{status === 'failed' ? message : t('emptyViewHint')}</div>
				<button type="button" className="vv-retry" onClick={() => setAttempt((value) => value + 1)}>{t('retry')}</button>
			</div>
		);
	}
	return <div className="vv-state" data-view-state="loading">{t('loading')}</div>;
}

/** The tab body: one grouped view selector over the chosen view. */
function ExtensionViewsBody(props) {
	const t = typeof props.t === 'function' ? props.t : (key) => key;
	const [views, setViews] = useState([]);
	const [selected, setSelected] = useState(undefined);
	const [resolved, setResolved] = useState(undefined);
	const [failure, setFailure] = useState(undefined);
	const [listFailure, setListFailure] = useState(undefined);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		let cancelled = false;
		const load = async () => {
			try {
				const rows = offerableViews(await fetchViews());
				if (cancelled) return;
				setViews(rows);
				setListFailure(undefined);
				setLoaded(true);
				setSelected((current) => chooseInitialView(rows, current));
			} catch (error) {
				if (!cancelled) {
					setListFailure(error instanceof Error ? error.message : String(error));
					setLoaded(true);
				}
			}
		};
		void load();
		const timer = setInterval(load, 10_000);
		return () => { cancelled = true; clearInterval(timer); };
	}, []);

	useEffect(() => {
		if (!selected) {
			setResolved(undefined);
			return undefined;
		}
		let cancelled = false;
		setFailure(undefined);
		setResolved(undefined);
		resolveView(selected)
			.then((next) => { if (!cancelled) setResolved(next); })
			.catch((error) => { if (!cancelled) setFailure(error instanceof Error ? error.message : String(error)); });
		return () => { cancelled = true; };
	}, [selected]);

	if (!loaded) {
		return <div className="vv-root"><div className="vv-state">{t('loading')}</div></div>;
	}
	if (listFailure !== undefined) {
		return <div className="vv-root"><div className="vv-state" role="alert">{t('listFailed', { message: listFailure })}</div></div>;
	}
	if (views.length === 0) {
		return <div className="vv-root"><div className="vv-state">{t('empty')}</div></div>;
	}

	const groups = groupViews(views);
	const current = views.find((view) => view.viewType === selected);
	return (
		<div className="vv-root">
			<div className="vv-toolbar">
				<select
					className="vv-select"
					aria-label={t('select')}
					data-ext-view-picker="true"
					value={selected ?? ''}
					onChange={(event) => setSelected(event.target.value)}
				>
					{!selected && <option value="">{t('choose')}</option>}
					{groups.map((group) => (
						<optgroup key={group.name} label={group.name}>
							{group.views.map((view) => (
								<option key={view.viewType} value={view.viewType}>
									{group.views.length === 1 ? group.name : (view.title || view.viewType)}
								</option>
							))}
						</optgroup>
					))}
				</select>
			</div>
			{!selected
				? <div className="vv-state">{t('choose')}</div>
				: failure !== undefined
					? <div className="vv-state" role="alert">{t('failed', { message: failure })}</div>
					: resolved === undefined
						? <div className="vv-state">{t('loading')}</div>
						: <ExtensionFrame handle={resolved.handle} origin={resolved.origin} title={current?.title || selected} t={t} />}
		</div>
	);
}

/** Register the tab type with the right Sidebar. */
export function registerExtensionViewsTab(ctx) {
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'vscode-extension-views: dictionaries');
	ctx.effect(() => {
		if (typeof document === 'undefined' || document.head === undefined) return () => undefined;
		if (document.head.querySelector('style[data-plugin="dsh-vscode-extension-views"]') !== null) return () => undefined;
		const style = document.createElement('style');
		style.setAttribute('data-plugin', 'dsh-vscode-extension-views');
		style.textContent = CSS;
		document.head.appendChild(style);
		return () => style.remove();
	}, 'vscode-extension-views: styles');
	const t = ctx.locale.bind(NS);
	const tabs = ctx.sidebarRightTabs;
	if (tabs === undefined || typeof tabs.register !== 'function') {
		console.warn('[dsh-vscode-extension-views] the right Sidebar tab registry is not available');
		return;
	}
	ctx.effect(() => tabs.register({
		id: TYPE_ID,
		kind: KIND,
		title: () => t('title'),
		guide: [{
			id: 'vscode-views',
			order: 30,
			title: () => t('guideTitle'),
			description: () => t('guideDescription'),
		}],
	}), 'vscode-extension-views: tab type');
	ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
		name: 'sidebar.right.pane.tab',
		key: TYPE_ID,
		locale: NS,
	}, ExtensionViewsBody)), 'vscode-extension-views: tab body');
}
