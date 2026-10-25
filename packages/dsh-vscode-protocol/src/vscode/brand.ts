/*---------------------------------------------------------------------------------------------
 *  DSH `dsh-vscode-protocol` — the product brand.
 *
 *  DSH-authored (MIT).
 *
 *  WHY A BRAND BLOCK AT ALL
 *  ------------------------
 *  The vendored extension host reads `_VSCODE_PRODUCT_JSON` at module-evaluation time
 *  (`src/vs/platform/product/common/product.ts`). Every brand field in it therefore becomes
 *  user-visible: `vscode.env.appName`, `vscode.env.uriScheme`, the data folder name, the URL
 *  protocol and the Windows AppUserModelID.
 *
 *  Microsoft owns the "VS Code" trademark. DSH must not present itself as VS Code, and it must
 *  not claim the `vscode://` URL scheme. The substitution table is fixed here and mirrored in
 *  `vendor/ATTRIBUTION.md`:
 *
 *  | upstream field            | DSH value                |
 *  |---------------------------|--------------------------|
 *  | nameShort / nameLong      | DeepSeek Harness         |
 *  | applicationName           | deepseek-harness         |
 *  | dataFolderName            | .dsh                     |
 *  | urlProtocol               | dsh                      |
 *  | win32AppUserModelId       | DeepSeek.Harness         |
 *
 *  The JSON file next to this module is the single source of truth: the build script injects it
 *  into the extension-host bundle, and the main side reads it through this module.
 *--------------------------------------------------------------------------------------------*/

import brand from '../../brand.json';

/** The brand fields DSH overrides. */
export interface ProductBrand {
	readonly nameShort: string;
	readonly nameLong: string;
	readonly applicationName: string;
	readonly dataFolderName: string;
	readonly urlProtocol: string;
	readonly win32AppUserModelId: string;
	readonly win32AppName: string;
	readonly quality: string;
	readonly commit: string;
	readonly version: string;
	readonly licenseName: string;
	readonly licenseUrl: string;
	readonly extensionsGallery: Record<string, string>;
}

/** The DSH product brand. */
export const PRODUCT_BRAND: ProductBrand = brand as ProductBrand;

/** The version string the extension host reports through `vscode.version`. */
export const EXTENSION_HOST_VERSION = PRODUCT_BRAND.version;
