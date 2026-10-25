/*---------------------------------------------------------------------------------------------
 *  DSH `dsh-vscode-protocol` — the extension-host READY handshake.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  WHY A HANDSHAKE AT ALL
 *  ----------------------
 *  The extension host registers its RPC actors inside
 *  `AbstractExtHostExtensionService._beforeAlmostReadyToRunExtensions()`, which the
 *  `ExtensionHostMain` constructor kicks off. Until that has happened, an incoming request is
 *  answered with `Unknown actor ExtHostWorkspace` and the init RPC is lost.
 *
 *  The spike worked around this by RETRYING the init RPC. A retry loop is not a handshake: it
 *  makes the first start slow when the machine is slow, it hides a real "the host never became
 *  ready" failure behind a timeout, and it can retry a request whose reply already arrived.
 *
 *  So the production host uses an explicit signal that travels OUTSIDE the protocol frames:
 *
 *    - the child writes the single line `DSH_EXTHOST_READY\n` on file descriptor 3;
 *    - if fd 3 is not available, it falls back to the same line on stderr;
 *    - the host waits for that line BEFORE it sends the first init RPC.
 *
 *  fd 3 is used because stdout is owned by the protocol frame stream: anything written there
 *  desynchronises the frame reader. stderr carries diagnostics and is therefore only a fallback.
 *--------------------------------------------------------------------------------------------*/

import { writeSync } from 'node:fs';

/** The exact line the child writes once its RPC actors are registered. */
export const READY_SIGNAL_LINE = 'DSH_EXTHOST_READY';

/** The full ready marker, including the newline terminator. */
export const READY_SIGNAL = `${READY_SIGNAL_LINE}\n`;

/** The file descriptor the child writes the ready marker to. */
export const READY_FD = 3;

/**
 * Write the ready marker to the child side's dedicated descriptor.
 *
 * @param fd - the descriptor to write to; defaults to {@link READY_FD}.
 * @returns whether the marker reached the descriptor.
 */
export function writeReadySignal(fd: number = READY_FD): boolean {
	try {
		writeSync(fd, READY_SIGNAL);
		return true;
	} catch {
		return false;
	}
}

/**
 * Write the ready marker, falling back to stderr when the dedicated descriptor is unusable.
 *
 * @param fd - the descriptor to write to; defaults to {@link READY_FD}.
 * @returns the stream the marker went to: `'fd'` or `'stderr'`.
 */
export function writeReadySignalOrStderr(fd: number = READY_FD): 'fd' | 'stderr' {
	if (writeReadySignal(fd)) {
		return 'fd';
	}
	try {
		writeSync(2, READY_SIGNAL);
		return 'stderr';
	} catch {
		return 'stderr';
	}
}

/**
 * A reader for the ready marker on the host side.
 *
 * It watches the child's dedicated descriptor when there is one and always watches stderr as
 * well, because the child may have had to fall back to stderr.
 */
export class ReadySignalReader {

	private readonly _waiters: Array<() => void> = [];
	private _ready = false;
	private _source: 'fd' | 'stderr' | 'unknown' = 'unknown';

	/** Whether the marker has been seen. */
	get ready(): boolean {
		return this._ready;
	}

	/** Which stream delivered the marker. */
	get source(): 'fd' | 'stderr' | 'unknown' {
		return this._source;
	}

	/**
	 * Resolve once the marker has been seen.
	 *
	 * @param timeoutMs - how long to wait; the promise rejects when it elapses.
	 * @returns a promise that resolves with the stream that delivered the marker.
	 */
	wait(timeoutMs: number): Promise<'fd' | 'stderr' | 'unknown'> {
		if (this._ready) {
			return Promise.resolve(this._source);
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this._waiters.splice(this._waiters.indexOf(onReady), 1);
				reject(new Error(`the extension host did not signal readiness within ${timeoutMs}ms`));
			}, timeoutMs);
			const onReady = () => {
				clearTimeout(timer);
				resolve(this._source);
			};
			this._waiters.push(onReady);
		});
	}

	/**
	 * Feed a chunk of stderr text into the reader.
	 *
	 * @param text - the stderr chunk.
	 * @returns whether this chunk carried the marker.
	 */
	consumeStderr(text: string): boolean {
		if (this._ready || !text.includes(READY_SIGNAL_LINE)) {
			return false;
		}
		this._mark('stderr');
		return true;
	}

	/**
	 * Feed a chunk of the dedicated descriptor into the reader.
	 *
	 * @param text - the chunk.
	 * @returns whether this chunk carried the marker.
	 */
	consumeFd(text: string): boolean {
		if (this._ready || !text.includes(READY_SIGNAL_LINE)) {
			return false;
		}
		this._mark('fd');
		return true;
	}

	private _mark(source: 'fd' | 'stderr'): void {
		this._ready = true;
		this._source = source;
		const waiters = this._waiters.splice(0, this._waiters.length);
		for (const waiter of waiters) {
			waiter();
		}
	}
}
