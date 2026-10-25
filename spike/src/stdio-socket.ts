/*---------------------------------------------------------------------------------------------
 *  DSH S1 spike — adapt Node's stdio duplex streams to VS Code's `ISocket` transport contract.
 *
 *  DSH-authored glue (MIT). No Microsoft code.
 *
 *  WHY this exists:
 *  VS Code's extension host speaks its OWN binary RPC protocol (`rpcProtocol.ts` +
 *  `base/parts/ipc/common/ipc.net.ts` `PersistentProtocol`), NOT JSON-RPC 2.0.
 *  `PersistentProtocol` needs an `ISocket`; upstream only ships socket-based implementations
 *  (`base/parts/ipc/node/ipc.net.ts` -> real TCP/unix socket).
 *  This adapter lets the SAME `PersistentProtocol` run over a child's stdin/stdout pipes,
 *  which is what DSH's `ctx.subprocess` gives us.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../upstream/src/vs/base/common/buffer.js';
import { IDisposable } from '../../upstream/src/vs/base/common/lifecycle.js';
import { IMessagePassingProtocol } from '../../upstream/src/vs/base/parts/ipc/common/ipc.js';
import {
	BufferedEmitter,
	ISocket,
	PersistentProtocol,
	SocketCloseEvent,
	SocketDiagnosticsEventType
} from '../../upstream/src/vs/base/parts/ipc/common/ipc.net.js';

const DEBUG = !!process.env.DSH_SOCKET_DEBUG;

/**
 * An `ISocket` over a Node readable/writable pair.
 */
export class StdioSocket implements ISocket {

	// PATCH #2: use upstream's `BufferedEmitter` so bytes that arrive BEFORE
	// `PersistentProtocol` subscribes (i.e. before the extension host finished booting) are
	// replayed instead of dropped. A plain `Emitter` silently loses them -> the init RPCs
	// vanish and the extension host never becomes ready.
	private readonly _onData = new BufferedEmitter<VSBuffer>();
	private readonly _onClose = new BufferedEmitter<SocketCloseEvent>();
	private readonly _onEnd = new BufferedEmitter<void>();

	private readonly _readable: NodeJS.ReadableStream;
	private readonly _writable: NodeJS.WritableStream;
	private readonly _disposables: IDisposable[] = [];

	private _closed = false;

	constructor(readable: NodeJS.ReadableStream, writable: NodeJS.WritableStream) {
		this._readable = readable;
		this._writable = writable;

		this._readable.on('data', (chunk: Buffer | string) => {
			const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
			if (DEBUG) { console.error(`[stdio-socket] rx ${buf.byteLength} bytes`); }
			// VSBuffer.wrap() takes a Uint8Array (not a bare ArrayBuffer).
			this._onData.fire(VSBuffer.wrap(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)));
		});
		this._readable.on('end', () => this._onEnd.fire());
		this._readable.on('close', () => {
			if (!this._closed) {
				this._closed = true;
				this._onClose.fire({ code: 'CLOSE_NORMAL', reason: 'stdio closed', wasClean: true } as SocketCloseEvent);
			}
		});
	}

	onData(listener: (e: VSBuffer) => void): IDisposable {
		return this._onData.event(listener);
	}

	onClose(listener: (e: SocketCloseEvent) => void): IDisposable {
		return this._onClose.event(listener);
	}

	onEnd(listener: () => void): IDisposable {
		return this._onEnd.event(listener);
	}

	write(buffer: VSBuffer): void {
		if (DEBUG) { console.error(`[stdio-socket] tx ${buffer.byteLength} bytes`); }
		this._writable.write(Buffer.from(buffer.buffer));
	}

	end(): void {
		this._writable.end();
	}

	async drain(): Promise<void> {
		const w = this._writable as unknown as { writableNeedDrain?: boolean };
		if (w.writableNeedDrain) {
			await new Promise<void>(resolve => this._writable.once('drain', () => resolve()));
		}
	}

	traceSocketEvent(type: SocketDiagnosticsEventType, data?: unknown): void {
		// no-op: DSH does not collect socket diagnostics in the spike
	}

	dispose(): void {
		this._closed = true;
		for (const d of this._disposables) {
			d.dispose();
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
