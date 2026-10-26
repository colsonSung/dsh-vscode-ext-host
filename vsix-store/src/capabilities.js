/**
 * What DSH can actually do with a VS Code extension's `contributes` block.
 *
 * The research notes are explicit that DSH is not a text editor: it has no
 * document model, no debugger, no notebook, no SCM
 * ([vscode-extension-research/README.md] §3 "B 类 / C 类", and
 * [dsh-mainthread-mapping.md] §2). This module turns that mapping into a
 * queryable table so the catalog can say, per extension, which contribution
 * points will work and which will be ignored.
 *
 * Three tiers:
 *
 * - `supported` — the contribution point maps onto a DSH service with
 *   equivalent semantics;
 * - `degraded` — it maps, but with a documented loss;
 * - `unsupported` — DSH has no equivalent concept, so the contribution is
 *   ignored.
 *
 * ## Every verdict carries its own source
 *
 * A table that cannot say *why* it says something rots. Each entry therefore
 * records:
 *
 * - `source` — `host` when a DSH Host service already backs the verdict,
 *   `research` when the verdict comes from the research drafts alone;
 * - `evidence` — the exact place that verdict comes from, so a reader can
 *   check it rather than trust it;
 * - `pending` — the track that may revise this verdict, when one exists.
 *
 * The pending tracks are:
 *
 * - `vscode-ext` — the webview / custom-editor chain; it may move
 *   `customEditors`, `webview` and `webviewViews` up a tier;
 * - `lsp` — the LSP glue; the language contribution points stay red (DSH has
 *   no editor), but a whole class of extensions may become usable;
 * - `ext-host` — the extension host process; without it, an extension that
 *   only ships code cannot run at all.
 *
 * A verdict is never made optimistic ahead of a track: the tier always
 * describes what DSH can do **today**, and `pending` only records that the
 * answer may change.
 *
 * ## The runtime layer
 *
 * `supported` / `degraded` / `unsupported` describe contribution points, not
 * the experience of installing an extension. `classifyContributes` also
 * returns a `runtime` verdict, because the two differ in a way a person
 * cares about: an extension that declares three contribution points and
 * gets none of them is not "partially supported", it is **useless**. The
 * runtime verdict says so in one field.
 */

/**
 * @typedef {'supported'|'degraded'|'unsupported'} ContributionTier
 * @typedef {'host'|'research'} ContributionSource
 * @typedef {{ tier: ContributionTier, source: ContributionSource, evidence: string, reason: string, pending?: string }} ContributionEntry
 */

/** @type {Record<string, ContributionEntry>} */
const TABLE = {
  // ---------------------------------------------------------------- 直接映射
  commands: {
    tier: 'supported',
    source: 'host',
    evidence: 'dsh-mainthread-mapping.md §2.1 #1/#2（ctx.commands.register / execute）',
    reason: '对应 ctx.commands；VS Code 的 command id 需要一层 id↔name 映射（研究稿 §2.2.1）。',
  },
  configuration: {
    tier: 'supported',
    source: 'host',
    evidence: 'dsh-mainthread-mapping.md §2.1 #3/#4/#6（ctx.settings、ctx.configEditor）',
    reason: '对应 ctx.settings 与 ctx.configEditor；section→ns 映射由宿主侧完成。',
  },
  languageModelTools: {
    tier: 'supported',
    source: 'host',
    evidence: 'dsh-mainthread-mapping.md §2.2.6（ctx.tools.register(defineTool)）',
    reason: '对应 ctx.tools.register(defineTool)；这是 VSIX 扩展与 DSH 之间唯一必须的功能桥（研究稿 §5.4）。',
  },
  mcpServerDefinitionProviders: {
    tier: 'degraded',
    source: 'host',
    evidence: 'mainthread-dclass.md §3（主侧 $upsertMcpCollection 只能收到定义）；dsh-mainthread-mapping.md §2.1 #30',
    reason: '扩展贡献的 MCP server 定义能被主侧收到，但 DSH 的 dsh-mcp-client 只有 Loader 行静态配置，没有运行时注册 API —— 定义收得到，server 起不来。',
  },
  chatSkills: {
    tier: 'supported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §10.2（chatSkills 是被支持的新方向）',
    reason: '对应 DSH 的 skill 体系。',
  },
  chatInstructions: {
    tier: 'supported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §10.2',
    reason: '对应 DSH 的指令体系。',
  },
  chatPromptFiles: {
    tier: 'supported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §10.2',
    reason: '对应 DSH 的提示词文件。',
  },

  // ---------------------------------------------------------------- 降级映射
  configurationDefaults: {
    tier: 'degraded',
    source: 'research',
    evidence: 'dsh-mainthread-mapping.md §2.1 #3（DSH 只有插件 namespace，没有「扩展默认」这一档）',
    reason: '默认值会并入插件命名空间，没有可单独检视的「扩展默认」层。',
  },
  chatAgents: {
    tier: 'degraded',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §10.2（chatParticipants 已弃用，chatAgents 是新方向）',
    reason: 'chat 贡献点会落成普通模型工具；DSH 没有 VS Code 的 chat 视图。',
  },
  languageModelChatProviders: {
    tier: 'degraded',
    source: 'host',
    evidence: 'dsh-mainthread-mapping.md §2.1 #29（ctx.llm.listProviders / listModels）',
    reason: 'DSH 有自己的模型注册表；VS Code 的 chat provider 会被适配成工具，而不是 chat participant。',
  },
  extensionDependencies: {
    tier: 'degraded',
    source: 'research',
    evidence: 'vscode-extension-research/vsix-runtime-and-trust.md §4.1 候选 (c)（profile 级允许列表）',
    reason: '依赖会被记录但不会自动安装；需要显式安装被依赖的扩展。',
  },
  extensionPack: {
    tier: 'degraded',
    source: 'research',
    evidence: 'vscode-extension-research/vsix-runtime-and-trust.md §4.1 候选 (c)',
    reason: '包成员会被记录但不会自动安装。',
  },
  authentication: {
    tier: 'degraded',
    source: 'host',
    evidence: 'dsh-mainthread-mapping.md §2.1 #22（ctx.credentials）',
    reason: 'CredentialRef 只收 POSIX 形式的标识符，不是任意字符串 key；扩展的 key 会被编码。',
  },
  capabilities: {
    tier: 'degraded',
    source: 'research',
    evidence: 'vscode-extension-research/vsix-runtime-and-trust.md §2.8（capabilities.untrustedWorkspaces）',
    reason: '它其实是信任元数据（untrustedWorkspaces / virtualWorkspaces），DSH 读它但不把它当运行时能力。',
  },
  keybindings: {
    tier: 'degraded',
    source: 'research',
    evidence: 'dsh-mainthread-mapping.md §2.1（DSH 没有快捷键模型）',
    reason: 'DSH 没有 keybinding 模型；快捷键贡献会被忽略。',
  },

  // ---------------------------------------------------------------- 不支持
  languages: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'dsh-mainthread-mapping.md §2.1 #11（DSH 没有文档模型）；README.md §3 B 类',
    reason: 'DSH 没有编辑器与文档模型，语言贡献点无处落地。',
    pending: 'lsp',
  },
  grammars: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §10.3（明确不映射编辑器类贡献点）',
    reason: '没有文档模型，语法贡献点无处落地。',
    pending: 'lsp',
  },
  snippets: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §10.3',
    reason: '没有编辑器，代码片段无处落地。',
  },
  languageConfiguration: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §10.3',
    reason: '没有编辑器。',
  },
  semanticTokenColors: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'dsh-mainthread-mapping.md §2.2（B 类 → 桩化）',
    reason: '没有语义 token 模型。',
  },
  semanticTokenModifiers: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'dsh-mainthread-mapping.md §2.2（B 类 → 桩化）',
    reason: '没有语义 token 模型。',
  },
  semanticTokenScopes: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'dsh-mainthread-mapping.md §2.2（B 类 → 桩化）',
    reason: '没有语义 token 模型。',
  },
  debuggers: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §3 C 类（debugger 概念根本冲突）',
    reason: 'DSH 没有调试器概念。',
  },
  breakpoints: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §3 C 类',
    reason: 'DSH 没有调试器概念。',
  },
  taskDefinitions: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §3 C 类（task 概念冲突）',
    reason: 'DSH 没有 task 概念。',
  },
  problemMatchers: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §3 C 类',
    reason: 'DSH 没有 problem 面板。',
  },
  problemPatterns: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §3 C 类',
    reason: 'DSH 没有 problem 面板。',
  },
  terminal: {
    tier: 'unsupported',
    source: 'host',
    evidence: 'dsh-mainthread-mapping.md §2.1 #25（ctx.terminals 是 Agent 拥有的，且无 Pseudoterminal）',
    reason: 'DSH 的终端属于 Agent，不属于 UI，扩展的终端贡献点绑不上去。',
  },
  terminalProfiles: {
    tier: 'unsupported',
    source: 'host',
    evidence: 'dsh-mainthread-mapping.md §2.1 #25',
    reason: '同 terminal。',
  },
  terminalQuickFixes: {
    tier: 'unsupported',
    source: 'host',
    evidence: 'dsh-mainthread-mapping.md §2.1 #25',
    reason: '同 terminal。',
  },
  customEditors: {
    tier: 'supported',
    source: 'host',
    evidence: 'webview-custom-editor.md §2（真实 hediet.vscode-drawio 端到端 15/15）；实测：认领 → 激活 → 14,651 字符 HTML → 沙箱 iframe → 双向消息',
    reason: '自定义编辑器已在 DSH 的文档预览面里真的能跑：文件被认领、扩展被激活、webview 的 HTML 由 DSH 提供并注入 vscode API shim、资源由 DSH 的路由提供。',
  },
  webview: {
    tier: 'supported',
    source: 'host',
    evidence: 'webview-custom-editor.md §3（承载面 = 扩展宿主 bundle 的一部分，沙箱 iframe + acquireVsCodeApi shim + 资源路由）',
    reason: 'webview 有了承载面：HTML 由扩展产出、由 DSH 改写资源 URL 并注入 vscode API shim，在沙箱 iframe（sandbox=allow-scripts，无 allow-same-origin）里渲染，消息双向。',
  },
  webviewViews: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'webview-custom-editor.md §5（webview view provider 做不到：DSH 没有视图容器，slot 是固定 108 个）',
    reason: 'webview 本身能跑，但「视图型 webview」没有容器可挂：DSH 的 slot 是固定清单，没有 VS Code 的 views/viewsContainers。',
  },
  notebookEditor: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §3 C 类（notebook 概念冲突）',
    reason: 'DSH 没有 notebook 模型。',
  },
  notebooks: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §3 C 类',
    reason: 'DSH 没有 notebook 模型。',
  },
  notebookRenderer: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §3 C 类',
    reason: 'DSH 没有 notebook 模型。',
  },
  themes: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §10.3',
    reason: 'DSH 没有编辑器主题系统。',
  },
  iconThemes: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §10.3',
    reason: 'DSH 没有图标主题系统。',
  },
  productIconThemes: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §10.3',
    reason: 'DSH 没有图标主题系统。',
  },
  colors: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §10.3',
    reason: 'DSH 用自己的主题 token，扩展的颜色贡献点无处落地。',
  },
  menus: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §10.5（明确不实现 menus）',
    reason: 'DSH 的 Command 没有菜单概念。',
  },
  submenus: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §10.5',
    reason: '同 menus。',
  },
  views: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §10.3',
    reason: 'DSH 的视图承载面与 VS Code 的 view container 不是一回事。',
  },
  viewsContainers: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §10.3',
    reason: '同 views。',
  },
  viewsWelcome: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §10.3',
    reason: '同 views。',
  },
  walkthroughs: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §3 C 类（walkthrough 概念冲突）',
    reason: 'DSH 没有 walkthrough 概念。',
  },
  chatParticipants: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §10.2（官方已弃用，仓库 0 命中）',
    reason: 'VS Code 官方已标 Deprecated，Copilot harness 已移除支持。',
  },
  extensionKind: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'dsh-mainthread-mapping.md §2.1 #31（DSH 无 workspace/UI 分离的扩展种类概念）',
    reason: 'DSH 只有一种宿主（本地进程），没有 kind 可选。',
  },
  l10n: {
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §10.3',
    reason: 'DSH 的本地化只覆盖插件自己的词典。',
  },
}

/** The contribution points DSH implements with equivalent semantics. */
export const SUPPORTED_CONTRIBUTIONS = Object.keys(TABLE).filter((key) => TABLE[key].tier === 'supported')

/**
 * The contribution points DSH implements with a documented loss.
 * @type {Record<string, string>}
 */
export const DEGRADED_CONTRIBUTIONS = Object.fromEntries(
  Object.entries(TABLE).filter(([, entry]) => entry.tier === 'degraded').map(([key, entry]) => [key, entry.reason]),
)

/** The contribution points DSH has no equivalent concept for. */
export const UNSUPPORTED_CONTRIBUTIONS = Object.keys(TABLE).filter((key) => TABLE[key].tier === 'unsupported')

/** Contribution keys that share one prefix rule. */
const PREFIX_RULES = [
  {
    prefix: 'semanticToken',
    tier: 'unsupported',
    source: 'research',
    evidence: 'dsh-mainthread-mapping.md §2.2（B 类 → 桩化）',
    reason: 'DSH 没有语义 token 模型。',
  },
  {
    prefix: 'terminal',
    tier: 'unsupported',
    source: 'host',
    evidence: 'dsh-mainthread-mapping.md §2.1 #25',
    reason: 'DSH 的终端属于 Agent，扩展的终端贡献点绑不上去。',
  },
  {
    prefix: 'notebook',
    tier: 'unsupported',
    source: 'research',
    evidence: 'vscode-extension-research/README.md §3 C 类',
    reason: 'DSH 没有 notebook 模型。',
  },
]

/**
 * Classify one contribution key.
 * @param {string} key - the contribution key from `contributes`.
 * @returns {{ key: string, tier: ContributionTier, source: ContributionSource, evidence: string, reason: string, pending?: string }} the verdict.
 */
export function classifyContribution(key) {
  const known = TABLE[key]
  if (known !== undefined) return { key, ...known }
  for (const rule of PREFIX_RULES) {
    if (key.startsWith(rule.prefix)) return { key, ...rule }
  }
  return {
    key,
    tier: 'unsupported',
    source: 'research',
    evidence: '不在 Track M 的能力表里',
    reason: 'DSH 不认识这个贡献点，所以它会被忽略。',
  }
}

/**
 * Compute the runtime verdict of an extension.
 *
 * The contribution tiers describe points; this describes the experience of
 * installing the extension, which is what a person actually wants to know.
 * @param {object} options - the verdict's inputs.
 * @param {string[]} options.contributes - the declared contribution keys.
 * @param {string[]} options.supported - the supported keys.
 * @param {string[]} options.degraded - the degraded keys.
 * @param {string[]} options.unsupported - the unsupported keys.
 * @returns {{ verdict: string, usable: boolean, blocker?: string, pendingTracks: string[] }} the runtime verdict.
 */
function runtimeVerdict({ contributes, supported, degraded, unsupported }) {
  const pendingTracks = new Set()
  for (const key of contributes) {
    const entry = classifyContribution(key)
    if (entry.pending !== undefined) pendingTracks.add(entry.pending)
  }
  if (contributes.length === 0) {
    // The extension declares nothing: it only ships code. Nothing can be
    // delivered without an extension host, so it cannot run yet.
    pendingTracks.add('ext-host')
    return {
      verdict: 'code-only',
      usable: false,
      blocker: 'no-extension-host',
      pendingTracks: [...pendingTracks],
    }
  }
  if (supported.length === 0) {
    // It declares things, and DSH supports none of them: installing it
    // delivers none of what it wants.
    return {
      verdict: 'none',
      usable: false,
      blocker: 'no-supported-contribution',
      pendingTracks: [...pendingTracks],
    }
  }
  if (unsupported.length > 0 || degraded.length > 0) {
    return { verdict: 'partial', usable: true, pendingTracks: [...pendingTracks] }
  }
  return { verdict: 'full', usable: true, pendingTracks: [...pendingTracks] }
}

/**
 * Split an extension's `contributes` block into the three tiers, with the
 * source of every verdict and the runtime experience of installing it.
 * @param {object|undefined} contributes - the manifest's `contributes` block.
 * @param {object} [options] - the classification's inputs.
 * @param {boolean} [options.executesCode] - whether the extension ships code.
 * @returns {{ contributes: string[], supported: string[], degraded: string[], unsupported: string[], entries: Array<object>, status: string, runtime: object, problems: Array<object> }} the split.
 */
export function classifyContributes(contributes, { executesCode = false } = {}) {
  const keys = contributes === undefined || contributes === null ? [] : Object.keys(contributes)
  const supported = []
  const degraded = []
  const unsupported = []
  const entries = []
  const problems = []
  for (const key of keys) {
    const entry = classifyContribution(key)
    entries.push(entry)
    if (entry.tier === 'supported') {
      supported.push(key)
    } else if (entry.tier === 'degraded') {
      supported.push(key)
      degraded.push(key)
      problems.push({
        code: 'degraded-contribution',
        severity: 'warning',
        message: `"${key}" works with a documented loss: ${entry.reason}`,
      })
    } else {
      unsupported.push(key)
      problems.push({
        code: entry.evidence.startsWith('不在 Track M') ? 'unknown-contribution' : 'unsupported-contribution',
        severity: 'warning',
        message: `"${key}" is not supported by DSH: ${entry.reason}`,
      })
    }
  }
  const runtime = runtimeVerdict({ contributes: keys, supported, degraded, unsupported })
  const status = runtime.verdict === 'full'
    ? 'supported'
    : runtime.verdict === 'partial'
      ? 'partial'
      : runtime.verdict === 'code-only'
        ? 'code-only'
        : 'unsupported'
  void executesCode
  return { contributes: keys, supported, degraded, unsupported, entries, status, runtime, problems }
}
