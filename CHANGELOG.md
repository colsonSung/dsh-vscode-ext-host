# Changelog

## 1.2.0 — 2026-11-08

The suite is **one bundle with four plugin rows**, and the Extensions work of November 7 is in.

### Changed

- **Three VS Code bundles became one.** `plugin/` now inserts `vsix-store`,
  `vscode-extension-host`, `lsp-stdio` and `extension-console` as rows of a single bundle, so the
  plugin manager shows one entry and one switch governs the whole VS Code capability. Row ids,
  route paths and provided service names are unchanged, so profile overrides keep working.
- `install.sh` installs the bundle plus its three side packages and adds one bundle row.
- The bundle is version `1.1.0`; the top-level repository is `1.2.0`.

### Added

- **The VS Code page** in the right sidebar: webview views, tree views, status bar items, and the
  commands the loaded extensions contribute.
- **The Extensions view** (`extension-console/`): one card per installed extension, its problems,
  its dependencies, and *Browse VSCode* over Open VSX and the Microsoft Marketplace.
- **An extension's login URL opens**: a webview that asks the host to open an external URL no
  longer does nothing.
- **Measured extension matrix** (`docs/extension-matrix.md`): sixteen real packages, activation and
  UI measured separately.
- `npm run verify` and `runtime/verify/README.md`: the five shipped suites, their preconditions and
  what each one proves.

### Fixed

- A profile with real extensions could not start: the init payload (every extension's manifest,
  ~900 KiB for GitLens alone) travelled through the child's environment and hit `spawn E2BIG`. It
  now goes to `<profile>/logs/exthost-init.json`.
- One broken extension took the whole host down: the child reports uncaught exceptions and
  unhandled rejections and keeps serving.
- `onView:undefined` was inferred as an activation event for every declared view.
- A custom editor's file could not load its own scripts; the webview origin now serves the
  extension's own files and the file it previews.
- A file is opened by the extension's editor from the preview's *Open with* list, under the
  extension's own name, instead of a generic "VS Code webview" panel.
- The model tool's `status` answer is lossless JSON.
- An extension's storage homes exist at activation instead of being missing.

## 1.1.0 — 2026-10-26

- The VSIX store shipped in this repository, and the verification harness was repaired.

## 1.0.0 — 2026-10-25

- First publication: the vendored VS Code extension host, the trust gate, crash recovery, the
  model-facing tool and the webview surface.
