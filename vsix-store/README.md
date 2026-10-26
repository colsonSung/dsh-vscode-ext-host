# @local/vsix-store — VSIX 扩展存储与目录适配器

DSH 的 **VSIX 扩展仓库**：搜索 Open VSX 与 Microsoft Marketplace，验签后把 VS Code 扩展装进 profile，
并让模型通过一个工具管理它们。

这是研究计划 S2「装得上、管得住」的实现。

> **发布位置**：本目录是**本地开发副本**（包名 `@local/vsix-store`，被 desktop profile 以 `link:` 引用）。
> 已发布版本是同一个仓库里的第二个 bundle：
> [`colsonSung/dsh-vscode-ext-host`](https://github.com/colsonSung/dsh-vscode-ext-host) 的 `vsix-store/`
> （包名 `dsh-vsix-store`，自 `v1.1.0` 起随该仓库发布，`install.sh` 一次装两个 bundle）。
> 两份代码同源；改动请先改这里，再同步到发布副本。

---

## 为什么是第二种安装单元

DSH 自带的 `dsh-plugin-manager` 的 `parseInstallSpec` 只认 `registry` / `tarball` / `git` / `path`
四种 kind，bundle 无法新增（`vscode-extension-research/README.md` §6）。而 VSIX **也不应该**被转成
Cordis bundle —— 转过去会摧毁 `require('vscode')`、activation events、`contributes` 与扩展宿主生命周期
这四样东西，而它们恰好是「跑真正的 VS Code 扩展」的全部意义
（`vscode-extension-research/vsix-runtime-and-trust.md` §5.4）。

所以本 bundle 与 DSH bundle **并列**，自己管理一套安装单元：

```
~/.dsh/profiles/<profile>/extensions/<publisher>.<name>-<version>[-<targetPlatform>]/
├── extension/            解包后的 extension/ 子树（VSIX 里只有这一棵是真身）
├── dsh-extension.json    本仓库的元数据（来源、验签结果、sha256、目标平台…）
└── global-storage/       扩展的 globalState
~/.dsh/profiles/<profile>/extensions.json          已安装扩展 + 启用状态
~/.dsh/profiles/<profile>/extensions-trust.json    publisher 级信任清单
```

* **不放 `node_modules`** —— pnpm 会 prune（研究文档 §6）。
* **不写 `__metadata`** —— VS Code 把 `__metadata` 写进已安装的 `package.json` 又在读取时删掉
  （研究文档 §1.6），DSH 把等价事实放进 `dsh-extension.json`，避免把内部字段泄漏给扩展代码。
* profile 目录取自 `ctx.profileContext.dir`。

---

## HTTP 契约

**`POST /vscode-extensions`**（由 `ctx.connection.authorizeIndex(req, res)` 把门，未认证由 Connection 自己 401）

| action | 字段 | 响应 |
|---|---|---|
| `list` | — | `{ ok: true, extensions: ExtensionRecord[] }` |
| `catalog` | `query`（必填）、`source`（`open-vsx` \| `marketplace` \| `both`，缺省两个都查）、`limit`（缺省 50）、`inspect`（缺省 true） | `{ ok: true, results: CatalogEntry[], sources: [...] }` |
| `inspect` | `publisher`、`name`、`version`、`source`、`manifestUrl`（可选，搜索结果里已有就不用再查一次） | `{ ok: true, capability: {...} }` |
| `install` | `publisher`、`name`、`version`、`source`、`trust`（**必须为 true**） | `{ ok: true, record: ExtensionRecord }` |
| `installStart` | 同 `install` | `{ ok: true, job: { id, state, stage } }` —— 立刻返回，安装在后台跑 |
| `installStatus` | `jobId` | `{ ok: true, job: { id, state, stage, record?, error? } }` |
| `remove` | `id`（`publisher.name@version`） | `{ ok: true, id, removed }` |
| `enable` | `id`、`enabled` | `{ ok: true, id, enabled, host }` |
| `trust` | `publisher`、`trusted` | `{ ok: true, publisher, trusted }` |

失败一律 `{ ok: false, error: "一句话原因" }`，HTTP 400。

### 安装的进度（`installStart` / `installStatus`）

下载、验签、解包一个 VSIX 要几十秒，页面不能只显示一个转圈。`installStart`
立刻返回一个 job id，安装在后台跑，`installStatus` 报告它到了哪一步：

`stage` 依次是 `resolve`（找扩展包）→ `download`（下载）→ `verify`（验签）→
`unpack`（解包）→ `done`；失败时 `state` 是 `failed`，`error` 是原因。

### 两个注册表赛跑

两个注册表把同一个扩展放在不同的文件主机上，而网络对这两个主机的态度可能
完全不同：一个半秒就能回答查询，然后以爬行速度发包；或者干脆连不上。**一
个一个问**会让安装先等完慢的那个，所以两个注册表**同时**问，第一个「下载完
并且验签完」的包获胜，另一个下载被中止。

Open VSX 对整个 `.vsix` 签了名（Ed25519），Marketplace 没有签名，所以
Open VSX 的包多一层「这个包确实来自它声称的发布者」的保证。为此第一个注册
表有 `REGISTRY_HEAD_START_MS`（20 秒）的起跑时间：网络正常时它能带着签名
把包送回来；网络不正常时，20 秒还没动静，第二个注册表已经上路。

### ExtensionRecord

```jsonc
{
  "id": "acme.my-ext@1.0.0",
  "kind": "vsix",
  "publisher": "acme",
  "name": "my-ext",
  "version": "1.0.0",
  "displayName": "My Ext",          // 已解析成纯字符串（en 兜底）
  "description": "一句话描述",
  "icon": "data:image/png;base64,…", // 没有就 null
  "enabled": true,
  "trusted": true,                  // publisher 级信任
  "installed": true,
  "source": "open-vsx",             // 或 "marketplace"
  "contributes": ["commands", "configuration"],
  "supported": ["commands", "configuration"],   // 直接映射 + 降级映射
  "degraded": [],                   // 附加字段：降级映射的那部分
  "unsupported": ["grammars"],
  "problems": [{ "code": "…", "severity": "error"|"warning", "message": "…" }],
  "directory": "/Users/…/extensions/acme.my-ext-1.0.0",
  "targetPlatform": null,           // 附加字段
  "executesCode": true              // 附加字段
}
```

> `supported` = 直接映射 **+** 降级映射；`degraded`（附加字段）标出其中属于降级映射的那部分，
> 每条降级映射也会在 `problems` 里带一条 `degraded-contribution` 的 warning。
> `unsupported` = 不支持 + 表里没有的未知贡献点（未知贡献点会额外带 `unknown-contribution`）。

### CatalogEntry

```jsonc
{
  "id": "ms-python.python",
  "publisher": "ms-python", "name": "python", "version": "2026.4.0",
  "displayName": "Python", "description": "…",
  "icon": "https://…",          // 目录项的图标是远端 URL；ExtensionRecord 里是 data URL
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
    "detail": "一句话说明",
    "contributes": [], "supported": [], "degraded": [], "unsupported": []
  },
  "problems": []
}
```

---

## 模型工具

`vscode_extension`，动作 `search` / `install` / `remove` / `list` / `enable` / `trust`
（`search` ↔ 路由的 `catalog`，其余同名）。

安全语义写在工具自己的描述里：**安装第三方扩展等于执行任意 Node 代码**，因此 `install` 必须带
`trust: true`，代表用户对该扩展的显式确认；不带就拒绝。

---

## 信任模型（三层，缺一层等于放开任意 Node 代码）

1. **来源完整性** —— Open VSX 的包用注册表级 Ed25519 公钥验签（对**整个 `.vsix` 原始字节**）；
   Microsoft Marketplace **没有** DSH 可公开校验的签名（`@vscode/vsce-sign` 是微软专有许可，
   研究文档 §2.6），只能靠 publisher 域名验证（`publisher.flags = verified`）。
2. **publisher 级信任** —— `extensions-trust.json`；安装时把该 publisher 记为已信任，
   `trust` 动作可以撤销；未信任的扩展在记录上带一条 `untrusted-publisher` 的 **error**，
   扩展宿主不会加载它。
3. **用户显式确认** —— 安装动作必须带 `trust: true`。

---

## 能力表（`contributes` → DSH）

> 表的权威是 `src/capabilities.js`，下面三行是它的三个导出集合，逐字一致。

| 档 | 贡献点 |
|---|---|
| 直接映射 | `commands`、`configuration`、`languageModelTools`、`chatSkills`、`chatInstructions`、`chatPromptFiles`、`customEditors`、`webview` |
| 降级映射 | `mcpServerDefinitionProviders`、`configurationDefaults`、`chatAgents`、`languageModelChatProviders`、`extensionDependencies`、`extensionPack`、`authentication`、`capabilities`、`keybindings` |
| 不支持 | `languages`、`grammars`、`snippets`、`languageConfiguration`、`semanticTokenColors`、`semanticTokenModifiers`、`semanticTokenScopes`、`debuggers`、`breakpoints`、`taskDefinitions`、`problemMatchers`、`problemPatterns`、`terminal`、`terminalProfiles`、`terminalQuickFixes`、`webviewViews`、`notebookEditor`、`notebooks`、`notebookRenderer`、`themes`、`iconThemes`、`productIconThemes`、`colors`、`menus`、`submenus`、`views`、`viewsContainers`、`viewsWelcome`、`walkthroughs`、`chatParticipants`、`extensionKind`、`l10n` |

表在 `src/capabilities.js`，是可查询的（`classifyContribution(key)` / `classifyContributes(contributes)`）。

---

## 实现要点

* **零依赖**：zip 读取器是自写的（`src/zip.js`，~200 行：中央目录 + deflate + CRC-32 + zip64），
  验签用 Node 内置 `node:crypto`。本 bundle 不引入任何 npm 依赖，
  也不需要把 `@deepseek-ai/dsh-tools` 拖进 profile 的 `node_modules`（`src/define-tool.js` 是等价的本地实现）。
* **`ctx.fs` 优先**：状态文件用 `ctx.fs.writeText` 写；解包、二进制与目录操作走 `node:fs`
  （`ctx.fs` 只有 `writeText`，没有二进制写与 mkdir —— 研究文档 §3 记载）。
* **两段式安装**：解到 `extensions/.staging-XXXXXX/` → 写 `dsh-extension.json` → `rename` 到最终目录，
  避免半安装状态（VS Code 的做法，研究文档 §1.6）。
* **完整性先于验签**：先校验 `.signature.manifest` 的 `package.size` 与 `package.digests.sha256`，
  再验签 —— 否则下载被截断会给出极具误导性的「签名无效」（研究文档 §3.2 的踩坑记录）。
* **网络重试**：Open VSX 的文件走 `openvsx.eclipsecontent.org` 这台会 302 的 CDN，
  从部分网络连接会间歇性超时；请求带 6 次退避重试。
* **该重试的不该重试，不该重试的不重试**：重试只对**网络抖动**有意义。
  * 一个**确定的答复**（404 / 403 / 410）不是抖动 —— 注册表说「没有这个版本」
    就是一个事实，再问五次只是把事实变成十二秒的等待。
  * 一个**连不上的主机**（connect timeout / ECONNREFUSED / ENOTFOUND）再问五次
    也不会有答案，而每一次要赔十秒 —— 那是**一分钟的沉默**。
  * 实测：本机 `lookupOpenVsx` 问一个只有 Marketplace 有的版本，改策略前 **12416 ms**，
    改策略后 **1229 ms**（同一个 URL）。整条安装链路因此从 ~20 s 降到 ~3.5 s。
* **交互式搜索有自己的预算**：下载路径值得等（`fetchBytes` 6 次 × 120 s），
  搜索不值得 —— 一次交互式搜索是 **6 秒超时、最多 2 次**，宁可快速失败让
  另一个注册表顶上，也不要让人对着「正在搜索…」等一分半。
* **列表先到，结论后到**：注册表**一秒**就能回答一次搜索，而 manifest 挂在 CDN 上，
  网络够不到时**每个结果**都要赔一次超时（24 个结果能把 1 秒的搜索变成 4 分钟）。
  所以 `catalog` 的 `inspect` 默认为 true（模型工具要一次拿全），而页面用
  `inspect: false` 先拿列表，再**逐个**调 `inspect` 补结论。
* **manifest 读取快速失败**：检查用的 manifest 请求是 **6 秒超时、最多 2 次**（下载路径仍然重试到底，
  因为那里的 CDN 值得等；这里等不来）。**够不到**时会去**另一个注册表**读同一个扩展的 manifest ——
  够不到是网络的事实，不是扩展的事实，所以换一家读是正当的二次尝试（**完整性**失败则绝不换）。

---

## 验证

见 [`../vscode-extension-support/vsix-store/README.md`](../vscode-extension-support/vsix-store/README.md)，
或直接跑本目录下的脚本（都不写 profile，全部落在临时目录里）：

```bash
node scripts/search-open-vsx.mjs "hello world" 3   # 单元级：真实网络搜索
node scripts/e2e-install.mjs secureannex hello-world 0.0.1   # 端到端：下载 → 验签 → 解包
node scripts/verify-signature.mjs secureannex hello-world 0.0.1  # 验签正例 + 三个反例
node scripts/service-check.mjs secureannex hello-world 0.0.1    # store 的各个动作
node scripts/route-check.mjs                                 # HTTP 路由 + 模型工具
```

实测输出摘要（2026-10-24，本机）：

```
search-open-vsx.mjs  → totalSize 144，返回 3 条；capability 从 manifest 算出：
                        secureannex.hello-world  → supported   (commands)
                        ti-development-tools.…    → unsupported (无贡献点)
e2e-install.mjs      → 3,009 B；Ed25519 验签 VALID；6 个 entry digest 全部匹配；
                        解包树 extension/{package.json, extension.js, LICENSE.txt, readme.md}；
                        contributes=[commands] → supported；executesCode=true
verify-signature.mjs → 1) VALID  2) 截断 → "the download is incomplete…"  3) 篡改 → sha256 不符
                        4) 篡改签名 → "the Ed25519 signature does not match the package"
service-check.mjs    → 无 trust 拒绝安装；装后 extensions.json / extensions-trust.json 形状正确；
                        停用改 enabled；撤销信任后记录出现 untrusted-publisher(error)
route-check.mjs      → 7 个 action 全部按契约返回；工具的 parameters/output schema
                        被 harness 自己的 assertSupportedJsonSchema 接受
```
