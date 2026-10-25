/*---------------------------------------------------------------------------------------------
 *  DSH S1 production — the main side's public surface.
 *
 *  DSH-authored (MIT).
 *
 *  The bundle's `index.js` imports this module (compiled to `bundle/dist/main-host.js`).
 *--------------------------------------------------------------------------------------------*/

export { ExtensionHostService, ExtensionHostCrashTracker, HostLog, resolveNodeCommand, curatedChildEnv } from './main-host.js';
export type { ExtensionHostConfig, NodeCommand } from './main-host.js';
export { ExtensionHostRuntime } from './service.js';
export type { HostStatusPayload, StatusPayload } from './service.js';
export { createExtensionHostTool, defineTool } from './tool.js';
export { resolveProfileExtensions, readExtensionsJson, readTrustJson } from './profile.js';
export type { ExtensionRecord, ResolvedProfile, SkippedExtension } from './profile.js';
export { createMethods, createChannelMethods, SERVICES } from './methods/index.js';
export type { ExtHostContext, ExtensionHostState, LoadedExtension, MainThreadMethodFactory, MainThreadMethods, ResolvedExtension } from './host-context.js';
