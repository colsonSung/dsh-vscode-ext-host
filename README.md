# VS Code Extension Host for DeepSeek Harness

**Run real VS Code extension packages (VSIX) inside DeepSeek Harness.**

DeepSeek Harness can install third-party VS Code extensions. This plugin is the half that
makes them *run*: it starts a real, vendored, open source VS Code **extension host** in a
child process, loads the extensions a profile enables and trusts, and gives the model a
tool to watch and control that process.

The extensions stay VSIX packages. They are **not** converted into Cordis bundles, and they
run inside a genuine VS Code extension host — the same one VS Code itself uses — so an
extension that ships a language server, a custom editor or a webview behaves the way its
author intended.

| | |
|---|---|
| **The host** | a child process on DSH's own Node, speaking VS Code's binary RPC protocol (`PersistentProtocol` + `RPCProtocol`) |
| **The trust gate** | an extension loads only when it is **enabled** *and* its **publisher is trusted** |
| **Crash recovery** | a crashing host restarts with a backoff; three crashes in five minutes stop the automatic restart (VS Code's own rule) |
| **The webview surface** | an extension's custom editor is resolved by the host and rendered in DSH's document preview, on its own origin |
| **The model tool** | `vscode_extension_host` — start / stop / restart the host, read its state and its log |

## Install

```bash
git clone https://github.com/colsonSung/dsh-vscode-ext-host.git
cd dsh-vscode-ext-host
./install.sh              # installs into the profile of the running Harness
```

`install.sh` takes an optional profile name (`./install.sh web`), defaults to `DSH_PROFILE`
and is idempotent. It **builds the extension host first** (see [Build](#build)), installs the
package into the profile and adds the bundle row to `<profile>/cordis.patch.yml`.
**Restart the Harness afterwards** — the host half of a plugin is loaded at start-up.

Manual equivalent:

```bash
dsh plugin --profile web add ./plugin
```

```yaml
# <profile>/cordis.patch.yml
- insert:
    - id: vscode-extension-host
      name: 'dsh-vscode-extension-host'
```

Requirements: Node.js 20 or newer, the `dsh` command on `PATH`, and network access the
first time (to fetch `esbuild`, the build dependency).

## Build

The repository ships **source**, not binaries. The extension host is ~4.9 MiB of bundled
JavaScript, and it is built from the vendored VS Code closure that lives in this
repository — so the build is reproducible and reviewable.

```bash
npm install          # esbuild, the only build dependency
npm run build        # all four build steps
```

or one step at a time:

| Command | Produces | What it is |
|---|---|---|
| `npm run build:host` | `plugin/dist/extension-host.js`, `plugin/main-host.js` | the child process (the vendored extension host) and the main side (RPC framework, profile seam, tool) |
| `npm run build:protocol` | `packages/dsh-vscode-protocol/dist/index.js` | the shared ESM protocol library |
| `npm run build:client` | `plugin/client.js` | the browser half of the bundle |
| `npm run build:webview` | `webview-surface/client.js` | the browser half of the standalone webview bundle |

`node runtime/build.mjs` is the entry point for the host build and also copies
`vendor/LICENSE.vscode.txt` and `vendor/ATTRIBUTION.md` into `plugin/vendor/`, so the MIT
licence travels with the built artefact.

The build **never modifies a vendored file**. Every DSH-specific change lives in
`runtime/**` or `packages/**`; the upstream tree is bundled byte-identically.

## `vendor/` and `upstream/`

These two directories are different things, and the difference matters.

| | `upstream/` | `vendor/` |
|---|---|---|
| what | a **checkout** of `github.com/microsoft/vscode` | the **closure** of that checkout the extension host actually needs |
| size | ~219 MB | ~14 MB |
| in this repository | **no** — it is in `.gitignore` | **yes** — it is committed |
| why | it is somebody else's repository; it is only needed to *regenerate* the closure | the closure is what the build compiles, and the MIT licence requires the copyright notice and the licence text to travel with every copy |

The closure is the transitive import closure of the extension host entry points —
638 files, ~251 000 lines — taken from `code-oss-dev` **1.144.0**, upstream commit
`1184ad4d45794110deb6b897ea83b15aac44ed89` (2026-10-23). Every vendored file keeps its
original Microsoft copyright header, and `vendor/FILELIST.txt` records the size of each one
so the closure can be checked against upstream.

`vendor/closure-summary.json` breaks the closure down per directory;
`vendor/ATTRIBUTION.md` is the full attribution.

### Regenerating the closure

Only needed when the vendored closure has to change:

```bash
git clone --filter=blob:none --sparse https://github.com/microsoft/vscode.git upstream
cd upstream && git sparse-checkout set src/vs && git checkout 1184ad4d45794110deb6b897ea83b15aac44ed89
cd .. && node spike/export-vendor.mjs
```

`spike/` is the original spike that produced this design: the first cut of the bundler,
the closure exporter and the stub-returns audit. It is kept for the history, not for the
build — see [`spike/README.md`](./spike/README.md).

### The npm stubs

The vendored closure reaches a dozen npm packages that DSH does not implement (proxy,
kerberos, ripgrep, native modules). Each one is **stubbed outside the upstream sources**
— see `NPM_STUBS` in `runtime/esbuild-config.mjs` — and every stub carries a comment that
explains what it replaces and why. The upstream tree stays byte-identical.

## Licence and attribution

Two licences apply, and they cover different trees.

| What | Licence | Where |
|---|---|---|
| the DSH-authored code (`plugin/`, `runtime/`, `packages/`, `lsp-stdio/`, `webview-surface/`, `spike/`) | **MIT**, © 2026 Ethan Song | [`LICENSE`](./LICENSE) |
| the vendored VS Code sources under `vendor/src/` | **MIT**, © Microsoft Corporation | [`vendor/LICENSE.vscode.txt`](./vendor/LICENSE.vscode.txt) |

The MIT licence requires the copyright notice and the permission notice to be included in
every copy or substantial portion. Both obligations are met:

1. every vendored file keeps its original header, and
2. the full upstream licence text ships next to the closure and next to the built
   artefact (`plugin/vendor/LICENSE.vscode.txt`).

[`vendor/ATTRIBUTION.md`](./vendor/ATTRIBUTION.md) is the authoritative statement of what
was vendored, from which commit, and which obligations follow.

### Trademarks

"Visual Studio Code" and "VS Code" are **Microsoft trademarks**. This project is not
affiliated with or endorsed by Microsoft. The upstream brand fields are replaced in the
DSH build (`packages/dsh-vscode-protocol/brand.json`): the product identifies itself as
"DeepSeek Harness", the application id is `deepseek-harness`, the data folder is `.dsh`
and the URL scheme is `dsh://` — **not** `vscode://`.

## Layout

```
plugin/            the installable DeepSeek Harness bundle (host + client)
runtime/           the DSH-authored host code and the build scripts
packages/          the shared protocol package (RPC framing + channel mapping)
vendor/            the vendored VS Code closure + its licence and attribution
lsp-stdio/         a second bundle: a stdio LSP provider (optional)
webview-surface/   the standalone webview bundle (optional, superseded by plugin/)
spike/             the original spike: bundler, closure exporter, stub audit
install.sh         one-command install into a profile
```

`plugin/` is the package `install.sh` installs. `lsp-stdio/` and `webview-surface/` are
separate DeepSeek Harness bundles that live in the same repository; they are optional.
The webview surface that the extension host actually uses is `plugin/webview-surface.js` —
the standalone `webview-surface/` bundle is the earlier, separate shape.

## The model tool

`vscode_extension_host` exposes the same five actions the Extensions page uses:

| action | what it does |
|---|---|
| `status` | whether the host runs, which extensions are loaded, which commands are registered, which extensions were skipped and why |
| `start` / `stop` / `restart` | control the host process |
| `log` | read the host's log lines |

## Security

An installed extension is **real third-party code**: it runs with your user's permissions.
The plugin therefore never implies that "installed" means "loaded" — an extension is only
loaded when it is enabled *and* its publisher is trusted in
`<profile>/extensions-trust.json`. See [`SECURITY.md`](./SECURITY.md) for where every piece
of state lives and how to revoke it.

## Verification

`runtime/verify/` holds the end-to-end verification of the host, and
`runtime/verify/evidence/` holds the recorded output of those runs.

```bash
node runtime/verify/run.mjs
```

The harness builds a throwaway profile, unpacks a real marketplace extension into it with
the VSIX store's own installer, starts the host and checks that the extension activates.
Two of its helpers need files this repository does not carry:

* `runtime/verify/vendor/` — a VS Code build downloaded for the draw.io webview check.
  It is a third-party artefact and is not committed; the verification script prints the URL
  it expects.
* `runtime/verify/setup-profile.mjs` imports the VSIX store's modules from a **sibling
  checkout** (`../vsix-store/`). It is only used by the verification harness, never by the
  build or by the installed plugin.

## Development

```bash
npm install
npm run build
```

The build is deterministic: the same source and the same closure produce the same bundle.
`runtime/build.mjs` prints the number of inputs, how many of them come from the vendored
tree and how many upstream copyright headers the artefact still carries — the last number
is the MIT check.

## License

MIT for the DSH-authored code — see [LICENSE](./LICENSE). The vendored VS Code closure
carries its own MIT licence and attribution — see
[`vendor/ATTRIBUTION.md`](./vendor/ATTRIBUTION.md).
