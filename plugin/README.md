# `dsh-vscode-extension-host`

**Run real VS Code extension packages (VSIX) inside DSH.**

DSH can install third-party VS Code extensions. This bundle is the half that makes them
*run*: it starts a real, vendored, open source VS Code extension host in a child process,
loads the extensions the profile enables and trusts, and gives the model a tool to watch and
control that process.

## It is also the whole VS Code suite

Since 2026-11-07 this bundle is the one bundle behind a profile's VS Code support. Its
`cordis.patch.yml` inserts four plugin rows:

| row | package | what it owns |
|---|---|---|
| `vsix-store` | `dsh-vsix-store` | the extension facts (`extensions.json`, `extensions-trust.json`), the registry search, the install, the trust decision |
| `vscode-extension-host` | `dsh-vscode-extension-host` | this package: the extension host, the routes, the tool, the webview surface |
| `lsp-stdio` | `dsh-lsp-stdio` | the `lsp` seam, and one provider per language server |
| `extension-console` | `dsh-extension-console` | the Extensions view on the Plugins page: one card per extension of the profile, plus the Browse VSCode tab |

The four keep their own packages and their own rows — the store must not die with the
extension host — but the plugin manager shows **one** entry, and one switch governs the
suite. The row ids, the route paths and the provided service names did not change, so a
profile override of any of the four rows and every caller of `/vscode-extensions` keep
working.

### A profile must install all four packages

The three side packages are no longer bundles, so they are **plain dependencies** of the
profile: they belong in the profile's `package.json` `dependencies` and **not** in
`dsh.profile.bundles`. A plain dependency that is not selected is not listed by the plugin
manager, so the Plugins page still shows one card.

They cannot be carried by this bundle's own `dependencies` alone: **pnpm does not install the
dependencies of a `link:` package** ([pnpm link](https://pnpm.io/cli/link)), so they would
be pruned from the profile on the next `pnpm install` and their rows would fail to import.
The profile's manifest is what installs them:

```jsonc
"dependencies": {
  "dsh-vscode-extension-host": "link:.../dsh-vscode-ext-host/plugin",             // the bundle
  "dsh-vsix-store":            "link:.../dsh-vscode-ext-host/vsix-store",         // a plain dependency
  "dsh-lsp-stdio":             "link:.../dsh-vscode-ext-host/lsp-stdio",          // a plain dependency
  "dsh-extension-console":     "link:.../dsh-vscode-ext-host/extension-console"   // a plain dependency
},
"dsh": { "profile": { "bundles": ["dsh-vscode-extension-host"] } } // one bundle only
```

`install.sh` in the repository root does exactly this.

### Why the console's own package keeps its browser half

`dsh-extension-console` stays a package of its own even though its row now lives here:
its browser half is a client module whose id **is** the package name (`dsh-extension-console`),
and a package declares one client module. Moving the host half into this bundle would mean
either rebuilding the console's client under a different id or splitting one plugin across
two packages. A row's `name` cannot name a file inside this bundle either — the Loader
resolves a row against the **profile** directory, not the bundle's.

## What it does

1. **Reads the profile contract** — `<profile>/extensions.json` and
   `<profile>/extensions-trust.json`, the two files the VSIX store owns. An extension is
   loaded only when it is **enabled** *and* its **publisher is trusted**: installing a VSIX
   means running third-party Node code, so "installed" must never imply "loaded".
2. **Starts the extension host** — a child process on DSH's own Node, speaking VS Code's own
   binary RPC protocol (`PersistentProtocol` + `RPCProtocol`, 13-byte frames).
3. **Waits for an explicit readiness handshake** — the child signals on file descriptor 3
   (`DSH_EXTHOST_READY`), and only then does the host send the four init RPCs. A request that
   arrives before the RPC actors are registered is answered with `Unknown actor` and is lost.
4. **Answers the extension host** — every `MainThread*` channel is registered. The ones DSH
   implements answer for real; the rest answer with a **type-correct empty value** derived
   from the protocol, because a blanket `undefined` crashes the whole host.
5. **Survives crashes** — a crashing host is restarted with a backoff, and three crashes
   within five minutes stop the automatic restart (VS Code's own rule).
6. **Reacts to enable/disable** — the host watches `extensions.json` and applies the change to
   the running host through an extension delta, without restarting the process.

## The route

`POST /vscode-extension-host` (same authentication as the VSIX store's route):

| action | answer |
|---|---|
| `status` | `{ ok: true, host: { running, pid?, startedAt?, restarts, lastError?, reason? }, extensions: [{ id, publisher, name, version, active, activatedAt?, error? }], commands, statusBar, skipped }` |
| `start` / `stop` / `restart` | `{ ok: true, host: {...} }` |
| `log` | `{ ok: true, lines: string[] }` |
| `command` | `{ ok: true, id, answer }` — runs a command an installed extension contributed, through the extension host |
| `views` | `{ ok: true, views: [{ viewType, extensionId }] }` — the webview views the loaded extensions registered |
| `resolveView` | `{ ok: true, handle, viewType, origin }` — asks the extension to fill one view; the webview surface then serves it |
| `treeChildren` | `{ ok: true, viewId, rows, revision }` — one level of a tree view, `handle` naming the row to expand (omitted for the root) |
| `panels` | `{ ok: true, panels: [{ handle, title, viewType, extensionId, revision }], origin }` — the webview panels the extensions opened |

`extensions[].id` is `publisher.name@version`, the same shape the VSIX store writes into
`extensions.json`.

## The webview surface

A VS Code extension can contribute a **custom editor**: a webview bound to a file. The
draw.io extension does, and it is the sharpest test of the whole chain.

| route | what |
|---|---|
| `GET /vscode-ext-host/webview/manifest` | which custom editors the loaded extensions declare, and which file suffixes they claim |
| `POST /vscode-ext-host/webview/open` | resolve the custom editor of one file (the extension opens it and answers with a handle) |
| `GET /vscode-ext-host/webview/panel/<handle>` | the HTML the extension produced |
| `GET /vscode-ext-host/webview/messages` | the messages the extension sent to its webview |
| `POST /vscode-ext-host/webview/message` | a message the webview sent to its extension |

Every route is behind `ctx.connection.authorizeIndex`, like the rest of the bundle.

**The webview gets its own origin.** The panel and the extension's own files are served
from a *second* loopback listener, not from the DSH page's origin. The iframe is therefore
cross-origin from the application, so `allow-same-origin` keeps it on the webview's own
origin (its `localStorage` works) while it still cannot reach the application's DOM,
cookies or storage. This is VS Code's own `vscode-webview://` model.

**Messages travel as values, not as envelopes.** VS Code's extension host serializes a
message, the main thread deserializes it, and the webview receives the *value*. Two
consequences the implementation has to respect:

* the extension → webview direction must **parse** the wire string before handing it to
  the iframe — otherwise the page receives a doubly encoded string and `JSON.parse(event.data)`
  yields a string instead of the action object;
* the webview → extension direction must **not** wrap the value in a frame of our own —
  a page that parses `event.data` (draw.io's editor does) would choke on the wrapper.

A webview that has to survive real extensions is therefore picky about this, and the
only honest way to find out is to run the real extension and read the page's console.

**The extension follows the interface's theme.** VS Code's extension host starts on
`ColorThemeKind.Dark` and only changes when the main thread sends
`$onColorThemeChange`. The browser half therefore reports the **effective** colour scheme
of DSH's interface (`ctx.theme`'s active theme) to the host, which sends it to the
extension host — before the extensions activate, so an extension that reads
`vscode.window.activeColorTheme` while it activates sees the scheme the user chose.
draw.io maps that kind onto its own theme (`Light` → `Kennedy`, `Dark` → `dark`), so
without it the canvas is dark on a light interface and light-on-dark shapes disappear.

**One renderer per custom editor.** VS Code's extensions contribute *editors*, not
formats: draw.io contributes a text editor and a binary one, the Data Wrangler
contributes another. The browser half therefore registers **one renderer per
editor**, under the extension's own name, so the preview's "Open with" list reads
"Draw.io", "Data Wrangler" — the way VS Code's does — instead of one lumped
"VS Code webview". The renderer carries the editor's `viewType`, and the open
request names it, so choosing one opens the file **with that editor** (the main
side refuses a `viewType` that does not claim the file).

**The priority decides who opens the file.** VS Code's rule: an editor with
priority `default` is used automatically, one with priority `option` only when
the person asks for it. The preview registry has two bands — `builtin` and
everything else — and the external band always wins the automatic selection, so
an `option` editor joins the built-in band: it is still LISTED in "Open with",
but it does not take the file away from the built-in viewer.

**A refused file says so, and the preview falls back.** An extension that took
the file and produced no webview (the Data Wrangler only opens the files IT
opened) leaves the preview without anything to show. After eight seconds the
preview says exactly that — and the editor stops offering that kind of file, so
the preview falls back to the built-in viewer on its own: an `.xls` the Data
Wrangler refused shows the spreadsheet, not a blank waiting page.

**A rewritten panel is a new panel.** An extension replaces the HTML of a webview it
already owns (draw.io does it when the theme changes). The panel therefore carries a
revision: the HTML answers it in a header, the message route repeats it, and the browser
half loads the frame with it — so a rewritten panel is loaded again instead of shown
stale, and a panel that did NOT change is never loaded twice.

## What has actually been run

Sixteen real packages, installed into the running profile through the store's own pipeline and
measured in a real browser. The full table, with the reasons for every failure, is in
[`../docs/extension-matrix.md`](../docs/extension-matrix.md).

| extension | what DSH does with it |
|---|---|
| `hediet.vscode-drawio` | the `.drawio` file opens in Draw.io inside the right Sidebar |
| `tomoki1207.pdf` | the PDF page is painted by the extension's own pdf.js |
| `GrapeCity.gc-excelviewer` | the CSV opens as a sortable table |
| `zaaack.markdown-editor` | the markdown file opens in the WYSIWYG editor |
| `saoudrizwan.claude-dev` (Cline) | opens in the right Sidebar's **Extension views** tab; the chat UI renders |
| `Continue.continue` | **currently blocked** on macOS: its `node_sqlite3.node` signature has a different Team ID from the DSH process, so activation stops before the chat view registers |
| `ms-vscode.hexeditor` | `window.tabGroups` now has an answer, but activation still fails later in the extension's telemetry setup |
| `qwtel.sqlite-viewer` | its webview loads but the grid stays empty (the worker never starts) |
| `eamodio.gitlens`, `ms-toolsai.datawrangler` | activate and register their views; the views resolve but paint nothing |

The **Extension views** tab is the home for a webview VIEW (the panel an AI chat extension
lives in). It offers the AI/agent extensions' views (Cline, Continue) and falls back to every
registered view when none is installed: GitLens' commit details or the hex editor's data
inspector are parts of an IDE, not standalone products, and listing them made the tab read as
a dump of internals. Cline is the default. The HTML readiness check uses the DSH-origin panel
route; the iframe itself still loads from the webview's own origin. A view that produces no
HTML gets an explicit empty state and a retry, not a silent blank page.

**An extension's login needs a real browser.** `vscode.env.openExternal` arrives as
`MainThreadWindow.$openUri`, and the handler used to answer `true` without opening anything:
Cline produced a device code, the caller was told the browser had opened, and nothing
appeared. The handler now opens `http`/`https` URLs with the operating system's own opener,
refuses every other scheme (a third-party extension must not launch a local handler), and
writes both the opened URL and any failure to the host log.

## Opening a file with an extension

This is the point of the bundle, and it is file-shaped, not panel-shaped: an installed
extension claims file types, and those files open **in the extension's own editor inside the
right Sidebar**.

1. The extension declares `contributes.customEditors` with the file patterns it claims
   (Draw.io claims `*.drawio`, `*.dio`, `*.dio.svg`, …).
2. The Host's manifest route lists those editors, one entry per editor with the suffixes it
   claims.
3. This bundle's browser half registers **one renderer per editor** into DSH's document
   preview, under the extension's own name ("Draw.io", "Draw.io (Binary)"), and a body into
   the right Sidebar's document slot. An editor with priority `default` wins the file
   automatically; priority `option` stays in the "Open with" list instead of taking the file
   away from the built-in viewer.
4. Opening such a file resolves the custom editor through the extension host, the extension
   produces its webview, and it renders where DSH shows documents — the right Sidebar.

Editing is the extension's own file access, so it needs no DSH-side editor: the extension
writes through `vscode.workspace.fs`, and the file on disk changes.

Installing and choosing extensions is **not** done in the right Sidebar: it lives on the
Plugins page (the `extension-console` row of this bundle), which owns the store, the
installed list and the Browse VSCode tab.

### Other route actions

The host route also answers `treeChildren` (tree views) and `panels` (open webview panels).
The **Extension views** tab consumes `views` and `resolveView`; tree views and arbitrary panels
still have no shipped UI.

## The browser half reloads itself

The browser half of this bundle is CODE, and a page that is already open still
runs the code it loaded. The Host half therefore tells the HMR transport
`ctx.clientModules.rebuilt('dsh-vscode-extension-host')` when it is
applied: the open page replaces the module in place, so a change to the
browser half takes effect **without a window reload**. Without it, every
change to the client half would need the person to reload DSH by hand — and
the symptom ("it still does not work") looks exactly like the fix not
having landed.

## The model tool

`vscode_extension_host` — the same actions the route answers (`status` / `start` / `stop` /
`restart` / `log`, plus `command` to run an extension's own command), so the model and the
VS Code page drive the same capability.

## Logs

* `<profile>/logs/extension-host.log` — the host side: process lifecycle, the handshake, every
  RPC, the activation results, the crashes and the backoff.
* `<profile>/logs/exthost.log` — the extension host's own log.
* `<profile>/logs/extHostTelemetry.log` — the extension host's telemetry log.

## Layout

| path | what |
|---|---|
| `index.js` | the Host half: the route, the tool, the auto-start |
| `main-host.js` | the main side of the protocol (compiled) |
| `dist/extension-host.js` | the child process: the vendored extension host (4.68 MiB, no runtime dependency) |
| `dist/package.json` | `{"type":"commonjs"}` — the bundle is an ES module, the child is CommonJS |
| `vendor/` | the upstream MIT licence and the attribution |

## Licence

The bundle redistributes parts of Visual Studio Code, Copyright (c) 2015 - present Microsoft
Corporation, under the MIT License. See `vendor/LICENSE.vscode.txt` and
`vendor/ATTRIBUTION.md`. The product brand is DSH's own — it does not present itself as
"VS Code" and does not use the `vscode://` URL scheme.
