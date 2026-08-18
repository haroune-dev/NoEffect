/**
 * In-extension-host smoke suite — the oldest-version proof.
 *
 * Runs INSIDE the VS Code extension host of a real (downloaded) VS Code
 * build. Proves, on the CHOSEN minimum version AND on stable:
 *
 *   1. the shipped-Node mapping (logs `process.versions.node`, asserts the
 *      documented Node 18 line on the 1.85.0 min build),
 *   2. activation completes without throwing,
 *   3. every contributed command is registered,
 *   4. no unhandled rejection escapes the host during the run,
 *   5. (best effort) one full analysis executes end-to-end — a settled
 *      "Coverage" record through the shipped logger; skipped gracefully
 *      when Chromium is absent.
 *
 * Failure = `process.exitCode = 1`; the host test runner closes the window
 * and exits with it, which `@vscode/test-electron` reports as a failure.
 * The module must export the `run` function — that is what the host test
 * runner calls.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * The smoke must observe the shipped logging path. The dev-loaded extension
 * runs the bundled entry (`dist/extension.js`), whose logger is a separate
 * module instance from the one imported here — so spying on the local logger
 * would capture nothing. Instead we patch the shared `vscode` API surface
 * (`window.createOutputChannel`) BEFORE activation: the bundle's logger calls
 * exactly that function, so its channel becomes the spy and every shipped log
 * line lands in `recorded`. This works for any entry-point layout and any
 * VS Code version that lazy-creates its output channel.
 */
type SpyChannel = {
  appendLine(line: string): void;
  name: string;
  append(value: string): void;
  clear(): void;
  hide(): void;
  show(): void;
  dispose(): void;
  replace(value: string): void;
};

function spyOutputChannel(): { recorded: string[]; restore(): void } {
  const recorded: string[] = [];
  const real = vscode.window.createOutputChannel.bind(vscode.window);
  vscode.window.createOutputChannel = ((name: string) => {
    const fake: SpyChannel = {
      name,
      append(value: string): void {
        recorded[recorded.length - 1] = (recorded[recorded.length - 1] ?? '') + value;
      },
      appendLine(line: string): void {
        recorded.push(line);
      },
      clear(): void {},
      hide(): void {},
      show(): void {},
      dispose(): void {},
      replace(_value: string): void {},
    };
    return fake as unknown as vscode.OutputChannel;
  }) as typeof vscode.window.createOutputChannel;
  return {
    recorded,
    restore(): void {
      vscode.window.createOutputChannel = real;
    },
  };
}

// The extension id is `publisher.name` from the manifest — derived here (not
// hardcoded) so a publisher/name change can never silently break the suite.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const manifest = require('../../../package.json') as { name: string; publisher: string };
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;

const REQUIRED_COMMANDS: readonly string[] = [
  'noEffect.analyzeCurrentFile',
  'noEffect.clearDecorations',
  'noEffect.showStatus',
  'noEffect.diagnoseSetup',
  'noEffect.showOutputLogs',
  'noEffect.restartAnalysisSession',
  'noEffect.clearCache',
  'noEffect.jumpAndHighlight',
];

/** Documented mapping (audit report): VS Code 1.85.x ships Electron 25 / Node 18.15.x. */
function isDocumentedMinNode(nodeVersion: string): boolean {
  return nodeVersion.startsWith('18.');
}

export async function run(): Promise<void> {
  try {
    const nodeVersion = process.versions.node;
    console.log(
      `[noeffect-smoke] host: vscode=${vscode.version} node=${nodeVersion} electron=${process.versions.electron} chrome=${process.versions.chrome}`
    );

    if (vscode.version.startsWith('1.85.')) {
      assert.ok(
        isDocumentedMinNode(nodeVersion),
        `on the minimum VS Code build the shipped Node must be 18.x, got ${nodeVersion}`
      );
    }

    const unhandled: unknown[] = [];
    const onRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onRejection);

    try {
      // Patch BEFORE activation so the bundle's logger binds the spy channel.
      const spy = spyOutputChannel();

      // 1. Activation — `activate()` rejects if activation threw.
      const ext = vscode.extensions.getExtension(EXTENSION_ID);
      assert.ok(ext, `extension ${EXTENSION_ID} must be installed`);
      await ext.activate();
      assert.ok(ext.isActive, `extension ${EXTENSION_ID} must be active after activate()`);
      console.log(`[noeffect-smoke] ${EXTENSION_ID} activated`);

      // 2. Commands contributed by package.json must be registered.
      const commands = await vscode.commands.getCommands(true);
      for (const id of REQUIRED_COMMANDS) {
        assert.ok(commands.includes(id), `contributed command ${id} must be registered`);
      }
      console.log(`[noeffect-smoke] ${REQUIRED_COMMANDS.length} contributed commands registered`);

      // 3. Best-effort full analysis: a real CSS document through the shipped
      //    pipeline. A settled run logs one deterministic "Coverage" line via
      //    the shipped logger; without Chromium the run degrades to a clean
      //    no-browser skip — both are acceptable, a throw is not.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-smoke-'));
      const recordVerdict = (verdict: string) => {
        if (process.env.NOEFFECT_SMOKE_RESULT) {
          fs.writeFileSync(process.env.NOEFFECT_SMOKE_RESULT, verdict);
        }
      };
      try {
        // 3. THE multipage regression FIRST — the exact user scenario: a CSS
        //    file linked from TWO pages (A in index.html, I in about.html)
        //    is opened and analyzed FIRST, without visiting either page —
        //    and this is the process's FIRST analysis (cold browser +
        //    DevServer, exactly where transient failures used to pollute
        //    the merge). The merged verdict must be A. `[Result]` is the
        //    single observable result record: it must list the genuinely
        //    inactive selectors and must NEVER list a merged-active one.
        const fixtureDir = path.join(dir, 'multipage');
        fs.mkdirSync(fixtureDir);
        for (const name of ['styles.css', 'index.html', 'about.html']) {
          fs.copyFileSync(
            path.join(
              __dirname,
              '..',
              '..',
              '..',
              'src',
              'test',
              'fixtures',
              'multipage-orchestration',
              name
            ),
            path.join(fixtureDir, name)
          );
        }
        const multipageCss = path.join(fixtureDir, 'styles.css');
        const multipageDoc = await vscode.workspace.openTextDocument(multipageCss);
        await vscode.window.showTextDocument(multipageDoc);
        // The analysis command settles when the run completes, so the
        // observation window must START before it — records logged by the
        // run (like `[Result]`) land after this marker, not before it.
        const multipageLogStart = spy.recorded.length;
        await vscode.commands.executeCommand('noEffect.analyzeCurrentFile');

        const multipageDeadline = Date.now() + 120_000;
        let multipageObserved = '';
        while (Date.now() < multipageDeadline) {
          multipageObserved = spy.recorded.slice(multipageLogStart).join('\n');
          const lastResultIndex = multipageObserved.lastIndexOf(`[Result] ${multipageCss}:`);
          if (lastResultIndex !== -1) {
            // Follow-up re-evaluations may add more records after this one;
            // give the completion a beat to settle before asserting.
            await new Promise((resolve) => setTimeout(resolve, 1000));
            multipageObserved = spy.recorded.slice(multipageLogStart).join('\n');
            const resultLine = multipageObserved
              .slice(multipageObserved.lastIndexOf(`[Result] ${multipageCss}:`))
              .split('\n')[0];
            assert.ok(
              resultLine.includes('.all-inactive'),
              'the fixture dims the genuinely inactive selector: ' + resultLine
            );
            assert.ok(
              resultLine.includes('.secondary-only'),
              'the fixture dims the one-page-inactive selector: ' + resultLine
            );
            assert.ok(
              !resultLine.includes('.active-somewhere'),
              'the merged-active selector must never be dimmed on a FIRST analysis: ' + resultLine
            );
            console.log('[noeffect-smoke] multipage first-open: merged-active stays undimmed');
            if (multipageObserved.includes('companion_pass_failed') || multipageObserved.includes('page_load_timeout')) {
              console.log('[noeffect-smoke] WARNING: transient analysis warnings observed:');
              const lines = multipageObserved.split('\n').filter((l) =>
                l.includes('companion') || l.includes('timeout') || l.includes('failed')
              );
              for (const l of lines.slice(0, 6)) {
                console.log('[noeffect-smoke]   ' + l);
              }
            }
            break;
          }
          if (
            multipageObserved.includes('CHROMIUM_NOT_FOUND') ||
            multipageObserved.includes('BROWSER_DETECTION_FAILED')
          ) {
            console.log('[noeffect-smoke] Chromium absent — multipage scenario skipped gracefully');
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (!multipageObserved.includes(`[Result] ${multipageCss}:`)) {
          const dumpPath = path.join(os.tmpdir(), `noeffect-smoke-log-${process.pid}.txt`);
          fs.writeFileSync(dumpPath, spy.recorded.join('\n'), 'utf-8');
          console.error(`[noeffect-smoke] full captured log dumped to ${dumpPath} (${spy.recorded.length} lines)`);
          assert.fail(
            'expected a [Result] record for the multipage stylesheet on its first analysis'
          );
        }

        // 4. Best-effort full analysis: a real CSS document through the
        //    shipped pipeline after the multipage scenario. A settled run
        //    logs one deterministic "Coverage" line via the shipped logger;
        //    without Chromium the run degrades to a clean no-browser skip —
        //    both are acceptable, a throw is not.
        const cssPath = path.join(dir, 'styles.css');
        fs.writeFileSync(cssPath, '.box { justify-content: center; }\n');
        const doc = await vscode.workspace.openTextDocument(cssPath);
        await vscode.window.showTextDocument(doc);
        const singleLogStart = spy.recorded.length;
        await vscode.commands.executeCommand('noEffect.analyzeCurrentFile');

        const deadline = Date.now() + 120_000;
        let observed = '';
        while (Date.now() < deadline) {
          observed = spy.recorded.slice(singleLogStart).join('\n');
          if (observed.includes('Coverage ')) {
            console.log('[noeffect-smoke] full analysis settled (Coverage record found)');
            recordVerdict('ANALYSIS_SETTLED');
            break;
          }
          if (
            observed.includes('CHROMIUM_NOT_FOUND') ||
            observed.includes('BROWSER_DETECTION_FAILED')
          ) {
            console.log('[noeffect-smoke] Chromium absent — analysis skipped gracefully');
            recordVerdict('NO_BROWSER_SKIP');
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (
          !observed.includes('Coverage ') &&
          !observed.includes('CHROMIUM_NOT_FOUND') &&
          !observed.includes('BROWSER_DETECTION_FAILED')
        ) {
          assert.fail(
            'expected either a settled analysis (Coverage record) or a graceful no-browser skip'
          );
        }
      } finally {
        spy.restore();
        fs.rmSync(dir, { recursive: true, force: true });
      }

      assert.deepEqual(unhandled, [], 'no unhandled rejection may escape the host run');
      console.log('[noeffect-smoke] no unhandled rejections');
      recordVerdict('HOST_OK');
    } finally {
      process.removeListener('unhandledRejection', onRejection);
    }
  } catch (err: unknown) {
    console.error('[noeffect-smoke] FAIL:', err);
    if (process.env.NOEFFECT_SMOKE_RESULT) {
      try {
        fs.writeFileSync(
          process.env.NOEFFECT_SMOKE_RESULT,
          `FAIL\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
        );
      } catch {
        // The verdict file is best-effort; the exit code remains the gate.
      }
    }
    process.exitCode = 1;
  }
}
