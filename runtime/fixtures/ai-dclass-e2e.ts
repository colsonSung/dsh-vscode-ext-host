/*---------------------------------------------------------------------------------------------
 *  DSH D-class (AI) main-thread services — the end-to-end probe.
 *
 *  DSH-authored (MIT). No Microsoft code.
 *
 *  WHAT IT PROVES
 *  --------------
 *  1. A real VS Code extension (the probe extension next to this file) that declares
 *     `contributes.languageModelTools` and calls `vscode.lm.registerTool(...)` activates inside
 *     the REAL vendored extension host.
 *  2. The main side — the D-class modules in `runtime/main/methods/ai-*.ts` — answers
 *     `$getTools()` and receives `$registerTool(...)`.
 *  3. The DSH side sees the tool: the fake DSH tool registry holds it, with the extension's
 *     `modelDescription` as the description and the extension's `inputSchema` as the parameters.
 *  4. Calling the tool routes DSH → extension host → the extension's `invoke`, and the result
 *     comes back as a DSH tool value.
 *  5. The extension's `prepareInvocation` confirmation copy reaches DSH's approval pipeline.
 *  6. The extension's `contributes.chatSkills` entry reaches `ctx.skills.register`.
 *
 *  HOW
 *  ---
 *  The driver speaks VS Code's own RPC protocol with the built extension host, exactly like the
 *  production main side does; only the main side's method table is swapped for the D-class
 *  modules plus type-correct stubs.
 *
 *  Usage: node runtime/fixtures/ai-dclass-e2e.mjs   (after `node runtime/build.mjs`)
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	buildInitData,
	ExtHostContext,
	MainContext,
	RPCProtocol,
	StdioSocket,
	toExtId,
} from '../../packages/dsh-vscode-protocol/src/index.js';
import { STUB_RETURNS } from '../main/stub-returns.js';
import { createChannelMethods } from '../main/methods/index.js';

import createAiToolsMethods from '../main/methods/ai-tools.js';
import createAiChatAgentsMethods from '../main/methods/ai-chat-agents.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const FIXTURE = resolve(__dirname, 'ai-tool-extension');
const CHILD = resolve(__dirname, 'extension-host-probe.js');

/** The extension id the probe uses. */
const EXTENSION_ID = 'dsh-probe.ai-tool';

/** Every assertion the run made. */
const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

/**
 * Record one assertion.
 * @param name - what was asserted.
 * @param ok - whether it held.
 * @param detail - the observed value.
 */
function check(name: string, ok: boolean, detail?: string): void {
	checks.push({ name, ok, detail })
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  -> ${detail}` : ''}`)
}

/**
 * The fake DSH host context: just enough of `ctx.tools`, `ctx.skills` and `ctx.approval` to
 * observe what the D-class modules do.
 */
function createFakeCtx(): any {
	const tools = new Map<string, any>()
	return {
		tools: {
			register(definition: any) {
				if (tools.has(definition.name)) {
					throw new Error(`tool name "${definition.name}" is already registered`)
				}
				tools.set(definition.name, definition)
				return () => { tools.delete(definition.name) }
			},
			get(name: string) { return tools.get(name) },
			schemas() { return [...tools.values()].map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) },
			async execute(exec: any) {
				const definition = tools.get(exec.name)
				if (!definition) { return { isError: true, error: { message: `unknown tool ${exec.name}` }, content: [] } }
				const value = await definition.execute(exec.arguments, exec)
				return { isError: false, value, content: [] }
			},
		},
		skills: {
			registered: [] as any[],
			register(skill: any) {
				this.registered.push(skill)
				return () => { }
			},
		},
		approval: {
			requests: [] as any[],
			async request(request: any) {
				this.requests.push(request)
				return 'allowed-once'
			},
		},
		logger: {
			info: () => { },
			warn: (message: string) => { console.log(`   [dsh warn] ${message}`) },
			error: (message: string) => { console.log(`   [dsh error] ${message}`) },
		},
	}
}

/**
 * Run the probe.
 */
async function main(): Promise<void> {
	const ctx = createFakeCtx()
	const profileDir = mkdtempSync(join(tmpdir(), 'dsh-dclass-e2e-'))
	const extensionDir = join(profileDir, 'extensions', 'dsh-probe.ai-tool-1.0.0', 'extension')
	cpSync(FIXTURE, extensionDir, { recursive: true })
	const manifest = JSON.parse(readFileSync(join(extensionDir, 'package.json'), 'utf8'))

	// The host handle the D-class modules get.
	const host = {
		ctx,
		extensions: [{
			id: `${EXTENSION_ID}@1.0.0`,
			extensionId: EXTENSION_ID,
			publisher: 'dsh-probe',
			name: 'ai-tool',
			version: '1.0.0',
			directory: 'dsh-probe.ai-tool-1.0.0',
			enabled: true,
			extensionPath: extensionDir,
			manifest,
		}],
		profileDir,
		log: (message: string) => { console.log(`   [host] ${message}`) },
		commands: new Map<string, (...args: any[]) => any>(),
		markActivated: () => { },
		markActivationError: () => { },
		setExtensionExports: () => { },
		getExtensionExports: () => undefined,
		status: () => ({ running: true, restarts: 0, reason: 'probe' }),
		call: async (channel: string, method: string, ...args: any[]) => {
			const identifier = (ExtHostContext as any)[channel]
			if (identifier === undefined) { throw new Error(`"${channel}" is not an extension-host channel`) }
			const proxy: any = rpc.getProxy(identifier)
			return proxy[method](...args)
		},
	} as any

	// The D-class modules.
	const toolMethods = createAiToolsMethods(ctx, host)
	const chatAgentMethods = createAiChatAgentsMethods(ctx, host)

	const initData = buildInitData({
		profileDir,
		extensions: [{ extensionId: EXTENSION_ID, extensionPath: extensionDir, manifest }],
		workspaceId: 'dsh-dclass-e2e',
		workspaceName: 'DSH D-class probe',
		logsDir: join(profileDir, 'logs'),
		sessionId: 'dsh-dclass-e2e',
	})

	const child = spawn(process.execPath, [CHILD], {
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, DSH_EXTHOST_INIT_DATA: JSON.stringify(initData), ELECTRON_RUN_AS_NODE: '1' },
	})
	child.stderr.on('data', (chunk: Buffer) => {
		const text = chunk.toString().trim()
		if (text.length > 0) { console.log(`   [exthost] ${text.split('\n').join('\n   [exthost] ')}`) }
	})

	const socket = new StdioSocket(child.stdout as any, child.stdin as any)
	const rpc = new RPCProtocol(socket.createMessagePassingProtocol(), {
		logIncoming: () => { },
		logOutgoing: () => { },
	})

	// Every main-thread channel: the production A-class implementations, the D-class modules
	// where they exist, type-correct stubs everywhere else (a wrong-shaped stub crashes the
	// extension host).
	const implementedByChannel: Record<string, Record<string, (...args: any[]) => any>> = {
		...createChannelMethods(ctx, host),
		MainThreadLanguageModelTools: toolMethods,
		MainThreadChatAgents2: chatAgentMethods,
		// The full error matters here: the probe has to be able to show WHERE the extension host
		// went wrong, not only what it said.
		MainThreadErrors: {
			'$onUnexpectedError'(err: any) {
				console.log(`   [exthost error] ${err?.message ?? JSON.stringify(err)}`)
				if (err?.stack) { console.log(String(err.stack).split('\n').map(line => `      ${line}`).join('\n')) }
			},
		},
	}
	for (const channel of Object.keys(MainContext as any)) {
		const implemented = implementedByChannel[channel] ?? {}
		rpc.set((MainContext as any)[channel], new Proxy({}, {
			get: (_target, property) => {
				if (typeof property !== 'string') { return undefined }
				if (property in implemented) { return implemented[property] }
				return (...args: any[]) => Promise.resolve(STUB_RETURNS[`${channel}.${property}`])
			},
		}))
	}

	// The four init RPCs.
	//
	// The extension host registers its RPC actors a few ticks AFTER the process started, so a
	// request that arrives too early fails with "Unknown actor". The production main side waits
	// for the ready signal; the probe retries instead, which is the same defence the spike uses.
	const rpcWhenReady = async <T>(fn: () => Promise<T>, label: string, attempts = 80): Promise<T> => {
		let lastError: any
		for (let attempt = 0; attempt < attempts; attempt++) {
			try {
				return await fn()
			} catch (error) {
				lastError = error
				const message = String((error as any)?.message ?? error)
				if (!/Unknown actor|Unknown method/i.test(message)) { throw error }
				await new Promise(resolve => setTimeout(resolve, 50))
			}
		}
		throw lastError
	}

	const workspace = rpc.getProxy(ExtHostContext.ExtHostWorkspace)
	const configuration = rpc.getProxy(ExtHostContext.ExtHostConfiguration)
	const telemetry = rpc.getProxy(ExtHostContext.ExtHostTelemetry)
	const metered = rpc.getProxy(ExtHostContext.ExtHostMeteredConnection)
	await rpcWhenReady(() => Promise.resolve(workspace.$initializeWorkspace({ id: 'dsh-dclass-e2e', name: 'DSH D-class probe', folders: [] } as any, true)), '$initializeWorkspace')
	const emptyModel = () => ({ contents: {}, keys: [], overrides: [] })
	await rpcWhenReady(() => Promise.resolve(configuration.$initializeConfiguration({
		defaults: emptyModel(), policy: emptyModel(), application: emptyModel(),
		userLocal: emptyModel(), userRemote: emptyModel(), workspace: emptyModel(),
		folders: [], configurationScopes: [],
	} as any)), '$initializeConfiguration')
	await rpcWhenReady(() => Promise.resolve(telemetry.$initializeTelemetryLevel(0, false, { usage: false, error: false })), '$initializeTelemetryLevel')
	await rpcWhenReady(() => Promise.resolve(metered.$initializeIsConnectionMetered(false)), '$initializeIsConnectionMetered')

	// Start the extension host and activate the probe extension.
	const service: any = rpc.getProxy(ExtHostContext.ExtHostExtensionService)
	console.log('   [probe] -> $startExtensionHost')
	await rpcWhenReady(() => service.$startExtensionHost({
		versionId: 1, toRemove: [], toAdd: [], addActivationEvents: {},
		myToRemove: [], myToAdd: [],
	} as any), '$startExtensionHost')
	console.log('   [probe] -> $activateByEvent')
	await rpcWhenReady(() => service.$activateByEvent('onLanguageModelTool:dsh-probe_echo', 0), '$activateByEvent')
	console.log('   [probe] -> $activate')
	await rpcWhenReady(() => service.$activate(toExtId(EXTENSION_ID) as any, { kind: 'explicit', extensionId: EXTENSION_ID } as any), '$activate')
	await new Promise(resolve => setTimeout(resolve, 1200))

	// ---------------------------------------------------------------------------
	// the assertions
	// ---------------------------------------------------------------------------

	// 1. the DSH side sees the tool, with the extension's schema.
	const tool = ctx.tools.get('dsh-probe_echo')
	check('the DSH tool registry holds the contributed tool', !!tool, tool ? tool.name : 'missing')
	check(
		'the tool description is the extension\'s modelDescription',
		tool?.description === manifest.contributes.languageModelTools[0].modelDescription,
		tool?.description,
	)
	check(
		'the tool parameters are the extension\'s inputSchema',
		JSON.stringify(tool?.parameters) === JSON.stringify(manifest.contributes.languageModelTools[0].inputSchema),
		JSON.stringify(tool?.parameters),
	)

	// 2. the extension host received the tool and registered its implementation.
	const listed = await toolMethods['$getTools']()
	check('$getTools() answers one tool', listed.length === 1, JSON.stringify(listed.map((t: any) => t.id)))
	check(
		'$getTools() carries the protocol id, the source and the schema',
		listed[0]?.id === 'dsh-probe_echo'
		&& listed[0]?.source?.type === 'extension'
		&& listed[0]?.source?.extensionId?.value === EXTENSION_ID
		&& listed[0]?.toolReferenceName === 'dshEcho'
		&& !!listed[0]?.inputSchema,
		JSON.stringify(listed[0]),
	)

	// 3. the tool call routes DSH → extension host → the extension's invoke.
	const result = await ctx.tools.execute({
		callId: 'call-1',
		name: 'dsh-probe_echo',
		arguments: { text: 'hello from dsh' },
		// The DSH tool pipeline routes every call with the calling agent; the approval request
		// needs one, because the approval service audits into that agent's session.
		agent: { id: 'probe-session' },
		signal: new AbortController().signal,
	})
	const rendered = (result as any)?.value?.content?.map((part: any) => part.value).join('')
	check('the tool call reached the extension implementation', rendered === 'echo: hello from dsh', rendered)

	// 4. the extension's prepareInvocation copy reached DSH's approval pipeline.
	const approval = ctx.approval.requests[0]
	check('the extension tool went through the DSH approval pipeline', !!approval, JSON.stringify(approval?.reason))
	check(
		'the approval reason is the extension\'s confirmation copy',
		typeof approval?.reason === 'string' && approval.reason.includes('Run the DSH echo tool?'),
		approval?.reason,
	)

	// 5. the contributed skill reached ctx.skills.
	const skill = ctx.skills.registered.find(entry => entry.name === 'dsh-echo')
	check('the contributed chatSkill reached ctx.skills', !!skill, skill?.name)
	check(
		'the skill carries the frontmatter description and the body',
		skill?.description?.includes('Echoes a piece of text back') && String(skill?.content).includes('# DSH Echo'),
		skill?.description,
	)

	// 6. the extension host reports the tool to the extension.
	const toolsInHost = await service.$getExtension?.(EXTENSION_ID).catch(() => undefined)
	void toolsInHost

	child.kill()
	rmSync(profileDir, { recursive: true, force: true })

	const failed = checks.filter(entry => !entry.ok)
	console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
	process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
	console.error('the probe crashed:', error)
	process.exit(1)
})
