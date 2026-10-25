/*---------------------------------------------------------------------------------------------
 *  DSH `dsh-vscode-protocol` — Node stdio adapted to VS Code's `ISocket` transport contract.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  WHY
 *  ---
 *  `PersistentProtocol` (the vendored extension-host transport) needs an `ISocket`. Upstream only
 *  ships socket-based implementations (`base/parts/ipc/node/ipc.net.ts` -> a real TCP / unix
 *  socket). DSH runs the extension host as a CHILD PROCESS and talks to it over its stdin and
 *  stdout, so this adapter puts the SAME `PersistentProtocol` on top of a pipe pair.
 *
 *  The one subtlety worth keeping: the emitter is upstream's `BufferedEmitter`, not a plain
 *  `Emitter`. A plain `Emitter` silently DROPS bytes that arrive before somebody subscribes,
 *  and the extension host starts talking as soon as it boots — those bytes are exactly the init
 *  RPCs. With the buffered emitter they are replayed instead of lost.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../vendor/src/vs/base/common/buffer.js';
import type { IDisposable } from '../../../../vendor/src/vs/base/common/lifecycle.js';
import type { IMessagePassingProtocol } from '../../../../vendor/src/vs/base/parts/ipc/common/ipc.js';
import {
	BufferedEmitter,
	PersistentProtocol,
} from '../../../../vendor/src/vs/base/parts/ipc/common/ipc.net.js';
import type { ISocket, SocketCloseEvent } from '../../../../vendor/src/vs/base/parts/ipc/common/ipc.net.js';

/** Set `DSH_SOCKET_DEBUG=1` to trace every frame boundary on stderr. */
const DEBUG = process.env.DSH_SOCKET_DEBUG === '1' || process.env.DSH_SOCKET_DEBUG === 'true';

/**
 * An `ISocket` over a Node readable/writable pair.
 */
export class StdioSocket implements ISocket {

	private readonly _onData = new BufferedEmitter<VSBuffer>();
	private readonly _onClose = new BufferedEmitter<SocketCloseEvent>();
	private readonly _onEnd = new BufferedEmitter<void>();

	private readonly _readable: NodeJS.ReadableStream;
	private readonly _writable: NodeJS.WritableStream;
	private readonly _disposables: IDisposable[] = [];

	private _closed = false;

	/**
	 * @param readable - the stream the peer frames arrive on (the child's stdout on the host
	 * side, `process.stdin` on the child side).
	 * @param writable - the stream the peer frames are written to (the child's stdin on the host
	 * side, the ORIGINAL `process.stdout` on the child side — see the note in `ext-host-main`).
	 */
	constructor(readable: NodeJS.ReadableStream, writable: NodeJS.WritableStream) {
		this._readable = readable;
		this._writable = writable;

		this._readable.on('data', (chunk: Buffer | string) => {
			const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
			if (DEBUG) {
				process.stderr.write(`[stdio-socket] rx ${buffer.byteLength} bytes\n`);
			}
			// `VSBuffer.wrap()` takes a Uint8Array, not a bare ArrayBuffer.
			this._onData.fire(VSBuffer.wrap(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)));
		});
		this._readable.on('end', () => this._onEnd.fire());
		this._readable.on('close', () => {
			if (!this._closed) {
				this._closed = true;
				this._onClose.fire({ code: 'CLOSE_NORMAL', reason: 'stdio closed', wasClean: true } as SocketCloseEvent);
			}
		});
	}

	/** Subscribe to incoming frames. */
	onData(listener: (e: VSBuffer) => void): IDisposable {
		return this._onData.event(listener);
	}

	/** Subscribe to the close event. */
	onClose(listener: (e: SocketCloseEvent) => void): IDisposable {
		return this._onClose.event(listener);
	}

	/** Subscribe to the end event. */
	onEnd(listener: () => void): IDisposable {
		return this._onEnd.event(listener);
	}

	/** Write one frame. */
	write(buffer: VSBuffer): void {
		if (DEBUG) {
			process.stderr.write(`[stdio-socket] tx ${buffer.byteLength} bytes\n`);
		}
		this._writable.write(Buffer.from(buffer.buffer));
	}

	/** Close the write side. */
	end(): void {
		this._writable.end();
	}

	/** Wait until the write side has room again. */
	async drain(): Promise<void> {
		const writable = this._writable as unknown as { writableNeedDrain?: boolean };
		if (writable.writableNeedDrain) {
			await new Promise<void>((resolve) => this._writable.once('drain', () => resolve()));
		}
	}

	/** Upstream collects socket diagnostics; DSH does not. */
	traceSocketEvent(): void {
		// no-op
	}

	/** Release the socket. */
	dispose(): void {
		this._closed = true;
		for (const disposable of this._disposables) {
			disposable.dispose();
		}
		this._onData.dispose();
		this._onClose.dispose();
		this._onEnd.dispose();
	}

	/**
	 * Wrap this socket in upstream's `PersistentProtocol`, which implements
	 * `IMessagePassingProtocol` — the exact type `RPCProtocol` and `ExtensionHostMain` want.
	 */
	createMessagePassingProtocol(): IMessagePassingProtocol {
		const protocol = new PersistentProtocol({ socket: this, sendKeepAlive: false });
		protocol.sendResume();
		return protocol;
	}
}
