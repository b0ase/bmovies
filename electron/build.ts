/**
 * Build script for Electron main process.
 *
 * Bundles electron/main.ts → electron/main.mjs using esbuild.
 * Marks electron and native modules as external.
 */
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['electron/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'electron/main.mjs',
  external: [
    'electron',
    // Native modules that can't be bundled
    'bufferutil',
    'utf-8-validate',
    'utp-native',
    'node-datachannel',
    // Node builtins
    'node:*',
  ],
  // Allow importing from src/
  alias: {},
  banner: {
    // CJS require() shim for ESM (needed for some deps)
    js: `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`,
  },
  sourcemap: true,
  minify: false, // Keep readable for debugging
});

console.log('Built electron/main.mjs');
