/**
 * Source-hygiene guard (release-hygiene P0).
 *
 * `src/` must stay TypeScript-only: compiled output is emitted to `out/`
 * (`tsconfig.json` sets `outDir: "out"` with `rootDir: "src"`), and the
 * compiler must never be able to emit next to the sources. This test is the
 * cheap, dependency-free tripwire that catches a stray `.js`/`.mjs`/`.cjs`
 * twin or a mis-configured compiler before it ships.
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

/**
 * Legitimate non-TypeScript files allowed to live under `src/` (e.g. static
 * assets that must sit next to their consuming module). Empty today —
 * anything added here needs a written justification in the commit.
 */
const ALLOWED_NON_TS_FILES: readonly string[] = [];

const NON_TS_EXTENSIONS = ['.js', '.mjs', '.cjs'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

test('src/ contains no compiled JavaScript (whitelist honored)', () => {
  assert.ok(fs.existsSync(SRC_ROOT), `src root must exist: ${SRC_ROOT}`);

  const offenders = walk(SRC_ROOT).filter((file) =>
    NON_TS_EXTENSIONS.some((ext) => file.endsWith(ext))
  );
  const allowed = new Set(
    ALLOWED_NON_TS_FILES.map((file) => path.normalize(path.join(SRC_ROOT, file)))
  );

  const unexpected = offenders.filter((file) => !allowed.has(file));
  assert.deepEqual(
    unexpected,
    [],
    'compiled output or stray JS twins found under src/ — delete them or extend ' +
      `ALLOWED_NON_TS_FILES (found: ${unexpected.map((f) => path.relative(SRC_ROOT, f)).join(', ')})`
  );
});

test('tsconfig can never emit into src/ (outDir=out, rootDir=src, allowJs off)', () => {
  const raw = fs.readFileSync(path.join(REPO_ROOT, 'tsconfig.json'), 'utf-8');
  const config = JSON.parse(raw) as {
    compilerOptions?: { outDir?: string; rootDir?: string; allowJs?: boolean };
  };

  assert.equal(config.compilerOptions?.outDir, 'out', 'outDir must target out/');
  assert.equal(config.compilerOptions?.rootDir, 'src', 'rootDir must be src/');
  assert.notEqual(config.compilerOptions?.allowJs, true, 'allowJs must stay disabled');
});
