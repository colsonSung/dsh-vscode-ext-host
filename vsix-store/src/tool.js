/**
 * The `vscode_extension` model tool.
 *
 * The tool is the model-facing half of the store; every action maps onto one
 * HTTP route action, so the Extensions page and the agent see the same facts.
 *
 * The security posture is written into the tool's own description, because a
 * model that installs an extension installs arbitrary third-party Node code:
 *
 * - installing needs an explicit `trust: true`, which stands for the user's
 *   approval, and the store refuses without it;
 * - only extensions from a trusted publisher are loaded by the extension
 *   host;
 * - Open VSX packages are verified against the registry's Ed25519 signature
 *   before they are unpacked; Marketplace packages have no signature DSH can
 *   verify, so they carry a warning instead.
 */

import { defineTool } from './define-tool.js'

const DESCRIPTION = [
  'Search, install, remove, enable or disable VS Code extension packages (VSIX) for DSH.',
  '',
  'SECURITY: installing a third-party extension means running its code. The install action only',
  'proceeds when the caller passes trust: true, which must stand for an explicit user approval of',
  'that specific extension. Extensions whose publisher is not trusted are never loaded by the',
  'extension host.',
  '',
  'Actions:',
  '- search: query the Open VSX registry and the Microsoft Marketplace; the results carry a',
  '  capability verdict telling whether DSH can actually run the extension (DSH supports the',
  '  declarative contribution points and the AI ones; editor-shaped extensions are not supported).',
  '- install: download, verify, unpack and install one extension.',
  '- remove: uninstall one extension by id (publisher.name@version).',
  '- list: list the installed extensions with their trust and enablement state.',
  '- enable: enable or disable one installed extension; a disabled extension is not loaded into',
  '  the extension host process.',
  '- trust: trust or untrust a publisher for this profile.',
].join('\n')

/**
 * Build the tool definition.
 * @param {object} service - the store's Host service.
 * @returns {object} the registry-ready tool definition.
 */
export function createExtensionTool(service) {
  return defineTool({
    name: 'vscode_extension',
    description: DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'What to do: search, install, remove, list, enable or trust.',
        enum: ['search', 'install', 'remove', 'list', 'enable', 'trust'],
      },
      query: {
        type: 'string',
        description: 'The search text. Required for the search action.',
      },
      source: {
        type: 'string',
        description: 'Which catalog to use: open-vsx or marketplace. The search action searches both when omitted.',
        enum: ['open-vsx', 'marketplace'],
      },
      limit: {
        type: 'integer',
        description: 'The maximum number of search results per catalog. Defaults to 20.',
      },
      inspect: {
        type: 'boolean',
        description: 'Read each result\'s manifest to decide whether DSH can run it. Defaults to true.',
      },
      publisher: {
        type: 'string',
        description: 'The extension publisher. Required for install and trust.',
      },
      name: {
        type: 'string',
        description: 'The extension name. Required for install.',
      },
      version: {
        type: 'string',
        description: 'The extension version. The latest version when omitted.',
      },
      trust: {
        type: 'boolean',
        description: 'The user\'s explicit approval to install this extension. The install action refuses without true.',
      },
      id: {
        type: 'string',
        description: 'The installed extension id, publisher.name@version. Required for remove and enable.',
      },
      enabled: {
        type: 'boolean',
        description: 'The wanted state for the enable action.',
      },
      trusted: {
        type: 'boolean',
        description: 'The wanted state for the trust action.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          data: { type: 'object', additionalProperties: true },
        },
        required: ['action', 'ok', 'summary'],
      },
      render: (_args, value) => [{ type: 'text', text: value?.summary ?? '' }],
    },
    async execute(args) {
      const action = args.action
      switch (action) {
        case 'search': {
          if (typeof args.query !== 'string' || args.query.trim().length === 0) {
            return { action, ok: false, summary: 'The search action needs a query.', data: {} }
          }
          const limit = typeof args.limit === 'number' ? Math.min(Math.max(args.limit, 1), 100) : 20
          const answer = await service.catalog({
            query: args.query,
            source: args.source,
            limit,
            inspect: args.inspect !== false,
          })
          const supported = answer.results.filter((entry) => entry.capability.status === 'supported').length
          const partial = answer.results.filter((entry) => entry.capability.status === 'partial').length
          // The popularity of an extension is the question the market metrics
          // answer, so the most installed result is named in the summary and
          // every result keeps its own downloads/rating in the data.
          const ranked = answer.results
            .filter((entry) => typeof entry.downloads === 'number')
            .sort((left, right) => right.downloads - left.downloads)
          const top = ranked[0]
          const popularity = top === undefined
            ? ''
            : ` Most installed: ${top.displayName ?? top.name} (${top.downloads} installs${typeof top.rating === 'number' ? `, rated ${top.rating}` : ''}).`
          return {
            action,
            ok: true,
            summary: `${answer.results.length} result(s) for "${args.query}": ${supported} fully supported by DSH, ${partial} partly supported.${popularity}`,
            data: answer,
          }
        }
        case 'install': {
          const record = await service.install({
            publisher: args.publisher,
            name: args.name,
            version: args.version,
            source: args.source ?? 'open-vsx',
            trust: args.trust === true,
          })
          return {
            action,
            ok: true,
            summary: `Installed ${record.id}.`,
            data: { record },
          }
        }
        case 'remove': {
          const outcome = await service.remove({ id: args.id })
          return { action, ok: true, summary: `Removed ${outcome.id}.`, data: outcome }
        }
        case 'list': {
          const records = await service.list()
          const summary = records.length === 0
            ? 'No VSIX extension is installed in this profile.'
            : `${records.length} extension(s) installed: ${records.map((record) => `${record.id}${record.enabled ? '' : ' (disabled)'}`).join(', ')}`
          return { action, ok: true, summary, data: { extensions: records } }
        }
        case 'enable': {
          const outcome = await service.setEnabled({ id: args.id, enabled: args.enabled === true })
          return {
            action,
            ok: true,
            summary: `${outcome.id} is now ${outcome.enabled ? 'enabled' : 'disabled'}.`,
            data: outcome,
          }
        }
        case 'trust': {
          const outcome = await service.setTrust({ publisher: args.publisher, trusted: args.trusted === true })
          return {
            action,
            ok: true,
            summary: `The publisher "${outcome.publisher}" is now ${outcome.trusted ? 'trusted' : 'untrusted'}.`,
            data: outcome,
          }
        }
        default:
          return { action: String(action), ok: false, summary: `Unknown action "${action}".`, data: {} }
      }
    },
  })
}
