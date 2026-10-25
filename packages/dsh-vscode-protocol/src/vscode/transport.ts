/*---------------------------------------------------------------------------------------------
 *  DSH `dsh-vscode-protocol` — the vendored VS Code extension-host transport.
 *
 *  DSH-authored glue (MIT). The code re-exported here is Microsoft's, vendored verbatim under
 *  `<repo>/vscode-ext-host/vendor/src/vs/**` with its copyright headers intact.
 *
 *  WHY THIS EXISTS
 *  ---------------
 *  VS Code's extension host does NOT speak JSON-RPC 2.0. It speaks its own binary protocol:
 *
 *    - `base/parts/ipc/common/ipc.net.ts` -> `PersistentProtocol`: a 13-byte frame header
 *      (`type | id | ack | length`) with STRICTLY ORDERED message ids. A gap makes the reader
 *      ask the peer to replay, it never silently re-syncs.
 *    - `workbench/services/extensions/common/rpcProtocol.ts` -> `RPCProtocol`: the request /
 *      reply / cancellation layer that runs on top of `IMessagePassingProtocol`.
 *
 *  Because the wire format is fixed by the vendored extension host, the DSH side has to speak
 *  exactly this protocol. This module is the single place where that happens.
 *--------------------------------------------------------------------------------------------*/

export {
	BufferedEmitter,
	PersistentProtocol,
	ProtocolConstants,
	SocketCloseEvent,
	SocketDiagnosticsEventType,
} from '../../../../vendor/src/vs/base/parts/ipc/common/ipc.net.js';

export type { ISocket } from '../../../../vendor/src/vs/base/parts/ipc/common/ipc.net.js';
export type { IMessagePassingProtocol } from '../../../../vendor/src/vs/base/parts/ipc/common/ipc.js';

export { RPCProtocol } from '../../../../vendor/src/vs/workbench/services/extensions/common/rpcProtocol.js';
export type { IRequestInitiator, RequestInitiator } from '../../../../vendor/src/vs/workbench/services/extensions/common/rpcProtocol.js';

export { ProxyIdentifier } from '../../../../vendor/src/vs/workbench/services/extensions/common/proxyIdentifier.js';

export { ExtensionIdentifier } from '../../../../vendor/src/vs/platform/extensions/common/extensions.js';
export type { IExtensionDescription } from '../../../../vendor/src/vs/platform/extensions/common/extensions.js';

export { URI } from '../../../../vendor/src/vs/base/common/uri.js';
export { VSBuffer } from '../../../../vendor/src/vs/base/common/buffer.js';
