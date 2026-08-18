import { test, after, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { CdpAnalyzer, DEFAULT_FIXTURES_ROOT } from '../../services/cdpAnalyzer';
import { SessionManager } from '../../services/sessionManager';
import { resolveCompanionsAll } from '../../services/companionResolver';
import { companionSettings } from '../../services/companionSettings';
import { multiPassCache } from '../../cache/multiPassCache';
import { AnalysisRunner } from '../../services/analysisRunner';
import { BrowserRunner } from '../../browser/browserRunner';
import { defaultLifecycle } from '../../browser/lifecycleManager';
import { astCache } from '../../cache/astCache';
import { mappingCache } from '../../cache/mappingCache';
import { CssLocation } from '../../models';
import { REASON_CODES } from '../../inactive/reasonCode';
import { contentHash } from '../../utils/contentHash';
import { companionContextFingerprintFor, STALE_CONTEXT_FINGERPRINT } from '../../engine/analysisContext';
import { companionCache } from '../../cache/companionCache';
import { AnalysisCancelledError } from '../../failure/errors';
import { CancellationTokenLike } from '../../failure/cancellation';
import { evidenceLine } from '../../status/derive';

/**
 * Integration tests for PR4: the production CdpAnalyzer pipeline against
 * real Chromium/CDP, including the CDP → local source-range mapping.
 *
 * These tests launch a real browser. When Chromium is unavailable (e.g. CI
 * without a Chromium binary), only these browser-dependent tests are
 * skipped with an explicit reason; unit tests are never skipped.
 */

const CHROMIUM_UNAVAILABLE_REASON =
  'Chromium executable (google-chrome) is not available in this environment';

async function skipIfNoChromium(t: TestContext): Promise<boolean> {
  const available = await BrowserRunner.isAvailable();
  if (!available) {
    t.skip(CHROMIUM_UNAVAILABLE_REASON);
    return true;
  }
  return false;
}

function isZeroRange(loc: CssLocation): boolean {
  return loc.startLine === 0 && loc.startColumn === 0 && loc.endLine === 0 && loc.endColumn === 0;
}

function rangeText(lines: string[], loc: CssLocation): string {
  if (loc.startLine === loc.endLine) {
    return (lines[loc.startLine] ?? '').slice(loc.startColumn, loc.endColumn);
  }
  return lines.slice(loc.startLine, loc.endLine + 1).join('\n');
}

test('inactive fixture: block .non-flex produces exactly 1 issue with a valid mapped local range', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeFixture(
    path.join(DEFAULT_FIXTURES_ROOT, 'inactive'),
    '.non-flex',
    Date.now()
  );

  assert.equal(issues.length, 1, 'expected exactly one inactive declaration');

  const issue = issues[0];
  assert.equal(issue.propertyName, 'justify-content');
  assert.equal(issue.propertyValue, 'center');
  assert.equal(issue.selectorText, '.non-flex');
  assert.equal(issue.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);
  assert.ok(issue.styleSheetId, 'expected a real CDP stylesheet id');
  assert.ok(issue.cdpRange, 'expected a CDP source range on the issue');

  // PR4: the issue must carry a valid, non-empty local source range that
  // points at the real authored declaration in the fixture stylesheet. A
  // non-empty declaration range is exactly what guarantees the decoration
  // pipeline dims the declaration and places the inline icon (it is never
  // skipped for an empty range).
  const cssFilePath = path.join(DEFAULT_FIXTURES_ROOT, 'inactive', 'styles.css');
  const lines = fs.readFileSync(cssFilePath, 'utf-8').split('\n');

  assert.equal(issue.location.filePath, cssFilePath);
  assert.ok(!isZeroRange(issue.location), 'location must not be the empty placeholder range');
  assert.equal(
    rangeText(lines, issue.location),
    'justify-content: center;',
    'declaration range must cover the real authored declaration text'
  );

  assert.ok(issue.declarationRange, 'expected a mapped declaration range');
  assert.deepEqual(issue.declarationRange, issue.location);

  assert.ok(issue.propertyNameRange, 'expected a mapped property-name range');
  assert.equal(rangeText(lines, issue.propertyNameRange), 'justify-content');

  assert.ok(issue.iconAnchorRange, 'expected a mapped icon anchor range');
  assert.equal(rangeText(lines, issue.iconAnchorRange), ';', 'icon anchor must be the final semicolon');
  assert.equal(issue.iconAnchorRange.startLine, issue.iconAnchorRange.endLine);
  assert.equal(
    issue.iconAnchorRange.startColumn + 1,
    issue.iconAnchorRange.endColumn,
    'icon anchor must be a single character'
  );
});

test('active fixture: flex .non-flex produces 0 issues', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeFixture(
    path.join(DEFAULT_FIXTURES_ROOT, 'active'),
    '.non-flex',
    Date.now()
  );

  assert.equal(issues.length, 0, 'expected no issues when the element is a flex container');
});

test('change test: rerunning after the file changes from inactive to active produces 0 issues', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  // Copy the inactive fixture to a scratch directory so the change test
  // never mutates the shared fixtures.
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-change-'));
  t.after(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });
  fs.copyFileSync(
    path.join(DEFAULT_FIXTURES_ROOT, 'inactive', 'index.html'),
    path.join(scratchDir, 'index.html')
  );
  fs.copyFileSync(
    path.join(DEFAULT_FIXTURES_ROOT, 'inactive', 'styles.css'),
    path.join(scratchDir, 'styles.css')
  );

  const analyzer = new CdpAnalyzer();

  // First run: the inactive fixture reports 1 mapped issue.
  const firstRun = await analyzer.analyzeFixture(scratchDir, '.non-flex', Date.now());
  assert.equal(firstRun.length, 1, 'expected 1 issue before the change');

  // Change the stylesheet to the active (flex) variant and rerun: the
  // previous result must be fully replaced — a zero-issue result is what
  // makes the decoration layer clear all stale decorations.
  const activeCss = fs.readFileSync(
    path.join(DEFAULT_FIXTURES_ROOT, 'active', 'styles.css'),
    'utf-8'
  );
  fs.writeFileSync(path.join(scratchDir, 'styles.css'), activeCss);

  const secondRun = await analyzer.analyzeFixture(scratchDir, '.non-flex', Date.now());
  assert.equal(secondRun.length, 0, 'expected 0 issues after the file changed to active');
});

/**
 * ── Performance PR: persistent session + caching ─────────────────────────
 *
 * The shared `defaultLifecycle` keeps one Chromium, one CDP WebSocket, one
 * DevServer and one analysis page alive across analyses. These tests prove
 * the session is started once and reused, that the AST/mapping caches hit on
 * identical inputs, and that a lost browser/CDP session recovers
 * transparently. All assertions use stat deltas so they are robust to state
 * left behind by earlier tests.
 */

// Tear down the persistent session when the whole file is done, so no
// Chromium/DevServer process is orphaned after the test process exits.
after(() => defaultLifecycle.dispose());

function copyFixtureToScratch(name: string): string {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), `noeffect-${name}-`));
  fs.copyFileSync(
    path.join(DEFAULT_FIXTURES_ROOT, 'inactive', 'index.html'),
    path.join(scratchDir, 'index.html')
  );
  fs.copyFileSync(
    path.join(DEFAULT_FIXTURES_ROOT, 'inactive', 'styles.css'),
    path.join(scratchDir, 'styles.css')
  );
  return scratchDir;
}

const INACTIVE_FIXTURE = path.join(DEFAULT_FIXTURES_ROOT, 'inactive');

test('persistent session: browser, DevServer and CDP are started once and reused', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  // Deterministic cold start: tear down whatever earlier tests left behind.
  await defaultLifecycle.dispose();

  const analyzer = new CdpAnalyzer();
  const before = defaultLifecycle.getStats();

  const firstRun = await analyzer.analyzeFixture(INACTIVE_FIXTURE, '.non-flex', Date.now());
  const afterFirst = defaultLifecycle.getStats();

  const secondRun = await analyzer.analyzeFixture(INACTIVE_FIXTURE, '.non-flex', Date.now());
  const afterSecond = defaultLifecycle.getStats();

  assert.equal(firstRun.length, 1, 'first analysis must find the inactive declaration');
  assert.equal(secondRun.length, 1, 'reused session must produce the same result');

  // The first run cold-starts the whole session exactly once.
  assert.equal(afterFirst.chromiumLaunches - before.chromiumLaunches, 1, 'exactly one browser launch');
  assert.equal(afterFirst.devServerStarts - before.devServerStarts, 1, 'exactly one DevServer start');
  assert.equal(afterFirst.cdpConnects - before.cdpConnects, 1, 'exactly one CDP connect');

  // The second run must reuse everything — no new process, connection or server.
  assert.equal(afterSecond.chromiumLaunches - afterFirst.chromiumLaunches, 0, 'no second browser launch');
  assert.equal(afterSecond.devServerStarts - afterFirst.devServerStarts, 0, 'no second DevServer start');
  assert.equal(afterSecond.cdpConnects - afterFirst.cdpConnects, 0, 'no second CDP connect');
  assert.ok(
    afterSecond.pageReuses - afterFirst.pageReuses >= 1,
    'the loaded analysis page must be reused, not rebuilt'
  );
});

test('AST cache: identical fixture content is parsed once, then hits', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  // A scratch copy is a unique file path, so this test is robust regardless
  // of what earlier tests parsed.
  const scratchDir = copyFixtureToScratch('astcache');
  t.after(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  const analyzer = new CdpAnalyzer();
  const before = astCache.stats();

  const firstRun = await analyzer.analyzeFixture(scratchDir, '.non-flex', Date.now());
  const mid = astCache.stats();

  const secondRun = await analyzer.analyzeFixture(scratchDir, '.non-flex', Date.now());
  const after = astCache.stats();

  assert.equal(firstRun.length, 1);
  assert.equal(secondRun.length, 1);

  assert.equal(mid.misses - before.misses, 1, 'first run must parse the stylesheet once');
  assert.equal(after.misses - mid.misses, 0, 'identical content must never re-parse');
  assert.equal(after.hits - mid.hits, 1, 'second run must hit the AST cache');
});

test('mapping cache: identical CDP batch hits on the second run', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const scratchDir = copyFixtureToScratch('mapcache');
  t.after(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  const analyzer = new CdpAnalyzer();
  const before = mappingCache.stats();

  await analyzer.analyzeFixture(scratchDir, '.non-flex', Date.now());
  const mid = mappingCache.stats();

  await analyzer.analyzeFixture(scratchDir, '.non-flex', Date.now());
  const after = mappingCache.stats();

  assert.equal(mid.misses - before.misses, 1, 'first run must build the mapping');
  assert.equal(after.misses - mid.misses, 0, 'identical batch must not re-map');
  assert.equal(after.hits - mid.hits, 1, 'second run must hit the mapping cache');
});

test('CDP recovery: a lost WebSocket session is reconnected transparently', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const analyzer = new CdpAnalyzer();

  // Warm up so the session is definitely live before the forced disconnect.
  await analyzer.analyzeFixture(INACTIVE_FIXTURE, '.non-flex', Date.now());
  const before = defaultLifecycle.getStats();

  // Force the CDP session down (as if the WebSocket died).
  defaultLifecycle.getCdp().disconnect();

  const issues = await analyzer.analyzeFixture(INACTIVE_FIXTURE, '.non-flex', Date.now());
  const after = defaultLifecycle.getStats();

  assert.equal(issues.length, 1, 'analysis must succeed after reconnecting');
  assert.equal(after.cdpReconnects - before.cdpReconnects, 1, 'the session must have been recovered');
  assert.equal(after.chromiumLaunches - before.chromiumLaunches, 1, 'recovery relaunches the browser');
  assert.equal(after.cdpConnects - before.cdpConnects, 1, 'recovery reconnects CDP');
});

test('browser crash recovery: a dead Chromium is relaunched transparently', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const analyzer = new CdpAnalyzer();

  // Warm up so the session is definitely live before the crash.
  await analyzer.analyzeFixture(INACTIVE_FIXTURE, '.non-flex', Date.now());
  const before = defaultLifecycle.getStats();

  // Crash the browser process for real (SIGKILL, listeners intact).
  defaultLifecycle.getRunner().kill();

  const issues = await analyzer.analyzeFixture(INACTIVE_FIXTURE, '.non-flex', Date.now());
  const after = defaultLifecycle.getStats();

  assert.equal(issues.length, 1, 'analysis must succeed after a browser crash');
  assert.equal(after.chromiumLaunches - before.chromiumLaunches, 1, 'a new browser must be launched');
  assert.equal(after.cdpReconnects - before.cdpReconnects, 1, 'recovery must reconnect the CDP session');
});

/**
 * ── Active-editor-file analysis ─────────────────────────────────────────
 *
 * `analyzeCssFile` analyzes a standalone CSS file through the persistent
 * session (wrapper page + virtual file routes); `analyzeHtmlFile` analyzes
 * an HTML file and maps its linked stylesheets. These tests prove the
 * production entry points behind the `noEffect.analyzeCurrentFile` command.
 */

/**
 * A deterministic standalone CSS file for the CSS-file flow tests. The
 * shared root fixture is edited during manual testing, so count-based
 * assertions must never depend on its exact content — a scratch copy keeps
 * these tests stable regardless of what the user does in the workspace.
 */
function scratchStandaloneCss(): { dir: string; cssFilePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-standalone-'));
  const cssFilePath = path.join(dir, 'styles.css');
  fs.writeFileSync(
    cssFilePath,
    [
      '.non-flex {',
      '  display: block;',
      '  justify-content: center;',
      '}',
      '',
      '.flex-container {',
      '  display: block;',
      '  justify-content: center;',
      '  align-items: center;',
      '  gap: 10px;',
      '  padding: 4px;',
      '  margin: 0;',
      '}',
      '',
    ].join('\n')
  );
  return { dir, cssFilePath };
}

test('analyzeCssFile: the open CSS file produces issues mapped to that exact file', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const { dir, cssFilePath } = scratchStandaloneCss();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssFilePath, Date.now());

  // The engine flags the four inactive declarations whose elements lack a
  // flex/grid formatting context: justify-content on .non-flex, and
  // justify-content, align-items and gap on the block .flex-container.
  assert.equal(issues.length, 4, 'expected the four inactive declarations');

  for (const issue of issues) {
    assert.equal(issue.location.filePath, cssFilePath, 'every issue must map to the analyzed CSS file');
  }

  const flexIssue = issues.find(
    (issue) => issue.selectorText === '.flex-container' && issue.propertyName === 'justify-content'
  );
  assert.ok(flexIssue, 'expected a justify-content issue for the user-facing .flex-container rule');
  assert.equal(flexIssue.propertyName, 'justify-content');
  assert.equal(flexIssue.propertyValue, 'center');
  assert.equal(flexIssue.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);
  assert.ok(flexIssue.styleSheetId, 'expected a real CDP stylesheet id');
  assert.ok(flexIssue.cdpRange, 'expected a CDP source range on the issue');

  // The expanded rule set must flow through the full pipeline too:
  // align-items and gap are inactive on the block .flex-container.
  const alignItemsIssue = issues.find(
    (issue) => issue.selectorText === '.flex-container' && issue.propertyName === 'align-items'
  );
  assert.ok(alignItemsIssue, 'expected an align-items issue on the block .flex-container');
  assert.equal(alignItemsIssue.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);

  const gapIssue = issues.find(
    (issue) => issue.selectorText === '.flex-container' && issue.propertyName === 'gap'
  );
  assert.ok(gapIssue, 'expected a gap issue on the block .flex-container');
  assert.equal(gapIssue.reasonCode, REASON_CODES.REQUIRES_FLEX_GRID_OR_MULTICOL_CONTAINER);

  const lines = fs.readFileSync(cssFilePath, 'utf-8').split('\n');
  assert.ok(!isZeroRange(flexIssue.location), 'location must not be the empty placeholder range');
  assert.equal(
    rangeText(lines, flexIssue.location),
    'justify-content: center;',
    'declaration range must cover the real authored declaration text'
  );
  assert.deepEqual(flexIssue.declarationRange, flexIssue.location);
  assert.ok(flexIssue.propertyNameRange, 'expected a mapped property-name range');
  assert.equal(rangeText(lines, flexIssue.propertyNameRange), 'justify-content');
  assert.ok(flexIssue.iconAnchorRange, 'expected a mapped icon anchor range');
  assert.equal(rangeText(lines, flexIssue.iconAnchorRange), ';', 'icon anchor must be the final semicolon');
  assert.equal(rangeText(lines, gapIssue.location), 'gap: 10px;');
});

test('analyzeCssFile: identical content reuses the loaded page without refreshing', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const { dir, cssFilePath } = scratchStandaloneCss();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const analyzer = new CdpAnalyzer();

  // Warm up the session so stat deltas measure the CSS-file flow only.
  await analyzer.analyzeFixture(INACTIVE_FIXTURE, '.non-flex', Date.now());

  const before = defaultLifecycle.getStats();
  const firstRun = await analyzer.analyzeCssFile(cssFilePath, Date.now());
  const afterFirst = defaultLifecycle.getStats();

  const secondRun = await analyzer.analyzeCssFile(cssFilePath, Date.now());
  const afterSecond = defaultLifecycle.getStats();

  assert.equal(firstRun.length, 4, 'first CSS-file run must find all four inactive declarations');
  assert.equal(secondRun.length, 4, 'reused session must produce the same result');

  assert.equal(afterFirst.pageNavigations - before.pageNavigations, 1, 'first run navigates to the wrapper page');
  assert.equal(afterFirst.chromiumLaunches - before.chromiumLaunches, 0, 'no new browser for a CSS file');
  assert.equal(afterFirst.cdpConnects - before.cdpConnects, 0, 'no new CDP connection for a CSS file');

  assert.equal(
    afterSecond.pageNavigations - afterFirst.pageNavigations,
    0,
    'identical CSS content must not navigate again'
  );
  assert.ok(
    afterSecond.pageReuses - afterFirst.pageReuses >= 1,
    'the loaded wrapper page must be reused, not rebuilt'
  );
});

test('analyzeHtmlFile: the HTML flow ensures the linked sheet’s GLOBAL outcome (F4)', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  // F4 single-writer: the HTML run emits NO external-sheet issues of its
  // own — its job is to ensure the linked stylesheet’s global
  // (multi-companion) outcome is fresh in the cssGlobal namespace, which
  // the CSS editors read for decorations.
  const store = new SessionManager();
  const analyzer = new CdpAnalyzer({ globalOutcomeStore: store });
  const htmlFilePath = path.join(INACTIVE_FIXTURE, 'index.html');
  const cssFilePath = path.join(INACTIVE_FIXTURE, 'styles.css');
  const issues = await analyzer.analyzeHtmlFile(htmlFilePath, Date.now());

  assert.equal(issues.length, 0, 'the HTML run judges ONLY embedded CSS — this fixture has none');
  const external = store.getIssuesForFile(cssFilePath);
  assert.equal(external?.length, 1, 'the global outcome carries the single inactive declaration');
  const issue = external![0];
  assert.equal(issue.propertyName, 'justify-content');
  assert.equal(issue.selectorText, '.non-flex');
  assert.equal(issue.location.filePath, cssFilePath);

  const lines = fs.readFileSync(issue.location.filePath, 'utf-8').split('\n');
  assert.equal(rangeText(lines, issue.location), 'justify-content: center;');
});

test('analyzeHtmlFile: an HTML content change refreshes the page but keeps the result', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const scratchDir = copyFixtureToScratch('htmlrefresh');
  t.after(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });
  const htmlFilePath = path.join(scratchDir, 'index.html');
  const cssFilePath = path.join(scratchDir, 'styles.css');

  const store = new SessionManager();
  const analyzer = new CdpAnalyzer({ globalOutcomeStore: store });
  await analyzer.analyzeFixture(INACTIVE_FIXTURE, '.non-flex', Date.now());

  const firstRun = await analyzer.analyzeHtmlFile(htmlFilePath, Date.now());
  const afterFirst = defaultLifecycle.getStats();
  assert.equal(store.getIssuesForFile(cssFilePath)?.length, 1, 'the first run ensures the global outcome');

  const secondRun = await analyzer.analyzeHtmlFile(htmlFilePath, Date.now());
  const afterSecond = defaultLifecycle.getStats();
  assert.equal(
    store.getIssuesForFile(cssFilePath)?.length,
    1,
    'an identical rerun REUSES the recorded global outcome (F4 freshness)'
  );

  // Change the HTML content (title) but keep the same linked stylesheet.
  const html = fs.readFileSync(htmlFilePath, 'utf-8');
  fs.writeFileSync(htmlFilePath, html.replace('NoEffect Inactive Fixture', 'Changed Title'));
  const afterChange = await analyzer.analyzeHtmlFile(htmlFilePath, Date.now());
  const afterThird = defaultLifecycle.getStats();

  assert.equal(firstRun.length, 0, 'no embedded CSS in this fixture — the HTML run emits nothing');
  assert.equal(secondRun.length, 0);
  assert.equal(afterChange.length, 0);
  assert.equal(
    store.getIssuesForFile(cssFilePath)?.length,
    1,
    'a refreshed page must still keep the global outcome fresh (unchanged stylesheet)'
  );

  // The DevServer re-roots and reuses the same URL, so a content change
  // shows up as a reload; an unchanged input shows up as a plain reuse.
  // Assert the combined load count to stay robust to either branch.
  const loads = (s: { pageNavigations: number; pageReloads: number }) =>
    s.pageNavigations + s.pageReloads;

  assert.equal(loads(afterSecond) - loads(afterFirst), 0, 'identical HTML content must not reload');
  assert.equal(
    afterSecond.pageReuses - afterFirst.pageReuses,
    0,
    'the warm rerun does not touch the page at all (fresh global outcome + reused HTML cache)'
  );
  assert.equal(
    loads(afterThird) - loads(afterSecond),
    1,
    'an HTML content change must trigger a refresh'
  );
});

/**
 * ── PR6 Phase 3 ─────────────────────────────────────────────────────────
 * The expanded rule families (position, z-index, float/clear, overflow,
 * misc) flow through the exact same PR5 pipeline: real CDP computed
 * styles, registry dispatch, and mapping to local declarations. These
 * tests prove the new rules find their issues AND introduce no false
 * positives.
 */

test('phase3 fixture: position/z-index/float/clear/misc issues map with no false positives', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const fixtureDir = path.join(DEFAULT_FIXTURES_ROOT, 'phase3');
  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(path.join(fixtureDir, 'styles.css'), Date.now());

  // Exactly the 7 provably-inactive declarations of the fixture — nothing
  // else in the page may be flagged.
  assert.equal(issues.length, 7, 'expected exactly the seven inactive declarations');
  assert.equal(
    issues.length,
    new Set(issues.map((i) => `${i.selectorText}|${i.propertyName}`)).size,
    'no duplicate issues for one declaration'
  );

  const byProperty = new Map(issues.map((issue) => [issue.propertyName, issue]));
  assert.deepEqual(
    [...byProperty.keys()].sort(),
    ['clear', 'float', 'left', 'overflow', 'top', 'vertical-align', 'z-index']
  );

  const cssFilePath = path.join(fixtureDir, 'styles.css');
  const lines = fs.readFileSync(cssFilePath, 'utf-8').split('\n');

  for (const issue of issues) {
    assert.equal(issue.location.filePath, cssFilePath, 'every issue must map to the phase3 stylesheet');
    assert.ok(!isZeroRange(issue.location), 'location must not be the empty placeholder range');
    assert.ok(issue.propertyNameRange, 'expected a mapped property-name range');
    assert.ok(issue.iconAnchorRange, 'expected a mapped icon anchor range');
  }

  const top = byProperty.get('top')!;
  assert.equal(top.selectorText, '.position-static');
  assert.equal(top.reasonCode, REASON_CODES.REQUIRES_POSITIONED_ELEMENT);
  assert.equal(rangeText(lines, top.location), 'top: 10px;');

  const left = byProperty.get('left')!;
  assert.equal(left.selectorText, '.position-static');
  assert.equal(left.reasonCode, REASON_CODES.REQUIRES_POSITIONED_ELEMENT);

  const zIndex = byProperty.get('z-index')!;
  assert.equal(zIndex.selectorText, '.static-zindex');
  assert.equal(zIndex.reasonCode, REASON_CODES.REQUIRES_POSITIONED_OR_FLEX_GRID_ITEM);

  const float = byProperty.get('float')!;
  assert.equal(float.selectorText, '.flex-parent .item');
  assert.equal(float.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_FLEX_GRID_ITEM);

  const clear = byProperty.get('clear')!;
  assert.equal(clear.selectorText, '.flex-parent .item');
  assert.equal(clear.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_FLEX_GRID_ITEM);

  const verticalAlign = byProperty.get('vertical-align')!;
  assert.equal(verticalAlign.selectorText, '.block-va');
  assert.equal(verticalAlign.reasonCode, REASON_CODES.REQUIRES_INLINE_LEVEL_OR_TABLE_CELL);

  const overflow = byProperty.get('overflow')!;
  assert.equal(overflow.selectorText, '.contents-box');
  assert.equal(overflow.reasonCode, REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX);
  assert.equal(rangeText(lines, overflow.location), 'overflow: hidden;');
});

/**
 * ── PR7 ────────────────────────────────────────────────────────────────
 * The extended applicability families (flex-only container properties,
 * grid template properties, table-internal padding, anchor positioning,
 * inline sizing and the reworked alignment/gap semantics) flow through
 * the exact same pipeline: real CDP computed styles, registry dispatch
 * and mapping to local declarations. Exactly the 11 provably-inactive
 * declarations of the fixture are expected — the active control elements
 * in the same page must never produce an issue.
 */

test('phase4 fixture: extended applicability rules map with no false positives', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const fixtureDir = path.join(DEFAULT_FIXTURES_ROOT, 'phase4');
  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(path.join(fixtureDir, 'styles.css'), Date.now());

  // Exactly the 11 provably-inactive declarations of the fixture.
  assert.equal(issues.length, 11, 'expected exactly the eleven inactive declarations');
  assert.equal(
    issues.length,
    new Set(issues.map((i) => `${i.selectorText}|${i.propertyName}`)).size,
    'no duplicate issues for one declaration'
  );

  const cssFilePath = path.join(fixtureDir, 'styles.css');
  const lines = fs.readFileSync(cssFilePath, 'utf-8').split('\n');

  for (const issue of issues) {
    assert.equal(issue.location.filePath, cssFilePath, 'every issue must map to the phase4 stylesheet');
    assert.ok(!isZeroRange(issue.location), 'location must not be the empty placeholder range');
    assert.ok(issue.propertyNameRange, 'expected a mapped property-name range');
    assert.ok(issue.iconAnchorRange, 'expected a mapped icon anchor range');
  }

  const byKey = new Map(issues.map((issue) => [`${issue.selectorText}|${issue.propertyName}`, issue]));

  const expectInactive = (selector: string, propertyName: string, reasonCode: string, text: string) => {
    const issue = byKey.get(`${selector}|${propertyName}`);
    assert.ok(issue, `expected ${propertyName} on ${selector}`);
    assert.equal(issue.reasonCode, reasonCode, `${propertyName} on ${selector} must use the exact reason code`);
    assert.equal(rangeText(lines, issue.location), text, `declaration range must cover ${propertyName}`);
  };

  // Inline non-replaced sizing.
  expectInactive(
    '.inline-size', 'width', REASON_CODES.NOT_APPLICABLE_TO_INLINE_BOX, 'width: 200px;'
  );
  expectInactive(
    '.inline-size', 'height', REASON_CODES.NOT_APPLICABLE_TO_INLINE_BOX, 'height: 100px;'
  );

  // Table-internal padding.
  expectInactive(
    '.table-row-pad', 'padding', REASON_CODES.NOT_APPLICABLE_TO_TABLE_INTERNAL_BOX, 'padding: 8px;'
  );

  // Flex-only container properties.
  expectInactive(
    '.block-flexprops', 'flex-direction', REASON_CODES.REQUIRES_FLEX_CONTAINER, 'flex-direction: row;'
  );
  expectInactive(
    '.block-flexprops', 'flex-wrap', REASON_CODES.REQUIRES_FLEX_CONTAINER, 'flex-wrap: wrap;'
  );

  // Grid container properties.
  expectInactive(
    '.block-gridprops', 'grid-template-columns', REASON_CODES.REQUIRES_GRID_CONTAINER, 'grid-template-columns: 1fr 1fr;'
  );
  expectInactive(
    '.block-gridprops', 'grid-auto-rows', REASON_CODES.REQUIRES_GRID_CONTAINER, 'grid-auto-rows: auto;'
  );

  // Gap needs a flex/grid/multicol container.
  expectInactive(
    '.block-gap', 'gap', REASON_CODES.REQUIRES_FLEX_GRID_OR_MULTICOL_CONTAINER, 'gap: 8px;'
  );

  // Anchor positioning.
  expectInactive(
    '.static-anchor', 'position-anchor', REASON_CODES.REQUIRES_ABSOLUTE_OR_FIXED_POSITION, 'position-anchor: auto;'
  );

  // Alignment-content semantics (PR6: container-required).
  expectInactive(
    '.inline-align', 'align-content', REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER, 'align-content: center;'
  );
  expectInactive(
    '.flex-nowrap', 'align-content', REASON_CODES.PREVENTED_BY_FLEX_WRAP_NOWRAP, 'align-content: center;'
  );

  // The active control elements must produce nothing: replaced inline img,
  // multicol gap and a real grid container.
  const activeKeys = [
    '.inline-img|width',
    '.multicol-gap|gap',
    '.grid-ok|grid-template-columns',
  ];
  for (const key of activeKeys) {
    assert.ok(!byKey.has(key), `expected no issue for active control ${key}`);
  }
});

/**
 * ── Advanced-context (Level 2) ────────────────────────────────────────
 * The compound multi-condition rules (out-of-flow flex/grid items,
 * composite text-overflow truncation, inline non-replaced suppression and
 * place-self in the place-* family) flow through the exact same pipeline.
 * Exactly the 17 provably-inactive declarations of the phase5 fixture are
 * expected — the active control elements must never produce an issue.
 */

test('phase5 fixture: advanced-context composite rules map with no false positives', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const fixtureDir = path.join(DEFAULT_FIXTURES_ROOT, 'phase5');
  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(path.join(fixtureDir, 'styles.css'), Date.now());

  // Exactly the 17 provably-inactive declarations of the fixture.
  assert.equal(issues.length, 17, 'expected exactly the seventeen inactive declarations');
  assert.equal(
    issues.length,
    new Set(issues.map((i) => `${i.selectorText}|${i.propertyName}`)).size,
    'no duplicate issues for one declaration'
  );

  const cssFilePath = path.join(fixtureDir, 'styles.css');
  const lines = fs.readFileSync(cssFilePath, 'utf-8').split('\n');

  for (const issue of issues) {
    assert.equal(issue.location.filePath, cssFilePath, 'every issue must map to the phase5 stylesheet');
    assert.ok(!isZeroRange(issue.location), 'location must not be the empty placeholder range');
    assert.ok(issue.propertyNameRange, 'expected a mapped property-name range');
    assert.ok(issue.iconAnchorRange, 'expected a mapped icon anchor range');
  }

  const byKey = new Map(issues.map((issue) => [`${issue.selectorText}|${issue.propertyName}`, issue]));

  const expectInactive = (selector: string, propertyName: string, reasonCode: string, text: string) => {
    const issue = byKey.get(`${selector}|${propertyName}`);
    assert.ok(issue, `expected ${propertyName} on ${selector}`);
    assert.equal(issue.reasonCode, reasonCode, `${propertyName} on ${selector} must use the exact reason code`);
    assert.equal(rangeText(lines, issue.location), text, `declaration range must cover ${propertyName}`);
  };

  // Case 1: out-of-flow flex items.
  expectInactive('.abs-flex', 'flex', REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX, 'flex: 1;');
  expectInactive('.abs-flex', 'flex-grow', REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX, 'flex-grow: 2;');
  expectInactive('.abs-flex', 'align-self', REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX, 'align-self: center;');
  expectInactive('.abs-flex', 'order', REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX, 'order: 3;');

  // Case 1: out-of-flow grid items.
  expectInactive('.abs-grid', 'grid-column', REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX, 'grid-column: 1 / 3;');
  expectInactive('.abs-grid', 'grid-column-start', REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX, 'grid-column-start: 1;');
  expectInactive('.abs-grid', 'grid-area', REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX, 'grid-area: 1 / 1 / 2 / 3;');
  expectInactive('.abs-grid', 'justify-self', REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX, 'justify-self: center;');

  // Case 2: composite text-truncation.
  expectInactive('.trunc-missing-overflow', 'text-overflow', REASON_CODES.REQUIRES_TRUNCATION_PRECONDITIONS, 'text-overflow: ellipsis;');
  expectInactive('.trunc-missing-nowrap', 'text-overflow', REASON_CODES.REQUIRES_TRUNCATION_PRECONDITIONS, 'text-overflow: ellipsis;');

  // Case 3: inline non-replaced suppression.
  expectInactive('.inline-geometry', 'margin-top', REASON_CODES.NOT_APPLICABLE_TO_INLINE_BOX, 'margin-top: 30px;');
  expectInactive('.inline-geometry', 'margin-bottom', REASON_CODES.NOT_APPLICABLE_TO_INLINE_BOX, 'margin-bottom: 30px;');
  expectInactive('.inline-geometry', 'padding-top', REASON_CODES.NOT_APPLICABLE_TO_INLINE_BOX, 'padding-top: 10px;');
  expectInactive('.inline-geometry', 'padding-bottom', REASON_CODES.NOT_APPLICABLE_TO_INLINE_BOX, 'padding-bottom: 10px;');
  expectInactive('.inline-geometry', 'transform', REASON_CODES.NOT_APPLICABLE_TO_INLINE_BOX, 'transform: rotate(45deg);');
  expectInactive('.inline-geometry', 'perspective', REASON_CODES.NOT_APPLICABLE_TO_INLINE_BOX, 'perspective: 500px;');

  // Case 4: place-self grouped with the place-* family.
  expectInactive('.plain-block', 'place-self', REASON_CODES.REQUIRES_FLEX_OR_GRID_ITEM, 'place-self: center;');

  // The active control elements must produce nothing.
  const activeKeys = [
    '.flex-item-ok|flex',
    '.grid-item-ok|grid-column',
    '.trunc-valid|text-overflow',
    '.inline-img|transform',
    '.inline-horizontal-padding|padding-left',
    '.inline-horizontal-padding|padding-right',
    '.block-transform|transform',
    '.flex-item-place|place-self',
  ];
  for (const key of activeKeys) {
    assert.ok(!byKey.has(key), `expected no issue for active control ${key}`);
  }
});

/**
 * ── PR Level 3 + pseudo formatting contexts ─────────────────────────────
 * The pseudo-element rules (::before/::after content existence,
 * ::first-letter property eligibility) and the scroll-container-dependent
 * properties (scrollbar-gutter, overscroll-behavior) flow through the
 * exact same pipeline: real CDP matched styles (including the
 * `pseudoElements` section), registry dispatch and mapping to local
 * declarations. Pseudo declarations that the pseudo-type rule accepts are
 * additionally judged by their property rule against the pseudo BOX's
 * formatting context: `margin-top` on a ::first-letter box (a non-replaced
 * inline box) is inactive even though the margin family is whitelisted.
 * Exactly the 10 provably-inactive declarations of the phase6 fixture are
 * expected — the active control elements must never produce an issue.
 */

test('phase6 fixture: pseudo-element and scroll-context rules map with no false positives', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const fixtureDir = path.join(DEFAULT_FIXTURES_ROOT, 'phase6');
  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(path.join(fixtureDir, 'styles.css'), Date.now());

  // Exactly the 10 provably-inactive declarations of the fixture.
  assert.equal(issues.length, 10, 'expected exactly the ten inactive declarations');
  assert.equal(
    issues.length,
    new Set(issues.map((i) => `${i.selectorText}|${i.propertyName}`)).size,
    'no duplicate issues for one declaration'
  );

  const cssFilePath = path.join(fixtureDir, 'styles.css');
  const lines = fs.readFileSync(cssFilePath, 'utf-8').split('\n');

  for (const issue of issues) {
    assert.equal(issue.location.filePath, cssFilePath, 'every issue must map to the phase6 stylesheet');
    assert.ok(!isZeroRange(issue.location), 'location must not be the empty placeholder range');
    assert.ok(issue.propertyNameRange, 'expected a mapped property-name range');
    assert.ok(issue.iconAnchorRange, 'expected a mapped icon anchor range');
  }

  const byKey = new Map(issues.map((issue) => [`${issue.selectorText}|${issue.propertyName}`, issue]));

  const expectInactive = (selector: string, propertyName: string, reasonCode: string, text: string) => {
    const issue = byKey.get(`${selector}|${propertyName}`);
    assert.ok(issue, `expected ${propertyName} on ${selector}`);
    assert.equal(issue.reasonCode, reasonCode, `${propertyName} on ${selector} must use the exact reason code`);
    assert.equal(rangeText(lines, issue.location), text, `declaration range must cover ${propertyName}`);
  };

  // Case 1: generated pseudo-elements without content.
  expectInactive('.no-content-pseudo::before', 'width', REASON_CODES.GENERATED_PSEUDO_MISSING, 'width: 100px;');
  expectInactive('.no-content-pseudo::before', 'height', REASON_CODES.GENERATED_PSEUDO_MISSING, 'height: 50px;');
  expectInactive('.no-content-pseudo::before', 'background-color', REASON_CODES.GENERATED_PSEUDO_MISSING, 'background-color: red;');
  expectInactive('.no-content-pseudo::before', 'display', REASON_CODES.GENERATED_PSEUDO_MISSING, 'display: block;');
  expectInactive('.no-content-after-pseudo::after', 'display', REASON_CODES.GENERATED_PSEUDO_MISSING, 'display: grid;');

  // Case 2: ::first-letter property eligibility and box formatting context.
  expectInactive('.article-text::first-letter', 'display', REASON_CODES.FIRST_LETTER_UNSUPPORTED_PROPERTY, 'display: flex;');
  expectInactive('.article-text::first-letter', 'position', REASON_CODES.FIRST_LETTER_UNSUPPORTED_PROPERTY, 'position: absolute;');
  expectInactive('.article-text::first-letter', 'margin-top', REASON_CODES.NOT_APPLICABLE_TO_INLINE_BOX, 'margin-top: 15px;');

  // Case 3: scroll-container-dependent properties.
  expectInactive('.non-scroll-box', 'scrollbar-gutter', REASON_CODES.REQUIRES_SCROLL_CONTAINER, 'scrollbar-gutter: stable;');
  expectInactive('.non-scroll-box', 'overscroll-behavior', REASON_CODES.REQUIRES_SCROLL_CONTAINER, 'overscroll-behavior: contain;');

  // The active control elements must produce nothing.
  const activeKeys = [
    '.with-content-pseudo::before|width',
    '.with-content-pseudo::before|background-color',
    '.with-content-pseudo::before|content',
    '.with-content-pseudo::before|display',
    '.with-content-pseudo::before|justify-content',
    '.with-content-pseudo::before|position',
    '.with-content-pseudo::before|width',
    '.with-content-pseudo::before|height',
    '.with-content-after-pseudo::after|content',
    '.with-content-after-pseudo::after|display',
    '.with-content-after-pseudo::after|grid-template-columns',
    '.with-content-after-pseudo::after|position',
    '.with-content-after-pseudo::after|width',
    '.with-content-after-pseudo::after|height',
    '.article-text::first-letter|font-size',
    '.article-text::first-letter|color',
    '.first-letter-float::first-letter|font-size',
    '.first-letter-float::first-letter|float',
    '.first-letter-float::first-letter|margin-right',
    '.scroll-box|scrollbar-gutter',
    '.scroll-box|overscroll-behavior',
  ];
  for (const key of activeKeys) {
    assert.ok(!byKey.has(key), `expected no issue for active control ${key}`);
  }
});

/**
 * ── PR "pseudo formatting contexts" regression ───────────────────────────
 * The reported case: a `::first-letter` box is a non-replaced inline box,
 * so `margin-top` on it is ignored even though the first-letter whitelist
 * accepts the margin family. The pseudo-type rule (whitelist) abstains on
 * `margin-top`; the engine then consults the margin-top property rule
 * against the COMPUTED pseudo box context (display inline) — the box's
 * authored `display: flex` does NOT leak into the box because Chromium
 * ignores authored display/position on `::first-letter`. The valid
 * first-letter properties (font-size/color/font-weight) stay active.
 */

test('analyzeCssFile: margin-top on a ::first-letter box is dimmed while valid first-letter properties stay active', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-firstletter-'));
  const cssFilePath = path.join(dir, 'styles.css');
  fs.writeFileSync(
    cssFilePath,
    [
      '.first-letter-case::first-letter {',
      '  display: flex;',
      '  position: absolute;',
      '  transform: translateY(8px);',
      '  margin-top: 8px;',
      '  font-size: 40px;',
      '  color: #b00;',
      '  font-weight: 700;',
      '}',
      '',
      '.first-letter-float-case::first-letter {',
      '  float: left;',
      '  margin-right: 8px;',
      '}',
      '',
    ].join('\n')
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssFilePath, Date.now());

  const byKey = new Map(issues.map((issue) => [`${issue.selectorText}|${issue.propertyName}`, issue]));

  // The four provably-inactive first-letter declarations.
  assert.equal(byKey.get('.first-letter-case::first-letter|display')?.reasonCode, REASON_CODES.FIRST_LETTER_UNSUPPORTED_PROPERTY);
  assert.equal(byKey.get('.first-letter-case::first-letter|position')?.reasonCode, REASON_CODES.FIRST_LETTER_UNSUPPORTED_PROPERTY);
  assert.equal(byKey.get('.first-letter-case::first-letter|transform')?.reasonCode, REASON_CODES.FIRST_LETTER_UNSUPPORTED_PROPERTY);
  assert.equal(byKey.get('.first-letter-case::first-letter|margin-top')?.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_INLINE_BOX);

  // The whitelisted first-letter text properties stay valid.
  assert.ok(!byKey.has('.first-letter-case::first-letter|font-size'), 'font-size must stay active on the first letter');
  assert.ok(!byKey.has('.first-letter-case::first-letter|color'), 'color must stay active on the first letter');
  assert.ok(!byKey.has('.first-letter-case::first-letter|font-weight'), 'font-weight must stay active on the first letter');

  // A floated first-letter is a blockified box that honors margins — active.
  assert.ok(!byKey.has('.first-letter-float-case::first-letter|float'), 'a floated first-letter must stay active');
  assert.ok(!byKey.has('.first-letter-float-case::first-letter|margin-right'), 'margins on a floated first-letter must stay active');

  // Nothing else on the first-letter boxes may be flagged.
  const firstLetterIssues = issues.filter((i) => (i.selectorText ?? '').includes('first-letter'));
  assert.equal(firstLetterIssues.length, 4, 'exactly the four provably-inactive first-letter declarations');
});

/**
 * ── PR "Context Resolution Hardening" ────────────────────────────────────
 * The phase7 fixture covers the three regression cases of the context
 * hardening PR:
 *   1. vertical-align on a `table-cell` whose table box was overridden to
 *      `display: block` (broken table context) is flagged; the intact
 *      table control stays active.
 *   2. place-self on a real flex item whose display is EXPLICITLY
 *      overridden to `display: block` is flagged; the implicit item
 *      control stays active.
 *   3. flex on a real flex child stays active (no false positive).
 * Exactly the 2 provably-inactive declarations are expected.
 */

test('phase7 fixture: context hardening maps the two inactive declarations with no false positives', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const fixtureDir = path.join(DEFAULT_FIXTURES_ROOT, 'phase7');
  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(path.join(fixtureDir, 'styles.css'), Date.now());

  assert.equal(issues.length, 2, 'expected exactly the two inactive declarations');
  assert.equal(
    issues.length,
    new Set(issues.map((i) => `${i.selectorText}|${i.propertyName}`)).size,
    'no duplicate issues for one declaration'
  );

  const cssFilePath = path.join(fixtureDir, 'styles.css');
  const lines = fs.readFileSync(cssFilePath, 'utf-8').split('\n');

  for (const issue of issues) {
    assert.equal(issue.location.filePath, cssFilePath, 'every issue must map to the phase7 stylesheet');
    assert.ok(!isZeroRange(issue.location), 'location must not be the empty placeholder range');
    assert.ok(issue.propertyNameRange, 'expected a mapped property-name range');
    assert.ok(issue.iconAnchorRange, 'expected a mapped icon anchor range');
  }

  const byKey = new Map(issues.map((issue) => [`${issue.selectorText}|${issue.propertyName}`, issue]));

  const expectInactive = (selector: string, propertyName: string, reasonCode: string, text: string) => {
    const issue = byKey.get(`${selector}|${propertyName}`);
    assert.ok(issue, `expected ${propertyName} on ${selector}`);
    assert.equal(issue.reasonCode, reasonCode, `${propertyName} on ${selector} must use the exact reason code`);
    assert.equal(rangeText(lines, issue.location), text, `declaration range must cover ${propertyName}`);
  };

  // Case 1: broken table context (the .table-case display: block override).
  expectInactive('.cell-broken', 'vertical-align', REASON_CODES.BROKEN_TABLE_CONTEXT, 'vertical-align: middle;');

  // Case 2: explicit display: block override removes the placement context.
  expectInactive('.place-bad', 'place-self', REASON_CODES.REQUIRES_FLEX_OR_GRID_ITEM, 'place-self: center;');

  // The active controls must produce nothing.
  const activeKeys = [
    '.cell-intact|vertical-align',
    '.place-good|place-self',
    '.flex-child|flex',
  ];
  for (const key of activeKeys) {
    assert.ok(!byKey.has(key), `expected no issue for active control ${key}`);
  }
});

test('analyzeCssFile: a standalone .flex-item keeps flex active (synthetic-parent hardening)', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-standalone-'));
  const cssFilePath = path.join(dir, 'styles.css');
  fs.writeFileSync(
    cssFilePath,
    [
      '.flex-item {',
      '  flex: 1;',
      '}',
      '',
    ].join('\n')
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssFilePath, Date.now());

  // The wrapper page places .flex-item under a synthetic <body> parent; the
  // real document parent is unknowable, so the item-dependent `flex` rule
  // must take the conservative no-decision path — never a false flag.
  assert.equal(issues.length, 0, 'a standalone .flex-item must not be flagged in the CSS-file flow');
});

/**
 * ── PR "Inactive Rules Regressions" (Level 5) ────────────────────────────
 * The standalone CSS-file flow previously lost context the HTML flow
 * already had:
 *   1. `flex-basis` (and friends) on a `position: absolute` rule was not
 *      flagged, because the synthetic wrapper reports no parent and the
 *      old out-of-flow condition required a known item parent.
 *   2. `place-self` under an explicit `display: block` override was not
 *      flagged, because the old override check ran AFTER the parent-unknown
 *      guard.
 *   3. `z-index` on a static rule was not flagged, because the z-index rule
 *      refused to decide whenever the parent display was 'none', treating
 *      it as the possibly-the-document-root ambiguity — but the synthetic
 *      wrapper parent provably cannot be the document root.
 *
 * The object-fit family moved to the Level-6 test below (operative element
 * type verdicts).
 */

test('analyzeCssFile: the three Level-5 regression cases resolve with no false positives', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-level5-'));
  const cssFilePath = path.join(dir, 'styles.css');
  fs.writeFileSync(
    cssFilePath,
    [
      '.abs-flex-item {',
      '  position: absolute;',
      '  order: 2;',
      '  flex-basis: 120px;',
      '}',
      '',
      '.place-item.bad {',
      '  display: block;',
      '  place-self: center;',
      '}',
      '',
      '.place-item.good {',
      '  place-self: center;',
      '}',
      '',
      '.static-box {',
      '  position: static;',
      '  z-index: 5;',
      '}',
      '',
    ].join('\n')
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssFilePath, Date.now());

  // Case 1: order + flex-basis on the out-of-flow .abs-flex-item are flagged
  // (out-of-flow wins over the unknown synthetic parent).
  // Case 2: place-self under the explicit display: block override is flagged.
  // Case 4: z-index on the synthetic-parent .static-box is flagged (the
  // synthetic wrapper parent provably cannot be the document root).
  const byKey = new Map(issues.map((issue) => [`${issue.selectorText}|${issue.propertyName}`, issue]));
  assert.equal(issues.length, 4, 'expected exactly the four provably-inactive declarations');
  assert.equal(
    issues.length,
    new Set(issues.map((i) => `${i.selectorText}|${i.propertyName}`)).size,
    'no duplicate issues for one declaration'
  );

  for (const issue of issues) {
    assert.equal(issue.location.filePath, cssFilePath, 'every issue must map to the analyzed CSS file');
    assert.ok(!isZeroRange(issue.location), 'location must not be the empty placeholder range');
    assert.ok(issue.propertyNameRange, 'expected a mapped property-name range');
    assert.ok(issue.iconAnchorRange, 'expected a mapped icon anchor range');
  }

  const flexBasis = byKey.get('.abs-flex-item|flex-basis');
  assert.ok(flexBasis, 'expected flex-basis flagged on the out-of-flow .abs-flex-item');
  assert.equal(flexBasis.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX);

  const order = byKey.get('.abs-flex-item|order');
  assert.ok(order, 'expected order flagged on the out-of-flow .abs-flex-item');
  assert.equal(order.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX);

  const placeSelf = byKey.get('.place-item.bad|place-self');
  assert.ok(placeSelf, 'expected place-self flagged under the explicit display: block override');
  assert.equal(placeSelf.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_ITEM);

  const zIndex = byKey.get('.static-box|z-index');
  assert.ok(zIndex, 'expected z-index flagged on the synthetic-parent .static-box');
  assert.equal(zIndex.reasonCode, REASON_CODES.REQUIRES_POSITIONED_OR_FLEX_GRID_ITEM);

  // The active control elements must produce nothing:
  //  - .place-item.good keeps place-self active (parent unknown, no override).
  const activeKeys = [
    '.place-item.good|place-self',
  ];
  for (const key of activeKeys) {
    assert.ok(!byKey.has(key), `expected no issue for active control ${key}`);
  }

  const lines = fs.readFileSync(cssFilePath, 'utf-8').split('\n');
  assert.equal(rangeText(lines, flexBasis.location), 'flex-basis: 120px;');
  assert.equal(rangeText(lines, order.location), 'order: 2;');
  assert.equal(rangeText(lines, placeSelf.location), 'place-self: center;');
  assert.equal(rangeText(lines, zIndex.location), 'z-index: 5;');
});

/**
 * ── PR "Replaced Elements Context Detection" (Level 6) ───────────────────
 * `object-fit`/`object-position` only apply to replaced elements. The
 * verdict comes from the element's node name — the operative element type:
 * the real document tag in the HTML flow, the wrapper-emitted tag in the
 * CSS-file flow. A bare class/id selector in the CSS-file flow fabricates
 * a `<div>` stand-in whose type is NOT a fact from the user's document —
 * the real element could be an `<img>` — so these rules ABSTAIN on
 * fabricated types. An explicitly-tagged non-replaced `div.x` IS provably
 * non-replaced and is dimmed; a tag-naming replaced `img.x`/`video.x`
 * builds the real element (active). The real-document distinction — a
 * `.object-fit-img` on an actual `<img>` vs a `.object-fit-box` on a
 * `<div>` — is asserted by the HTML-flow test that follows.
 */

test('analyzeCssFile: object-fit/object-position respect proven, not fabricated, element types (Level 6)', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-level6-'));
  const cssFilePath = path.join(dir, 'styles.css');
  fs.writeFileSync(
    cssFilePath,
    [
      // Explicitly tagged non-replaced -> provably no effect (dimmed).
      'div.explicit-box {',
      '  object-fit: cover;',
      '  object-position: center;',
      '}',
      '',
      // Tag-naming replaced elements -> active.
      'img.object-fit-img {',
      '  object-fit: cover;',
      '  object-position: center;',
      '}',
      '',
      'video.hero {',
      '  object-fit: contain;',
      '}',
      '',
      // Bare classes fabricate an unknown type -> no decision (stay active).
      '.object-fit-box {',
      '  object-fit: cover;',
      '}',
      '',
      '.object-fit-img {',
      '  object-fit: cover;',
      '}',
      '',
    ].join('\n')
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssFilePath, Date.now());

  const byKey = new Map(issues.map((issue) => [`${issue.selectorText}|${issue.propertyName}`, issue]));

  // Bare classes fabricate an UNKNOWN element type — no decision, so
  // object-fit/object-position stay active (the reported false positive).
  // Only the explicit `div.explicit-box` is provably non-replaced.
  assert.equal(issues.length, 2, 'expected exactly the two provably-inactive declarations');
  assert.equal(
    issues.length,
    new Set(issues.map((i) => `${i.selectorText}|${i.propertyName}`)).size,
    'no duplicate issues for one declaration'
  );

  for (const issue of issues) {
    assert.equal(issue.location.filePath, cssFilePath, 'every issue must map to the analyzed CSS file');
    assert.ok(!isZeroRange(issue.location), 'location must not be the empty placeholder range');
    assert.ok(issue.propertyNameRange, 'expected a mapped property-name range');
    assert.ok(issue.iconAnchorRange, 'expected a mapped icon anchor range');
  }

  const boxFit = byKey.get('div.explicit-box|object-fit');
  assert.ok(boxFit, 'expected object-fit dimmed on the explicitly-tagged div.explicit-box');
  assert.equal(boxFit.reasonCode, REASON_CODES.REQUIRES_REPLACED_ELEMENT);

  const boxPosition = byKey.get('div.explicit-box|object-position');
  assert.ok(boxPosition, 'expected object-position dimmed on the explicitly-tagged div.explicit-box');
  assert.equal(boxPosition.reasonCode, REASON_CODES.REQUIRES_REPLACED_ELEMENT);

  // Fabricated (bare-class) and replaced (tag-naming) types are NOT provably
  // non-replaced, so object-fit/object-position stay active.
  const activeKeys = [
    'img.object-fit-img|object-fit',
    'img.object-fit-img|object-position',
    'video.hero|object-fit',
    '.object-fit-box|object-fit',
    '.object-fit-img|object-fit',
  ];
  for (const key of activeKeys) {
    assert.ok(!byKey.has(key), `expected no issue for ${key} — not a provably non-replaced type`);
  }

  const lines = fs.readFileSync(cssFilePath, 'utf-8').split('\n');
  assert.equal(rangeText(lines, boxFit.location), 'object-fit: cover;');
  assert.equal(rangeText(lines, boxPosition.location), 'object-position: center;');
});

/**
 * ── PR "Replaced Elements Context Detection" — HTML-flow regression ──────
 * In a REAL document (HTML flow) the element type is a database, factual
 * tag, never a fabric conventional guess. So `.object-fit-img` on an actual
 * `<img class="object-fit-img">` must stay active (the reported false
 * positive), while `.object-fit-box` on a real `<div>` must stay dimmed.
 * This is the real-DOM counterpart to the Level-6 CSS-flow test above.
 */

test('analyzeHtmlFile: a real <img> keeps object-fit active while a real <div> is dimmed (Level 6)', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-level6-html-'));
  const htmlFilePath = path.join(dir, 'index.html');
  const cssFilePath = path.join(dir, 'styles.css');
  fs.writeFileSync(
    htmlFilePath,
    [
      '<!DOCTYPE html>',
      '<html lang="en"><head><link rel="stylesheet" href="styles.css"></head><body>',
      '<div class="object-fit-box">object-fit on div</div>',
      '<img class="object-fit-img" alt="x" src="data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'10\'></svg>">',
      '</body></html>',
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    cssFilePath,
    [
      '.object-fit-box {',
      '  object-fit: cover;',
      '  object-position: center;',
      '}',
      '',
      '.object-fit-img {',
      '  object-fit: cover;',
      '  object-position: center;',
      '}',
      '',
    ].join('\n')
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // F4: the HTML run ensures the linked sheet’s GLOBAL outcome; the
  // external-sheet verdicts live in the cssGlobal namespace.
  const store = new SessionManager();
  const analyzer = new CdpAnalyzer({ globalOutcomeStore: store });
  const issues = await analyzer.analyzeHtmlFile(htmlFilePath, Date.now());
  assert.equal(issues.length, 0, 'no embedded CSS — the HTML run emits nothing');
  const external = store.getIssuesForFile(cssFilePath) ?? [];

  const byKey = new Map(external.map((issue) => [`${issue.selectorText}|${issue.propertyName}`, issue]));

  // The real `<div class="object-fit-box">` is a non-replaced element — dimmed.
  assert.equal(byKey.get('.object-fit-box|object-fit')?.reasonCode, REASON_CODES.REQUIRES_REPLACED_ELEMENT);
  assert.equal(byKey.get('.object-fit-box|object-position')?.reasonCode, REASON_CODES.REQUIRES_REPLACED_ELEMENT);

  // The real `<img class="object-fit-img">` is a replaced element — active.
  assert.ok(!byKey.has('.object-fit-img|object-fit'), 'object-fit must stay active on a real <img>');
  assert.ok(!byKey.has('.object-fit-img|object-position'), 'object-position must stay active on a real <img>');
});

/**
 * ── Companion-document resolution (Level 6) ──────────────────────────────
 * `analyzeCssFile` prefers the REAL document when one in the same directory
 * links the analyzed stylesheet: element types then come from the user's
 * DOM, not from a fabricated `<div>`. This makes the fixture's expectations
 * hold in the CSS-file flow too — `.object-fit-box` (a real `<div>`) is
 * dimmed while `.object-fit-img` (a real `<img>`) stays active, both from
 * the CSS file alone.
 */

test('analyzeCssFile: a companion document makes bare-class selectors use their real element types (Level 6)', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-level6-companion-'));
  const cssFilePath = path.join(dir, 'styles.css');
  const htmlFilePath = path.join(dir, 'index.html');
  fs.writeFileSync(
    htmlFilePath,
    [
      '<!DOCTYPE html>',
      '<html lang="en"><head><link rel="stylesheet" href="styles.css"></head><body>',
      '<div class="object-fit-box">object-fit on div</div>',
      '<img class="object-fit-img" alt="x" src="data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'10\'></svg>">',
      '</body></html>',
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    cssFilePath,
    [
      '.object-fit-box {',
      '  object-fit: cover;',
      '  object-position: center;',
      '}',
      '',
      '.object-fit-img {',
      '  object-fit: cover;',
      '}',
      '',
    ].join('\n')
  );
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssFilePath, Date.now());

  const byKey = new Map(issues.map((issue) => [`${issue.selectorText}|${issue.propertyName}`, issue]));

  // The companion `<div class="object-fit-box">` is a real non-replaced
  // element — dimmed even though the selector is a bare class.
  const boxFit = byKey.get('.object-fit-box|object-fit');
  const boxPosition = byKey.get('.object-fit-box|object-position');
  assert.ok(boxFit, 'expected object-fit dimmed on the companion-document <div>');
  assert.equal(boxFit.reasonCode, REASON_CODES.REQUIRES_REPLACED_ELEMENT);
  assert.ok(boxPosition, 'expected object-position dimmed on the companion-document <div>');
  assert.equal(boxPosition.reasonCode, REASON_CODES.REQUIRES_REPLACED_ELEMENT);

  // The companion `<img class="object-fit-img">` is a real replaced
  // element — stays active.
  assert.ok(!byKey.has('.object-fit-img|object-fit'), 'object-fit must stay active on the companion <img>');

  // Every issue still maps back to the analyzed CSS file.
  assert.equal(issues.length, 2, 'expected exactly the two dimmed box declarations');
  for (const issue of issues) {
    assert.equal(issue.location.filePath, cssFilePath);
    assert.ok(!isZeroRange(issue.location), 'location must not be the empty placeholder range');
  }

  const lines = fs.readFileSync(cssFilePath, 'utf-8').split('\n');
  assert.equal(rangeText(lines, boxFit.location), 'object-fit: cover;');
  assert.equal(rangeText(lines, boxPosition.location), 'object-position: center;');
});

/**
 * ── PR "Embedded CSS" (Level 9) ─────────────────────────────────────────
 * `analyzeHtmlFile` now analyzes `<style>` blocks and `style=""`
 * attributes of the HTML file itself, alongside its linked stylesheets.
 * Embedded declarations map back into the HTML DOCUMENT — the style block
 * rule maps to its declaration inside `<style>`, the inline declaration
 * maps to its slice of the attribute VALUE text. All three flows share
 * the same engine, and a duplicated property value across the three
 * sources stays three distinct issues (distinct locations, never merged).
 */

const EMBEDDED_FIXTURE = path.join(DEFAULT_FIXTURES_ROOT, 'embedded');

test('embedded fixture: <style> block and style attribute issues map into the HTML document', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const htmlFilePath = path.join(EMBEDDED_FIXTURE, 'index.html');
  const cssFilePath = path.join(EMBEDDED_FIXTURE, 'styles.css');
  const store = new SessionManager();
  const analyzer = new CdpAnalyzer({ globalOutcomeStore: store });
  const issues = await analyzer.analyzeHtmlFile(htmlFilePath, Date.now());
  const external = store.getIssuesForFile(cssFilePath) ?? [];

  // One inactive justify-content per source: the global stylesheet (the
  // cssGlobal namespace), the <style> block and the style="" attribute
  // (the page-local HTML run).
  assert.equal(issues.length, 2, 'the HTML run emits the two embedded issues');
  assert.equal(external.length, 1, 'the external stylesheet issue lives in the cssGlobal namespace');

  // The inline issue carries no selector (a style attribute has none).
  const inlineIssue = issues.find((issue) => issue.selectorText === '');
  assert.ok(inlineIssue, 'expected the inline style-attribute issue');
  assert.equal(inlineIssue.propertyName, 'justify-content');
  assert.equal(inlineIssue.propertyValue, 'space-between');
  assert.equal(inlineIssue.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);
  assert.equal(inlineIssue.location.filePath, htmlFilePath, 'the inline issue must map into the HTML file');

  const htmlLines = fs.readFileSync(htmlFilePath, 'utf-8').split('\n');
  assert.ok(!isZeroRange(inlineIssue.location), 'location must not be the empty placeholder range');
  assert.equal(
    rangeText(htmlLines, inlineIssue.location),
    'justify-content: space-between;',
    'the inline declaration range must slice exactly the attribute text'
  );
  assert.ok(inlineIssue.propertyNameRange, 'expected a mapped property-name range');
  assert.equal(rangeText(htmlLines, inlineIssue.propertyNameRange), 'justify-content');
  assert.ok(inlineIssue.iconAnchorRange, 'expected a mapped icon anchor range');
  assert.equal(rangeText(htmlLines, inlineIssue.iconAnchorRange), ';', 'icon anchor must be the final semicolon of the attribute declaration');

  // The <style> block issue maps into the style block's source text.
  const blockIssue = issues.find(
    (issue) => issue.selectorText === '.block-inline' && issue.propertyName === 'justify-content'
  );
  assert.ok(blockIssue, 'expected the <style> block issue');
  assert.equal(blockIssue.location.filePath, htmlFilePath, 'the block issue must map into the HTML file');
  assert.equal(
    rangeText(htmlLines, blockIssue.location),
    'justify-content: center;',
    'the block declaration range must cover the authored declaration inside <style>'
  );
  assert.ok(blockIssue.propertyNameRange, 'expected a mapped property-name range');
  assert.equal(rangeText(htmlLines, blockIssue.propertyNameRange), 'justify-content');

  // The external stylesheet issue maps into styles.css as before — through
  // the global outcome.
  const externalIssue = external.find(
    (issue) => issue.selectorText === '.non-flex' && issue.propertyName === 'justify-content'
  );
  assert.ok(externalIssue, 'expected the linked-stylesheet issue');
  assert.equal(externalIssue.location.filePath, cssFilePath);
  const cssLines = fs.readFileSync(cssFilePath, 'utf-8').split('\n');
  assert.equal(rangeText(cssLines, externalIssue.location), 'justify-content: center;');

  // Identical property values in different sources never merge.
  assert.equal(
    new Set(
      [...issues, ...external].map((i) => `${i.location.filePath}:${i.location.startLine}:${i.location.startColumn}`)
    ).size,
    3,
    'the three sources must stay three distinct locations'
  );
});

/**
 * ── Duplicate-declaration semantics ─────────────────────────────────────
 * CSS gives the LAST declaration of a property inside one declaration
 * block the win, so every earlier duplicate provably has no effect. The
 * `duplicates` fixture repeats `justify-content` three times in an
 * EXTERNAL rule and three times in ONE style="" attribute line. The
 * document ALSO declares `.dup-ext` in a `<style>` block AFTER the
 * `<link>`, so on the real div the embedded block wins the whole
 * property cascade: every EXTERNAL copy (the two earlier duplicates AND
 * the block winner) carries the cross-rule override verdict, while the
 * two INLINE earlier duplicates keep the classic later-declaration
 * verdict and the two remaining winners (embedded + inline last) carry
 * the context verdict — each issue mapped to its own exact source slice.
 */

const DUPLICATES_FIXTURE = path.join(DEFAULT_FIXTURES_ROOT, 'duplicates');

test('duplicates fixture: every authored duplicate is reported with its own source range', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const htmlFilePath = path.join(DUPLICATES_FIXTURE, 'index.html');
  const cssFilePath = path.join(DUPLICATES_FIXTURE, 'styles.css');
  const store = new SessionManager();
  const analyzer = new CdpAnalyzer({ globalOutcomeStore: store });
  const issues = await analyzer.analyzeHtmlFile(htmlFilePath, Date.now());
  const external = store.getIssuesForFile(cssFilePath) ?? [];

  // 3 in the external rule (all cross-rule losers — the cssGlobal
  // namespace), 1 in the <style> block (the cascade WINNER — the same
  // selector/property tuple as the external rule, so it must map to its
  // OWN block line, never steal an external one), and 3 in the inline
  // attribute (2 overridden + 1 effective — the page-local HTML run).
  assert.equal(issues.length, 4, 'the HTML run emits the block + three inline issues');
  assert.equal(external.length, 3, 'the external rule produces three issues in the global outcome');

  // Distinct source locations — identical property text never merges.
  const all = [...issues, ...external];
  assert.equal(
    new Set(all.map((i) => `${i.location.filePath}:${i.location.startLine}:${i.location.startColumn}`)).size,
    7,
    'every duplicate must own a distinct source range'
  );

  const overridden = all.filter((i) => i.reasonCode === REASON_CODES.OVERRIDDEN_BY_LATER_DECLARATION);
  const crossRule = all.filter((i) => i.reasonCode === REASON_CODES.OVERRIDDEN_BY_CROSS_RULE_DECLARATION);
  const contextual = all.filter((i) => i.reasonCode === REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);
  assert.equal(overridden.length, 2, 'the two earlier INLINE duplicates carry the block-override verdict');
  assert.equal(crossRule.length, 3, 'all three EXTERNAL copies lose the cascade to the later <style> block');
  assert.equal(contextual.length, 2, 'the two cascade winners carry the context verdict');

  for (const issue of all) {
    assert.ok(!isZeroRange(issue.location), 'location must not be the empty placeholder range');
    assert.ok(issue.propertyNameRange, 'expected a mapped property-name range');
    assert.ok(issue.iconAnchorRange, 'expected a mapped icon anchor range');
  }

  const cssLines = fs.readFileSync(cssFilePath, 'utf-8').split('\n');
  assert.equal(external.filter((i) => i.selectorText === '.dup-ext').length, 3);
  assert.deepEqual(
    external.map((i) => rangeText(cssLines, i.location)).sort(),
    ['justify-content: center;', 'justify-content: center;', 'justify-content: flex-end;'].sort(),
    'each external duplicate maps to its own authored line — the block rule must not shift them'
  );
  assert.equal(
    external.filter((i) => i.reasonCode === REASON_CODES.OVERRIDDEN_BY_CROSS_RULE_DECLARATION).length,
    3,
    'the whole external rule loses the property cascade to the embedded block'
  );

  const htmlLines = fs.readFileSync(htmlFilePath, 'utf-8').split('\n');

  // Interactive override jump: every override verdict must carry the
  // LOCAL range of the cascade-winning declaration — the property name of
  // the LAST declaration of the property in its block — so the hover link
  // can jump the user to the live declaration.
  const linesFor = (issue: (typeof all)[number]): string[] =>
    issue.location.filePath === cssFilePath ? cssLines : htmlLines;

  for (const issue of overridden) {
    assert.ok(issue.overrideTarget, 'an override verdict must carry the winning declaration range');
    assert.equal(
      rangeText(linesFor(issue), issue.overrideTarget),
      'justify-content',
      'the target must be the winner property NAME'
    );
    const target = issue.overrideTarget;
    assert.ok(
      target.startLine > issue.location.startLine ||
        (target.startLine === issue.location.startLine &&
          target.startColumn > issue.location.startColumn),
      'the winner must come AFTER the overridden declaration in source order'
    );
  }

  // The <style> block's .dup-ext declaration maps into the block's own
  // line inside the HTML document, NOT into the external rule's lines.
  const blockIssue = issues.find(
    (i) => i.selectorText === '.dup-ext' && i.location.filePath === htmlFilePath
  );
  assert.ok(blockIssue, 'expected the <style> block issue');
  assert.equal(blockIssue.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);
  assert.equal(rangeText(htmlLines, blockIssue.location), 'justify-content: center;');

  // The inline attribute's three declarations produce three issues.
  const inline = issues.filter((i) => i.selectorText === '');
  assert.equal(inline.length, 3, 'the inline attribute produces three issues');
  assert.deepEqual(
    inline.map((i) => rangeText(htmlLines, i.location)).sort(),
    ['justify-content: center;', 'justify-content: center;', 'justify-content: flex-end;'].sort(),
    'each inline duplicate maps to its own slice of the attribute value text'
  );
  assert.equal(
    inline.filter((i) => i.reasonCode === REASON_CODES.OVERRIDDEN_BY_LATER_DECLARATION).length,
    2
  );
});

/**
 * ── Cross-rule cascade semantics ──────────────────────────────────────
 * One element usually matches several rules declaring the same property;
 * only the cascade winner has an effect there. The `crossrule` fixture
 * is the reported regression: `.action-button { color: #ffffff }` vs
 * `.action-button.is-danger { color: #ff4d4f }` on ONE button — the base
 * declaration must be dimmed with the cross-rule verdict and carry a
 * jump target at the winning declaration, while the winner stays active.
 */
const CROSSRULE_FIXTURE = path.join(DEFAULT_FIXTURES_ROOT, 'crossrule');

test('crossrule fixture: the base-class declaration loses the cascade to the compound class', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const htmlFilePath = path.join(CROSSRULE_FIXTURE, 'index.html');
  const cssFilePath = path.join(CROSSRULE_FIXTURE, 'styles.css');
  const store = new SessionManager();
  const analyzer = new CdpAnalyzer({ globalOutcomeStore: store });
  const issues = await analyzer.analyzeHtmlFile(htmlFilePath, Date.now());
  const external = store.getIssuesForFile(cssFilePath) ?? [];

  assert.equal(issues.length, 0, 'the fixture has no embedded or inline declarations');
  assert.equal(external.length, 1, 'exactly the losing base-class declaration is reported');

  const loser = external.find((i) => i.selectorText === '.action-button');
  assert.ok(loser, 'expected the .action-button color issue');
  assert.equal(loser.propertyName, 'color');
  assert.equal(loser.reasonCode, REASON_CODES.OVERRIDDEN_BY_CROSS_RULE_DECLARATION);

  const cssLines = fs.readFileSync(cssFilePath, 'utf-8').split('\n');
  assert.equal(rangeText(cssLines, loser.location), 'color: #ffffff;');

  // Interactive override jump: the verdict carries the LOCAL range of the
  // cascade-winning declaration — the is-danger rule's property name.
  assert.ok(loser.overrideTarget, 'a cross-rule verdict must carry the winning declaration range');
  assert.equal(rangeText(cssLines, loser.overrideTarget), 'color');
  const winnerLine = cssLines.findIndex((line) => line.includes('#ff4d4f'));
  assert.ok(winnerLine >= 0, 'the fixture must contain the winning declaration');
  assert.equal(loser.overrideTarget.startLine, winnerLine, 'the target is the is-danger declaration');

  // The cascade winner is effective on the matched element — never reported.
  assert.ok(
    !external.some((i) => i.selectorText === '.action-button.is-danger'),
    'the winning declaration stays active'
  );
});

/**
 * ── Demo-workspace regression (`.action-button` vs `.action-button.is-danger`) ─
 * The `demo-video` workspace is the reported reproduction: the base rule's
 * `color: #ffffff` must be dimmed with the cross-rule verdict — and only
 * with it — when the production pipeline analyzes its `style.css` against
 * the real `index.html` companion. Analyzed through the AnalysisRunner so
 * the exact extension entry path is exercised.
 */
const DEMO_VIDEO_ROOT = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'test',
  'demo-video'
);

test('demo-video workspace: .action-button color loses the cascade to .action-button.is-danger', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const cssFilePath = path.join(DEMO_VIDEO_ROOT, 'style.css');
  const runner = new AnalysisRunner();
  const result = await runner.run(
    {
      filePath: cssFilePath,
      extension: '.css',
      isDirty: false,
      workspaceUntrusted: false,
      scheme: 'file',
      sizeBytes: fs.statSync(cssFilePath).size,
      chromiumPath: '',
    },
    Date.now()
  );

  const { issues = [] } = result;
  assert.ok(
    result.outcome.status === 'success' || result.outcome.status === 'partial',
    'the demo workspace must complete a real analysis'
  );

  const loser = issues.find(
    (i) => i.selectorText === '.action-button' && i.propertyName === 'color'
  );
  assert.ok(loser, 'the base rule color declaration must be reported as inactive');
  assert.equal(
    loser.reasonCode,
    REASON_CODES.OVERRIDDEN_BY_CROSS_RULE_DECLARATION,
    'the base rule loses the cascade to the compound selector'
  );
  assert.match(
    loser.reasonText ?? '',
    /\.action-button\.is-danger/,
    'the reason must name the winning selector'
  );

  const cssLines = fs.readFileSync(cssFilePath, 'utf-8').split('\n');
  assert.equal(rangeText(cssLines, loser.location), 'color: #ffffff;');

  // Winner metadata: the issue must point at the is-danger rule's own
  // declaration so the hover can jump the user to the live declaration.
  assert.ok(loser.overrideTarget, 'a cross-rule verdict must carry the winning declaration range');
  assert.equal(rangeText(cssLines, loser.overrideTarget), 'color');
  const winnerLine = cssLines.findIndex((line) => line.includes('#ff4d4f'));
  assert.ok(winnerLine >= 0, 'the demo must contain the winning declaration');
  assert.equal(loser.overrideTarget.startLine, winnerLine, 'the target is the is-danger declaration');

  // The winner and every other block declaration stay untouched.
  assert.ok(
    !issues.some((i) => i.selectorText === '.action-button.is-danger'),
    'the winning declaration stays active'
  );
  assert.ok(
    !issues.some((i) => i.selectorText === '.action-button' && i.propertyName !== 'color'),
    'only the overridden color declaration is reported for .action-button'
  );
});

test('outcome axes: a real run carries an active mode and a coverage envelope', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  // Drive the production analysis through the orchestrator so the outcome
  // contract (status + mode + coverage) is produced end-to-end, not just
  // the raw issues.
  const cssFilePath = path.join(DEFAULT_FIXTURES_ROOT, 'inactive', 'styles.css');
  const runner = new AnalysisRunner();
  const result = await runner.run(
    {
      filePath: cssFilePath,
      extension: '.css',
      isDirty: false,
      workspaceUntrusted: false,
      scheme: 'file',
      sizeBytes: fs.statSync(cssFilePath).size,
      chromiumPath: '',
    },
    Date.now()
  );

  const { outcome } = result;
  assert.ok(outcome.status === 'success' || outcome.status === 'partial');
  assert.equal(outcome.mode, 'active', 'a fixture run over a real document is fully active');
  assert.ok(outcome.coverage, 'a completed run must carry axis 3 (coverage)');
  assert.ok(
    outcome.coverage?.overall.counts.targets >= 1,
    'at least one selector was targeted'
  );
  assert.equal(outcome.coverage?.currentRun?.stage, 'decoration');
  assert.ok(
    (outcome.coverage?.currentRun?.counts.queryable ?? 0) >= 1,
    'the browser visibly inspected at least one selector'
  );
  assert.ok(outcome.analyzedSelectorsCount >= 1);
});

/**
 * ── Level 10: cross-directory companion-document resolution ─────────────
 *
 * A CSS file with no same-directory linking HTML is now resolved across
 * directories through the shared URL model (the same resolution the
 * DevServer serves with). Each fixture proves the analyzer ran against the
 * REAL cross-directory document (exact issue counts + standing controls)
 * and that the deterministic comparator (distance → index.html →
 * alphabetical) picks the documented winner.
 */

test('crossdir-down: ../linked companion one level up dims object-fit on the real div', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const fixture = path.join(DEFAULT_FIXTURES_ROOT, 'crossdir-down');
  const cssFilePath = path.join(fixture, 'styles', 'theme.css');
  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssFilePath, Date.now());

  assert.equal(issues.length, 1, 'only the real <div> may be dimmed — the <img> control stays active');
  const issue = issues[0];
  assert.equal(issue.selectorText, '.object-fit-box');
  assert.equal(issue.propertyName, 'object-fit');
  assert.equal(issue.reasonCode, REASON_CODES.REQUIRES_REPLACED_ELEMENT);
  assert.equal(issue.location.filePath, cssFilePath, 'issues map to the analyzed CSS file');
  assert.ok(!isZeroRange(issue.location));
});

test('crossdir-up: ../linked companion one level down dims justify-content on the block', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const fixture = path.join(DEFAULT_FIXTURES_ROOT, 'crossdir-up');
  const cssFilePath = path.join(fixture, 'styles.css');
  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssFilePath, Date.now());

  assert.equal(issues.length, 1, 'the flex .flexy control stays active');
  const issue = issues[0];
  assert.equal(issue.selectorText, '.non-flex');
  assert.equal(issue.propertyName, 'justify-content');
  assert.equal(issue.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);
  assert.equal(issue.location.filePath, cssFilePath);
});

test('crossdir-root: root-relative /css/theme.css companion is served from the search root', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const fixture = path.join(DEFAULT_FIXTURES_ROOT, 'crossdir-root');
  const cssFilePath = path.join(fixture, 'css', 'theme.css');
  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssFilePath, Date.now());

  assert.equal(issues.length, 1, 'the real <div> dims, the real <img> stays active');
  const issue = issues[0];
  assert.equal(issue.selectorText, '.object-fit-box');
  assert.equal(issue.reasonCode, REASON_CODES.REQUIRES_REPLACED_ELEMENT);
  assert.equal(issue.location.filePath, cssFilePath);
});

test('crossdir-base: <base href> companion resolves the relative href exactly', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const fixture = path.join(DEFAULT_FIXTURES_ROOT, 'crossdir-base');
  const cssFilePath = path.join(fixture, 'assets', 'theme.css');
  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssFilePath, Date.now());

  assert.equal(issues.length, 1, 'the block .non-flex dims, the flex .flexy stays active');
  const issue = issues[0];
  assert.equal(issue.selectorText, '.non-flex');
  assert.equal(issue.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);
  assert.equal(issue.location.filePath, cssFilePath);
});

test('crossdir-multi: distance-first selection feeds the merged evidence (Level 11)', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const fixture = path.join(DEFAULT_FIXTURES_ROOT, 'crossdir-multi');
  const cssFilePath = path.join(fixture, 'styles', 'x.css');

  // Distance-first selection is a resolution property: the root index.html
  // (distance 1) must rank before the two pages/ documents (distance 2,
  // alphabetical). Proof at the resolution layer, independent of passes.
  const ranked = await resolveCompanionsAll({ cssFilePath });
  assert.deepEqual(
    ranked.map((companion) => path.relative(fixture, companion.htmlPath)),
    ['index.html', path.join('pages', 'index.html'), path.join('pages', 'a.html')],
    'distance first, then index.html, then alphabetical within equal distance'
  );

  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssFilePath, Date.now());

  // Level 11 merged semantics: the distance-1 root page dims
  // `justify-content` on its plain-block `.non-flex` (I), but BOTH
  // distance-2 pages present `.non-flex` as a real flex container (A).
  // The lattice join absorbs: I ⊔ A = A — nothing may be dimmed. Zero
  // issues prove ALL ranked companions were analyzed (a silently failed
  // farther pass would leave the closer I uncontradicted → 1 issue) and
  // that no fabricated wrapper evidence slipped in.
  assert.equal(issues.length, 0, 'the merged verdict absorbs the closer inactive evidence');
});

test('analyzeCssFile: a warm multi-companion run is K cache lookups + one pure merge, no navigation', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const fixture = path.join(DEFAULT_FIXTURES_ROOT, 'crossdir-multi');
  const cssFilePath = path.join(fixture, 'styles', 'x.css');
  const analyzer = new CdpAnalyzer();

  multiPassCache.reset();

  // COLD: three per-pass misses (one per ranked companion), one merged miss.
  const coldIssues = await analyzer.analyzeCssFile(cssFilePath, Date.now());
  const cold = multiPassCache.stats();
  assert.equal(cold.passMisses, 3, 'each ranked companion pass must run once on the cold path');
  assert.equal(cold.mergedMisses, 1, 'the merged result must be built once on the cold path');
  assert.equal(cold.passHits, 0);
  assert.equal(coldIssues.length, 0, 'cold merged verdict: I ⊔ A = A');

  // WARM: the merged-cache key (css hash + K + companion-hash tuple) hits
  // and short-circuits BEFORE any per-pass lookup — the run is one cache
  // read + one pure merge + issue materialization, and the browser
  // session is never even consulted (no navigation, no rescan).
  // The production command layer builds a FRESH analyzer per trigger, so
  // the warm run must go through a new instance to reproduce that path.
  const warmAnalyzer = new CdpAnalyzer();
  const warmIssues = await warmAnalyzer.analyzeCssFile(cssFilePath, Date.now());
  const warm = multiPassCache.stats();

  assert.equal(warm.mergedHits, 1, 'the merged result is reused on the warm path');
  assert.equal(warm.mergedMisses, 1, 'no new merge is ever built on the warm path');
  assert.equal(warm.passHits, 0, 'the warm path never consults the per-pass cache');
  assert.equal(warm.passMisses, 3, 'no new pass is ever run on the warm path');
  assert.equal(warmIssues.length, 0, 'identical merged result on the warm path');

  // Regression: a warm run prepares NO session, so a fresh (per-trigger)
  // analyzer instance would report epoch 0 while the live session is at
  // epoch >= 1 — the command layer would read that as "superseded", drop
  // the result and record the cssGlobal namespace under 0, whose fresh
  // probe (live epoch) then never matches → valid decorations get CLEARED.
  // The warm outcome must be stamped with the LIVE epoch: a warm hit
  // derives from the same resolved content + context snapshot as any
  // current-world determination.
  const liveEpoch = defaultLifecycle.epoch;
  assert.ok(liveEpoch >= 1, 'the cold run prepared a real session (epoch >= 1)');
  assert.equal(
    warmAnalyzer.getLastSessionEpoch(),
    liveEpoch,
    'a warm run must report the live session epoch, never 0'
  );
});

test('companion expansion: rank-4 evidence changes the verdict, and a real evidence change flips it back', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-expansion-'));
  const cssFilePath = path.join(dir, 'styles.css');
  fs.writeFileSync(
    cssFilePath,
    ['.late-floater {', '  justify-content: center;', '}'].join('\n')
  );

  const page = (body: string) =>
    `<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body>${body}</body></html>`;

  // a/b/c fill the Top-K ranks (K = 3, alphabetical); d.html is ranked
  // 4th — ONLY the evidence-expansion tail can select it.
  for (const name of ['a.html', 'b.html', 'c.html']) {
    fs.writeFileSync(path.join(dir, name), page('<div class="plain"></div>'));
  }
  const lateHtmlPath = path.join(dir, 'd.html');
  fs.writeFileSync(lateHtmlPath, page('<div class="late-floater">late</div>'));

  companionCache.reset();
  multiPassCache.reset();
  const previousProvider = companionSettings.workspaceFolderProvider;
  companionSettings.workspaceFolderProvider = () => dir;
  t.after(() => {
    companionSettings.workspaceFolderProvider = previousProvider;
  });

  const ranked = await resolveCompanionsAll({ cssFilePath });
  assert.deepEqual(
    ranked.map((companion) => path.basename(companion.htmlPath)),
    ['a.html', 'b.html', 'c.html', 'd.html'],
    'd.html is ranked outside the Top-3 evidence budget'
  );

  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssFilePath, Date.now());

  // Only d.html judges `.late-floater`, and there it is a plain block:
  // the merged verdict ⊥ ⊔ ⊥ ⊔ ⊥ ⊔ I = I dims it — BECAUSE the expansion
  // reached the rank-4 document. Without the expansion the selector would
  // never be located in any analyzed companion and nothing would dim.
  assert.equal(issues.length, 1, 'the rank-4 companion provides the only judgment');
  const issue = issues[0];
  assert.equal(issue.selectorText, '.late-floater');
  assert.equal(issue.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);
  assert.equal(issue.analyzedCompanions, 4, 'the expanded selection ran all 4 linked documents');

  // The recorded identity: the freshness probes (skip gate, decorations)
  // must re-derive EXACTLY this fingerprint from the validated snapshot —
  // that identity is what keeps the decoration state stable across saves.
  const recordedContext = analyzer.getLastContextFingerprint();
  assert.ok(recordedContext, 'the run records its context fingerprint');
  assert.equal(
    companionContextFingerprintFor(cssFilePath),
    recordedContext,
    'the probe re-derives the recorded fingerprint — a save without evidence change keeps decorations stable'
  );

  // The evidence genuinely changes: d.html now makes `.late-floater` a
  // real flex container → ⊥ ⊔ ... ⊔ A = A — the declaration must stop
  // dimming. The selection itself is unchanged (the class token persists
  // in d.html), only the judged verdict flips.
  fs.writeFileSync(lateHtmlPath, page('<div class="late-floater" style="display: flex">late</div>'));

  const reAnalyzer = new CdpAnalyzer();
  const secondIssues = await reAnalyzer.analyzeCssFile(cssFilePath, Date.now());
  assert.equal(secondIssues.length, 0, 'the new flex evidence flips the merged verdict to active');

  // And reverting the evidence dims it again — the companion pass must
  // never judge a stale DOM (the persistent session is parked on the
  // same page URL, so this is exactly the reload-boundary regression).
  fs.writeFileSync(lateHtmlPath, page('<div class="late-floater">late</div>'));

  const thirdAnalyzer = new CdpAnalyzer();
  const thirdIssues = await thirdAnalyzer.analyzeCssFile(cssFilePath, Date.now());
  assert.equal(thirdIssues.length, 1, 'removing the flex evidence dims the declaration again');
  assert.equal(thirdIssues[0].selectorText, '.late-floater');
});

test('test-multipage: a declaration present ONLY in a secondary companion merges ⊥ ⊔ I = I', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  // Regression for the reported case: `.secondary-only` matches only in
  // `about.html` (ranked second) — the primary pass leaves it ⊥. The
  // merged evidence must STILL dim `justify-content` (⊥ ⊔ I = I) even
  // though the primary page never located the selector.
  const cssFilePath = path.join(DEFAULT_FIXTURES_ROOT, 'test-multipage', 'styles.css');
  multiPassCache.reset();

  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssFilePath, Date.now());

  const bySelector = new Map(issues.map((issue) => [issue.selectorText, issue.propertyName]));
  assert.deepEqual(
    Array.from(bySelector.entries()).sort(),
    [
      ['.all-inactive', 'justify-content'],
      ['.secondary-only', 'justify-content'],
    ],
    'primary-only AND secondary-only declarations dim; the flex-child declaration ' +
      'is absent (A ⊔ I = A)'
  );
  assert.equal(issues.length, 2, 'exactly the two inactive declarations are dimmed');

  // Both ranked companions were actually evaluated (K = 2 cold passes).
  const cold = multiPassCache.stats();
  assert.equal(cold.passMisses, 2, 'one pass per ranked companion');
  assert.equal(cold.mergedMisses, 1, 'one merged build on the cold path');

  // The healthy warm path is intact: all passes succeeded, so the merged
  // result IS cached and the rerun reuses it without new passes.
  const warmIssues = await analyzer.analyzeCssFile(cssFilePath, Date.now());
  const warm = multiPassCache.stats();
  assert.equal(warm.mergedHits, 1, 'complete runs cache their merged result');
  assert.equal(warm.passMisses, 2, 'no new pass on the warm path');
  assert.equal(warmIssues.length, 2, 'identical merged evidence on the warm path');
});

test('test-multipage: opening about.html orchestrates the linked sheet — I ⊔ A = A keeps .active-somewhere alive', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  // Regression for the reported case: the HTML flow used to judge the
  // analyzed page ALONE, so opening `about.html` dimmed `align-self` on
  // `.active-somewhere` even though the declaration is effective on the
  // flex child of `index.html`. F4 single-writer: opening an HTML file
  // ensures the GLOBAL multi-companion outcome of every linked stylesheet —
  // the merged verdicts (about.html + index.html) keep `.active-somewhere`
  // alive (I ⊔ A = A).
  const fixture = path.join(DEFAULT_FIXTURES_ROOT, 'test-multipage');
  const cssFilePath = path.join(fixture, 'styles.css');
  const store = new SessionManager();
  const analyzer = new CdpAnalyzer({ globalOutcomeStore: store });
  const issues = await analyzer.analyzeHtmlFile(path.join(fixture, 'about.html'), Date.now());

  assert.equal(issues.length, 0, 'the HTML run emits ONLY embedded CSS — this page has none');
  const external = store.getIssuesForFile(cssFilePath) ?? [];
  const bySelector = new Map(external.map((issue) => [issue.selectorText, issue.propertyName]));
  assert.deepEqual(
    Array.from(bySelector.entries()).sort(),
    [
      ['.all-inactive', 'justify-content'],
      ['.secondary-only', 'justify-content'],
    ],
    'the merged global outcome dims the two universally-inactive declarations; the ' +
      'flex-child declaration is absent because index.html gives it effect'
  );
  assert.equal(external.length, 2, 'exactly the two inactive declarations are dimmed');
});

test('test-multipage: opening index.html dims .secondary-only via the linked sheet — ⊥ ⊔ I = I', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  // The global outcome must not depend on the open page containing the
  // element: `.secondary-only` exists only in `about.html`, but its
  // `justify-content` is provably inactive there — `⊥ ⊔ I = I` dims it
  // even when the user is looking at `index.html`.
  const fixture = path.join(DEFAULT_FIXTURES_ROOT, 'test-multipage');
  const cssFilePath = path.join(fixture, 'styles.css');
  multiPassCache.reset();

  const store = new SessionManager();
  const analyzer = new CdpAnalyzer({ globalOutcomeStore: store });
  const issues = await analyzer.analyzeHtmlFile(path.join(fixture, 'index.html'), Date.now());

  assert.equal(issues.length, 0, 'the HTML run emits ONLY embedded CSS — this page has none');
  const external = store.getIssuesForFile(cssFilePath) ?? [];
  const bySelector = new Map(external.map((issue) => [issue.selectorText, issue.propertyName]));
  assert.deepEqual(
    Array.from(bySelector.entries()).sort(),
    [
      ['.all-inactive', 'justify-content'],
      ['.secondary-only', 'justify-content'],
    ],
    'primary AND secondary-page evidence merge into the global outcome; the ' +
      'flex-child declaration stays alive (A ⊔ I = A)'
  );
  assert.equal(external.length, 2, 'exactly the two inactive declarations are dimmed');

  // Both ranked companions were actually evaluated (2 cold passes) and the
  // merged result was recorded into the cssGlobal namespace.
  const stats = multiPassCache.stats();
  assert.equal(stats.passMisses, 2, 'one cold pass per ranked companion');
  assert.equal(stats.mergedMisses, 1, 'one merged build on the cold path');
});

test('test-multipage: a warm HTML rerun REUSES the recorded global outcome (no navigation)', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  // F4 freshness: the second open of the same page must NOT re-run the
  // global analysis — the recorded (content, context, epoch) identity is
  // still fresh, so the store returns the outcome without touching the
  // browser session.
  const fixture = path.join(DEFAULT_FIXTURES_ROOT, 'test-multipage');
  const cssFilePath = path.join(fixture, 'styles.css');
  const htmlPath = path.join(fixture, 'index.html');
  multiPassCache.reset();

  const store = new SessionManager();
  const analyzer = new CdpAnalyzer({ globalOutcomeStore: store });

  const first = await analyzer.analyzeHtmlFile(htmlPath, Date.now());
  const afterFirst = multiPassCache.stats();
  const loadsBefore = defaultLifecycle.getStats();
  assert.equal(afterFirst.passMisses, 2, 'both ranked companions run cold on the first open');
  assert.equal(store.getIssuesForFile(cssFilePath)?.length, 2, 'the global outcome is recorded');

  const second = await analyzer.analyzeHtmlFile(htmlPath, Date.now());
  const afterSecond = multiPassCache.stats();
  const loadsAfter = defaultLifecycle.getStats();
  const loads = (s: { pageNavigations: number; pageReloads: number }) =>
    s.pageNavigations + s.pageReloads;

  assert.equal(afterSecond.passMisses, afterFirst.passMisses, 'no new cold pass on the warm rerun');
  assert.equal(loads(loadsAfter) - loads(loadsBefore), 0, 'no navigation on the warm rerun');
  assert.equal(store.getIssuesForFile(cssFilePath)?.length, 2, 'identical merged outcome on the warm rerun');
  assert.equal(first.length, second.length, 'identical page-local result on the warm rerun');
});

test('crossdir-negative: node_modules-only linker is pruned → synthetic wrapper flow', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const fixture = path.join(DEFAULT_FIXTURES_ROOT, 'crossdir-negative');
  const cssFilePath = path.join(fixture, 'styles', 'x.css');
  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssFilePath, Date.now());

  // No companion: the wrapper page fabricates a block <div> for .block
  // (dimmed) and a flex <div> for .flexy (active).
  assert.equal(issues.length, 1, 'wrapper flow dims the block, keeps the flex active');
  const issue = issues[0];
  assert.equal(issue.selectorText, '.block');
  assert.equal(issue.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);
  assert.equal(issue.location.filePath, cssFilePath);
});

test('analyzeHtmlFile: cross-directory linked stylesheets are served through the workspace root', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  // The HTML flow serves from the workspace folder when one is known, so a
  // pages/ document linking ../styles.css resolves and loads exactly like
  // the browser requests it. No vscode workspace exists under plain node,
  // so the workspace-folder provider is injected directly for this test.
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-htmlcross-'));
  t.after(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(scratchDir, 'pages'), { recursive: true });
  fs.writeFileSync(
    path.join(scratchDir, 'styles.css'),
    '.non-flex { display: block; justify-content: center; }\n.flexy { display: flex; justify-content: center; }\n'
  );
  fs.writeFileSync(
    path.join(scratchDir, 'pages', 'index.html'),
    '<link rel="stylesheet" href="../styles.css">' +
      '<div class="non-flex"></div><div class="flexy"></div>'
  );

  const previous = companionSettings.workspaceFolderProvider;
  companionSettings.workspaceFolderProvider = () => scratchDir;
  t.after(() => {
    companionSettings.workspaceFolderProvider = previous;
  });

  // F4: the HTML run ensures the linked sheet’s GLOBAL outcome — the
  // external-sheet verdicts live in the cssGlobal namespace.
  const store = new SessionManager();
  const analyzer = new CdpAnalyzer({ globalOutcomeStore: store });
  const issues = await analyzer.analyzeHtmlFile(path.join(scratchDir, 'pages', 'index.html'), Date.now());

  assert.equal(issues.length, 0, 'no embedded CSS — the HTML run emits nothing');
  const external = store.getIssuesForFile(path.join(scratchDir, 'styles.css')) ?? [];
  assert.equal(external.length, 1, 'the block dims, the flex stays active');
  const issue = external[0];
  assert.equal(issue.selectorText, '.non-flex');
  assert.equal(issue.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);
  assert.equal(issue.location.filePath, path.join(scratchDir, 'styles.css'));
});

/**
 * ── Phase 6 mandated tests (T1–T11) on the multipage-orchestration fixture ──
 * Fixture lattice (styles.css linked from index.html + about.html):
 *
 *   .all-inactive     index = I   about = I   → I    ❌ dimmed
 *   .active-somewhere index = A   about = I   → A    ✅ never dimmed
 *   .secondary-only   index = ⊥   about = I   → I    ❌ dimmed
 */

const MULTIPAGE_FIXTURE = path.join(DEFAULT_FIXTURES_ROOT, 'multipage-orchestration');

function copyMultipageFixtureToScratch(tag: string): string {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), `noeffect-mp-${tag}-`));
  for (const name of ['styles.css', 'index.html', 'about.html']) {
    fs.copyFileSync(path.join(MULTIPAGE_FIXTURE, name), path.join(scratchDir, name));
  }
  return scratchDir;
}

/** The expected merged fixture outcome: exactly the two dimmed selectors. */
function assertSettledOutcome(issues: { selectorText?: string }[]): void {
  const selectors = issues.map((i) => i.selectorText).sort();
  assert.deepEqual(
    selectors,
    ['.all-inactive', '.secondary-only'],
    'the settled global outcome dims the two universally-inactive declarations; ' +
      '.active-somewhere stays active (A ⊔ I = A)'
  );
  assert.equal(issues.length, 2, 'exactly the two inactive declarations are dimmed');
}

test('T1 [F1+F2] no-save-required: a companion HTML change re-analyzes despite an unchanged CSS hash', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const scratchDir = copyMultipageFixtureToScratch('t1');
  t.after(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });
  const cssFilePath = path.join(scratchDir, 'styles.css');
  const indexHtmlPath = path.join(scratchDir, 'index.html');
  const cssBefore = fs.readFileSync(cssFilePath, 'utf-8');
  multiPassCache.reset();
  companionCacheReset();

  const analyzer = new CdpAnalyzer();
  const first = await analyzer.analyzeCssFile(cssFilePath, Date.now());
  assertSettledOutcome(first);
  const cold = multiPassCache.stats();
  assert.equal(cold.passMisses, 2, 'both ranked companions ran cold on the first analysis');

  // Change a companion HTML — WITHOUT touching styles.css. `.secondary-only`
  // now exists on index.html too, so its evidence updates from ⊥ to I; the
  // context fingerprint (F1) must change even though the CSS hash is stable.
  fs.writeFileSync(
    indexHtmlPath,
    fs.readFileSync(indexHtmlPath, 'utf-8').replace(
      '<!-- .secondary-only deliberately ABSENT on this page',
      '<div class="secondary-only">Block on home too</div>\n  <!-- .secondary-only now present on this page'
    )
  );
  assert.equal(
    fs.readFileSync(cssFilePath, 'utf-8'),
    cssBefore,
    'the stylesheet must stay byte-identical across the companion change'
  );

  const second = await analyzer.analyzeCssFile(cssFilePath, Date.now());
  const warm = multiPassCache.stats();

  // Reanalysis RAN: the changed companion produced a new per-pass key (one
  // new cold pass) and a new merged key (one new cold merge) — a hash-only
  // skip gate would have reused the stale outcome instead.
  assert.equal(warm.passMisses, cold.passMisses + 1, 'the changed companion page was re-inspected');
  assert.equal(warm.mergedMisses, cold.mergedMisses + 1, 'a new context fingerprint built a new merged result');
  assertSettledOutcome(second);
});

test('T2 [F3] failed-attempt non-poisoning: a failed run never records a skip identity', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const cssFilePath = path.join(MULTIPAGE_FIXTURE, 'styles.css');
  multiPassCache.reset();
  companionCacheReset();

  // Pre-populate the resolution snapshot the analysis judges against (the
  // same source the F1 context fingerprint is derived from), so the identity
  // is known before the first — failed — run.
  const cssReal = path.normalize(path.resolve(cssFilePath));
  const primaryRoot = companionSettings.workspaceFolderProvider?.(cssFilePath) ?? path.dirname(cssReal);
  companionCache.set(`${primaryRoot}|${cssReal}`, await resolveCompanionsAll({ cssFilePath }));

  const store = new SessionManager();
  const analyzer = new CdpAnalyzer({ globalOutcomeStore: store });
  const cssContent = fs.readFileSync(cssFilePath, 'utf-8');
  const contentFp = contentHash(cssContent);
  const contextFp = companionContextFingerprintFor(cssFilePath);
  assert.notEqual(contextFp, STALE_CONTEXT_FINGERPRINT, 'a resolved fixture must have a context fingerprint');

  // The FIRST attempt fails (session error — simulated with an already
  // cancelled token, the same failure the runner reports as a failed run).
  const cancelled: CancellationTokenLike = {
    isCancellationRequested: true,
    onCancellationRequested: () => ({ dispose: () => {} }),
  };
  await assert.rejects(
    analyzer.analyzeCssFile(cssFilePath, Date.now(), cancelled),
    (err: unknown) => err instanceof AnalysisCancelledError,
    'the forced session failure must surface as a failed run'
  );

  // The failed attempt recorded NOTHING: identical content + identical
  // context must NOT be skipped — the gate stays open.
  assert.equal(
    store.shouldSkipReanalysisWithContext(cssFilePath, contentFp, contextFp),
    false,
    'a failed attempt must never record a "last analyzed" identity'
  );

  // The environment is ready now: identical content runs AGAIN and succeeds.
  const issues = await analyzer.analyzeCssFile(cssFilePath, Date.now());
  assertSettledOutcome(issues);

  store.recordSuccessfulAnalysis(cssFilePath, contentFp, contextFp);
  assert.equal(
    store.shouldSkipReanalysisWithContext(cssFilePath, contentFp, contextFp),
    true,
    'only a recorded success may close the skip gate'
  );
});

test('T3 [A⊔I=A] .active-somewhere stays active — including while about.html is open', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const cssFilePath = path.join(MULTIPAGE_FIXTURE, 'styles.css');
  multiPassCache.reset();
  companionCacheReset();

  // The declaration is a flex child in index.html (A) and a block in
  // about.html (I): the merged lattice keeps it ACTIVE.
  const analyzer = new CdpAnalyzer();
  const cssIssues = await analyzer.analyzeCssFile(cssFilePath, Date.now());
  assertSettledOutcome(cssIssues);
  assert.ok(
    !cssIssues.some((i) => i.selectorText === '.active-somewhere'),
    'the merged CSS outcome must never dim .active-somewhere'
  );

  // While about.html is OPEN, its page-local evidence is only I — the
  // ensured global outcome must still keep the declaration alive.
  const store = new SessionManager();
  const orchestrated = new CdpAnalyzer({ globalOutcomeStore: store });
  const htmlIssues = await orchestrated.analyzeHtmlFile(path.join(MULTIPAGE_FIXTURE, 'about.html'), Date.now());
  assert.equal(htmlIssues.length, 0, 'no embedded CSS on this page');
  const globalOutcome = store.getIssuesForFile(cssFilePath) ?? [];
  assertSettledOutcome(globalOutcome);
  assert.ok(
    !globalOutcome.some((i) => i.selectorText === '.active-somewhere'),
    '.active-somewhere stays active while about.html is open (I ⊔ A = A)'
  );
});

test('T4 [⊥⊔I=I] .secondary-only dims immediately after CSS analysis, without opening about.html', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const cssFilePath = path.join(MULTIPAGE_FIXTURE, 'styles.css');
  multiPassCache.reset();
  companionCacheReset();

  // The CSS-file flow alone (no HTML flow, no page opened by the user)
  // resolves the companions and dims the secondary-page declaration.
  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssFilePath, Date.now());
  assertSettledOutcome(issues);
  const secondary = issues.find((i) => i.selectorText === '.secondary-only');
  assert.ok(secondary, '.secondary-only must be dimmed right after the CSS analysis');
  assert.equal(secondary.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);
  assert.equal(secondary.location.filePath, cssFilePath);
});

test('T5 [F4] the HTML flow never overrides the global CSS outcome', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }

  const cssFilePath = path.join(MULTIPAGE_FIXTURE, 'styles.css');
  multiPassCache.reset();
  companionCacheReset();

  // 1) Analyze styles.css: the global multi-companion result is fresh.
  const analyzer = new CdpAnalyzer();
  const cssIssues = await analyzer.analyzeCssFile(cssFilePath, Date.now());
  assertSettledOutcome(cssIssues);
  const cssStats = multiPassCache.stats();

  // 2) Open about.html through the orchestrated flow: the global outcome is
  //    REUSED (fresh identity) — the page pass adds no CSS verdicts.
  const store = new SessionManager();
  const orchestrated = new CdpAnalyzer({ globalOutcomeStore: store });
  const htmlIssues = await orchestrated.analyzeHtmlFile(path.join(MULTIPAGE_FIXTURE, 'about.html'), Date.now());
  assert.equal(htmlIssues.length, 0);
  const afterOpen = multiPassCache.stats();
  assert.equal(afterOpen.passMisses, cssStats.passMisses, 'opening the page must not re-run the global analysis');
  assertSettledOutcome(store.getIssuesForFile(cssFilePath) ?? []);

  // 3) Re-inspect styles.css: identical to before opening about.html.
  const reInspect = await analyzer.analyzeCssFile(cssFilePath, Date.now());
  assertSettledOutcome(reInspect);
  assert.equal(
    JSON.stringify(reInspect.map((i) => `${i.selectorText}|${i.propertyName}`).sort()),
    JSON.stringify(cssIssues.map((i) => `${i.selectorText}|${i.propertyName}`).sort()),
    'the re-inspected outcome is identical to the pre-open outcome'
  );
});

test('T6 [F1+F2] an HTML-only change flips the verdict (no CSS edit needed)', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t) === true) {
    return;
  }

  const scratchDir = copyMultipageFixtureToScratch('t6');
  t.after(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });
  const cssFilePath = path.join(scratchDir, 'styles.css');
  const indexHtmlPath = path.join(scratchDir, 'index.html');
  const cssBefore = fs.readFileSync(cssFilePath, 'utf-8');
  multiPassCache.reset();
  companionCacheReset();

  const analyzer = new CdpAnalyzer();
  const before = await analyzer.analyzeCssFile(cssFilePath, Date.now());
  assert.ok(
    !before.some((i) => i.selectorText === '.active-somewhere'),
    'baseline: the flex child is active (A ⊔ I = A)'
  );

  // Move the class OUT of the flex container in index.html — the element is
  // now a plain block on BOTH pages (I ⊔ I = I). styles.css stays identical.
  fs.writeFileSync(
    indexHtmlPath,
    fs.readFileSync(indexHtmlPath, 'utf-8').replace(
      '  <div class="flex-container">\n    <div class="active-somewhere">Flex child</div>\n  </div>',
      '  <div class="active-somewhere">Plain block now</div>'
    )
  );
  assert.equal(fs.readFileSync(cssFilePath, 'utf-8'), cssBefore, 'styles.css must stay byte-identical');

  const after = await analyzer.analyzeCssFile(cssFilePath, Date.now());
  const flipped = after.find((i) => i.selectorText === '.active-somewhere');
  assert.ok(flipped, 'the HTML-only change must flip the verdict to dimmed (I ⊔ I = I)');
  assert.equal(flipped.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_ITEM, 'align-self needs a flex/grid ITEM');
  assert.equal(flipped.location.filePath, cssFilePath);
  assert.equal(after.length, 3, 'all three declarations are dimmed after the flip');
  assertSettledOutcome(after.filter((i) => i.selectorText !== '.active-somewhere'));
});

test('T7 [F1+F2] a maxCompanions change alone triggers reanalysis (K is part of the context)', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t) === true) {
    return;
  }

  const cssFilePath = path.join(MULTIPAGE_FIXTURE, 'styles.css');
  const previousMax = companionSettings.maxCompanions;
  t.after(() => {
    companionSettings.maxCompanions = previousMax;
  });

  const analyzer = new CdpAnalyzer();

  // K = 1: index.html fills the only ranked slot, but the evidence-expansion
  // tail still reaches about.html (its document contains the selector
  // tokens), so `.secondary-only` IS judged — a budget change can never
  // lose real evidence.
  companionSettings.maxCompanions = 1;
  multiPassCache.reset();
  companionCacheReset();
  const withOne = await analyzer.analyzeCssFile(cssFilePath, Date.now());
  assert.deepEqual(
    withOne.map((i) => i.selectorText).sort(),
    ['.all-inactive', '.secondary-only'],
    'with K=1 the evidence expansion still judges the selector present only in about.html'
  );
  assert.equal(
    withOne.find((i) => i.selectorText === '.secondary-only')?.analyzedCompanions,
    2,
    'the expanded selection ran both ranked documents even under the K=1 budget'
  );

  // K = 3 (unchanged CSS + HTML): the context fingerprint includes K, so the
  // merged key differs and a genuine reanalysis runs — both pages dim.
  companionSettings.maxCompanions = previousMax;
  multiPassCache.reset();
  companionCacheReset();
  const withThree = await analyzer.analyzeCssFile(cssFilePath, Date.now());
  assertSettledOutcome(withThree);
});

test('T10 [F5] rapid open/close cycles: no stale CSS decorations, superseded epochs dropped', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t) === true) {
    return;
  }

  const fixture = MULTIPAGE_FIXTURE;
  const cssFilePath = path.join(fixture, 'styles.css');
  multiPassCache.reset();
  companionCacheReset();

  const store = new SessionManager();
  const analyzer = new CdpAnalyzer({ globalOutcomeStore: store });

  // Rapid open/close: about → index → about, all through the same store.
  const cycles = [
    path.join(fixture, 'about.html'),
    path.join(fixture, 'index.html'),
    path.join(fixture, 'about.html'),
  ];
  for (const page of cycles) {
    await analyzer.analyzeHtmlFile(page, Date.now());
    assertSettledOutcome(store.getIssuesForFile(cssFilePath) ?? []);
  }

  // The final state equals the settled global outcome — the last fresh
  // outcome won, earlier page-local runs never leaked into cssGlobal.
  assertSettledOutcome(store.getIssuesForFile(cssFilePath) ?? []);

  // Epoch supersede: a NEWER recorded epoch invalidates the older entry, so
  // a stale (superseded) epoch can never resurrect old decorations.
  const epochStore = new SessionManager();
  const settled = store.getIssuesForFile(cssFilePath) ?? [];
  epochStore.completeAnalysis(
    resultLike({
      success: true,
      issues: settled,
      namespace: { kind: 'cssGlobal', cssPath: cssFilePath, contentFingerprint: 'fp', contextFingerprint: 'ctx', epoch: 7 },
    })
  );
  epochStore.completeAnalysis(
    resultLike({
      success: true,
      issues: [],
      namespace: { kind: 'cssGlobal', cssPath: cssFilePath, contentFingerprint: 'fp', contextFingerprint: 'ctx', epoch: 8 },
    })
  );
  assert.equal(epochStore.getFresh(cssFilePath, 'fp', 'ctx', 7), undefined, 'the superseded epoch is dropped');
  assert.deepEqual(epochStore.getFresh(cssFilePath, 'fp', 'ctx', 8), [], 'only the latest epoch is live');
});

test('T11 [F4] embedded issues stay in about.html and never leak to styles.css', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t) === true) {
    return;
  }

  const scratchDir = copyMultipageFixtureToScratch('t11');
  t.after(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });
  const cssFilePath = path.join(scratchDir, 'styles.css');
  const aboutHtmlPath = path.join(scratchDir, 'about.html');
  multiPassCache.reset();
  companionCacheReset();

  // Add an inactive EMBEDDED declaration (a <style> block rule with a real
  // element) to about.html — styles.css is untouched.
  fs.writeFileSync(
    aboutHtmlPath,
    fs
      .readFileSync(aboutHtmlPath, 'utf-8')
      .replace(
        '  <link rel="stylesheet" href="styles.css">',
        '  <link rel="stylesheet" href="styles.css">\n  <style>.embedded-block { display: block; justify-content: center; }</style>'
      )
      .replace(
        '  <div class="all-inactive">Block on about</div>',
        '  <div class="all-inactive">Block on about</div>\n  <div class="embedded-block">Embedded block</div>'
      )
  );

  const store = new SessionManager();
  const analyzer = new CdpAnalyzer({ globalOutcomeStore: store });
  const issues = await analyzer.analyzeHtmlFile(aboutHtmlPath, Date.now());

  // The embedded issue maps into about.html ONLY.
  assert.equal(issues.length, 1, 'the <style> block declaration is the only embedded issue');
  const embedded = issues[0];
  assert.equal(embedded.selectorText, '.embedded-block');
  assert.equal(embedded.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);
  assert.equal(embedded.location.filePath, aboutHtmlPath, 'the embedded issue must map into the HTML file');

  // NO issue may target styles.css from the HTML run, and the global outcome
  // still holds exactly its own external issues.
  assert.equal(
    issues.filter((i) => i.location.filePath === cssFilePath).length,
    0,
    'embedded issues never leak into the stylesheet'
  );
  assertSettledOutcome(store.getIssuesForFile(cssFilePath) ?? []);
});

test('evidence metadata on the multipage fixture: N == I invariant and the exact hover line for each dimmed selector', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t) === true) {
    return;
  }

  const scratchDir = copyMultipageFixtureToScratch('evidence');
  t.after(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });
  const cssFilePath = path.join(scratchDir, 'styles.css');
  multiPassCache.reset();
  companionCacheReset();

  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssFilePath, Date.now());
  assertSettledOutcome(issues);

  const bySelector = new Map(issues.map((i) => [i.selectorText, i]));
  const allInactive = bySelector.get('.all-inactive');
  const secondaryOnly = bySelector.get('.secondary-only');
  assert.ok(allInactive, '.all-inactive dims in the settled outcome');
  assert.ok(secondaryOnly, '.secondary-only dims in the settled outcome');

  // Lattice invariant, proven on the live pipeline: every dimmed (merged-I)
  // issue reports inactiveCount == evaluatedCount — the derive defensive
  // branch stays dead.
  for (const issue of issues) {
    assert.equal(
      issue.inactiveCount,
      issue.evaluatedCount,
      `${issue.selectorText}: every merged-I issue must carry I == N`
    );
  }

  // Both index.html and about.html exercise the orchestration stylesheet.
  assert.equal(allInactive!.analyzedCompanions, 2, 'the fixture runs with M = 2 companions');
  // .all-inactive: inactive on BOTH pages → M=2, N=2, I=2.
  assert.equal(allInactive!.evaluatedCount, 2, '.all-inactive is evaluated on both pages');
  assert.equal(
    evidenceLine(allInactive!.evaluatedCount!, allInactive!.inactiveCount!, allInactive!.analyzedCompanions!),
    'No effect in 2 of 2 analyzed pages.',
    'hovering .all-inactive shows the canonical evidence line'
  );
  // .secondary-only: exercised ONLY on about.html → M=2, N=1, I=1.
  assert.equal(secondaryOnly!.evaluatedCount, 1, '.secondary-only is exercised only on about.html');
  assert.equal(
    evidenceLine(secondaryOnly!.evaluatedCount!, secondaryOnly!.inactiveCount!, secondaryOnly!.analyzedCompanions!),
    'No effect in 1 of 2 analyzed pages.',
    'hovering .secondary-only shows the canonical evidence line'
  );
});

test('freshness gate: the cssGlobal snapshot applies only under its exact run-time identity — and a companion change retires the old snapshot', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t) === true) {
    return;
  }

  const scratchDir = copyMultipageFixtureToScratch('freshgate');
  t.after(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });
  const cssFilePath = path.join(scratchDir, 'styles.css');
  const indexHtmlPath = path.join(scratchDir, 'index.html');
  const cssBefore = fs.readFileSync(cssFilePath, 'utf-8');
  multiPassCache.reset();
  companionCacheReset();

  const store = new SessionManager();
  const analyzer = new CdpAnalyzer({ globalOutcomeStore: store });
  const first = await analyzer.analyzeCssFile(cssFilePath, Date.now());
  assertSettledOutcome(first);

  const runIdentity = analyzer.getLastContextFingerprint();
  assert.ok(runIdentity, 'the CSS run must expose the context fingerprint it judged against');
  const epoch = defaultLifecycle.epoch;
  const liveHash = contentHash(fs.readFileSync(cssFilePath, 'utf-8'));
  assert.equal(
    runIdentity,
    companionContextFingerprintFor(cssFilePath),
    'a stable world: the run-time identity equals what the gate computes now'
  );

  // The command layer records the CSS run into the cssGlobal namespace under
  // the run's OWN identity (transactional — the fingerprint it judged
  // against, never recomputed after the run).
  store.completeAnalysis(
    resultLike({
      success: true,
      issues: first,
      cssFilePaths: [cssFilePath],
      namespace: {
        kind: 'cssGlobal',
        cssPath: cssFilePath,
        contentFingerprint: liveHash,
        contextFingerprint: runIdentity,
        epoch,
      },
    })
  );

  // THE DECORATION GATE: the stored outcome is applied ONLY under the exact
  // run-time identity — the probe the editor path makes before applying.
  assert.ok(
    store.getFreshCssIssues(cssFilePath, liveHash, runIdentity, epoch),
    'a fresh (content, context, epoch) probe applies the snapshot'
  );
  // Every other identity must NOT apply — the regression: bare issues with
  // the identity discarded could be applied stale.
  assert.equal(
    store.getFreshCssIssues(cssFilePath, liveHash, 'companions:other;max:2', epoch),
    undefined,
    'a foreign context fingerprint must never apply the snapshot'
  );
  assert.equal(
    store.getFreshCssIssues(cssFilePath, liveHash, STALE_CONTEXT_FINGERPRINT, epoch),
    undefined,
    'the stale-context marker must never apply the snapshot'
  );
  assert.equal(
    store.getFreshCssIssues(cssFilePath, contentHash(cssBefore + ' '), runIdentity, epoch),
    undefined,
    'a live-buffer hash drift must never apply the snapshot'
  );

  // Companion drift: index.html gains a .secondary-only block — styles.css
  // stays byte-identical, so ONLY the analysis context changes.
  fs.writeFileSync(
    indexHtmlPath,
    fs.readFileSync(indexHtmlPath, 'utf-8').replace(
      '<!-- .secondary-only deliberately ABSENT on this page',
      '<div class="secondary-only">Block on home too</div>\n  <!-- .secondary-only now present on this page'
    )
  );
  assert.equal(
    fs.readFileSync(cssFilePath, 'utf-8'),
    cssBefore,
    'the stylesheet must stay byte-identical across the companion change'
  );

  const second = await analyzer.analyzeCssFile(cssFilePath, Date.now());
  assertSettledOutcome(second);
  const newIdentity = analyzer.getLastContextFingerprint();
  assert.ok(newIdentity, 'the re-run must expose its own run-time identity');
  assert.notEqual(
    newIdentity,
    runIdentity,
    'the changed companion must produce a new analysis-context fingerprint'
  );

  // The re-run is recorded under the NEW identity (transactional recording).
  store.completeAnalysis(
    resultLike({
      success: true,
      issues: second,
      cssFilePaths: [cssFilePath],
      namespace: {
        kind: 'cssGlobal',
        cssPath: cssFilePath,
        contentFingerprint: liveHash,
        contextFingerprint: newIdentity,
        epoch,
      },
    })
  );

  // The OLD snapshot is retired: the gate probing with the pre-drift identity
  // must not find it — the stale outcome can never be applied, which is what
  // the editor path relies on when the analysis has not caught up yet.
  assert.equal(
    store.getFreshCssIssues(cssFilePath, liveHash, runIdentity, epoch),
    undefined,
    'the pre-drift snapshot is not fresh in the new world — the gate clears instead of applying'
  );
  assert.ok(
    store.getFreshCssIssues(cssFilePath, liveHash, newIdentity, epoch),
    'the post-drift snapshot is exactly what the gate applies now'
  );
  // The raw read still surfaces the LATEST issues — but it is no longer the
  // source of truth for CSS decoration application.
  assertSettledOutcome(store.getIssuesForFile(cssFilePath) ?? []);
});

function companionCacheReset(): void {
  companionCache.reset();
}

function resultLike(overrides: Partial<import('../../models').AnalysisResult>): import('../../models').AnalysisResult {
  return {
    success: true,
    issues: [],
    timestamp: 0,
    durationMs: 0,
    htmlFilePath: '',
    cssFilePaths: [],
    ...overrides,
  };
}
