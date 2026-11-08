# `dsh-vscode-protocol`

**A pure library**: no DSH context, no I/O of its own, zero third-party runtime dependencies, pure ESM.

It answers one question: **how does DSH talk to a real VS Code extension host?**

The answer is not JSON-RPC 2.0 but **VS Code's own binary protocol**:

| Layer | Upstream file (vendored, kept verbatim) | Notes |
|---|---|---|
| Framing | `base/parts/ipc/common/ipc.net.ts` → `PersistentProtocol` | 13-byte header `type\|id\|ack\|length`; **message ids must be strictly consecutive** — a gap asks for a replay rather than resynchronising |
| RPC | `workbench/services/extensions/common/rpcProtocol.ts` → `RPCProtocol` | request / response / cancel, running on top of `IMessagePassingProtocol` |
| Channel table | `workbench/api/common/extHost.protocol.ts` → `MainContext` / `ExtHostContext` | channel names and `$` method names are **kept as-is**; change one character and you get "Unknown method" |

## Exports

| Export | From | Purpose |
|---|---|---|
| `PersistentProtocol` / `BufferedEmitter` / `RPCProtocol` / `ProxyIdentifier` | vendor | the transport layer and the RPC framework |
| `MainContext` / `ExtHostContext` | vendor | the channel constant tables (as-is) |
| `DSH_MAIN_THREAD_CAPABILITY` / `mainThreadCapability()` | DSH | the capability decision for each main-thread service in DSH |
| `StdioSocket` | DSH | adapts Node's stdin/stdout to the upstream `ISocket` |
| `ReadySignalReader` / `writeReadySignalOrStderr()` | DSH | the extension host ready handshake (fd 3, falling back to stderr) |
| `buildInitData()` / `toExtId()` / `deriveImplicitActivationEvents()` | DSH | builds the extension host init payload |
| `PRODUCT_BRAND` | DSH | the brand substitution table (must not use "VS Code" as the product name, must not use `vscode://`) |

## Why the ready handshake exists

The extension host registers its RPC actors in
`AbstractExtHostExtensionService._beforeAlmostReadyToRunExtensions()`. A request that arrives before
that gets `Unknown actor ExtHostWorkspace`, and the init RPC is dropped outright.

The spike worked around it with retries; the production version uses **an explicit signal independent
of protocol frames**: once its actors are registered, the child process writes a line
`DSH_EXTHOST_READY\n` to **fd 3** (falling back to stderr when fd 3 is unavailable), and the main
side waits for it before sending the first init RPC.

## On the vendored sources

This package builds inside the repository, and at compile time inlines
`vendor/src/vs/**` into `dist/index.js`. The upstream sources are **read-only
and unmodified**, and their copyright headers are kept verbatim (the build script rewrites each
module's header comment into esbuild's legal comment form, kept in the artefact with
`legalComments: 'inline'`).

## Build

```bash
node packages/dsh-vscode-protocol/build.mjs   # from the repository root
```
