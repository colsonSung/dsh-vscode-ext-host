/*---------------------------------------------------------------------------------------------
 *  DSH S1 production — the `vscode_extension_host` model tool.
 *
 *  DSH-authored (MIT).
 *
 *  The tool exposes the same five actions as the `/vscode-extension-host` route, so the model
 *  and the Extensions page drive exactly the same capability:
 *
 *      status | start | stop | restart | log
 *
 *  The tool definition is compiled here rather than taken from `@deepseek-ai/dsh-tools`: that
 *  package's peer graph spans the whole runtime (`dsh-agent` / `dsh-llm` / `dsh-scope` /
 *  `dsh-session` / ...), and a bundle that depends on it would drag that graph into the
 *  profile's `node_modules` on every install. The contract is the same: the parameters become
 *  a raw JSON Schema, the arguments are validated before `execute` runs, and `output` declares
 *  the canonical value's schema and how it renders.
 *--------------------------------------------------------------------------------------------*/

import type { ExtensionHostRuntime } from './service.js';

/**
 * Compile a parameter specification into a raw JSON Schema.
 *
 * @param spec - the per-parameter spec.
 * @returns the raw JSON Schema.
 */
export function compileParameters(spec: Record<string, { type: string; required?: boolean; description?: string; enum?: unknown[] }>): object {
	const properties: Record<string, object> = {};
	const required: string[] = [];
	for (const [name, definition] of Object.entries(spec ?? {})) {
		const node: Record<string, unknown> = { type: definition.type };
		if (definition.description !== undefined) { node.description = definition.description; }
		if (definition.enum !== undefined) { node.enum = definition.enum; }
		properties[name] = node;
		if (definition.required === true) { required.push(name); }
	}
	return { type: 'object', properties, ...(required.length === 0 ? {} : { required }) };
}

/**
 * Validate one value against a raw JSON Schema node.
 *
 * @param schema - the schema node.
 * @param value - the value.
 * @param path - the diagnostic path.
 * @returns the violations.
 */
function validateNode(schema: any, value: unknown, path: string): string[] {
	const violations: string[] = [];
	const type = schema?.type;
	if (type === undefined) { return violations; }
	if (type === 'object') {
		if (value === null || typeof value !== 'object' || Array.isArray(value)) {
			violations.push(`"${path}" must be an object`);
			return violations;
		}
		for (const key of schema.required ?? []) {
			if (!Object.hasOwn(value, key) || value[key] === undefined) {
				violations.push(`"${path === '' ? key : `${path}.${key}`}" is required`);
			}
		}
		for (const [key, child] of Object.entries(schema.properties ?? {})) {
			if (!Object.hasOwn(value, key) || value[key] === undefined) { continue; }
			violations.push(...validateNode(child, value[key], path === '' ? key : `${path}.${key}`));
		}
		return violations;
	}
	if (type === 'array') {
		if (!Array.isArray(value)) {
			violations.push(`"${path}" must be an array`);
			return violations;
		}
		(value as unknown[]).forEach((entry, index) => {
			violations.push(...validateNode(schema.items, entry, `${path}[${index}]`));
		});
		return violations;
	}
	if (type === 'string' && typeof value !== 'string') { violations.push(`"${path}" must be a string`); }
	if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) { violations.push(`"${path}" must be a number`); }
	if (type === 'integer' && !Number.isInteger(value)) { violations.push(`"${path}" must be an integer`); }
	if (type === 'boolean' && typeof value !== 'boolean') { violations.push(`"${path}" must be a boolean`); }
	if (type === 'null' && value !== null) { violations.push(`"${path}" must be null`); }
	if (schema.enum !== undefined && !schema.enum.includes(value)) {
		violations.push(`"${path}" must be one of ${JSON.stringify(schema.enum)}`);
	}
	return violations;
}

/**
 * Define a model-facing tool.
 *
 * @param options - the tool definition.
 * @returns the registry-ready definition.
 */
export function defineTool(options: {
	name: string;
	description: string;
	parameters: Record<string, { type: string; required?: boolean; description?: string; enum?: unknown[] }>;
	output: { schema: object; render: (args: any, value: any) => Array<object> };
	execute: (args: any) => Promise<any>;
}): object {
	const schema = compileParameters(options.parameters);
	return {
		name: options.name,
		description: options.description,
		parameters: schema,
		output: options.output,
		async execute(args: any) {
			const violations = validateNode(schema, args ?? {}, '');
			if (violations.length > 0) {
				throw new Error(`invalid arguments: ${violations.join('; ')}`);
			}
			return options.execute(args ?? {});
		},
	};
}

const DESCRIPTION = [
	'Control the VS Code extension host of this DSH profile.',
	'',
	'The extension host is the process that runs the installed VS Code extension packages. It',
	'loads only the extensions that are enabled AND whose publisher is trusted, and it restarts',
	'itself when it crashes (three crashes within five minutes stop the automatic restart).',
	'',
	'Actions:',
	'- status: whether the host process runs, how many times it restarted, the last error, and',
	'  which extensions it loaded and activated.',
	'- start: start the extension host.',
	'- stop: stop the extension host.',
	'- restart: restart the extension host.',
	'- log: read the tail of the extension host log.',
].join('\n');

/**
 * Build the model tool.
 *
 * @param runtime - the extension host service.
 * @returns the registry-ready tool definition.
 */
export function createExtensionHostTool(runtime: ExtensionHostRuntime): object {
	return defineTool({
		name: 'vscode_extension_host',
		description: DESCRIPTION,
		parameters: {
			action: {
				type: 'string',
				required: true,
				description: 'What to do with the extension host.',
				enum: ['status', 'start', 'stop', 'restart', 'log'],
			},
			lines: {
				type: 'integer',
				description: 'How many log lines to read. Only for the log action. Defaults to 200.',
			},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					action: { type: 'string' },
					ok: { type: 'boolean' },
					summary: { type: 'string' },
					data: { type: 'object', additionalProperties: true },
				},
				required: ['action', 'ok', 'summary'],
			},
			render: (_args: any, value: any) => [{ type: 'text', text: value?.summary ?? '' }],
		},
		async execute(args: any) {
			const action = String(args.action);
			switch (action) {
				case 'status': {
					const payload = runtime.payload();
					const commands = runtime.registeredCommands();
					return {
						action,
						ok: true,
						summary: payload.host.running
							? `The extension host runs (pid ${payload.host.pid ?? 'unknown'}) with ${payload.extensions.length} extension(s) loaded, ${payload.extensions.filter((entry) => entry.active).length} activated.`
							: `The extension host is not running${payload.host.lastError ? `: ${payload.host.lastError}` : '.'}`,
						data: { ...payload, commands },
					};
				}
				case 'start': {
					const host = await runtime.start();
					return { action, ok: true, summary: host.running ? 'The extension host is running.' : `The extension host did not start: ${host.lastError ?? 'unknown reason'}`, data: { host } };
				}
				case 'stop': {
					const host = await runtime.stop();
					return { action, ok: true, summary: 'The extension host is stopped.', data: { host } };
				}
				case 'restart': {
					const host = await runtime.restart();
					return { action, ok: true, summary: host.running ? 'The extension host was restarted.' : `The extension host did not restart: ${host.lastError ?? 'unknown reason'}`, data: { host } };
				}
				case 'log': {
					const count = typeof args.lines === 'number' ? Math.min(Math.max(args.lines, 1), 5000) : 200;
					const lines = runtime.logLines(count);
					return {
						action,
						ok: true,
						summary: lines.length === 0 ? 'The extension host log is empty.' : lines.slice(-5).join('\n'),
						data: { lines },
					};
				}
				default:
					return { action, ok: false, summary: `Unknown action "${action}".`, data: {} };
			}
		},
	});
}
