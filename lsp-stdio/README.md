# dsh-lsp-stdio — making `ctx.lsp` real

> **It is now one plugin row, not a bundle** (2026-11-07): the three VS Code bundles were merged
> into one bundle, `dsh-vscode-extension-host`, and this package is inserted as its `lsp-stdio`
> row. The row id and `ctx.provide('lsp')` / `ctx.provide('lspStdio')` are unchanged; this row's
> former `cordis.patch.yml` configuration (`positionBase`, timeouts, `extensionServers`, `servers`)
> moved into that bundle's patch.

This package does two things:

1. **Provides the `ctx.lsp` capability seam** (if nobody else provides it yet);
2. **Points `ctx.lsp` at a real language server** (stdio).

## Why it is needed

The API catalogue DSH generates (`@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js`, produced
by `scripts/gen-cordis-api.ts`) **describes** a service called `lsp`, with a complete contract:
`registerProvider(provider)` / `query(request, signal?)`, plus a full set of `Lsp*` types.

But **a catalogue is not an implementation**. Nothing in this build registers `lsp`:

```bash
grep -rn "super(ctx, 'lsp')" --include="*.js" dsh/node_modules/@deepseek-ai/     # no match
ls -d dsh/node_modules/@deepseek-ai/*lsp*                                        # none
```

`@deepseek-ai/dsh-lsp` appears in the composition reference's package table, but that is a package
**in the monorepo**, and it **does not ship with the distribution**. So before this package existed,
nothing could answer `ctx.lsp.query(...)`.

This package therefore implements the seam itself, **clause by clause against the catalogue's
contract**; if `@deepseek-ai/dsh-lsp` is ever actually released, this package will **switch to it**
(the provider contract is identical on both sides).

## Contract (from the API catalogue, clause by clause)

| Method | Catalogue description | Where this implementation lands |
|---|---|---|
| `registerProvider(provider)` | *"atomically reserving its id and every normalized extension. Any conflict or invalid input publishes nothing and throws `LspError`; the returned disposer releases all reservations."* | `lib/lsp-service.js` → `LspSeam.registerProvider`: validates the whole input first, works out every reservation, then publishes in one step; any conflict is thrown before publication |
| `query(request, signal?)` | *"Select a provider by the file's extension and run one query. Selection is per-query and order-independent; no match throws `LspError` `LSP_UNAVAILABLE`."* | `lib/lsp-service.js` → `LspSeam.query`: a flat extension → provider index, independent of registration order; no match throws `LSP_UNAVAILABLE` |

**The definition of "normalized extension"** (the catalogue does not define it; this package does):
lower case, leading dot stripped, so `.ts` / `.TS` / `ts` are the same reservation key. The provider's
`extensionToLanguage` keys and the file paths in requests both go through the same normalisation
function, so the two sides always line up.

## Coordinates

LSP is **0-based**, in **UTF-16 code units**. The DSH side's convention is **1-based**.
The conversion lives in **one** function: `toDshPosition()` (`lib/stdio-provider.js`).
The `positionBase` config option switches the whole thing to 0-based, to line up with a future
official `dsh-tool-lsp`.

## Error classes (`LspError`)

`lib/lsp-error.js`. **A missing server never returns an empty result**; every failure has its own code:

| Code | Meaning |
|---|---|
| `LSP_UNAVAILABLE` | no provider serves this file extension (the catalogue contract requires this code) |
| `LSP_INVALID_REQUEST` | the request itself is invalid (bad position, unreadable file) |
| `LSP_CONFLICT` | the provider id or extension is already taken |
| `LSP_NOT_CONFIGURED` | no server is configured for this language |
| `LSP_SERVER_NOT_INSTALLED` | the configured command cannot be found (ENOENT) |
| `LSP_SERVER_START_FAILED` | the process started but the handshake did not complete |
| `LSP_SERVER_EXITED` | the server exited mid-request (**the message carries the server's own stderr**) |
| `LSP_SERVER_ERROR` | the server returned a JSON-RPC error |
| `LSP_TIMEOUT` | the deadline passed |
| `LSP_PROTOCOL_ERROR` | framing or JSON-RPC violation |
| `LSP_UNSUPPORTED_OPERATION` | the server does not implement this method (JSON-RPC `-32601`) |
| `LSP_CANCELLED` | the caller cancelled |

## Configuration

```yaml
- id: lsp-stdio
  name: 'dsh-lsp-stdio'
  config:
    positionBase: 1          # 1 = DSH's 1-based convention, 0 = LSP native
    requestTimeoutMs: 15000
    initializeTimeoutMs: 20000
    extensionServers:
      enabled: true
      requireTrusted: true
    servers: []
```

`servers` overrides the built-in defaults (**TypeScript / Python / Go / Rust**) **by id**:
rewriting an existing id overrides it, a new id appends, and to turn a default off, rewrite it with
`enabled: false`.

```yaml
    servers:
      - id: typescript
        command: /opt/homebrew/bin/typescript-language-server
        args: ['--stdio']
        extensions: ['.ts', '.tsx']
        languageIds: ['typescript', 'typescriptreact']
```

**The default commands are bare executable names**, not `npx -y …`. The reason: the provider
**never** downloads or installs anything at query time (`npx -y` would quietly pull code down and
run it while the user asks a question), and a missing server fails **immediately** with
`LSP_SERVER_NOT_INSTALLED`, with a message that states what to install.

## Route (c): does installing a VS Code language extension make it work?

**The conclusion first: nothing in a VS Code extension's manifest declares a language server.**
`contributes.languages` has only `id` / `aliases` / `extensions` / `configuration` / `icon` /
`colorizedBracketPairs` — nothing that points at a server. Real language extensions
(`ms-python.python` and the like) **pack the server inside the extension directory** and spawn it
from their own `main` code; that server is a child process of the extension host, and **another LSP
client cannot reach it**.

So this package defines a **small explicit convention**, read in a fixed order:

1. `<extension dir>/dsh-lsp.json` — a sibling file in the extension directory (the most explicit form):
   ```json
   { "command": "node", "args": ["server.js"], "extensions": [".ts"], "languageIds": ["typescript"] }
   ```
2. `<extension dir>/extension/package.json` → `dsh.lspServer` — the same object, under the
   `dsh` key of the extension manifest.

When the convention does not state `extensions` / `languageIds`, they are derived from the
extension's own `contributes.languages`: each language id contributes its `extensions`, and the
language id is the language name. **This is where "install a language extension and it works"
actually becomes true.**

**Precedence**: servers declared by an extension register first, so the extensions they claim win;
servers from configuration only get the remaining extensions. An extension claimed by neither side →
`LSP_UNAVAILABLE`.

**Trust**: only an extension that is `installed && enabled` and comes from a **trusted** publisher
may contribute a server. Trust is decided by the record's `trusted` field first; failing that, by the
`publishers` table in `extensions-trust.json`; if neither has it, the publisher is **not trusted**.

## Self-check

```bash
node scripts/verify.mjs            # 34 checks: protocol, error classes, conflicts, config, trust, precedence
node scripts/verify-real-server.mjs # 2 checks: a real pyright-langserver
```

`verify.mjs` uses the package's own `fake-lsp-server.mjs` (a process that really speaks the LSP
protocol) and needs nothing installed. `verify-real-server.mjs` looks for a real language server
(`pyright-langserver`) and, when it cannot find one, **reports honestly that it did not run** rather
than passing off a simulated result as real.

Both scripts write their evidence to `runtime/verify/evidence/`.

> Running `verify.mjs` locally needs `@deepseek-ai/schemastery` to resolve: the script symlinks
> the copy in the DSH distribution into the package's `node_modules` (it downloads nothing;
> `node_modules` is not in `files`, and pnpm prunes it when the bundle is installed).

## Dependencies and deviations

* It depends only on `@deepseek-ai/schemastery` (the Config schema). **It does not depend on any
  `@deepseek-ai/dsh-*`**, so the bundle does not get version-pinned as DSH upgrades.
* Child processes are spawned with `node:child_process`, not `ctx.subprocess`. The reason:
  `ctx.subprocess`'s pipe mode does not ship a `.d.ts` in this build, its public handle shape exists
  only as one prose sentence in the README (*"`pipe` hands you the raw stream"*), and staking the
  core of an LSP client on a handle shape with no type declaration is a bad trade. The DSH README
  explicitly offers the "own your spawn transport" path (*"route around the service and import
  `scrubbedParentEnv` directly so environment policy stays single-sourced"*).
* Environment scrubbing is a **local implementation** (`scrubbedEnvironment()`: strips `DSH_*`
  and credential-shaped names), not DSH's `scrubbedParentEnv`. This is a deliberate deviation: the
  package depends on no DSH package. Switching to the official implementation is one import line.
