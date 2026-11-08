# dsh-vsix-store — VSIX extension store and catalogue adapter

DSH's **VSIX extension repository**: it searches Open VSX and the Microsoft Marketplace, verifies the
signature, installs VS Code extensions into a profile, and lets the model manage them through a tool.

This is the implementation of research plan S2, "installable and governable".

> **It is now one plugin row, not a bundle** (2026-11-07): the three VS Code bundles were merged into
> one bundle, `dsh-vscode-extension-host`, and this package is inserted as its `vsix-store` row.
> The plugin manager has one entry and one switch; the row id, the `/vscode-extensions` route and
> `ctx.provide('vsixStore')` are unchanged. Before the merge it was a separate `link:` dependency of
> the desktop profile; it now comes in through that bundle's `dependencies`.

> **Where it lives**: this directory is the package as published in this repository. It is not a
> bundle — it is the `vsix-store` row of the `dsh-vscode-extension-host` bundle — so `install.sh`
> installs it as a plain profile dependency and adds no row of its own.

---

## Why a second kind of install unit

`parseInstallSpec` in DSH's own `dsh-plugin-manager` accepts only four kinds — `registry` /
`tarball` / `git` / `path` — and a bundle cannot add more.
And a VSIX **should not** be converted into a Cordis bundle either: converting it would destroy
`require('vscode')`, activation events, `contributes` and the extension host lifecycle — exactly the
four things that make "running a real VS Code extension" mean anything.

So this package sits **alongside** DSH bundles and manages its own set of install units:

```
~/.dsh/profiles/<profile>/extensions/<publisher>.<name>-<version>[-<targetPlatform>]/
├── extension/            the unpacked extension/ subtree (the only real one in a VSIX)
├── dsh-extension.json    this repository's metadata (origin, signature result, sha256, target platform…)
└── global-storage/       the extension's globalState
~/.dsh/profiles/<profile>/extensions.json          installed extensions + enablement
~/.dsh/profiles/<profile>/extensions-trust.json    the publisher-level trust list
```

* **No `node_modules`** — pnpm prunes it.
* **No `__metadata`** — VS Code writes `__metadata` into an installed `package.json` and strips it on
  read; DSH puts the equivalent facts in `dsh-extension.json`, so internal
  fields never leak to extension code.
* The profile directory comes from `ctx.profileContext.dir`.

---

## HTTP contract

**`POST /vscode-extensions`** (gated by `ctx.connection.authorizeIndex(req, res)`; an unauthenticated request gets the Connection's own 401)

| action | fields | response |
|---|---|---|
| `list` | — | `{ ok: true, extensions: ExtensionRecord[] }` |
| `catalog` | `query` (required), `source` (`open-vsx` \| `marketplace` \| `both`, both by default), `limit` (50 by default), `inspect` (true by default) | `{ ok: true, results: CatalogEntry[], sources: [...] }` |
| `inspect` | `publisher`, `name`, `version`, `source`, `manifestUrl` (optional; skip the extra lookup when the search result already has it) | `{ ok: true, capability: {...} }` |
| `install` | `publisher`, `name`, `version`, `source`, `trust` (**must be true**) | `{ ok: true, record: ExtensionRecord }` |
| `installStart` | same as `install` | `{ ok: true, job: { id, state, stage } }` — returns immediately, the install runs in the background |
| `installStatus` | `jobId` | `{ ok: true, job: { id, state, stage, record?, error? } }` |
| `remove` | `id` (`publisher.name@version`) | `{ ok: true, id, removed }` |
| `enable` | `id`, `enabled` | `{ ok: true, id, enabled, host }` |
| `trust` | `publisher`, `trusted` | `{ ok: true, publisher, trusted }` |

A failure is always `{ ok: false, error: "one-line reason" }`, with HTTP 400.

### Install progress (`installStart` / `installStatus`)

Downloading, verifying and unpacking a VSIX takes tens of seconds, and a page cannot show a spinner
for all of it. `installStart` returns a job id immediately, the install runs in the background, and
`installStatus` reports how far it has got:

`stage` runs `resolve` (find the package) → `download` (download) → `verify` (verify the signature) →
`unpack` (unpack) → `done`; on failure `state` is `failed` and `error` carries the reason.

### Two registries race

The two registries host the same extension on different file hosts, and the network may treat those
two hosts completely differently: one answers the query in half a second and then sends the package at
a crawl, or cannot be reached at all. **Asking one after the other** makes the install wait for the
slow one, so both registries are asked **at the same time**, the first package that **finishes
downloading and verifies** wins, and the other download is aborted.

Open VSX signs the whole `.vsix` (Ed25519); the Marketplace does not sign, so an Open VSX package
carries one extra guarantee — "this package really comes from the publisher it claims". For that
reason the first registry gets a `REGISTRY_HEAD_START_MS` (20 second) head start: with a healthy
network it can deliver the package with its signature; with an unhealthy one, 20 seconds of silence
means the second registry is already on its way.

### ExtensionRecord

```jsonc
{
  "id": "acme.my-ext@1.0.0",
  "kind": "vsix",
  "publisher": "acme",
  "name": "my-ext",
  "version": "1.0.0",
  "displayName": "My Ext",          // resolved to a plain string (en as the fallback)
  "description": "a one-line description",
  "icon": "data:image/png;base64,…", // null when there is none
  "enabled": true,
  "trusted": true,                  // publisher-level trust
  "installed": true,
  "source": "open-vsx",             // or "marketplace"
  "contributes": ["commands", "configuration"],
  "supported": ["commands", "configuration"],   // direct mapping + degraded mapping
  "degraded": [],                   // additional field: the part from degraded mappings
  "unsupported": ["grammars"],
  "problems": [{ "code": "…", "severity": "error"|"warning", "message": "…" }],
  "directory": "/Users/…/extensions/acme.my-ext-1.0.0",
  "targetPlatform": null,           // additional field
  "executesCode": true              // additional field
}
```

> `supported` = direct mapping **+** degraded mapping; `degraded` (an additional field) marks the part
> of it that came from degraded mappings, and every degraded mapping also adds a `degraded-contribution`
> warning to `problems`.
> `unsupported` = unsupported plus unknown contribution points that are not in the table (unknown
> contribution points also carry `unknown-contribution`).

### CatalogEntry

```jsonc
{
  "id": "ms-python.python",
  "publisher": "ms-python", "name": "python", "version": "2026.4.0",
  "displayName": "Python", "description": "…",
  "icon": "https://…",          // a catalogue entry's icon is a remote URL; in ExtensionRecord it is a data URL
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
    "detail": "a one-line explanation",
    "contributes": [], "supported": [], "degraded": [], "unsupported": []
  },
  "problems": []
}
```

---

## Model tool

`vscode_extension`, with actions `search` / `install` / `remove` / `list` / `enable` / `trust`
(`search` ↔ the route's `catalog`; the rest keep their names).

The security semantics are written into the tool's own description: **installing a third-party
extension means executing arbitrary Node code**, so `install` must carry `trust: true`, standing for
the user's explicit confirmation of that extension; without it the call is refused.

---

## Trust model (three layers; missing one means arbitrary Node code)

1. **Origin integrity** — Open VSX packages are verified against the registry-level Ed25519 public key
   (over the **whole `.vsix` raw bytes**); the Microsoft Marketplace has **no** signature DSH can verify
   publicly (`@vscode/vsce-sign` is under a Microsoft proprietary licence), so it relies on publisher
   domain verification (`publisher.flags = verified`).
2. **Publisher-level trust** — `extensions-trust.json`; installing records that publisher as trusted,
   and the `trust` action can revoke it; an untrusted extension carries an `untrusted-publisher`
   **error** on its record, and the extension host will not load it.
3. **Explicit user confirmation** — the install action must carry `trust: true`.

---

## Capability table (`contributes` → DSH)

> The authority for the table is `src/capabilities.js`; the three rows below are its three exported sets, character for character.

| Tier | Contribution points |
|---|---|
| Direct mapping | `commands`, `configuration`, `languageModelTools`, `chatSkills`, `chatInstructions`, `chatPromptFiles`, `customEditors`, `webview` |
| Degraded mapping | `mcpServerDefinitionProviders`, `configurationDefaults`, `chatAgents`, `languageModelChatProviders`, `extensionDependencies`, `extensionPack`, `authentication`, `capabilities`, `keybindings` |
| Unsupported | `languages`, `grammars`, `snippets`, `languageConfiguration`, `semanticTokenColors`, `semanticTokenModifiers`, `semanticTokenScopes`, `debuggers`, `breakpoints`, `taskDefinitions`, `problemMatchers`, `problemPatterns`, `terminal`, `terminalProfiles`, `terminalQuickFixes`, `webviewViews`, `notebookEditor`, `notebooks`, `notebookRenderer`, `themes`, `iconThemes`, `productIconThemes`, `colors`, `menus`, `submenus`, `views`, `viewsContainers`, `viewsWelcome`, `walkthroughs`, `chatParticipants`, `extensionKind`, `l10n` |

The table lives in `src/capabilities.js` and is queryable (`classifyContribution(key)` / `classifyContributes(contributes)`).

---

## Implementation notes

* **Zero dependencies**: the zip reader is hand-written (`src/zip.js`, ~200 lines: central directory +
  deflate + CRC-32 + zip64), and signature verification uses Node's built-in `node:crypto`. The package
  pulls in no npm dependency, and it does not need to drag `@deepseek-ai/dsh-tools` into the profile's
  `node_modules` (`src/define-tool.js` is an equivalent local implementation).
* **`ctx.fs` first**: state files are written with `ctx.fs.writeText`; unpacking, binary and directory
  operations go through `node:fs` (`ctx.fs` has only `writeText`, with no binary write and no mkdir).
* **Two-phase install**: unpack to `extensions/.staging-XXXXXX/` → write `dsh-extension.json` → `rename`
  to the final directory, so a half-installed state cannot exist (VS Code's own approach).
* **Integrity before signature**: check `.signature.manifest`'s `package.size` and
  `package.digests.sha256` first, then verify the signature — otherwise a truncated download produces a
  deeply misleading "invalid signature".
* **Network retries**: Open VSX files go through `openvsx.eclipsecontent.org`, a CDN that answers 302
  and intermittently times out from some network connections; requests carry 6 backoff retries.
* **Retry what should be retried, and nothing else**: retrying only means anything for **network
  jitter**.
  * A **definite answer** (404 / 403 / 410) is not jitter — the registry saying "there is no such
    version" is a fact, and asking five more times only turns that fact into a twelve-second wait.
  * An **unreachable host** (connect timeout / ECONNREFUSED / ENOTFOUND) will not answer five more
    times either, and each attempt costs ten seconds — that is **a minute of silence**.
  * Measured: on this machine, a `lookupOpenVsx` call for a version that only the Marketplace had
    took **12416 ms** before the policy change and **1229 ms** after it (same URL). The whole install
    path dropped from ~20 s to ~3.5 s as a result.
* **Interactive search has its own budget**: the download path is worth waiting for (`fetchBytes`
  6 × 120 s); search is not — one interactive search is a **6 second timeout, at most 2 attempts**, and
  a fast failure that lets the other registry take over beats leaving someone staring at "searching…"
  for ninety seconds.
* **The list arrives first, the verdicts after**: a registry answers a search in **a second**, while
  manifests sit on a CDN, and when the network cannot reach it **every result** costs another timeout
  (24 results turn a 1 second search into 4 minutes). So `catalog`'s `inspect` defaults to true (the
  model tool wants everything in one call), while the page uses `inspect: false` to get the list first
  and then calls `inspect` **one at a time** to fill in the verdicts.
* **Manifest reads fail fast**: the manifest request used for inspection is a **6 second timeout, at
  most 2 attempts** (the download path still retries to the end, because that CDN is worth waiting for;
  this one is not). When a manifest is **unreachable**, it reads the same extension's manifest from
  **the other registry** — unreachable is a fact about the network, not about the extension, so reading
  elsewhere is a legitimate second attempt (**integrity** failures never switch).

---

## Verification

The scripts in this directory check the package on its own (none of them writes to a profile;
everything lands in a temporary directory):

```bash
node scripts/search-open-vsx.mjs "hello world" 3   # unit level: a real network search
node scripts/e2e-install.mjs secureannex hello-world 0.0.1   # end to end: download → verify → unpack
node scripts/verify-signature.mjs secureannex hello-world 0.0.1  # one valid case + three counter-cases
node scripts/service-check.mjs secureannex hello-world 0.0.1    # the store's individual actions
node scripts/route-check.mjs                                 # HTTP route + model tool
```

Measured output summary (2026-10-24, this machine):

```
search-open-vsx.mjs  → totalSize 144, 3 results returned; capability computed from the manifest:
                        secureannex.hello-world  → supported   (commands)
                        ti-development-tools.…    → unsupported (no contribution points)
e2e-install.mjs      → 3,009 B; Ed25519 signature VALID; all 6 entry digests match;
                        unpacked tree extension/{package.json, extension.js, LICENSE.txt, readme.md};
                        contributes=[commands] → supported; executesCode=true
verify-signature.mjs → 1) VALID  2) truncated → "the download is incomplete…"  3) tampered → sha256 mismatch
                        4) tampered signature → "the Ed25519 signature does not match the package"
service-check.mjs    → install refused without trust; after install extensions.json / extensions-trust.json have the right shape;
                        disabling flips enabled; after trust is revoked the record shows untrusted-publisher(error)
route-check.mjs      → all 7 actions answer per the contract; the tool's parameters/output schema
                        is accepted by the harness's own assertSupportedJsonSchema
```
