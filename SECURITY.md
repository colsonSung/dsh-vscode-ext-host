# Security policy

## What this repository runs

This repository ships two bundles, and together they run **third-party VS Code extension
packages (VSIX) inside DeepSeek Harness**. An installed extension is real extension code:
it runs in the extension host child process with the permissions of your user account, and
it can read and write the files it is given. Treat installing an extension the same way
you would treat installing a program.

| Bundle | What it does with third-party code |
| --- | --- |
| `dsh-vsix-store` | downloads it, verifies it, unpacks it into the profile, and keeps the publisher trust list |
| `dsh-vscode-extension-host` | loads it into the extension host and runs it |

## The trust gate

The extension host only loads an extension when **both** conditions hold:

1. the extension is **enabled** in the profile, and
2. its **publisher is trusted** in `extensions-trust.json`.

Trust is per publisher. The trust file lives in the profile directory:

```
<DSH_HOME>/profiles/<profile>/extensions-trust.json
```

The store adds two more layers in front of that gate:

1. **Source integrity** — an Open VSX package is verified against the registry's own
   Ed25519 public key over the **whole `.vsix` byte stream**. The Microsoft Marketplace
   publishes no signature that can be checked outside Microsoft, so a package from there
   rests on publisher verification alone.
2. **Explicit confirmation** — an install must carry the user's explicit consent
   (`trust: true`); without it the store refuses.

| Credential / state | Where it lives | How to rotate it |
| --- | --- | --- |
| publisher trust | `<profile>/extensions-trust.json` | remove the publisher entry (the extension stops loading on the next start) |
| the installed extension list | `<profile>/extensions.json` | remove the extension through the Extensions page, or with the `vscode_extension` tool |
| the host's own log | `<profile>/logs/` | delete it; it carries no credentials, only host events |

Nothing in this repository needs a key, a token or an account. The extension host
talks to the extension over a local socket inside your own machine.

## What the repository stores

| What | Where | Notes |
| --- | --- | --- |
| the extension host's state | `<profile>/global-storage/` | per-extension global state, written by the extension itself |
| the host's log | `<profile>/logs/` | host events and extension activation failures |
| the installed extension trees | `<profile>/extensions/<publisher>.<name>-<version>/` | the unpacked VSIX, the store's own metadata (`dsh-extension.json`) and the extension's global storage |
| the build products | `plugin/dist/`, `plugin/main-host.js` | generated locally by `npm run build`; they contain no credentials |

## What it talks to

The **host** half talks to nothing outside the machine: the extension host is a child
process on your own Node, reached over a local socket.

The **store** half talks to the two extension registries, and only to them:

| Registry | What is sent | What is fetched |
| --- | --- | --- |
| `open-vsx.org` | a search query, or a package request | the search index, the `.vsix` package, its signature and the registry's public key |
| `marketplace.visualstudio.com` | a search query, or a package request | the search index, the `.vsix` package and the extension manifests |

The package bytes themselves come from the file hosts those registries point at — Open VSX
redirects to its own CDN, the Marketplace to its own asset host — and the store verifies
what it receives before it unpacks it.

Nothing about the profile is sent. There is no account, no telemetry and no upload of
anything the machine holds: the requests carry the search terms and the package
coordinates, and the answers are written into the profile directory.

## Reporting a problem

Please report security issues privately through GitHub's
[security advisory](https://docs.github.com/en/code-security/security-advisories)
form for this repository rather than in a public issue.

## Secret scanning

The repository is scanned for credential material before every release. The
scanner looks for the patterns that this project has actually used (API keys,
private keys, personal paths). One match is expected and is **not** a leak: the
vendored upstream VS Code source contains its own secret-redaction pattern
table, which literally names the GitHub token prefixes it detects. See
`vendor/ATTRIBUTION.md`.
