# `dsh-vsix-store`

**Search, verify, install and trust VS Code extension packages (VSIX) for DSH.**

DSH can install third-party VS Code extensions. This bundle is the half that makes them
*installable*: it searches Open VSX and the Microsoft Marketplace, verifies the package
signature, unpacks the extension into the profile and owns the publisher trust list. The
other half — the [extension host](../plugin/) — is what makes them *run*.

The two halves meet on the filesystem: this bundle writes `<profile>/extensions.json` and
`<profile>/extensions-trust.json`, and the host loads an extension only when it is
**enabled** *and* its **publisher is trusted** — "installed" is deliberately not "loaded".

## Why a second install unit

DSH's own plugin manager understands four install kinds — `registry`, `tarball`, `git` and
`path` — and a bundle cannot add a fifth. A VSIX also must not be converted into a Cordis
bundle: that would destroy `require('vscode')`, the activation events, the `contributes`
block and the extension-host lifecycle — the four things that make a real VS Code extension
worth running.

So this bundle sits **beside** the DSH bundles and manages its own install unit:

```
~/.dsh/profiles/<profile>/extensions/<publisher>.<name>-<version>[-<targetPlatform>]/
├── extension/            the unpacked extension/ subtree (the only real tree in a VSIX)
├── dsh-extension.json    this store's own metadata (source, signature verdict, sha256, target platform…)
└── global-storage/       the extension's globalState
~/.dsh/profiles/<profile>/extensions.json          the installed extensions + their enabled flag
~/.dsh/profiles/<profile>/extensions-trust.json    the publisher-level trust list
```

* **No `node_modules`** — pnpm prunes it, and a VSIX ships its dependencies bundled anyway.
* **No `__metadata`** — VS Code writes `__metadata` into an installed `package.json` and
  deletes it again on read; DSH keeps the equivalent facts in `dsh-extension.json`.
* The profile directory comes from `ctx.profileContext.dir`.

## The HTTP contract

**`POST /vscode-extensions`** — gated by `ctx.connection.authorizeIndex(req, res)`; an
unauthenticated request is answered with a 401 by the Connection itself.

| action | fields | answer |
|---|---|---|
| `list` | — | `{ ok: true, extensions: ExtensionRecord[] }` |
| `catalog` | `query` (required), `source` (`open-vsx` \| `marketplace` \| `both`, both by default), `limit` (50 by default), `inspect` (true by default) | `{ ok: true, results: CatalogEntry[], sources: [...] }` |
| `inspect` | `publisher`, `name`, `version`, `source`, `manifestUrl` (optional — pass the one the search already returned and it is not fetched again) | `{ ok: true, capability: {...} }` |
| `install` | `publisher`, `name`, `version`, `source`, `trust` (**must be true**) | `{ ok: true, record: ExtensionRecord }` |
| `installStart` | same as `install` | `{ ok: true, job: { id, state, stage } }` — returns at once, the install runs in the background |
| `installStatus` | `jobId` | `{ ok: true, job: { id, state, stage, record?, error? } }` |
| `remove` | `id` (`publisher.name@version`) | `{ ok: true, id, removed }` |
| `enable` | `id`, `enabled` | `{ ok: true, id, enabled, host }` |
| `trust` | `publisher`, `trusted` | `{ ok: true, publisher, trusted }` |

A failure is always `{ ok: false, error: "one sentence" }` with HTTP 400.

### Installation progress (`installStart` / `installStatus`)

Downloading, verifying and unpacking a VSIX takes tens of seconds, so `installStart`
returns a job id at once and `installStatus` reports how far the background install got.

`stage` runs `resolve` (find the package) → `download` → `verify` (the signature) →
`unpack` → `done`. On failure `state` is `failed` and `error` carries the reason.

### Two registries race

The two registries host the same extension on different file hosts, and a network may
treat them very differently: one answers a query in half a second and then serves the
package at a crawl, or it is unreachable. So both are asked **at the same time** and the
first package that is **downloaded and verified** wins; the other download is aborted.

Open VSX signs the whole `.vsix` (Ed25519); the Marketplace has no signature. An Open VSX
package therefore carries one more guarantee — that it really comes from the publisher it
claims. The first registry gets a head start of `REGISTRY_HEAD_START_MS` (20 seconds): on a
healthy network it returns the package with its signature, and when the network is not
healthy the second registry is already on its way after 20 silent seconds.

## ExtensionRecord

```jsonc
{
  "id": "acme.my-ext@1.0.0",
  "kind": "vsix",
  "publisher": "acme",
  "name": "my-ext",
  "version": "1.0.0",
  "displayName": "My Ext",          // resolved to a plain string (en fallback)
  "description": "one line",
  "icon": "data:image/png;base64,…", // null when there is none
  "enabled": true,
  "trusted": true,                  // publisher-level trust
  "installed": true,
  "source": "open-vsx",             // or "marketplace"
  "contributes": ["commands", "configuration"],
  "supported": ["commands", "configuration"],   // direct mapping + degraded mapping
  "degraded": [],                   // extra field: the part that is degraded
  "unsupported": ["grammars"],
  "problems": [{ "code": "…", "severity": "error"|"warning", "message": "…" }],
  "directory": "/Users/…/extensions/acme.my-ext-1.0.0",
  "targetPlatform": null,           // extra field
  "executesCode": true              // extra field
}
```

> `supported` = direct mapping **+** degraded mapping; `degraded` (an extra field) marks
> the degraded part, and every degraded entry carries a `degraded-contribution` warning in
> `problems`. `unsupported` = not supported + the contribution points that are not in the
> table at all (an unknown one additionally carries `unknown-contribution`).

## CatalogEntry

```jsonc
{
  "id": "ms-python.python",
  "publisher": "ms-python", "name": "python", "version": "2026.4.0",
  "displayName": "Python", "description": "…",
  "icon": "https://…",          // a catalog icon is a remote URL; an ExtensionRecord's is a data URL
  "downloadUrl": "https://…",
  "manifestUrl": "https://…",
  "source": "open-vsx",
  "installed": false,
  "publisherVerified": true,
  "deprecated": false,
  "targetPlatform": null,
  "capability": {
    "status": "supported" | "partial" | "unsupported" | "unknown",
    "basis": "manifest" | "no-manifest" | "manifest-unreachable" | "not-inspected",
    "detail": "one sentence",
    "contributes": [], "supported": [], "degraded": [], "unsupported": []
  },
  "problems": []
}
```

## The model tool

`vscode_extension` — the actions `search` / `install` / `remove` / `list` / `enable` /
`trust` (`search` is the route's `catalog`; the rest carry the same name).

The security semantics live in the tool's own description: **installing a third-party
extension means running arbitrary Node code**, so `install` must carry `trust: true` — the
user's explicit approval of that extension. Without it the store refuses.

## The trust model (three layers; missing one means arbitrary Node code is allowed)

1. **Source integrity** — an Open VSX package is verified with the registry's Ed25519
   public key, over the **raw bytes of the whole `.vsix`**. The Microsoft Marketplace has
   **no** signature DSH can verify publicly (`@vscode/vsce-sign` is under Microsoft's
   proprietary licence), so there only the publisher domain check
   (`publisher.flags = verified`) is left.
2. **Publisher-level trust** — `extensions-trust.json`. Installing records the publisher as
   trusted; the `trust` action takes it back. An extension whose publisher is not trusted
   carries an `untrusted-publisher` **error** on its record, and the extension host will not
   load it.
3. **Explicit user confirmation** — the install action must carry `trust: true`.

## The capability table (`contributes` → DSH)

| tier | contribution points |
|---|---|
| Direct mapping | `commands`, `configuration`, `languageModelTools`, `chatSkills`, `chatInstructions`, `chatPromptFiles`, `customEditors`, `webview` |
| Degraded mapping | `mcpServerDefinitionProviders`, `configurationDefaults`, `chatAgents`, `languageModelChatProviders`, `extensionDependencies`, `extensionPack`, `authentication`, `capabilities`, `keybindings` |
| Not supported | `languages`, `grammars`, `snippets`, `languageConfiguration`, `semanticTokenColors`, `semanticTokenModifiers`, `semanticTokenScopes`, `debuggers`, `breakpoints`, `taskDefinitions`, `problemMatchers`, `problemPatterns`, `terminal`, `terminalProfiles`, `terminalQuickFixes`, `webviewViews`, `notebookEditor`, `notebooks`, `notebookRenderer`, `themes`, `iconThemes`, `productIconThemes`, `colors`, `menus`, `submenus`, `views`, `viewsContainers`, `viewsWelcome`, `walkthroughs`, `chatParticipants`, `extensionKind`, `l10n` |

The table lives in `src/capabilities.js` and is queryable
(`classifyContribution(key)` / `classifyContributes(contributes)`). The three rows above are
the exported sets of that file, verbatim — the code is the authority, not this table.

## Implementation notes

* **Zero dependencies** — the zip reader is written from scratch (`src/zip.js`, ~200 lines:
  central directory + deflate + CRC-32 + zip64), and the signature check uses Node's own
  `node:crypto`. This bundle pulls in no npm dependency at all, and it does not have to drag
  `@deepseek-ai/dsh-tools` into the profile's `node_modules` (`src/define-tool.js` is the
  equivalent local implementation).
* **`ctx.fs` first** — the state files are written with `ctx.fs.writeText`; unpacking,
  binary writes and directory operations go through `node:fs` (`ctx.fs` only has
  `writeText` — there is no binary write and no mkdir).
* **Two-phase install** — unpack into `extensions/.staging-XXXXXX/` → write
  `dsh-extension.json` → `rename` into the final directory, so a half-installed extension
  never exists (VS Code's own rule).
* **Integrity before signature** — the `package.size` and `package.digests.sha256` of the
  `.signature.manifest` are checked **before** the signature is verified; otherwise a
  truncated download produces a deeply misleading "invalid signature".
* **Network retries** — Open VSX serves its files from `openvsx.eclipsecontent.org`, a CDN
  that answers with a 302 and times out intermittently from some networks; requests carry six
  retries with a backoff.
* **Retry what should be retried, do not retry what should not** — a retry only means
  something for **network jitter**.
  * A **definitive answer** (404 / 403 / 410) is not jitter — a registry that says "this
    version does not exist" is stating a fact, and asking five more times only turns that
    fact into twelve seconds of waiting.
  * A **host that cannot be reached** (connect timeout / ECONNREFUSED / ENOTFOUND) will not
    answer on the sixth try either, and every try costs ten seconds — that is a **minute of
    silence**.
  * Measured on this machine: `lookupOpenVsx` asked for a version that only the Marketplace
    has took **12416 ms** before the policy change and **1229 ms** after it (the same URL).
    The whole install chain therefore dropped from ~20 s to ~3.5 s.
* **An interactive search has its own budget** — the download path is worth waiting for
  (`fetchBytes`, 6 attempts × 120 s); a search is not — one interactive search is **6 s per
  attempt, at most 2**, and it fails fast so that the other registry can take over, rather
  than leaving a person staring at "searching…" for a minute and a half.
* **The list arrives first, the verdict later** — a registry answers a search in **one
  second**, while the manifest sits on a CDN; when the network cannot reach it, **every
  result** pays a timeout (24 results turn a one-second search into four minutes). So
  `catalog`'s `inspect` defaults to true (the model tool wants everything at once), while a
  page asks for `inspect: false` first and then calls `inspect` **per result** to add the
  verdict.
* **A manifest read fails fast** — the manifest request used for the inspection times out
  after **6 s**, at most **2 attempts** (the download path still retries to the end, because
  that CDN is worth waiting for; here it is not). When the manifest **cannot be reached**,
  the same
  extension's manifest is read from the **other registry** — not being able to reach it is
  a fact about the network, not about the extension, so a second attempt elsewhere is
  legitimate (an **integrity** failure never switches registry).

## Verification

Run the scripts in this directory (none of them writes to a profile — everything lands in a
temp directory):

```bash
node scripts/search-open-vsx.mjs "hello world" 3   # unit level: a real network search
node scripts/e2e-install.mjs secureannex hello-world 0.0.1   # end to end: download → verify → unpack
node scripts/verify-signature.mjs secureannex hello-world 0.0.1  # one positive signature case + three negative ones
node scripts/service-check.mjs secureannex hello-world 0.0.1    # the store's own actions
node scripts/route-check.mjs                                 # the HTTP route + the model tool
```

Measured output summary (2026-10-24, on this machine):

```
search-open-vsx.mjs  → totalSize 144, 3 results; the capability is computed from the manifest:
                        secureannex.hello-world  → supported   (commands)
                        ti-development-tools.…    → unsupported (no contribution points)
e2e-install.mjs      → 3,009 B; the Ed25519 signature is VALID; all 6 entry digests match;
                        unpacked tree extension/{package.json, extension.js, LICENSE.txt, readme.md};
                        contributes=[commands] → supported; executesCode=true
verify-signature.mjs → 1) VALID  2) truncated → "the download is incomplete…"  3) tampered → sha256 mismatch
                        4) tampered signature → "the Ed25519 signature does not match the package"
service-check.mjs    → an install without trust is refused; after installing, extensions.json / extensions-trust.json have the right shape;
                        disabling changes enabled; revoking trust puts untrusted-publisher(error) on the record
route-check.mjs      → the 7 actions the script exercises answer as the contract says; the tool's parameters/output schema
                        are accepted by the harness's own assertSupportedJsonSchema
```

## Running this bundle on its own

The store is the host-only half of the pair and needs **no build** — it is plain ESM
JavaScript with zero npm dependencies, so there is nothing to install and nothing to compile.

```bash
dsh plugin --profile web add ./vsix-store
```

With only the store installed, extensions can be managed through the model tool
`vscode_extension` — search, install, remove, list, enable and trust. The **graphical**
Extensions page is provided by a separate bundle, which does not live in this repository.

One consequence is worth stating plainly: without the extension host bundle, an extension
can be **installed** but never **loaded** — nothing runs its code. The store writes the
profile state; the host is what reads it and starts the process the extension runs in.
