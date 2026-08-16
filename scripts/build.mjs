/**
 * Production bundle build (release-packaging P0).
 *
 * Bundles the extension + its only runtime dependency (`ws`) into a single
 * CommonJS file at `dist/extension.js`. The VSIX ships with ZERO
 * node_modules — the bundle IS the payload.
 *
 * Compatibility target: chosen to MATCH the recorded policy
 * (PROJECT_STATE.md Runtime line / NODE-COMPAT-AUDIT.md): the declared
 * minimum VS Code 1.85.0 ships Electron 25.9.7 / Node 18.15.0, so esbuild
 * targets `node18.15`. The compatibility policy itself is untouched.
 *
 * Repo-only asset: this script is required by `vscode:prepublish` (vsce runs
 * it from the repo root at package time) and must never ship inside the VSIX
 * (`.vscodeignore` excludes `scripts/**`).
 */

import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(root, 'dist', 'extension.js');

mkdirSync(dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [resolve(root, 'src', 'extension.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node18.15'],
  external: ['vscode'],
  outfile,
  metafile: true,
  sourcemap: true,
  minify: false,
  logLevel: 'info',
});

// Dependency graph proof artifact: which inputs produced dist/extension.js.
writeFileSync(
  resolve(root, 'dist', 'extension.meta.json'),
  JSON.stringify(result.metafile, null, 2)
);

console.log(`[build] dist/extension.js written (${result.metafile.inputs ? Object.keys(result.metafile.inputs).length : 0} input files)`);
