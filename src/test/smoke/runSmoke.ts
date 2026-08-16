/**
 * Smoke-test launcher (runs on the DEVELOPMENT Node, outside VS Code).
 *
 * Downloads (cached in ~/.vscode-test) the requested VS Code build and runs
 * the in-host smoke suite (`smokeMain.js`) against the shipped extension:
 *
 *   node out/test/smoke/runSmoke.js stable     # latest stable VS Code
 *   node out/test/smoke/runSmoke.js 1.85.0     # oldest supported (min)
 *   node out/test/smoke/runSmoke.js 1.93.0     # any explicit version
 *
 * Exits non-zero on any in-host failure or a failed launch.
 *
 * The in-host suite reports its verdict through a shared file
 * (`NOEFFECT_SMOKE_RESULT`): the extension-host test runner does not
 * reliably propagate `process.exitCode`, so the file handshake is the
 * authoritative gate — the launcher fails unless the host recorded a known
 * good verdict.
 */

import { runTests } from '@vscode/test-electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const requested = process.argv[2] ?? 'stable';

const ACCEPTED_VERDICTS = new Set(['HOST_OK']);

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const verdictFile = path.join(
    os.tmpdir(),
    `noeffect-smoke-${process.pid}-${Date.now()}.verdict`
  );

  try {
    await runTests({
      version: requested,
      extensionDevelopmentPath: repoRoot,
      extensionTestsPath: path.join(__dirname, 'smokeMain.js'),
      launchArgs: ['--disable-gpu', '--no-sandbox'],
      extensionTestsEnv: { NOEFFECT_SMOKE_RESULT: verdictFile },
    });

    // `runTests` resolved — now honor the in-host verdict file. A missing
    // or FAIL verdict means the suite did not complete cleanly.
    const verdict = fs.existsSync(verdictFile) ? fs.readFileSync(verdictFile, 'utf8').trim() : '';
    const verdictCode = verdict.split('\n')[0] ?? '';
    if (!ACCEPTED_VERDICTS.has(verdictCode)) {
      throw new Error(
        `in-host smoke suite did not record an accepted verdict ` +
          `(got: ${verdictCode || '<missing verdict file>'})\n${verdict || ''}`
      );
    }
  } finally {
    if (fs.existsSync(verdictFile)) {
      fs.rmSync(verdictFile, { force: true });
    }
  }
}

main()
  .then(() => {
    console.log(`[noeffect-smoke] PASS on VS Code "${requested}"`);
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error(`[noeffect-smoke] FAIL on VS Code "${requested}":`, err);
    process.exit(1);
  });
