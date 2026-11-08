# VS Code extensions in DSH — what actually works

Measured on 2026-11-07 against **sixteen** real packages installed into the running desktop
profile (`~/.dsh/profiles/desktop/extensions`), each installed through the store's own
pipeline from Open VSX / the Marketplace.

Two things are measured, because they are different questions:

- **activation** — does the extension load and start inside the extension host?
- **use** — does its UI actually appear? For a *custom editor* that means: the file opens in
  the extension's own UI (rendered in a real headless Chrome, with the DSH message bridge
  wired). For a *webview view* it means: the view resolves and paints something.

A third number matters for the extensions that contribute no UI at all: how many of the
commands they declare the host actually knows, because a command that was never registered
cannot be run from anywhere.

## The list

| extension | version | category | activation | commands registered | UI measured |
|---|---|---|---|---|---|
| `hediet.vscode-drawio` | 1.6.6 | custom editor (`.drawio`, `.dio`) | active | 9/10 | **works** — the file opens in Draw.io |
| `tomoki1207.pdf` | 1.2.2 | custom editor (`.pdf`) | active | — | **works** — the page is painted by pdf.js |
| `GrapeCity.gc-excelviewer` | 4.2.58 | custom editor (`.csv`, `.xlsx`) | active | 4/4 | **works** — the table renders with sortable headers |
| `zaaack.markdown-editor` | 0.1.22 | custom editor (`.md`) | active | 1/1 | **works** — the WYSIWYG editor renders the file |
| `qwtel.sqlite-viewer` | 26.9.1 | custom editor (`.db`) | active | 5/5 | **broken** — the frame loads, the grid never appears |
| `ms-vscode.hexeditor` | 1.11.1 | custom editor (any file) | **fails** | 0/8 | **broken** — `tabGroups` is now answered, but activation fails later in telemetry setup |
| `saoudrizwan.claude-dev` (Cline) | 4.1.26 | AI agent, webview view | active | 17/19 | **works** — the chat UI renders in the right Sidebar's Extension views tab |
| `Continue.continue` | 2.1.0 | AI chat, webview view + panel | nominal active | 34/38 | **currently blocked** — its signed `node_sqlite3.node` has a different Team ID from the DSH process, so the view never registers |
| `eamodio.gitlens` | 2026.11.60410 | git, webview views | active | 712/1196 | **partial** — the view resolves but paints nothing |
| `ms-toolsai.datawrangler` | 1.24.2 | data wrangling, webview views | active | 20/20 | **partial** — the view resolves but paints nothing |
| `mtxr.sqltools` | 0.28.6 | SQL runner | active | 35/35 | no UI of its own (it is a command + database driver) |
| `donjayamanne.githistory` | 0.6.20 | git history | active | 23/24 | no UI of its own |
| `esbenp.prettier-vscode` | 12.4.0 | formatter | active | 2/2 | no UI of its own |
| `redhat.vscode-yaml` | 2.1.2026110608 | language service | active | — | no UI; the LSP itself is the `lsp-stdio` row's job |
| `bierner.markdown-mermaid` | 1.32.1 | markdown preview | active | 0/0 | no UI of its own (it patches the markdown preview) |
| `vscode-icons-team.vscode-icons` | 13.0.0 | icons | active | **0/13** | no UI of its own — and none of its commands exist |

**Activation: 15 of 16. Commands: 991 registered in total.** Ten extensions present a UI of their
own: five of the ten work, two are partial, two are broken and one is blocked.

The custom editors (the first column of the table) are five of those ten: four work and one
`qwtel.sqlite-viewer`, does not paint.

## What broke, and why

### 1. A profile with real extensions could not start at all (`spawn E2BIG`)

The init payload carries every extension's **manifest**, and it travelled through the child's
environment. GitLens' manifest alone is ~900 KiB (1196 commands), so the payload crossed the
operating system's limit and `spawn` failed before the host existed. The payload now goes to
`<profile>/logs/exthost-init.json` and the child reads it from there.

### 2. One broken extension took the whole host down

`donjayamanne.githistory` (a 2021 webpack bundle) throws while its module is evaluated. Node
exits on the unhandled rejection, so the host died and restarted in a loop — with sixteen
extensions installed, **nothing** worked. The child now reports uncaught exceptions and
unhandled rejections to the host log and keeps serving, the way VS Code treats "this
extension failed" as an extension-level error.

### 3. `onView:undefined` activated extensions for the wrong reason

`contributes.views` maps a container id to the **array** of views in it. The inferred
activation events read `.id` off the array, so every declared view produced the event
`onView:undefined`.

### 4. The hex editor needed editor tabs, then hit a second activation failure

`ms-vscode.hexeditor` calls `vscode.window.tabGroups.activeTabGroup` while it activates. The
vendored host answers with `assertReturnsDefined(...)` over the (empty) tab list. DSH now
publishes one active group with no tabs before activation, which removes that assertion. The
extension then fails later in its bundled telemetry setup with `Cannot read properties of
undefined (reading 'length')`; activation still does not finish, so none of its eight commands
exist yet.

### 5. The SQLite viewer's grid never appears

Its webview loads (the extension's own `index.js` is served and the CSP is fine) but the
table stays empty. The extension resolves its database through a **worker thread**
(`worker.js` next to the extension, plus `sqlite3.wasm`) and the viewer's `data-config`
carries the path as an `asWebviewUri`. The panel route serves the extension's own files, but
the wasm/worker pair is loaded from a path the webview's origin does not serve, and the
worker cannot start — so the query never runs and the grid stays empty.

## The two honest boundaries

**A webview view now has a home.** The right Sidebar's **Extension views** tab lists the views
that actually registered, grouped by extension, and opens Cline by default. The default is not
merely the first view in the list: GitLens' detail view has no useful content without Git
context, and selecting it first produced a misleading blank page. A view that produces no HTML
now gets an explicit empty state and a retry. Continue is the remaining exception: its native
SQLite module currently fails macOS code-signature validation before the view registers.

**A language extension does not change how a file looks.** `redhat.vscode-yaml` activates
when a YAML file is in play, but its diagnostics need a language server, which is the
`lsp-stdio` row's job — a separate line of work, not measured here.

## How it was measured

Not by reading a log and assuming. The matrix script:

1. copies the installed extensions into a throwaway profile;
2. starts the **real** extension host and the **real** webview surface;
3. opens each file through the real `open` route, which resolves the custom editor through
   the extension host;
4. loads the produced webview in a **real headless Chrome** on the webview's own origin;
5. wires the DSH message bridge in both directions;
6. asserts the extension's own DOM is present (a painted canvas for pdf.js, the grid for the
   Excel viewer, the editor for markdown) — and saves a screenshot for each.

The shipped suites are `runtime/verify/{run,webview-e2e,bundle-smoke,client-preview,view-tab}.mjs`
(27 / 22 / 19 / 14 / 11 checks, 93 in total, all green after the Extension views change).
