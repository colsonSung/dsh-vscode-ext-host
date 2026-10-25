/*---------------------------------------------------------------------------------------------
 *  A-class main-thread service — `fileSystem`.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  Protocol shape: `MainThreadFileSystemShape`
 *  (`vendor/src/vs/workbench/api/common/extHost.protocol.ts:2026`).
 *
 *      $stat(resource): Promise<files.IStat>
 *      $readdir(resource): Promise<[string, files.FileType][]>
 *      $readFile(resource): Promise<VSBuffer>
 *      $writeFile(resource, content: VSBuffer): Promise<void>
 *      $rename(resource, target, opts): Promise<void>
 *      $copy(resource, target, opts): Promise<void>
 *      $mkdir(resource): Promise<void>
 *      $delete(resource, opts): Promise<void>
 *      $ensureActivation(scheme): Promise<void>
 *      $registerFileSystemProvider(handle, scheme, capabilities, readonlyMessage?): Promise<void>
 *      $unregisterProvider(handle): void
 *      $onFileSystemChange(handle, resource): void
 *
 *  WHAT DSH'S `ctx.fs` CAN DO
 *  --------------------------
 *  `ctx.fs` is the abstract file system of `@deepseek-ai/dsh-fs`; the shipped provider is
 *  `@deepseek-ai/dsh-fs-local`. Its whole surface (from the generated API catalog,
 *  `dsh-tool-cordis/lib/types/api-catalog.js`):
 *
 *      watch, resolve, processPath, fileUrl, contains, stat, lstat,
 *      readText, streamText, readBytes, readByteRange, listDir,
 *      writeText, editText
 *
 *  So:
 *
 *    | VS Code method   | DSH                          | verdict                            |
 *    |------------------|------------------------------|------------------------------------|
 *    | `$stat`          | `stat`                       | implemented                        |
 *    | `$readdir`       | `listDir`                    | implemented                        |
 *    | `$readFile`      | `readBytes`                  | implemented                        |
 *    | `$writeFile`     | `writeText`                  | implemented for TEXT only           |
 *    | `$rename`        | —                            | not supported                      |
 *    | `$copy`          | —                            | not supported                      |
 *    | `$mkdir`         | —                            | not supported                      |
 *    | `$delete`        | —                            | not supported                      |
 *
 *  THE BINARY-WRITE GAP
 *  --------------------
 *  DSH's `ctx.fs` has NO binary write: `writeText(target, content: string, …)` is the only
 *  write that creates a file, and `editText` is the only one that changes one. VS Code's
 *  `workspace.fs.writeFile` takes a `VSBuffer`, so a binary write cannot be reproduced
 *  faithfully.
 *
 *  DSH therefore decodes the buffer as UTF-8 and writes the TEXT. A buffer that is NOT valid
 *  UTF-8 is a BINARY file, and the write is REFUSED with a message that names the gap: the
 *  alternative — replacing the broken bytes with U+FFFD — would hand the extension a file it
 *  never wrote, and the corruption would only surface later, far from its cause. A text file
 *  (the common case, and what every editor extension writes) round-trips byte-for-byte.
 *
 *  The upstream fix is one method on the `ctx.fs` abstraction: `writeBytes(target, bytes, …)`
 *  (`@deepseek-ai/dsh-fs` + `@deepseek-ai/dsh-fs-local`). It is out of this layer's scope.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../vendor/src/vs/base/common/buffer.js';
import type { ExtHostContext } from '../host-context.js';
import { log, notSupported, service, uriToPath, type VsUri } from './support.js';

/** `files.FileType` (`vendor/src/vs/platform/files/common/files.ts`). */
const FILE_TYPE_UNKNOWN = 0;
const FILE_TYPE_FILE = 1;
const FILE_TYPE_DIRECTORY = 2;
const FILE_TYPE_SYMBOLIC_LINK = 64;

/**
 * The handlers for one main-thread service.
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle (for client→main calls).
 * @returns a map of VS Code protocol method name to handler.
 */
export default function createFileSystemMethods(ctx: any, host: ExtHostContext): Record<string, (...args: any[]) => any> {
	/**
	 * The DSH file system service, or `undefined`.
	 *
	 * @returns the service.
	 */
	function fs(): any {
		return service(ctx, 'fs')
	}

	/**
	 * The `files.FileType` of a DSH file-system entry type.
	 *
	 * @param type - the DSH type: `file`, `directory`, `symlink` or `other`.
	 * @returns the VS Code file type.
	 */
	function fileTypeOf(type: unknown): number {
		if (type === 'file') { return FILE_TYPE_FILE }
		if (type === 'directory') { return FILE_TYPE_DIRECTORY }
		if (type === 'symlink') { return FILE_TYPE_SYMBOLIC_LINK }
		return FILE_TYPE_UNKNOWN
	}

	/**
	 * Resolve a URI into a DSH file-system target.
	 *
	 * Only the `file:` scheme has a path DSH can act on; every other scheme belongs to a
	 * file-system provider DSH does not have.
	 *
	 * @param resource - the URI components.
	 * @returns the target, or `undefined` when the URI is not a `file:` URI.
	 */
	async function targetOf(resource: VsUri): Promise<any> {
		const path = uriToPath(resource)
		if (!path) { return undefined }
		const filesystem = fs()
		if (!filesystem?.resolve) { return undefined }
		return await filesystem.resolve(path)
	}

	/**
	 * The absolute path of a DSH file-system target.
	 *
	 * @param target - the `FsTarget`.
	 * @returns the path.
	 */
	function targetPath(target: any): string {
		const filesystem = fs()
		try {
			const processPath = filesystem?.processPath?.(target)
			if (typeof processPath === 'string' && processPath.length > 0) { return processPath }
		} catch { /* fall through to the display path */ }
		return typeof target?.displayPath === 'string' ? target.displayPath : ''
	}

	return {
		/**
		 * Read the metadata of one file.
		 *
		 * @param resource - the URI.
		 * @returns the `files.IStat`.
		 */
		async '$stat'(resource: VsUri): Promise<any> {
			const filesystem = fs()
			const target = await targetOf(resource)
			if (!filesystem?.stat || !target) {
				throw new Error(`NotSupported: ${resource?.scheme ?? 'unknown'}: URIs are not readable in DeepSeek Harness`)
			}
			const info = await filesystem.stat(target)
			if (!info) {
				throw new Error(`ENOENT: ${targetPath(target)} does not exist`)
			}
			return {
				type: fileTypeOf(info.type),
				ctime: 0,
				mtime: 0,
				size: typeof info.size === 'number' ? info.size : 0,
			}
		},

		/**
		 * List one directory.
		 *
		 * @param resource - the URI.
		 * @returns the entries, as `[name, fileType]` pairs.
		 */
		async '$readdir'(resource: VsUri): Promise<Array<[string, number]>> {
			const filesystem = fs()
			const target = await targetOf(resource)
			if (!filesystem?.listDir || !target) {
				throw new Error(`NotSupported: ${resource?.scheme ?? 'unknown'}: URIs are not readable in DeepSeek Harness`)
			}
			const entries = await filesystem.listDir(target)
			return (entries ?? []).map((entry: any) => [String(entry?.name ?? ''), fileTypeOf(entry?.type)] as [string, number])
		},

		/**
		 * Read one file.
		 *
		 * The protocol answers with a `VSBuffer`; the RPC layer has a dedicated frame for a
		 * top-level `VSBuffer` reply (`rpcProtocol.ts:837-841`), so the buffer survives the
		 * wire.
		 *
		 * @param resource - the URI.
		 * @returns the file's bytes.
		 */
		async '$readFile'(resource: VsUri): Promise<any> {
			const filesystem = fs()
			const target = await targetOf(resource)
			if (!filesystem?.readBytes || !target) {
				throw new Error(`NotSupported: ${resource?.scheme ?? 'unknown'}: URIs are not readable in DeepSeek Harness`)
			}
			const bytes = await filesystem.readBytes(target, undefined, Number.MAX_SAFE_INTEGER)
			return VSBuffer.wrap(bytes)
		},

		/**
		 * Write one file.
		 *
		 * DSH's `ctx.fs` has no binary write, so the buffer is decoded as UTF-8 and written as
		 * text. A buffer that is NOT valid UTF-8 cannot be written faithfully: the bytes would
		 * be replaced by U+FFFD, and the extension would read back a file it never wrote. The
		 * write is therefore REFUSED for such a buffer, with a message that names the gap.
		 * See the module header.
		 *
		 * @param resource - the URI.
		 * @param content - the bytes.
		 */
		async '$writeFile'(resource: VsUri, content: any): Promise<void> {
			const filesystem = fs()
			const target = await targetOf(resource)
			if (!filesystem?.writeText || !target) {
				throw notSupported(`writing ${resource?.scheme ?? 'unknown'}: URIs`, 'DeepSeek Harness writes through ctx.fs.writeText')
			}
			const bytes = toBytes(content)
			const text = decodeUtf8(bytes)
			if (text === undefined) {
				throw notSupported(
					`writing the binary file ${resource?.path ?? ''}`,
					'ctx.fs has no binary write (writeText only), so a buffer that is not valid UTF-8 cannot be written faithfully',
				)
			}
			await filesystem.writeText(target, text)
		},

		/**
		 * Rename a file.
		 *
		 * DSH's `ctx.fs` has no move operation.
		 *
		 * @throws {Error} always — `NotSupported`.
		 */
		async '$rename'(): Promise<void> {
			throw notSupported('renaming a file', 'DeepSeek Harness has no move operation in ctx.fs')
		},

		/**
		 * Copy a file.
		 *
		 * @throws {Error} always — `NotSupported`.
		 */
		async '$copy'(): Promise<void> {
			throw notSupported('copying a file', 'DeepSeek Harness has no copy operation in ctx.fs')
		},

		/**
		 * Create a directory.
		 *
		 * @throws {Error} always — `NotSupported`.
		 */
		async '$mkdir'(): Promise<void> {
			throw notSupported('creating a directory', 'DeepSeek Harness has no mkdir in ctx.fs')
		},

		/**
		 * Delete a file.
		 *
		 * @throws {Error} always — `NotSupported`.
		 */
		async '$delete'(): Promise<void> {
			throw notSupported('deleting a file', 'DeepSeek Harness has no delete in ctx.fs')
		},

		/**
		 * Make sure a file-system provider is active.
		 *
		 * DSH has one provider, the `file:` scheme, and it is always active.
		 *
		 * @param scheme - the scheme.
		 */
		async '$ensureActivation'(scheme: string): Promise<void> {
			if (scheme !== 'file') {
				log(ctx, 'warn', '[dsh-vscode] a file-system provider was requested that DeepSeek Harness does not have', { scheme })
			}
		},

		/**
		 * Register a file-system provider.
		 *
		 * DSH has no custom file-system providers. The registration is accepted and dropped
		 * so that an extension's `activate()` does not fail.
		 *
		 * @param handle - the handle.
		 * @param scheme - the scheme.
		 */
		async '$registerFileSystemProvider'(handle: number, scheme: string): Promise<void> {
			host.log(`MainThreadFileSystem.$registerFileSystemProvider(${handle}, ${scheme}) — DSH has no custom file-system providers`)
		},

		/**
		 * Unregister a file-system provider.
		 *
		 * @param handle - the handle.
		 */
		'$unregisterProvider'(handle: number): void {
			// DSH has no custom file-system providers; the registration is dropped.
		},

		/**
		 * Report a change of a file-system provider's resources.
		 *
		 * DSH has no custom file-system providers, so there is nothing to report.
		 *
		 * @param handle - the handle.
		 * @param resource - the changed resources.
		 */
		'$onFileSystemChange'(handle: number, resource: unknown): void {
			// DSH has no custom file-system providers; the notification is dropped.
		},
	}
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `TextDecoder` with `fatal: true` refuses a buffer that is not valid UTF-8 instead of
 * replacing the broken bytes with U+FFFD. That is what lets `$writeFile` tell "this is a
 * text file" from "this is a binary file DSH cannot write".
 *
 * @param bytes - the bytes.
 * @returns the text, or `undefined` when the bytes are not valid UTF-8.
 */
function decodeUtf8(bytes: Uint8Array): string | undefined {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch {
		return undefined
	}
}

/**
 * Read the bytes out of whatever the protocol carried.
 *
 * The protocol answers with a `VSBuffer`; the RPC layer rebuilds it on the receiving side
 * (`rpcProtocol.ts:863`). A plain array of bytes is accepted too, because a caller that
 * builds the call by hand may pass one.
 *
 * @param content - the value.
 * @returns the bytes.
 */
function toBytes(content: any): Uint8Array {
	if (content === undefined || content === null) { return new Uint8Array(0) }
	if (content instanceof Uint8Array) { return content }
	if (typeof content?.buffer === 'object' && content.buffer instanceof Uint8Array) {
		return new Uint8Array(content.buffer.buffer, content.buffer.byteOffset, content.buffer.byteLength)
	}
	if (Array.isArray(content)) { return Uint8Array.from(content) }
	if (typeof content === 'string') { return new TextEncoder().encode(content) }
	return new Uint8Array(0)
}
