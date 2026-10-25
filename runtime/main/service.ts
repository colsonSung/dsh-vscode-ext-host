/*---------------------------------------------------------------------------------------------
 *  DSH S1 production — the extension host's DSH-side service.
 *
 *  DSH-authored (MIT).
 *
 *  This is the object the bundle hands to the HTTP route and to the model tool. It owns the
 *  `ExtensionHostService` (the process) and turns it into the shape the Extensions page and
 *  the model read.
 *
 *  THE CONTRACT (fixed — the Extensions page depends on it)
 *  -------------------------------------------------------
 *      status -> { ok: true, host: { running, pid?, startedAt?, restarts, lastError?, reason? },
 *                   extensions: [{ id, publisher, name, version, active, activatedAt?, error? }] }
 *      start  -> { ok: true, host: {...} }
 *      stop   -> { ok: true, host: {...} }
 *      restart-> { ok: true, host: {...} }
 *      log    -> { ok: true, lines: string[] }
 *
 *  `extensions[].id` is `publisher.name@version`, the same shape the VSIX store writes into
 *  `extensions.json`.
 *--------------------------------------------------------------------------------------------*/

import { fileURLToPath } from 'node:url';

import { ExtensionHostService, type ExtensionHostState } from './main-host.js';
import type { LoadedExtension } from './host-context.js';

/** The host block of the status payload. */
export interface HostStatusPayload {
	running: boolean;
	pid?: number;
	startedAt?: string;
	restarts: number;
	lastError?: string;
	reason?: string;
}

/** The status payload the Extensions page reads. */
export interface StatusPayload {
	host: HostStatusPayload;
	extensions: LoadedExtension[];
}

/**
 * The extension host's DSH-side service.
 */
export class ExtensionHostRuntime {

	private readonly _ctx: any;
	private readonly _host: ExtensionHostService;
	private _startPromise: Promise<void> | undefined;

	/**
	 * @param ctx - the DSH Host plugin context.
	 * @param options - the optional overrides.
	 */
	constructor(ctx: any, options: { childScript?: string; nodeCommand?: string } = {}) {
		this._ctx = ctx;
		const profileDir = ctx?.profileContext?.dir;
		if (typeof profileDir !== 'string' || profileDir.length === 0) {
			throw new Error('dsh-vscode-extension-host: the current profile has no directory');
		}
		this._host = new ExtensionHostService({
			ctx,
			profileDir,
			childScript: options.childScript ?? defaultChildScript(),
			nodeCommand: options.nodeCommand,
		});
	}

	/**
	 * Start the host, at most once per concurrent call.
	 *
	 * @returns the lifecycle snapshot.
	 */
	async start(): Promise<HostStatusPayload> {
		if (this._host.status().running) {
			return this._host.status() as HostStatusPayload;
		}
		if (this._startPromise === undefined) {
			this._startPromise = this._host.start()
				.catch((error) => {
					this._host.log.write(`ERROR the extension host could not be started: ${error instanceof Error ? error.message : String(error)}`);
				})
				.finally(() => {
					this._startPromise = undefined;
				});
		}
		await this._startPromise;
		return this._host.status() as HostStatusPayload;
	}

	/**
	 * Stop the host.
	 *
	 * @returns the lifecycle snapshot.
	 */
	async stop(): Promise<HostStatusPayload> {
		return await this._host.stop() as HostStatusPayload;
	}

	/**
	 * Restart the host.
	 *
	 * @returns the lifecycle snapshot.
	 */
	async restart(): Promise<HostStatusPayload> {
		return await this._host.restart() as HostStatusPayload;
	}

	/**
	 * The lifecycle snapshot.
	 *
	 * @returns the snapshot.
	 */
	status(): HostStatusPayload {
		return this._host.status() as HostStatusPayload;
	}

	/**
	 * The status payload the Extensions page reads.
	 *
	 * @returns the payload.
	 */
	payload(): StatusPayload {
		return {
			host: this._host.status() as HostStatusPayload,
			extensions: this._host.loadedExtensions(),
		};
	}

	/**
	 * The tail of the host log.
	 *
	 * @param lines - how many lines.
	 * @returns the lines.
	 */
	/**
	 * Write one line into the extension host's log.
	 * @param message - the line.
	 */
	log(message: string): void {
		this._host.log.write(message);
	}

	logLines(lines: number): string[] {
		return this._host.logLines(lines);
	}

	/**
	 * The commands the loaded extensions registered.
	 *
	 * @returns the command ids.
	 */
	registeredCommands(): string[] {
		return this._host.registeredCommands();
	}

	/**
	 * The extensions the host refused to load, and why.
	 *
	 * @returns the list.
	 */
	skippedExtensions(): Array<{ id: string; reason: string; detail: string }> {
		return this._host.skippedExtensions();
	}

	/**
	 * Tell the extension host which colour scheme DSH's interface is showing.
	 *
	 * The extension host's theming starts on Dark, so an extension that follows the
	 * editor's theme (draw.io picks its light theme from `vscode.window.activeColorTheme`)
	 * renders as if the user had chosen dark.
	 *
	 * @param scheme - `light` or `dark`.
	 * @returns true when the scheme was accepted.
	 */
	setColorScheme(scheme: string): boolean {
		return this._host.setColorScheme(scheme);
	}

	/**
	 * Release the host.
	 *
	 * @returns a promise that settles when the child is gone.
	 */
	dispose(): Promise<void> {
		return this._host.dispose();
	}
}

/**
 * The default path of the child bundle.
 *
 * The main side sits at the bundle root and the child one directory below it, in `dist/`.
 * `import.meta.url` resolves the real path even when the bundle is installed through a
 * symlink.
 *
 * @returns the absolute path.
 */
function defaultChildScript(): string {
	return fileURLToPath(new URL('./dist/extension-host.js', import.meta.url));
}
