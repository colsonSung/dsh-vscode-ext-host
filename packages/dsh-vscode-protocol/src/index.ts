/*---------------------------------------------------------------------------------------------
 *  DSH `dsh-vscode-protocol` — the public surface of the VS Code extension-host protocol.
 *
 *  Pure library: no DSH context, no I/O of its own, no third-party runtime dependency.
 *  Everything here is either DSH-authored glue (MIT) or Microsoft's vendored code, re-exported
 *  unchanged.
 *
 *  The package answers one question: "how does DSH speak to a real VS Code extension host?"
 *  The answer is VS Code's own binary protocol, so the transport, the channel tables and the
 *  method names are reproduced verbatim.
 *--------------------------------------------------------------------------------------------*/

export * from './vscode/transport.js';
export * from './vscode/channels.js';
export * from './vscode/stdio-socket.js';
export * from './vscode/ready-signal.js';
export * from './vscode/brand.js';
export * from './vscode/init-data.js';
