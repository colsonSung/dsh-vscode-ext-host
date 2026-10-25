/*---------------------------------------------------------------------------------------------
 *  DSH S1 spike — extension host child-process entry point.
 *
 *  This file is DSH-authored glue (MIT). It contains NO Microsoft code.
 *  The Microsoft extension host itself is vendored verbatim under `upstream/src/vs/**`.
 *
 *  Shape follows `src/vs/workbench/api/node/extensionHostProcess.ts` (upstream) but replaces
 *  the IPC/socket transport with a stdio transport so the host can live in a plain Node process.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionHostMain } from '../../upstream/src/vs/workbench/api/common/extensionHostMain.js';
import { IHostUtils } from '../../upstream/src/vs/workbench/api/common/extHostExtensionService.js';
import { IExtensionHostInitData } from '../../upstream/src/vs/workbench/services/extensions/common/extensionHostProtocol.js';

import { StdioSocket } from './stdio-socket.js';

// side-effect imports: register the ext host service singletons
import '../../upstream/src/vs/workbench/api/common/extHost.common.services.js';
import '../../upstream/src/vs/workbench/api/node/extHost.node.services.js';

/**
 * [FINDING] Upstream passes the init data as the FIRST protocol message (see
 * `extensionHostProcess.ts` -> `connectToRenderer`), not via env / argv. We keep the same
 * "first message" contract so the shape stays compatible with upstream, but accept it from
 * an env var for simplicity of the DSH launcher (the DSH launcher is the only producer).
 */
function readInitData(): IExtensionHostInitData {
	const raw = process.env.DSH_EXTHOST_INIT_DATA;
	if (!raw) {
		throw new Error('DSH_EXTHOST_INIT_DATA env var is missing');
	}
	return JSON.parse(raw) as IExtensionHostInitData;
}

async function main(): Promise<void> {
	const initData = readInitData();

	// PATCH #4: the protocol OWNS stdout.
	//
	// VS Code's extension host protocol is a BINARY frame stream, not newline-delimited
	// JSON. Any stray `console.log` / `process.stdout.write` from the extension host (or from
	// the extension itself, before `ExtHostConsoleForwarder` takes over) corrupts the frame
	// stream: the reader desynchronises and every subsequent RPC message is silently dropped.
	//
	// Upstream avoids this because the ext host talks over a dedicated socket. For a stdio
	// transport we must reserve fd 1 for the protocol and move everything else to fd 2.
	const rawStdoutWrite = process.stdout.write.bind(process.stdout);
	(process.stdout as unknown as { write: unknown }).write = function (
		chunk: unknown, enc?: unknown, cb?: unknown
	) {
		return (process.stderr as unknown as { write: unknown }).write(chunk, enc, cb);
	};

	// Upstream's own transport (`PersistentProtocol`) over the child's stdin/stdout.
	// See vscode-ext-host/spike/src/stdio-socket.ts.
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

	process.stderr.write(`[dsh-exthost] pid=${process.pid} node=${process.version} argv=${JSON.stringify(process.argv)}\n`);

	const extensionHostMain = new ExtensionHostMain(socket.createMessagePassingProtocol(), initData, hostUtils, null);

	process.on('SIGTERM', () => extensionHostMain.terminate('SIGTERM'));
	process.on('SIGINT', () => extensionHostMain.terminate('SIGINT'));
}

main().catch((err) => {
	process.stderr.write(`[dsh-exthost] fatal: ${err?.stack ?? err}\n`);
	process.exit(81);
});
