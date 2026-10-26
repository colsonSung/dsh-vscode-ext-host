# @local/dsh-lsp-stdio — 让 `ctx.lsp` 真的存在

这个 bundle 做两件事：

1. **提供 `ctx.lsp` 这条能力缝**（如果还没有别人提供的话）；
2. **把 `ctx.lsp` 指向真正的语言服务器**（stdio）。

## 为什么需要它

DSH 生成的 API 目录（`@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js`，由
`scripts/gen-cordis-api.ts` 生成）**描述**了一个叫 `lsp` 的服务，契约完整：
`registerProvider(provider)` / `query(request, signal?)`，以及一整套 `Lsp*` 类型。

但**目录 ≠ 实现**。这个 build 里没有任何包注册 `lsp`：

```bash
grep -rn "super(ctx, 'lsp')" --include="*.js" dsh/node_modules/@deepseek-ai/     # 无匹配
ls -d dsh/node_modules/@deepseek-ai/*lsp*                                        # 无
```

`@deepseek-ai/dsh-lsp` 在 composition reference 的包表里出现过，那是**monorepo 里**的包，
**没有随发行版发布**。所以在没有这个 bundle 之前，`ctx.lsp.query(...)` 谁也答不上来。

本 bundle 因此自己实现这条缝，**逐条对齐目录里的契约**；如果将来真的发布了
`@deepseek-ai/dsh-lsp`，本 bundle 会**改用它**（provider 契约两边完全一样）。

## 契约（来自 API 目录，逐条对齐）

| 方法 | 目录里的描述 | 本实现的落点 |
|---|---|---|
| `registerProvider(provider)` | *"atomically reserving its id and every normalized extension. Any conflict or invalid input publishes nothing and throws `LspError`; the returned disposer releases all reservations."* | `lib/lsp-service.js` → `LspSeam.registerProvider`：先全量校验、算好所有预留，再一次性发布；任何冲突都在发布前抛出 |
| `query(request, signal?)` | *"Select a provider by the file's extension and run one query. Selection is per-query and order-independent; no match throws `LspError` `LSP_UNAVAILABLE`."* | `lib/lsp-service.js` → `LspSeam.query`：扩展名 → provider 的扁平索引，与注册顺序无关；无匹配抛 `LSP_UNAVAILABLE` |

**"normalized extension" 的定义**（目录没定义，本 bundle 定义）：小写、去前导点，
所以 `.ts` / `.TS` / `ts` 是同一个预留键。provider 的 `extensionToLanguage` 键和请求里的
文件路径都走同一个归一化函数，两边必然对得上。

## 坐标

LSP 是 **0 基**、**UTF-16 code unit**。DSH 侧约定是 **1 基**。
换算只在**一个**函数里：`toDshPosition()`（`lib/stdio-provider.js`）。
`positionBase` 配置项可以整体切换成 0 基，用来对齐将来的官方 `dsh-tool-lsp`。

## 错误分类（`LspError`）

`lib/lsp-error.js`。**缺服务器绝不返回空结果**，每种失败都有自己的码：

| 码 | 含义 |
|---|---|
| `LSP_UNAVAILABLE` | 没有任何 provider 服务这个文件扩展名（目录契约明确要求这个码） |
| `LSP_INVALID_REQUEST` | 请求本身不合法（位置坏、文件读不了） |
| `LSP_CONFLICT` | provider id 或扩展名已被占用 |
| `LSP_NOT_CONFIGURED` | 该语言没有配置服务器 |
| `LSP_SERVER_NOT_INSTALLED` | 配的命令找不到（ENOENT） |
| `LSP_SERVER_START_FAILED` | 进程起来了但握手没成 |
| `LSP_SERVER_EXITED` | 服务器在请求途中退出（**消息里带服务器自己的 stderr**） |
| `LSP_SERVER_ERROR` | 服务器回了 JSON-RPC error |
| `LSP_TIMEOUT` | 超过截止时间 |
| `LSP_PROTOCOL_ERROR` | 分帧或 JSON-RPC 违规 |
| `LSP_UNSUPPORTED_OPERATION` | 服务器不实现这个方法（JSON-RPC `-32601`） |
| `LSP_CANCELLED` | 调用方取消 |

## 配置

```yaml
- id: lsp-stdio
  name: '@local/dsh-lsp-stdio'
  config:
    positionBase: 1          # 1 = DSH 的一基约定，0 = LSP 原生
    requestTimeoutMs: 15000
    initializeTimeoutMs: 20000
    extensionServers:
      enabled: true
      requireTrusted: true
    servers: []
```

`servers` 按 **id** 覆盖内置默认（TypeScript / Python / Go / Rust）：
用同一个 id 重写就是覆盖，写新 id 是追加，想关掉某个默认就把它重写成 `enabled: false`。

```yaml
    servers:
      - id: typescript
        command: /opt/homebrew/bin/typescript-language-server
        args: ['--stdio']
        extensions: ['.ts', '.tsx']
        languageIds: ['typescript', 'typescriptreact']
```

**默认命令是裸可执行文件名**，不是 `npx -y …`。原因：provider **不会**在查询时下载或
安装任何东西（`npx -y` 会在用户问一个问题时悄悄拉代码下来执行），而且缺服务器会**立刻**
以 `LSP_SERVER_NOT_INSTALLED` 失败，消息里写清楚该装什么。

## 路线 (c)：装了 VSCode 语言扩展就能用吗

**先说结论：VSCode 的扩展清单里没有任何字段声明语言服务器。**
`contributes.languages` 只有 `id` / `aliases` / `extensions` / `configuration` / `icon` /
`colorizedBracketPairs`——没有指向服务器的东西。真实的语言扩展（`ms-python.python` 等）
把服务器**打包在扩展目录里**，在自己的 `main` 代码里 spawn；那个服务器是扩展宿主进程的
子进程，**另一个 LSP 客户端够不着它**。

所以本 bundle 定义了一个**显式的小约定**，按固定顺序读：

1. `<扩展目录>/dsh-lsp.json` —— 扩展目录里的一个同级文件（最显式的形式）：
   ```json
   { "command": "node", "args": ["server.js"], "extensions": [".ts"], "languageIds": ["typescript"] }
   ```
2. `<扩展目录>/extension/package.json` → `dsh.lspServer` —— 同样的对象，放在扩展清单的
   `dsh` 键下。

约定没写 `extensions` / `languageIds` 时，从扩展自己的 `contributes.languages` 推导：
每个语言 id 贡献它的 `extensions`，语言 id 就是语言名。**这才是"装了语言扩展就能用"
真正成立的地方。**

**优先级**：扩展声明的服务器先注册，因此它占住的扩展名优先；配置里的服务器只拿到剩下
的扩展名。两边都没覆盖到的扩展名 → `LSP_UNAVAILABLE`。

**信任**：只有 `installed && enabled` 且**受信任**的发布者才能贡献服务器。信任的判定是
记录里的 `trusted` 字段优先，没有就用 `extensions-trust.json` 的 `publishers` 表，两者
都没有则**不受信任**。

## 自检

```bash
node scripts/verify.mjs            # 34 项：协议、错误分类、冲突、配置、信任、优先级
node scripts/verify-real-server.mjs # 2 项：真的 pyright-langserver
```

`verify.mjs` 用 bundle 自带的 `fake-lsp-server.mjs`（一个真的说 LSP 协议的进程），
不需要装任何东西。`verify-real-server.mjs` 会找一个真的语言服务器（`pyright-langserver`），
找不到就**如实报告没做**，不会拿模拟结果冒充。

两个脚本会把证据写进 `runtime/verify/evidence/`。

> 本地跑 `verify.mjs` 需要 `@deepseek-ai/schemastery` 可解析：脚本会自动把 DSH 发行版里
> 那份软链到 bundle 的 `node_modules` 下（不下载任何东西；`node_modules` 不在 `files` 里，
> 装 bundle 时会被 pnpm prune 掉）。

## 依赖与偏差

* 只依赖 `@deepseek-ai/schemastery`（Config schema）。**不依赖任何 `@deepseek-ai/dsh-*`**，
  这样 bundle 不会随 DSH 升级而版本钉死。
* 子进程用 `node:child_process` 自己 spawn，而不是 `ctx.subprocess`。理由：
  `ctx.subprocess` 的 pipe 模式在这个 build 里没有随包发布 `.d.ts`，它的公开 handle 形状
  只有 README 里的一句散文（*"`pipe` hands you the raw stream"*），把 LSP 客户端的核心押在
  一个没有类型声明的 handle 形状上不划算。DSH README 里明确给了"自己拥有 spawn 的
  transport"这条路径（*"route around the service and import `scrubbedParentEnv` directly so
  environment policy stays single-sourced"*）。
* 环境变量清洗是**本地实现**（`scrubbedEnvironment()`：去掉 `DSH_*` 和
  凭据形状的名字），不是 DSH 的 `scrubbedParentEnv`。这是有意为之的偏差：bundle 不依赖
  任何 DSH 包。接上官方实现只是换一行 import。
