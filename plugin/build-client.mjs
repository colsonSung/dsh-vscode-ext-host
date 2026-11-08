import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// npm runs this script from the repository root, so the paths are anchored to this file
// rather than to the working directory.
const HERE = dirname(fileURLToPath(import.meta.url));

const wrap = () => ({
  banner: {
    js: `window.__ModuleLoader__.load({
	id: "dsh-vscode-extension-host",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;`,
  },
  footer: {
    js: `		return module.exports;
	}
});`,
  },
});

await build({
  bundle: true,
  format: 'cjs',
  target: 'es2020',
  platform: 'browser',
  minify: true,
  logLevel: 'info',
  jsx: 'automatic',
  entryPoints: [join(HERE, 'src/client-entry.jsx')],
  outfile: join(HERE, 'client.js'),
  // The platform module table owns these; the client resolves them at runtime.
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  ...wrap(),
});
