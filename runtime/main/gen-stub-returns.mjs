#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  DSH S1 production — derive the type-correct EMPTY return values for the stub actors.
 *
 *  DSH-authored (MIT).
 *
 *  WHY A GENERATOR
 *  ---------------
 *  A blanket `return undefined` stub is NOT safe. The vendored extension host does e.g.
 *
 *      this._proxy.$getTools().then(tools => { for (const tool of tools) { ... } });
 *
 *  so an `undefined` reply crashes the WHOLE extension host with "tools is not iterable".
 *  Every main-thread method must answer with a value of the right shape.
 *
 *  WHY A SCANNER AND NOT A REGEX
 *  ------------------------------
 *  The first version of this generator matched the interface bodies with a non-greedy regex
 *  and matched the shape names with `MainThread\w*Shape`. Both assumptions are wrong:
 *
 *  - `MainThreadChatAgentsShape2` does not END with "Shape", so the whole shape was skipped
 *    (22 methods);
 *  - an interface body that contains a nested object literal ends at its first `\n}`, so the
 *    methods after it were skipped (2 more methods).
 *
 *  A missing entry is not cosmetic: it means the extension host gets `undefined` where it
 *  expects a list, and the whole host goes down. The generator therefore scans the braces
 *  properly, and `audit-stub-returns.mjs` re-derives the method list independently and fails
 *  when the two disagree.
 *
 *  The generator emits two tables:
 *
 *      STUB_RETURNS     channel.$method -> [] | 0 | false | '' | undefined
 *      METHOD_CHANNELS  $method        -> [channel, ...]   (14 names live on several channels)
 *
 *  Usage: node gen-stub-returns.mjs
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const PROTOCOL = resolve(ROOT, 'vendor/src/vs/workbench/api/common/extHost.protocol.ts');
const OUT = resolve(__dirname, 'stub-returns.ts');

const source = readFileSync(PROTOCOL, 'utf8');

/**
 * Find every `export interface <Name> { ... }` block with a brace-matching scan.
 *
 * @param {string} text - the protocol source.
 * @returns {Array<{ name: string, body: string }>} the shapes.
 */
export function scanShapes(text) {
	const shapes = [];
	const declaration = /export interface ([A-Za-z0-9_]+)\s*(?:extends\s+[A-Za-z0-9_<>,\s]+)?\{/g;
	let match;
	while ((match = declaration.exec(text))) {
		const name = match[1];
		let index = match.index + match[0].length;
		let depth = 1;
		const start = index;
		while (index < text.length && depth > 0) {
			const character = text[index];
			if (character === '{') { depth += 1; }
			else if (character === '}') { depth -= 1; }
			index += 1;
		}
		shapes.push({ name, body: text.slice(start, index - 1) });
		declaration.lastIndex = index;
	}
	return shapes;
}

/**
 * Find every method of an interface body.
 *
 * @param {string} body - the interface body.
 * @returns {Array<{ name: string, parameters: string, returns: string }>} the methods.
 */
export function scanMethods(body) {
	const methods = [];
	let index = 0;
	while (index < body.length) {
		const dollar = body.indexOf('$', index);
		if (dollar < 0) { break; }
		const name = /^\$([A-Za-z0-9_]+)/.exec(body.slice(dollar));
		if (!name) { index = dollar + 1; continue; }
		let cursor = dollar + name[0].length;
		while (cursor < body.length && /\s/.test(body[cursor])) { cursor += 1; }
		if (body[cursor] !== '(') { index = dollar + 1; continue; }
		// Scan to the matching closing parenthesis.
		let depth = 0;
		const parametersStart = cursor + 1;
		while (cursor < body.length) {
			if (body[cursor] === '(') { depth += 1; }
			else if (body[cursor] === ')') {
				depth -= 1;
				if (depth === 0) { break; }
			}
			cursor += 1;
		}
		const parameters = body.slice(parametersStart, cursor);
		cursor += 1;
		while (cursor < body.length && /\s/.test(body[cursor])) { cursor += 1; }
		if (body[cursor] !== ':') { index = dollar + 1; continue; }
		cursor += 1;
		// The return type runs to the next `;` at depth 0.
		let returns = '';
		let typeDepth = 0;
		while (cursor < body.length) {
			const character = body[cursor];
			if (character === '{' || character === '(' || character === '[') { typeDepth += 1; }
			else if (character === '}' || character === ')' || character === ']') { typeDepth -= 1; }
			else if (character === ';' && typeDepth <= 0) { break; }
			returns += character;
			cursor += 1;
		}
		methods.push({ name: `$${name[1]}`, parameters, returns: returns.trim() });
		index = cursor + 1;
	}
	return methods;
}

/**
 * The empty value of a return type.
 *
 * @param {string} returnType - the declared return type.
 * @returns {string} a TypeScript expression for the empty value.
 */
export function defaultFor(returnType) {
	if (!returnType) {
		return 'undefined';
	}
	let type = returnType.replace(/\s+/g, ' ').trim();
	const promise = /^Promise<([\s\S]*)>$/.exec(type);
	if (promise) {
		type = promise[1].trim();
	}
	const wrapper = /^(?:Dto|SerializableObjectWithBuffers)<([\s\S]*)>$/.exec(type);
	if (wrapper) {
		type = wrapper[1].trim();
	}
	if (/\[\]$/.test(type)) { return '[]'; }
	if (/^(void|undefined|null)$/.test(type)) { return 'undefined'; }
	if (/^number$/.test(type)) { return '0'; }
	if (/^boolean$/.test(type)) { return 'false'; }
	if (/^string$/.test(type)) { return "''"; }
	return 'undefined';
}

/**
 * Derive the two tables from the protocol source.
 *
 * @param {string} text - the protocol source.
 * @returns {{ returns: Record<string, string>, channels: Map<string, string[]>, shapes: number, methods: number }} the tables.
 */
export function derive(text) {
	const contextRe = /(\w+):\s*createProxyIdentifier<([\w]+)>\('([^']+)'\)/g;
	const contextToShape = new Map();
	let match;
	while ((match = contextRe.exec(text))) {
		contextToShape.set(match[1], match[2]);
	}

	const returns = {};
	const channels = new Map();
	let shapes = 0;
	let methods = 0;

	for (const shape of scanShapes(text)) {
		if (!shape.name.startsWith('MainThread')) { continue; }
		shapes += 1;
		let channel = null;
		for (const [context, shapeName] of contextToShape) {
			if (shapeName === shape.name) {
				channel = context;
				break;
			}
		}
		if (channel === null) { continue; }
		for (const method of scanMethods(shape.body)) {
			methods += 1;
			returns[`${channel}.${method.name}`] = defaultFor(method.returns);
			if (!channels.has(method.name)) {
				channels.set(method.name, []);
			}
			const list = channels.get(method.name);
			if (!list.includes(channel)) {
				list.push(channel);
			}
		}
	}
	return { returns, channels, shapes, methods };
}

const { returns, channels, shapes, methods } = derive(source);
const returnEntries = Object.entries(returns).sort(([a], [b]) => a.localeCompare(b));
const channelEntries = [...channels.entries()].sort(([a], [b]) => a.localeCompare(b));

const ts = `/*---------------------------------------------------------------------------------------------
 *  GENERATED by runtime/main/gen-stub-returns.mjs — do not edit by hand.
 *  Source: vendor/src/vs/workbench/api/common/extHost.protocol.ts
 *
 *  STUB_RETURNS   the type-correct EMPTY return value of every main-thread RPC method.
 *                 A stub must answer with the right SHAPE (e.g. [] for a list) or the whole
 *                 extension host crashes.
 *  METHOD_CHANNELS the channels that declare a method name. 14 names live on several channels,
 *                 so the method registry has to know which one a handler belongs to.
 *--------------------------------------------------------------------------------------------*/

export const STUB_RETURNS: Record<string, any> = {
${returnEntries.map(([key, value]) => `\t'${key}': ${value},`).join('\n')}
};

export const METHOD_CHANNELS: Record<string, string[]> = {
${channelEntries.map(([key, value]) => `\t'${key}': ${JSON.stringify(value)},`).join('\n')}
};
`;

writeFileSync(OUT, ts);
console.log(`[gen-stub-returns] parsed ${shapes} MainThread shapes, ${methods} methods, wrote ${returnEntries.length} method defaults -> ${OUT}`);
console.log(`[gen-stub-returns] ${channelEntries.length} distinct method names, ${channelEntries.filter(([, value]) => value.length > 1).length} of them on more than one channel`);
