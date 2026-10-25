/*---------------------------------------------------------------------------------------------
 *  A-class main-thread service — `workspace`.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  Protocol shape: `MainThreadWorkspaceShape`
 *  (`vendor/src/vs/workbench/api/common/extHost.protocol.ts:1998`).
 *
 *  WHAT DSH HAS AND WHAT IT DOES NOT
 *  ---------------------------------
 *  DSH has NO workspace folders. The init payload says so explicitly:
 *  `workspace: { id, name, transient: false, configuration: null, isUntitled: false }` and
 *  `$initializeWorkspace` is sent with `folders: []`
 *  (`runtime/main/main-host.ts`, `_sendInitRpcs`). So `vscode.workspace.workspaceFolders` is
 *  an empty array inside the extension, and every method that operates ON a folder has
 *  nothing to operate on.
 *
 *  What DSH DOES have is a file system (`ctx.fs`), so the two methods that only need a path
 *  are implemented for real:
 *
 *    - `$startFileSearch` — a bounded, recursive glob search over `ctx.fs`;
 *    - `$checkExists`     — a real existence check over `ctx.fs`.
 *
 *  The rest answer with the type-correct empty value. Two of them are worth calling out:
 *
 *    - `$requestWorkspaceTrust` / `$requestResourceTrust` / `$isResourceTrusted` answer
 *      `false`: DSH has NO workspace-trust model. The trust DSH does have is PROFILE level
 *      (`extensions-trust.json`, which decides whether an extension loads at all). A
 *      "not trusted" answer is the safe failure mode, and it is the same answer the
 *      generated stub already gives — the spike measured that extensions activate fine
 *      with it.
 *    - `$resolveEncoding` / `$resolveDecoding` / `$validateDetectedEncoding` answer with
 *      UTF-8, because the generated stub answers `undefined` for two of them and the
 *      protocol types them as objects and strings.
 *--------------------------------------------------------------------------------------------*/

import type { ExtHostContext } from '../host-context.js';
import { log, pathToUri, service, uriToPath, type VsUri } from './support.js';

/** The number of directory entries a single search visits before it gives up. */
const SEARCH_ENTRY_BUDGET = 20_000;

/** The number of directories a single search descends into before it gives up. */
const SEARCH_DEPTH_BUDGET = 24;

/**
 * The handlers for one main-thread service.
 * @param ctx - the DSH Host plugin context.
 * @param host - the extension host handle (for client→main calls).
 * @returns a map of VS Code protocol method name to handler.
 */
export default function createWorkspaceMethods(ctx: any, host: ExtHostContext): Record<string, (...args: any[]) => any> {
	/**
	 * The DSH file system service, or `undefined`.
	 *
	 * @returns the service.
	 */
	function fs(): any {
		return service(ctx, 'fs')
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

	/**
	 * Turn a glob into a regular expression.
	 *
	 * VS Code's search patterns are globs with `**`, `*`, `?` and `{a,b}`. DSH needs the
	 * matching only, so the conversion is deliberately small:
	 *
	 *   `**` → `.*`   (across directory separators)
	 *   `*`  → `[^/]*`
	 *   `?`  → `.`
	 *   `{a,b}` → `(a|b)`
	 *
	 * @param glob - the glob.
	 * @returns the regular expression source.
	 */
	function globToRegExpSource(glob: string): string {
		let source = ''
		for (let index = 0; index < glob.length; index++) {
			const char = glob[index]
			if (char === '*') {
				if (glob[index + 1] === '*') {
					source += '.*'
					index++
					if (glob[index + 1] === '/') { index++ }
				} else {
					source += '[^/]*'
				}
				continue
			}
			if (char === '?') { source += '.'; continue }
			if (char === '{') {
				const close = glob.indexOf('}', index)
				if (close > index) {
					const alternatives = glob.slice(index + 1, close).split(',')
					source += `(?:${alternatives.map((entry) => entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`
					index = close
					continue
				}
			}
			source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		}
		return source
	}

	/**
	 * Build a matcher for a glob.
	 *
	 * @param glob - the glob.
	 * @returns a predicate.
	 */
	function globMatcher(glob: string): (value: string) => boolean {
		try {
			const regexp = new RegExp(globToRegExpSource(glob))
			return (value: string) => regexp.test(value)
		} catch {
			return () => false
		}
	}

	return {
		/**
		 * Search for files.
		 *
		 * The search is a bounded recursive walk over `ctx.fs`:
		 *   - the folder comes from `includeFolder`; DSH has no workspace folder, so a
		 *     missing folder means "nothing to search" and the answer is `null`;
		 *   - the pattern comes from `options.filePattern` (a glob over the file NAME);
		 *   - `options.excludePattern` holds globs over the RELATIVE path;
		 *   - `options.maxResults` caps the answer;
		 *   - `options.exists` asks whether ONE exact path exists instead of a glob search.
		 *
		 * @param includeFolder - the folder to search in.
		 * @param options - the query.
		 * @param token - the cancellation token.
		 * @returns the matching URIs, or `null` when there is nothing to search.
		 */
		async '$startFileSearch'(includeFolder: VsUri | null, options: any, token?: any): Promise<any[] | null> {
			const folderPath = uriToPath(includeFolder ?? undefined)
			if (!folderPath) { return null }
			const filesystem = fs()
			if (!filesystem?.listDir) { return null }

			const limit = typeof options?.maxResults === 'number' && options.maxResults > 0 ? options.maxResults : 1000
			const excludes: Array<(value: string) => boolean> = []
			for (const exclude of options?.excludePattern ?? []) {
				const pattern = typeof exclude?.pattern === 'string' ? exclude.pattern : undefined
				if (pattern) { excludes.push(globMatcher(pattern)) }
			}
			const filePattern = typeof options?.filePattern === 'string' ? options.filePattern : undefined
			const matchName = filePattern ? globMatcher(filePattern) : undefined

			const found: any[] = []
			let budget = SEARCH_ENTRY_BUDGET
			let aborted = false

			/**
			 * Walk one directory.
			 *
			 * @param directory - the absolute path.
			 * @param relative - the path relative to the search root.
			 * @param depth - the current depth.
			 */
			const walk = async (directory: string, relative: string, depth: number): Promise<void> => {
				if (aborted || found.length >= limit || budget <= 0 || depth > SEARCH_DEPTH_BUDGET) { return }
				let target: any
				try {
					target = await filesystem.resolve(directory)
				} catch {
					return
				}
				let entries: any[] = []
				try {
					entries = await filesystem.listDir(target)
				} catch {
					return
				}
				for (const entry of entries ?? []) {
					if (aborted || found.length >= limit || budget <= 0) { return }
					budget--
					const childRelative = relative ? `${relative}/${entry.name}` : entry.name
					if (excludes.some((exclude) => exclude(childRelative))) { continue }
					if (entry.type === 'directory') {
						const childPath = joinPath(directory, entry.name)
						await walk(childPath, childRelative, depth + 1)
						continue
					}
					if (matchName && !matchName(entry.name)) { continue }
					found.push(pathToUri(targetPath(entry.target) || joinPath(directory, entry.name)))
				}
			}

			// `options.exists` asks about one exact path rather than a glob.
			if (options?.exists === true && filePattern) {
				const exact = joinPath(folderPath, filePattern)
				try {
					const target = await filesystem.resolve(exact)
					const info = await filesystem.stat(target)
					return info ? [pathToUri(exact)] : []
				} catch {
					return []
				}
			}

			await walk(folderPath, '', 0)
			if (aborted) { return null }
			return found
		},

		/**
		 * Search text.
		 *
		 * DSH has no text search. The protocol allows `null` for "no results", which is the
		 * type-correct empty value.
		 *
		 * @returns `null`.
		 */
		async '$startTextSearch'(): Promise<null> {
			return null
		},

		/**
		 * Check whether a set of paths exists.
		 *
		 * @param folders - the folders to look in.
		 * @param includes - the relative paths.
		 * @returns whether ALL of them exist.
		 */
		async '$checkExists'(folders: ReadonlyArray<VsUri>, includes: readonly string[]): Promise<boolean> {
			const filesystem = fs()
			if (!filesystem?.stat) { return false }
			for (const folder of folders ?? []) {
				const base = uriToPath(folder)
				if (!base) { return false }
				for (const include of includes ?? []) {
					try {
						const target = await filesystem.resolve(joinPath(base, include))
						const info = await filesystem.stat(target)
						if (!info) { return false }
					} catch {
						return false
					}
				}
			}
			return true
		},

		/**
		 * Save a document.
		 *
		 * DSH has no document model, so there is nothing to save. The protocol's empty value
		 * for `Promise<UriComponents | undefined>` is `undefined`.
		 *
		 * @returns `undefined`.
		 */
		async '$save'(): Promise<undefined> {
			return undefined
		},

		/**
		 * Save every document.
		 *
		 * @returns `false` — nothing was saved.
		 */
		async '$saveAll'(): Promise<boolean> {
			return false
		},

		/**
		 * Change the workspace folders.
		 *
		 * DSH has no workspace folders; the request is accepted and dropped.
		 */
		async '$updateWorkspaceFolders'(extensionName: string, index: number, deleteCount: number, foldersToAdd: unknown): Promise<void> {
			host.log(
				`MainThreadWorkspace.$updateWorkspaceFolders(${extensionName}) is ignored: ` +
				'DeepSeek Harness has no workspace folders',
			)
		},

		/**
		 * Resolve a proxy for a URL.
		 *
		 * DSH has no proxy resolver.
		 *
		 * @returns `undefined`.
		 */
		async '$resolveProxy'(): Promise<undefined> {
			return undefined
		},

		/**
		 * Look up credentials for a URL.
		 *
		 * DSH's credentials are DSH credentials, not HTTP credentials.
		 *
		 * @returns `undefined`.
		 */
		async '$lookupAuthorization'(): Promise<undefined> {
			return undefined
		},

		/**
		 * Look up a Kerberos ticket.
		 *
		 * @returns `undefined`.
		 */
		async '$lookupKerberosAuthorization'(): Promise<undefined> {
			return undefined
		},

		/**
		 * Load the trusted certificates.
		 *
		 * @returns an empty list.
		 */
		async '$loadCertificates'(): Promise<string[]> {
			return []
		},

		/**
		 * Ask whether a resource may be trusted.
		 *
		 * DSH has no workspace-trust model, so the answer is "not trusted" — the safe
		 * failure mode, and the same answer the generated stub gives.
		 *
		 * @returns `false`.
		 */
		async '$requestResourceTrust'(): Promise<boolean> {
			return false
		},

		/**
		 * Ask whether the workspace may be trusted.
		 *
		 * @returns `false`.
		 */
		async '$requestWorkspaceTrust'(): Promise<boolean> {
			return false
		},

		/**
		 * Report whether a resource is trusted.
		 *
		 * @returns `false`.
		 */
		async '$isResourceTrusted'(): Promise<boolean> {
			return false
		},

		/**
		 * Register an edit-session identity provider.
		 *
		 * DSH has no edit sessions.
		 */
		'$registerEditSessionIdentityProvider'(): void {
			// DSH has no edit sessions; the registration is dropped.
		},

		/**
		 * Unregister an edit-session identity provider.
		 */
		'$unregisterEditSessionIdentityProvider'(): void {
			// DSH has no edit sessions; the registration is dropped.
		},

		/**
		 * Register a canonical URI provider.
		 *
		 * DSH has no canonical URI providers.
		 */
		'$registerCanonicalUriProvider'(): void {
			// DSH has no canonical URI providers; the registration is dropped.
		},

		/**
		 * Unregister a canonical URI provider.
		 */
		'$unregisterCanonicalUriProvider'(): void {
			// DSH has no canonical URI providers; the registration is dropped.
		},

		/**
		 * Resolve the decoding of a resource.
		 *
		 * DSH reads and writes UTF-8 only.
		 *
		 * @returns the UTF-8 answer.
		 */
		async '$resolveDecoding'(): Promise<{ preferredEncoding: string; guessEncoding: boolean; candidateGuessEncodings: string[] }> {
			return { preferredEncoding: 'utf8', guessEncoding: false, candidateGuessEncodings: ['utf8'] }
		},

		/**
		 * Resolve the encoding of a resource.
		 *
		 * @returns the UTF-8 answer.
		 */
		async '$resolveEncoding'(): Promise<{ encoding: string; addBOM: boolean }> {
			return { encoding: 'utf8', addBOM: false }
		},

		/**
		 * Validate a detected encoding.
		 *
		 * @returns `utf8`.
		 */
		async '$validateDetectedEncoding'(): Promise<string> {
			return 'utf8'
		},
	}
}

/**
 * Join two path segments with a forward slash.
 *
 * The extension host works with POSIX-style paths inside a URI, and DSH's file system takes
 * absolute paths. A plain join keeps the two apart without pulling a path library in.
 *
 * @param base - the base path.
 * @param child - the child segment.
 * @returns the joined path.
 */
function joinPath(base: string, child: string): string {
	if (!base) { return child }
	if (base.endsWith('/')) { return `${base}${child}` }
	return `${base}/${child}`
}
