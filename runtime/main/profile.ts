/*---------------------------------------------------------------------------------------------
 *  DSH S1 production — the DSH profile contract.
 *
 *  DSH-authored (MIT).
 *
 *  THE SEAM
 *  --------
 *  The VSIX store bundle owns two files in the profile:
 *
 *      <profile>/extensions.json          the installed extensions and their `enabled` flag
 *      <profile>/extensions-trust.json    the trusted publishers
 *
 *  and one directory layout:
 *
 *      <profile>/extensions/<publisher>.<name>-<version>[-<platform>]/
 *      └── extension/                     the unpacked extension subtree
 *
 *  This module is the only place that knows that layout. The extension host itself only ever
 *  sees a resolved list, so the storage format can change without touching the host.
 *
 *  TWO GATES, BOTH MANDATORY
 *  -------------------------
 *  An extension is loaded only when it is ENABLED **and** its PUBLISHER IS TRUSTED.
 *
 *  The trust gate is the security boundary: a VSIX runs third-party Node code inside the
 *  extension host process, so "installed" must never imply "loaded". The store records the
 *  trust decision in `extensions-trust.json` (the authoritative source) and mirrors it on each
 *  record; a record that says `trusted: false` also blocks the load.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { ResolvedExtension } from './host-context.js';

/** One entry of `extensions.json`. */
export interface ExtensionRecord {
	/** `publisher.name@version`. */
	id?: string;
	/** The publisher name. */
	publisher?: string;
	/** The extension name. */
	name?: string;
	/** The extension version. */
	version?: string;
	/**
	 * The install directory.
	 *
	 * The VSIX store writes the ABSOLUTE path here. Older state files wrote the bare
	 * directory name, so both are accepted.
	 */
	directory?: string;
	/** Whether the extension is enabled. */
	enabled?: boolean;
	/** The trust flag the store mirrored onto the record. */
	trusted?: boolean;
	/** The sha256 of the original `.vsix`. */
	sha256?: string;
	/** The target platform suffix. */
	targetPlatform?: string;
	/** The extension's own `package.json`, when the store inlined it. */
	manifest?: any;
}

/** The shape of `extensions.json`. */
export interface ExtensionsJson {
	extensions?: ExtensionRecord[];
}

/** The shape of `extensions-trust.json`. */
export interface ExtensionsTrustJson {
	publishers?: Record<string, boolean>;
}

/** Why an extension was not loaded. */
export interface SkippedExtension {
	/** The record id. */
	readonly id: string;
	/** The reason it was skipped. */
	readonly reason: 'disabled' | 'untrusted-publisher' | 'missing-manifest' | 'unknown-publisher';
	/** A human readable explanation. */
	readonly detail: string;
}

/** The outcome of resolving the profile's extension list. */
export interface ResolvedProfile {
	/** The extensions the host may load. */
	readonly loaded: ResolvedExtension[];
	/** The extensions the host refuses to load, and why. */
	readonly skipped: SkippedExtension[];
}

/**
 * Read `extensions.json`.
 *
 * @param profileDir - the profile directory.
 * @returns the records, or an empty list when the file is absent or broken.
 */
export function readExtensionsJson(profileDir: string): ExtensionRecord[] {
	const path = join(profileDir, 'extensions.json');
	if (!existsSync(path)) {
		return [];
	}
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as ExtensionsJson;
		return Array.isArray(parsed?.extensions) ? parsed.extensions : [];
	} catch {
		return [];
	}
}

/**
 * Read `extensions-trust.json`.
 *
 * @param profileDir - the profile directory.
 * @returns the trusted publishers, or an empty map when the file is absent or broken.
 */
export function readTrustJson(profileDir: string): Record<string, boolean> {
	const path = join(profileDir, 'extensions-trust.json');
	if (!existsSync(path)) {
		return {};
	}
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as ExtensionsTrustJson;
		const publishers = parsed?.publishers;
		if (publishers === undefined || publishers === null || typeof publishers !== 'object') {
			return {};
		}
		return { ...publishers };
	} catch {
		return {};
	}
}

/**
 * Resolve the absolute path of an extension's `extension/` subtree.
 *
 * @param profileDir - the profile directory.
 * @param record - the extension record.
 * @returns the absolute path.
 */
export function resolveExtensionPath(profileDir: string, record: ExtensionRecord): string {
	const directory = typeof record.directory === 'string' ? record.directory : '';
	if (directory.length === 0) {
		return join(profileDir, 'extensions', '', 'extension');
	}
	const absolute = resolve(directory);
	// The store writes an absolute path; older state files wrote the bare directory name.
	const base = absolute.startsWith('/') || /^[A-Za-z]:[\\/]/.test(absolute)
		? absolute
		: join(profileDir, 'extensions', absolute);
	return join(base, 'extension');
}

/**
 * Resolve the extensions the host may load.
 *
 * @param profileDir - the profile directory.
 * @returns the loaded extensions and the skipped ones with their reasons.
 */
export function resolveProfileExtensions(profileDir: string): ResolvedProfile {
	const records = readExtensionsJson(profileDir);
	const trust = readTrustJson(profileDir);

	const loaded: ResolvedExtension[] = [];
	const skipped: SkippedExtension[] = [];

	for (const record of records) {
		const publisher = typeof record.publisher === 'string' ? record.publisher : '';
		const name = typeof record.name === 'string' ? record.name : '';
		const version = typeof record.version === 'string' ? record.version : '';
		const id = typeof record.id === 'string' && record.id.length > 0
			? record.id
			: `${publisher}.${name}@${version}`;

		if (record.enabled === false) {
			skipped.push({ id, reason: 'disabled', detail: 'the extension is disabled in extensions.json' });
			continue;
		}
		if (publisher.length === 0) {
			skipped.push({ id, reason: 'unknown-publisher', detail: 'the record carries no publisher' });
			continue;
		}
		// The trust file is authoritative; a record that says `trusted: false` also blocks.
		const trustedByFile = trust[publisher] === true;
		const trustedByRecord = record.trusted !== false;
		if (!trustedByFile || !trustedByRecord) {
			skipped.push({
				id,
				reason: 'untrusted-publisher',
				detail: `the publisher "${publisher}" is not trusted, so the extension host will not load this extension`,
			});
			continue;
		}

		const extensionPath = resolveExtensionPath(profileDir, record);
		const manifestPath = join(extensionPath, 'package.json');
		if (!existsSync(manifestPath)) {
			skipped.push({
				id,
				reason: 'missing-manifest',
				detail: `there is no package.json at ${manifestPath}`,
			});
			continue;
		}

		let manifest: any;
		try {
			manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
		} catch (error) {
			skipped.push({
				id,
				reason: 'missing-manifest',
				detail: `the manifest at ${manifestPath} is not valid JSON: ${(error as Error).message}`,
			});
			continue;
		}

		loaded.push({
			id,
			extensionId: `${publisher}.${name}`,
			publisher,
			name,
			version,
			directory: typeof record.directory === 'string' ? record.directory : '',
			enabled: true,
			extensionPath,
			manifest,
			sha256: record.sha256,
			targetPlatform: record.targetPlatform,
		});
	}

	return { loaded, skipped };
}
