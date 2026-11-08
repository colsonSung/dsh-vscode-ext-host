#!/usr/bin/env node
/** The Extensions tab must not append DSH bundles to the installed VS Code extensions. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let loaded;
const window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded = { id, exports: factory((name) => {
        if (name === 'react' || name === 'react/jsx-runtime') return {};
        throw new Error(`unexpected module ${name}`);
      }) };
    },
  },
};
globalThis.window = window;

new Function('window', readFileSync(resolve(import.meta.dirname, '../client.js'), 'utf8'))(window);
assert.equal(loaded.id, 'dsh-extension-console');
assert.equal(typeof loaded.exports.installedUnits, 'function');

const units = loaded.exports.installedUnits({
  snapshot: {
    units: [{ id: 'bundle:@local/dsh-memory', kind: 'bundle', name: '@local/dsh-memory' }],
  },
  vsix: [{
    id: 'saoudrizwan.claude-dev@4.1.26',
    name: 'claude-dev',
    publisher: 'saoudrizwan',
    displayName: 'Cline',
    version: '4.1.26',
    enabled: true,
  }],
  host: {
    extensions: [{ id: 'saoudrizwan.claude-dev@4.1.26', active: true }],
  },
});

assert.equal(units.length, 1, 'the DSH bundle must not appear in this list');
assert.equal(units[0].backend, 'vsix');
assert.equal(units[0].id, 'saoudrizwan.claude-dev@4.1.26');
assert.equal(units[0].loaded, true);
assert.deepEqual(loaded.exports.installedUnits({ snapshot: { units: [{}] }, vsix: [] }), []);
console.log('PASS  Extensions / Installed contains only VS Code extensions');
