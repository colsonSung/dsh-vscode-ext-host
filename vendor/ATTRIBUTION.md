# Third-party attribution — vendored Microsoft VS Code extension host

This directory contains **verbatim sources from the Microsoft VS Code repository**, vendored so
that DSH can run real VS Code extensions inside its own extension host process.

## Microsoft VS Code

* Upstream repository: <https://github.com/microsoft/vscode>
* Vendored commit: `1184ad4d45794110deb6b897ea83b15aac44ed89 2026-10-23 17:19:34 -0700`
* Vendored subset: `src/vs/**` — the transitive import closure of
  * `src/vs/workbench/api/common/extensionHostMain.ts` (the extension host bootstrap),
  * `src/vs/workbench/api/node/extHost.node.services.ts` (the Node service registrations),
  * `src/vs/workbench/api/common/extHost.api.impl.ts` (the `vscode` API factory),
  * `src/vs/workbench/services/extensions/common/rpcProtocol.ts` (the RPC framework),
  * `src/vs/base/parts/ipc/common/ipc.net.ts` (`PersistentProtocol` — the wire transport).
* Licence: MIT. The verbatim licence text is in [`LICENSE.vscode.txt`](./LICENSE.vscode.txt).

Every vendored file keeps its original copyright header:

```
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
```

### MIT obligations that DSH must honour

1. **Keep the copyright notice and the full MIT licence text** in every copy or substantial
   portion of the Software. `vendor/LICENSE.vscode.txt` + the per-file headers satisfy this.
2. Do **not** strip or rewrite the upstream headers.

### Trademark obligations (separate from the licence)

* "Visual Studio Code" / "VS Code" and the VS Code logo are **Microsoft trademarks**.
  DSH must not use them as its own product name or imply official affiliation.
  DSH describes this capability as *"compatible with the VS Code extension format"* /
  *"runs the open-source VS Code extension host"*.
* The upstream `product.json` brand fields are **replaced** in the DSH build
  (see `spike/build.mjs`): `nameShort` / `nameLong` = "DeepSeek Harness",
  `applicationName` = "deepseek-harness", `dataFolderName` = ".dsh",
  `urlProtocol` = "dsh" (NOT `vscode://`), `win32AppUserModelId` = "DeepSeek.Harness".

## Third-party npm packages

The bundled extension host has **no runtime npm dependency**: every upstream npm package that
is reachable from the vendored closure is replaced by a local stub
(see `spike/build.mjs` → `NPM_STUBS`). Each stub is listed with its justification in
`vscode-extension-support/exthost-spike.md`.
