# `dsh-vscode-webview-surface`

**Render a VS Code extension's webview in DSH.**

A VS Code extension can contribute a **custom editor**: a webview bound to a file. This
bundle is the DSH side of that: the HTTP surface a browser half reads, and the rendering
contract with the document preview.

The **protocol** side — the panels the extensions produced, the HTML they put in them, the
messages they sent — lives in the extension host bundle
(`dsh-vscode-extension-host`, `runtime/main/methods/webview-*.ts` and
`custom-editor-*.ts`). The two halves meet at one Cordis service:

```
this bundle:  ctx.provide('vscodeWebviewSurface', surface)
ext host:     ctx.get('vscodeWebviewSurface')
```

A Cordis service lives in the root store, so a sibling plugin can read it
(`cordis/src/reflect.ts`: `provide()` writes `this.store[key]`, `get()` reads it back for
the isolate symbol every non-isolating scope shares).

## The routes

| Route | What it does |
|---|---|
| `GET /vscode-ext-host/webview/manifest` | the custom editors the loaded extensions declare |
| `POST /vscode-ext-host/webview/open` | resolve the custom editor of a file |
| `GET /vscode-ext-host/webview/panel/<handle>` | the HTML the extension produced |
| `GET /vscode-ext-host/webview/messages` | the messages the extension sent to the webview |
| `POST /vscode-ext-host/webview/message` | a message the webview sent to its extension |
| `GET /vscode-ext-host/webview/resource/<path>` | a static file of an extension |

Every route is behind `ctx.connection.authorizeIndex`, the same gate the extension host
bundle and the VSIX store use.

## The HTML rewrite

`webview.asWebviewUri(...)` produces an
`https://file%2B.vscode-resource.vscode-cdn.net/...` URL. That host does not exist in DSH, so
the surface rewrites those URLs to its own resource route, and relaxes the extension's own
CSP just enough for the `acquireVsCodeApi` shim to run.

The resource route is a **path prefix**, not a query: the webview's HTML carries a
`<base href>` that points at one of the extension's files, and every relative URL inside the
webview resolves against it. With a path prefix the relative URLs keep resolving into the
same directory, exactly as they do in VS Code.

The resource route only serves files **inside the `extension/` subtree of a loaded
extension**. Anything else is refused — the route takes an absolute path, and without that
check it would be a read-any-file primitive.

## The iframe

The browser half renders the HTML in an iframe with `sandbox="allow-scripts"` and **without**
`allow-same-origin`. The extension's script therefore runs in an **opaque origin**: it cannot
reach the application's DOM, its cookies or its storage. The only channel out of the iframe
is `postMessage`, and both directions are checked:

```
iframe -> app   the app checks `event.source === iframe.contentWindow`
app    -> iframe the app posts to that exact WindowProxy
```

The extension's `acquireVsCodeApi()` is injected by the Host, because the iframe is a plain
document and the extension expects the global to exist.

## The preview

The browser half registers a document preview implementation
(`ctx.documentPreviews.register({ …, loading: 'renderer' })`) and a body in the keyed
`sidebar.right.tab.document` slot. The suffixes it claims are the ones the **installed**
extensions claim, read from the Host's manifest — so a `.drawio` file only gets the webview
preview when a drawio extension is actually installed.

## Build

```
node build.mjs      # the browser half -> client.js
```

The Host half (`index.js`) is plain ESM and needs no build step.
