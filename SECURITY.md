# Security policy

## What this plugin runs

This plugin runs **third-party VS Code extension packages (VSIX) inside DeepSeek
Harness**. An installed extension is real extension code: it runs in the
extension host child process with the permissions of your user account, and it
can read and write the files it is given. Treat installing an extension the same
way you would treat installing a program.

## The trust gate

The extension host only loads an extension when **both** conditions hold:

1. the extension is **enabled** in the profile, and
2. its **publisher is trusted** in `extensions-trust.json`.

Trust is per publisher. The trust file lives in the profile directory:

```
<DSH_HOME>/profiles/<profile>/extensions-trust.json
```

| Credential / state | Where it lives | How to rotate it |
| --- | --- | --- |
| publisher trust | `<profile>/extensions-trust.json` | remove the publisher entry (the extension stops loading on the next start) |
| the installed extension list | `<profile>/extensions.json` | remove the extension through the Extensions page |
| the host's own log | `<profile>/logs/` | delete it; it carries no credentials, only host events |

Nothing in this plugin needs a key, a token or an account. The extension host
talks to the extension over a local socket inside your own machine.

## What the plugin stores

| What | Where | Notes |
| --- | --- | --- |
| the extension host's state | `<profile>/global-storage/` | per-extension global state, written by the extension itself |
| the host's log | `<profile>/logs/` | host events and extension activation failures |
| the build products | `plugin/dist/`, `plugin/main-host.js` | generated locally by `npm run build`; they contain no credentials |

No credential is read from the environment, no network call is made to fetch
extensions, and nothing is uploaded.

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
