# dsh-extension-console

An **Extensions** view for VS Code extensions, on the Plugins page of the Harness Web UI.
DSH bundles and built-in plugin rows stay in the Plugins page's own Installed / Updates /
Discover tabs; they are not appended to either view here.

> **It is now one component of the VS Code suite** (2026-11-07): it is no longer a bundle but
> the `extension-console` row of the `dsh-vscode-extension-host` bundle, so the plugin manager no
> longer lists a separate entry and the one switch on the Plugins page governs the whole VS Code
> capability. It is still a separate package: the browser half's client module id is the package
> name, and a package can declare only one client module, so that half stays in its own package.
> The host half (the `/extensions-console` route, the unit registry) mounts with the row as well;
> the route and the row id are unchanged.

The Plugins page answers a package-shaped question: *which bundles are
installed, and which of their rows are on?* This bundle answers the
person-shaped question: *which extensions do I have, is each one healthy, what
does it need, and can I turn the whole thing off?*

## What it shows

- **Installed VS Code extensions.** One card per VSIX record: its icon, title, version,
  origin, effective state, and any problem it carries. A search box filters the list by title
  and extension name.
- **VS Code registries.** Browse VSCode searches Open VSX and the Microsoft Marketplace; it
  never searches or displays DSH plugin indexes.
- **Extension-level switching and details.** A card opens the extension's detail view and
  controls its VSIX enablement; the extension host's live activation state is shown alongside.

## Browsing the VSCode registries

The **Browse VSCode** tab searches the two registries the VSIX store knows.
Five things about it are deliberate:

- **Both registries are searched, and the page says so.** The registry
  selector offers *Open VSX*, *Microsoft Marketplace* and *Open VSX +
  Marketplace*, and the last one is the default. A page that opens on a
  registry nobody picked is a page that searches somewhere surprising, so the
  choice is **not remembered between visits** — every visit starts on the same,
  visible default. The results line names the registry each answer came from
  and how many results it contributed, and every card carries its registry as a
  tag.
- **The registries are asked at the same time, and each answer is shown as it
  arrives.** A registry that needs three seconds must not hold back the one
  that needed one, so the list grows while the slower registry is still
  answering. The list that is already on screen also **stays** on screen while
  the next one is on the way — it is never blanked out and refilled.
- **The search runs while the person types.** There is a button and an Enter
  key for the impatient, but waiting for a keystroke that does not have to
  happen is waiting.
- **The list comes before the verdicts.** A registry answers its search in about
  a second; a manifest on an unreachable CDN costs a timeout *per result*. So
  the page asks for the list without the inspection, shows it, and then fills
  in "what this does in DSH" one extension at a time — the card says
  *Checking what it does in DSH…* while it waits.
- **An install says that it is happening, and what it is doing.** Pressing
  *Install* turns the card into the question it really is — *this puts
  third-party code from this publisher on your machine* — and only the answer
  starts the install. The card then names the stage the install is in (*finding
  the package*, *downloading the package*, *checking the signature*,
  *unpacking the extension*), and a failure is written out on the card
  instead of swallowed.

The button is never silently disabled: a control that does nothing when it is
pressed looks broken, and the trust question belongs to the extension being
installed, not to a checkbox above the list.

## Removing an extension

A VSCode extension can be **uninstalled** from its detail view: the button
turns into a confirmation (uninstalling deletes the extension's files), and the
store removes the directory and the record. The extension host watches the
profile's extension list, so the extension is unloaded from the running host in
the same step — no restart.

## Where the facts come from

- **Installed extensions:** the VSIX store's `/vscode-extensions` list.
- **Activation state:** the extension host's `/vscode-extension-host` status.
- **Catalog results:** the same VSIX store's Open VSX / Marketplace search.

The DSH bundle graph is deliberately not read for this tab. The legacy `/extensions-console`
route remains mounted for compatibility, but the Extensions tab does not use it to append DSH
units or dependency notices.

## The route

The browser half reads one exact route, `/extensions-console`:

| Method | Body | Answer |
| --- | --- | --- |
| `GET` | — | the snapshot: units, edges, cycles, and the module-level edges they came from |
| `POST` | `{"action":"enable","id":"…","enabled":true}` | the manager's change result |
| `POST` | `{"action":"retry","id":"…"}` | the manager's change result after a restart |

The route carries the profile's plugin facts, so it answers only to a browser
the Connection has already admitted; an unauthenticated request gets the
Connection's own 401. The browser refreshes the view when the Host announces
`plugin-manager/changed`.

**Why a route and not a Remote namespace.** A plugin cannot add a typed
Remote namespace of its own: the Remote contribution contract is generated by
the DSH build, and a third-party bundle has no way to produce one. The Host's
`ctx.connection.authorizeIndex` is the same gate the SPA index uses, so the
route is admitted exactly like the page that reads it.

## Retry

A row that failed to load stays failed while its options are unchanged, so a
retry is a disable followed by an enable — both recorded in the profile patch,
and the enable brings the row back. When the failed rows are known, only those
are restarted; when the failure is the bundle's own patch, the bundle is
restarted instead.

## Build

The browser half is written as JSX and compiled into `client.js`:

```sh
ln -s ../plugin-share/node_modules node_modules   # esbuild, reused from a sibling bundle
node build.mjs
rm node_modules
```

The compiled bundle registers a lazy factory through
`window.__ModuleLoader__.load`, so nothing runs until the Plugins page asks
for the tab.

## Boundaries

- **It touches VSIX extensions, and nothing else.** The bundle installs and
  removes VSCode extensions through the VSIX store's route, and changes the
  enablement of its own profile's extensions; it never edits a package, and it
  never touches a plugin row's own settings.
- **No editor concepts.** It does not model documents, editors, or terminals,
  so it has nothing to say about an extension that only exists to decorate
  one.
- **One view, many backends.** The unit registry reads the profile's bundles
  today. A VSIX-backed extension backend would add units of its own to the
  same registry, and this view would need no change.
