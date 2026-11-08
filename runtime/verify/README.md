# The executable verification suites

Every claim in the top-level README is produced by one of these scripts. They run against the
**real** artefacts — no mocks of the extension host, no hand-written expected values — and each one
prints the assertion together with the evidence that made it pass.

```bash
npm run build     # the suites test the BUILT artefacts, so build first
npm run verify    # runs all five of the suites below
```

| suite | what it proves | third-party input |
|---|---|---|
| `run.mjs` | a real Marketplace extension (`redhat.vscode-yaml`) is installed through the store's own pipeline into a throwaway profile, the host loads it, it activates, and the command it contributes appears on the DSH side; then a crashing extension is restarted under the crash cap, and an untrusted publisher is not loaded at all | `spike/vendor-ext/vscode-yaml.vsix` |
| `webview-e2e.mjs` | a real extension's **custom editor** is resolved by the host, the panel it produces is served from the webview origin, and its messages travel both ways | `runtime/verify/vendor/hediet.vscode-drawio-*.vsix` |
| `bundle-smoke.mjs` | the bundle registers its route, its tools and its actions, and the model tool answers a lossless status payload | — |
| `client-preview.mjs` | the browser half, loaded against a fake module table, registers one renderer per custom editor and picks the right one for a file | `runtime/verify/vendor/hediet.vscode-drawio-*.vsix` |
| `view-tab.mjs` | the VS Code page registers its tab, its guide card and its dictionaries, and picks the default view without picking a blank one | — |

## Third-party inputs

Two of the suites need one real VSIX each. They are not committed — they are somebody else's
artefact — so a fresh clone downloads them once:

```bash
node runtime/verify/fetch-drawio.mjs   # hediet.vscode-drawio into runtime/verify/vendor/
```

For `run.mjs`, download **redhat.vscode-yaml** from the Microsoft Marketplace and save it as
`spike/vendor-ext/vscode-yaml.vsix`:

<https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml>

Both paths are in `.gitignore`. Without the file, the suite says which file it is missing and
exits non-zero instead of failing with an unrelated error.

## Evidence

The committed logs under `runtime/verify/evidence/`, `lsp-stdio/runtime/verify/evidence/` and
`spike/evidence/` are the output of earlier runs, kept so a change to the host can be compared
against the run that produced the current numbers.

They were produced on the author's machine, so absolute paths in them are shown with the
repository root replaced by `<repo>` and any remaining home directory by `~`. Nothing else in them
was edited: the checks, the numbers and the failures are as they were printed.
