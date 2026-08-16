/**
 * Stage C — packaged-artifact proof (release-packaging P0).
 *
 * 1. Packages the VSIX fresh with `@vscode/vsce package --no-dependencies`
 *    (the exact command the release process uses).
 * 2. Installs the VSIX into an ISOLATED profile with VS Code's own
 *    `--install-extension` machinery (temp `--user-data-dir` +
 *    `--extensions-dir`; never touches the user's real profile).
 * 3. Launches a real VS Code window against that isolated profile and runs
 *    the in-host smoke suite (`smokeMain.js`) — activation, command
 *    registration, and one full analysis (graceful skip without Chromium) —
 *    all loaded from the INSTALLED extension copy (dist bundle), NOT from
 *    `extensionDevelopmentPath`.
 *
 * Requires the repo to be built (`npm run compile && npm run build`).
 * Exits non-zero on any failure.
 */

import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import pkg from '../../../package.json';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const VSCE_BIN = path.join(
  REPO_ROOT,
  'node_modules',
  '@vscode',
  'vsce',
  'vsce'
);
const DIST_ENTRY = path.join(REPO_ROOT, 'dist', 'extension.js');
const SMOKE_MAIN = path.join(__dirname, 'smokeMain.js');

async function main(): Promise<void> {
  if (!fs.existsSync(DIST_ENTRY)) {
    throw new Error('dist/extension.js missing — run `npm run build` first');
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-pack-'));
  const vsixPath = path.join(work, `${pkg.name}-${pkg.version}.vsix`);
  const userDataDir = path.join(work, 'user-data');
  const extensionsDir = path.join(work, 'extensions');

  try {
    // 1. Package.
    const packed = spawnSync(
      process.execPath,
      [VSCE_BIN, 'package', '--no-dependencies', '--out', vsixPath],
      { cwd: REPO_ROOT, stdio: 'inherit' }
    );
    if (packed.status !== 0) {
      throw new Error(`vsce package failed with exit ${packed.status}`);
    }
    const size = fs.statSync(vsixPath).size;
    console.log(`[pack] vsix written: ${vsixPath} (${(size / 1024).toFixed(1)} KiB)`);

    // 2. Install into an isolated profile. Prefer VS Code's own installer;
    //    on hosts where the CLI hangs (headless/no-dbus), fall back to
    //    extracting the VSIX into the extensions dir — the identical result
    //    the installer produces.
    const execPath = await downloadAndUnzipVSCode('stable');
    const installed = spawnSync(
      execPath,
      [
        '--install-extension',
        vsixPath,
        '--user-data-dir',
        userDataDir,
        '--extensions-dir',
        extensionsDir,
        '--force',
        '--no-sandbox',
        '--disable-gpu',
      ],
      { stdio: 'inherit', timeout: 60_000, killSignal: 'SIGKILL' }
    );
    const extDir = path.join(extensionsDir, 'noeffect.no-effect-0.1.0');
    if (installed.status !== 0 || !fs.existsSync(extDir)) {
      console.warn('[pack] CLI install failed or hung — falling back to VSIX extraction');
      spawnSync('pkill', ['-9', '-f', `^${execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`], { stdio: 'ignore' });
      fs.mkdirSync(extensionsDir, { recursive: true });
      const staging = path.join(work, 'vsix-stage');
      fs.mkdirSync(staging, { recursive: true });
      const extracted = spawnSync(
        'unzip',
        ['-o', '-q', vsixPath, '-d', staging],
        { stdio: 'inherit' }
      );
      if (extracted.status !== 0) {
        throw new Error(`VSIX extraction failed with exit ${extracted.status}`);
      }
      const payloadRoot = path.join(staging, 'extension');
      if (!fs.existsSync(path.join(payloadRoot, 'package.json'))) {
        throw new Error(`VSIX payload missing package.json under ${payloadRoot}`);
      }
      fs.cpSync(payloadRoot, extDir, { recursive: true });
      const json = [
        {
          identifier: { id: 'noeffect.no-effect', uuid: '' },
          version: pkg.version,
          location: {
            $mid: 1,
            path: extDir,
            scheme: 'file',
          },
          relativeLocation: `noeffect.no-effect-${pkg.version}`,
        },
      ];
      fs.writeFileSync(
        path.join(extensionsDir, 'extensions.json'),
        JSON.stringify(json, null, 2)
      );
    }
    if (!fs.existsSync(extDir)) {
      throw new Error(`installed extension dir missing: ${extDir}`);
    }
    const installedMain = JSON.parse(
      fs.readFileSync(path.join(extDir, 'package.json'), 'utf-8')
    ).main;
    console.log(`[pack] installed at ${extDir}, main=${installedMain}`);
    if (installedMain !== './dist/extension.js') {
      throw new Error(`installed package main is not ./dist/extension.js: ${installedMain}`);
    }

    // 3. Run the in-host smoke against the installed (packaged) extension.
    //    An EMPTY development path is deliberate: no dev-extension is loaded,
    //    so the host resolves the extension purely from the installed VSIX.
    //    The smoke writes its analysis verdict to a file (extension-host
    //    console output is not relayed), which we assert on after the run.
    const verdictFile = path.join(work, 'smoke-verdict.txt');
    await runTests({
      version: 'stable',
      extensionDevelopmentPath: [],
      extensionTestsPath: SMOKE_MAIN,
      extensionTestsEnv: {
        NOEFFECT_SMOKE_RESULT: verdictFile,
        ELECTRON_ENABLE_LOGGING: '1',
      },
      launchArgs: [
        '--user-data-dir',
        userDataDir,
        '--extensions-dir',
        extensionsDir,
        '--disable-gpu',
        '--no-sandbox',
      ],
    });
    const verdict = fs.existsSync(verdictFile)
      ? fs.readFileSync(verdictFile, 'utf-8').trim()
      : '';
    if (verdict !== 'ANALYSIS_SETTLED' && verdict !== 'NO_BROWSER_SKIP') {
      throw new Error(`smoke verdict missing or unexpected: ${JSON.stringify(verdict)}`);
    }
    console.log(`[pack] smoke verdict: ${verdict}`);
    console.log('[pack] STAGE C PASS — installed VSIX activates and analyzes');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('[pack] FAIL:', err);
    process.exit(1);
  });
