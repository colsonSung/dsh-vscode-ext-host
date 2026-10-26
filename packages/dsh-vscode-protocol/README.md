# `@local/dsh-vscode-protocol`

**纯库**：无 DSH context、无自有 I/O、零第三方运行时依赖、纯 ESM。

它回答一个问题：**DSH 怎么跟一个真正的 VS Code 扩展宿主说话？**

答案不是 JSON-RPC 2.0，而是 **VS Code 自己的二进制协议**：

| 层 | 上游文件（已 vendor，逐字保留） | 说明 |
|---|---|---|
| 帧 | `base/parts/ipc/common/ipc.net.ts` → `PersistentProtocol` | 13 字节头 `type\|id\|ack\|length`，**消息 id 必须严格连续**，出现空洞会请求重放而不是重新同步 |
| RPC | `workbench/services/extensions/common/rpcProtocol.ts` → `RPCProtocol` | 请求 / 应答 / 取消三层，跑在 `IMessagePassingProtocol` 之上 |
| 通道表 | `workbench/api/common/extHost.protocol.ts` → `MainContext` / `ExtHostContext` | 通道名与 `$` 方法名**原样保留**，改一个字符就等于「Unknown method」 |

## 导出

| 导出 | 来自 | 作用 |
|---|---|---|
| `PersistentProtocol` / `BufferedEmitter` / `RPCProtocol` / `ProxyIdentifier` | vendor | 传输层与 RPC 框架 |
| `MainContext` / `ExtHostContext` | vendor | 通道常量表（原样） |
| `DSH_MAIN_THREAD_CAPABILITY` / `mainThreadCapability()` | DSH | 每个主线程服务在 DSH 里的能力判定 |
| `StdioSocket` | DSH | 把 Node 的 stdin/stdout 适配成上游的 `ISocket` |
| `ReadySignalReader` / `writeReadySignalOrStderr()` | DSH | 扩展宿主 ready 握手（fd 3，退化到 stderr） |
| `buildInitData()` / `toExtId()` / `deriveImplicitActivationEvents()` | DSH | 构造扩展宿主 init payload |
| `PRODUCT_BRAND` | DSH | 品牌替换表（不得使用 "VS Code" 作产品名，不得使用 `vscode://`） |

## 为什么要做 ready 握手

扩展宿主在 `AbstractExtHostExtensionService._beforeAlmostReadyToRunExtensions()` 里注册 RPC
actor。在那之前到达的请求会得到 `Unknown actor ExtHostWorkspace`，init RPC 直接丢掉。

尖峰用「重试」绕过；生产化改成**独立于协议帧的显式信号**：子进程在 actor 注册完成后往
**fd 3** 写一行 `DSH_EXTHOST_READY\n`（fd 3 不可用时退化到 stderr），主侧等到它才发第一个
init RPC。

## 关于 vendored 源码

本包在仓库内构建，编译时会把 `<repo>/vscode-ext-host/vendor/src/vs/**` 内联进
`dist/index.js`。上游源码**只读、零改动**，版权头逐字保留（构建脚本把每个模块的头注释改写成
esbuild 的 legal comment 形式，配合 `legalComments: 'inline'` 保留在产物里）。

## 构建

```bash
cd vscode-ext-host/packages/dsh-vscode-protocol && node build.mjs
```
