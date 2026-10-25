# The spike — how the extension host was first brought into DeepSeek Harness

This directory is the **executable history** of the project: the first cut of the
bundler, the closure exporter, the stub generator and the profile setup, with the
recorded output of the runs that proved the idea worked.

The production code lives elsewhere (`runtime/`, `packages/`, `plugin/`). The spike is
kept because it is the record of *why* the production code looks the way it does.

## What it proved

Microsoft's VS Code extension host can be vendored into DeepSeek Harness, bundled with
esbuild into **one self-contained JavaScript file**, started in a **plain Node child
process**, and a **really published VSIX extension activates successfully**. The spike
ran two real marketplace extensions (a Microsoft one and a Red Hat one) plus a local
probe extension; all three activated.

## Layout

```
spike/
├── src/
│   ├── ext-host-main.ts       the child process entry point: the extension host
│   ├── main-host.ts           the main side: reads extensions.json → init data → spawn
│   ├── stdio-socket.ts        the ISocket adapter (stdio ⇄ PersistentProtocol)
│   └── stub-returns.ts        generated: type-correct empty values for 517 MainThread methods
├── build.mjs                  the esbuild bundler (6 patches + 12 npm stubs + brand override)
├── gen-stub-returns.mjs       generates the stub defaults from extHost.protocol.ts
├── export-vendor.mjs          exports the vendor closure + the licence + the attribution
├── setup-profile.mjs          unpacks a VSIX into the DeepSeek Harness profile layout
├── run-spike.sh               runs the whole spike again
├── profile/                   a sample profile contract
│   ├── extensions.json
│   ├── extensions-trust.json
│   └── extensions/<dir>/extension/…
└── evidence/{run.log,build.log}   the recorded output of the runs
```

## Running it again

```bash
# 1. generate the stub defaults and build
node spike/gen-stub-returns.mjs
node spike/build.mjs

# 2. prepare a profile (unpack the VSIX packages)
node spike/setup-profile.mjs spike/profile \
    spike/vendor-ext/js-profile-table.vsix spike/vendor-ext/vscode-yaml.vsix

# 3. run it
./spike/run-spike.sh
```

The build writes to `dist/` at the repository root and needs the `upstream/` checkout
(see the root README for how to make one).

## What is not in the repository

| Path | Why |
|---|---|
| `spike/vendor-ext/` | the downloaded VSIX packages — third-party artefacts, too large, and they belong to their publishers |
| `spike/profile/extensions/` | those VSIX packages, unpacked |
| `upstream/` | the `microsoft/vscode` checkout; only needed to regenerate `vendor/` |

`spike/profile/extensions.json` and `spike/profile/extensions-trust.json` **are**
committed: they are the sample profile contract the spike was verified against.

## Upstream commit

`1184ad4d45794110deb6b897ea83b15aac44ed89` (2026-10-23) — one commit later than the
commit the original study used; the protocol surface had not changed.
