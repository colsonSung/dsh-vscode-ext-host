import { build } from 'esbuild';

const wrap = () => ({
  banner: {
    js: `window.__ModuleLoader__.load({
	id: "@local/dsh-vscode-webview-surface",
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
  entryPoints: ['src/client-entry.jsx'],
  outfile: 'client.js',
  // The platform module table owns these; the client resolves them at runtime.
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  ...wrap(),
});
