/*---------------------------------------------------------------------------------------------
 *  DSH S1 production — the extension host CHILD PROCESS entry point.
 *
 *  DSH-authored glue (MIT). No Microsoft code: the extension host itself is the vendored
 *  upstream tree under `vscode-ext-host/vendor/src/vs/**`, compiled into this file by esbuild.
 *
 *  The shape follows upstream's `src/vs/workbench/api/node/extensionHostProcess.ts`, with two
 *  deliberate differences:
 *
 *  1. The transport is the child's stdio instead of a socket.
 *  2. The init data arrives through the environment instead of the first protocol message.
 *     The protocol channel carries BINARY frames; dropping a raw JSON document into it would
 *     desynchronise the frame reader and silently lose every later message.
 *
 *  Two disciplines are non-negotiable here:
 *
 *  - **stdout belongs to the protocol.** A single `console.log` from the extension host, or
 *    from an extension before the console forwarder takes over, desynchronises the frame
 *    reader and every later RPC is silently dropped. Everything else goes to stderr.
 *  - **the ready signal is not a protocol message.** It travels on file descriptor 3, because
 *    the host must know that the RPC actors are registered before it sends the init RPC.
 *--------------------------------------------------------------------------------------------*/

import { writeSync } from 'node:fs';

import { ExtensionHostMain } from '../../vendor/src/vs/workbench/api/common/extensionHostMain.js';
import type { IHostUtils } from '../../vendor/src/vs/workbench/api/common/extHostExtensionService.js';
import type { IExtensionHostInitData } from '../../vendor/src/vs/workbench/services/extensions/common/extensionHostProtocol.js';

import {
	StdioSocket,
	writeReadySignalOrStderr,
} from '../../packages/dsh-vscode-protocol/src/index.js';

// Side-effect imports: register the extension host's service singletons.
import '../../vendor/src/vs/workbench/api/common/extHost.common.services.js';
import '../../vendor/src/vs/workbench/api/node/extHost.node.services.js';

/** The environment variable the host hands the init payload to the child in. */
export const INIT_DATA_ENV = 'DSH_EXTHOST_INIT_DATA';

/**
 * Read the init payload the host put into the environment.
 *
 * @returns the payload.
 */
function readInitData(): IExtensionHostInitData {
	const raw = process.env[INIT_DATA_ENV];
	if (!raw) {
		throw new Error(`${INIT_DATA_ENV} is missing; the extension host was started without an init payload`);
	}
	return JSON.parse(raw) as IExtensionHostInitData;
}

/**
 * Run the extension host.
 */
async function main(): Promise<void> {
	const initData = readInitData();

	// The protocol OWNS stdout.
	//
	// The upstream extension host talks over a dedicated socket, where stdout is an ordinary
	// log stream. Over stdio the stdout IS the frame stream, so every stray write — from the
	// extension host, from an extension, from `console.log` before the console forwarder is
	// installed — would desynchronise the reader. The symptom is silent: the init RPC never
	// returns and nothing is logged.
	//
	// The original writer is captured FIRST and used for the protocol frames.
	const rawStdoutWrite = process.stdout.write.bind(process.stdout);
	(process.stdout as unknown as { write: unknown }).write = function (
		chunk: unknown, encoding?: unknown, callback?: unknown,
	): boolean {
		return (process.stderr as unknown as { write: unknown }).write(chunk, encoding, callback) as boolean;
	};

	const socket = new StdioSocket(process.stdin, { write: rawStdoutWrite } as unknown as NodeJS.WritableStream);

	const hostUtils = new class NodeHost implements IHostUtils {
		declare readonly _serviceBrand: undefined;
		public readonly pid = process.pid;
		exit(code: number): void { process.exit(code); }
		async fsExists(path: string): Promise<boolean> {
			const { existsSync } = await import('node:fs');
			return existsSync(path);
		}
		async fsRealpath(path: string): Promise<string> {
			const { realpathSync } = await import('node:fs');
			return realpathSync(path);
		}
	};

	writeSync(2, `[dsh-exthost] pid=${process.pid} node=${process.version} argv=${JSON.stringify(process.argv)}\n`);

	// The constructor registers every RPC actor synchronously: `initialize()` runs the body of
	// `_beforeAlmostReadyToRunExtensions()` up to its first `await`, and
	// `createApiFactoryAndRegisterActors()` is called before that await. When this constructor
	// returns, `ExtHostWorkspace`, `ExtHostConfiguration`, `ExtHostTelemetry`,
	// `ExtHostMeteredConnection` and `ExtHostExtensionService` are all addressable.
	const extensionHostMain = new ExtensionHostMain(socket.createMessagePassingProtocol(), initData, hostUtils, null);

	// THE READY HANDSHAKE. It travels outside the protocol frames, on fd 3.
	const source = writeReadySignalOrStderr();
	writeSync(2, `[dsh-exthost] ready (via ${source})\n`);

	const shutdown = (reason: string) => {
		try {
			extensionHostMain.terminate(reason);
		} catch {
			// The host is going away anyway.
		}
	};
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
	writeSync(2, `[dsh-exthost] fatal: ${(error as Error)?.stack ?? String(error)}\n`);
	process.exit(81 /* ExtensionHostExitCode.UnexpectedError */);
});
