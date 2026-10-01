import { test, after, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { CdpAnalyzer } from '../../services/cdpAnalyzer';
import { BrowserRunner } from '../../browser/browserRunner';
import { defaultLifecycle } from '../../browser/lifecycleManager';
import { companionSettings } from '../../services/companionSettings';
import { multiPassCache } from '../../cache/multiPassCache';
import { astCache } from '../../cache/astCache';
import { companionCache } from '../../cache/companionCache';

// The shared lifecycle keeps one Chromium/CDP/DevServer alive across tests;
// dispose after the file so the test process can exit (same as the main
// integration suite).
after(() => defaultLifecycle.dispose());

/**
 * Responsive regression tests (real Chromium/CDP).
 *
 * Reproduction: base `width: 90%` overridden at >=768px but active below
 * 768px must NEVER be reported as globally ineffective merely because the
 * analyzer inspects at a large viewport.
 *
 * When Chromium is unavailable, these browser-dependent tests skip;
 * unit tests in `responsiveContexts.test.ts` always run.
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

function writeScratchFixture(css: string, htmlBody: string): { dir: string; cssPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-responsive-'));
  const cssPath = path.join(dir, 'styles.css');
  const htmlPath = path.join(dir, 'index.html');
  fs.writeFileSync(cssPath, css, 'utf-8');
  fs.writeFileSync(
    htmlPath,
    [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      '<link rel="stylesheet" href="./styles.css">',
      '<title>Responsive fixture</title>',
      '</head>',
      '<body>',
      htmlBody,
      '</body>',
      '</html>',
      '',
    ].join('\n'),
    'utf-8'
  );
  return { dir, cssPath };
}

function resetCaches(): void {
  multiPassCache.reset();
  astCache.reset();
  companionCache.reset();
}

const FOO_CSS = [
  '.foo {',
  '    width: 90%;',
  '}',
  '',
  '',
  '@media (min-width: 768px) {',
  '    .foo {',
  '        width: 45%;',
  '    }',
  '}',
  '',
  '',
  '@media (min-width: 992px) {',
  '    .foo {',
  '        width: 20%;',
  '    }',
  '}',
  '',
].join('\n');

const FOO_HTML_BODY = '<div class="foo">hello</div>';

function widthIssuesFor(issues: Array<{ propertyName: string; propertyValue: string }>, value: string) {
  return issues.filter((i) => i.propertyName === 'width' && i.propertyValue === value);
}

test('Test 4: width:90% active below 768px is NOT reported as globally ineffective', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }
  resetCaches();
  const previousProvider = companionSettings.workspaceFolderProvider;
  const { dir, cssPath } = writeScratchFixture(FOO_CSS, FOO_HTML_BODY);
  t.after(() => {
    companionSettings.workspaceFolderProvider = previousProvider;
    fs.rmSync(dir, { recursive: true, force: true });
    resetCaches();
  });
  companionSettings.workspaceFolderProvider = () => dir;

  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssPath, Date.now());

  const base = widthIssuesFor(issues, '90%');
  assert.equal(
    base.length,
    0,
    `width: 90% is active below 768px and must NOT be dimmed (got ${JSON.stringify(issues.map((i) => `${i.propertyName}:${i.propertyValue}`))})`
  );
});

test('Test 5: genuinely overridden in every viewport is still reported', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }
  resetCaches();
  const previousProvider = companionSettings.workspaceFolderProvider;
  // `color: red` always loses to the later same-specificity `color: blue`
  // in every viewport (no media involved) — must still be ineffective.
  const css = ['.always-overridden {', '    color: red;', '}', '.always-overridden {', '    color: blue;', '}', ''].join('\n');
  const { dir, cssPath } = writeScratchFixture(css, '<div class="always-overridden">hi</div>');
  t.after(() => {
    companionSettings.workspaceFolderProvider = previousProvider;
    fs.rmSync(dir, { recursive: true, force: true });
    resetCaches();
  });
  companionSettings.workspaceFolderProvider = () => dir;

  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssPath, Date.now());
  const red = issues.filter((i) => i.propertyName === 'color' && i.propertyValue === 'red');
  assert.equal(red.length, 1, `always-overridden color:red must still be reported (got ${issues.length} issue(s))`);
  assert.match(red[0].reasonCode ?? '', /OVERRIDDEN/, 'override detection preserved');
});

test('Test 6: declaration active only inside a media query is recognized as active', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }
  resetCaches();
  const previousProvider = companionSettings.workspaceFolderProvider;
  const css = [
    '.mq-only {',
    '    display: block;',
    '}',
    '',
    '@media (min-width: 768px) {',
    '    .mq-only {',
    '        display: flex;',
    '    }',
    '}',
    '',
  ].join('\n');
  const { dir, cssPath } = writeScratchFixture(css, '<div class="mq-only"><span>a</span></div>');
  t.after(() => {
    companionSettings.workspaceFolderProvider = previousProvider;
    fs.rmSync(dir, { recursive: true, force: true });
    resetCaches();
  });
  companionSettings.workspaceFolderProvider = () => dir;

  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssPath, Date.now());
  const flex = issues.filter((i) => i.propertyName === 'display' && i.propertyValue === 'flex');
  assert.equal(
    flex.length,
    0,
    `display:flex (active >=768px) must NOT be reported as ineffective (got ${JSON.stringify(issues.map((i) => `${i.propertyName}:${i.propertyValue}`))})`
  );
});

test('boundary: real Chromium evaluates max-width:767/min-width:768 inclusively at 767 and 768', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }
  resetCaches();
  const previousProvider = companionSettings.workspaceFolderProvider;
  const { dir } = writeScratchFixture('.probe { color: red; }', '<div class="probe">x</div>');
  t.after(() => {
    companionSettings.workspaceFolderProvider = previousProvider;
    fs.rmSync(dir, { recursive: true, force: true });
    resetCaches();
  });
  companionSettings.workspaceFolderProvider = () => dir;

  const prepared = await defaultLifecycle.prepare(dir, '/index.html', true);
  const cdp = prepared.cdp;
  try {
    for (const width of [767, 768]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const maxAt = (await cdp.send('Runtime.evaluate', {
        expression: `matchMedia('(max-width: 767px)').matches`,
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      const minAt = (await cdp.send('Runtime.evaluate', {
        expression: `matchMedia('(min-width: 768px)').matches`,
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      const maxMatches = maxAt?.result?.value === true;
      const minMatches = minAt?.result?.value === true;
      if (width === 767) {
        assert.equal(maxMatches, true, 'max-width:767 must match AT 767 (inclusive)');
        assert.equal(minMatches, false, 'min-width:768 must NOT match at 767');
      } else {
        assert.equal(maxMatches, false, 'max-width:767 must NOT match at 768');
        assert.equal(minMatches, true, 'min-width:768 must match AT 768 (inclusive)');
      }
    }
  } finally {
    try {
      await cdp.send('Emulation.clearDeviceMetricsOverride', {});
    } catch {
      // Best-effort restore; the analyzer clears overrides after its own runs.
    }
  }
});

test('boundary: complementary max-767/min-768 pair splits correctly (base inactive everywhere, both media active)', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }
  resetCaches();
  const previousProvider = companionSettings.workspaceFolderProvider;
  const css = [
    '.split {',
    '    width: 10px;',
    '}',
    '@media (max-width: 767px) {',
    '    .split {',
    '        width: 20px;',
    '    }',
    '}',
    '@media (min-width: 768px) {',
    '    .split {',
    '        width: 30px;',
    '    }',
    '}',
    '',
  ].join('\n');
  const { dir, cssPath } = writeScratchFixture(css, '<div class="split">x</div>');
  t.after(() => {
    companionSettings.workspaceFolderProvider = previousProvider;
    fs.rmSync(dir, { recursive: true, force: true });
    resetCaches();
  });
  companionSettings.workspaceFolderProvider = () => dir;

  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssPath, Date.now());
  const byValue = new Map(issues.filter((i) => i.propertyName === 'width').map((i) => [i.propertyValue, i]));
  // Base loses everywhere (max wins narrow, min wins wide) → still reported.
  assert.ok(byValue.has('10px'), `base width:10px inactive everywhere must be reported (got ${issues.length} issue(s))`);
  // Each media declaration wins its own half → globally ACTIVE → never dimmed.
  assert.ok(!byValue.has('20px'), 'max-width:767 declaration active at 767 must NOT be dimmed');
  assert.ok(!byValue.has('30px'), 'min-width:768 declaration active at 768 must NOT be dimmed');
});

test('cross-sheet: sibling breakpoint widens coverage (analyzed base NOT dimmed)', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }
  resetCaches();
  const previousProvider = companionSettings.workspaceFolderProvider;
  // Analyzed sheet has NO media; the sibling sheet overrides it at >=500px.
  // Without the union fix the analyzer would evaluate only the default
  // viewport (800px), see the override, and incorrectly dim the base.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-responsive-xsheet-'));
  const cssPath = path.join(dir, 'styles.css');
  fs.writeFileSync(cssPath, '.shared {\n    width: 10px;\n}\n', 'utf-8');
  fs.writeFileSync(
    path.join(dir, 'other.css'),
    '@media (min-width: 500px) {\n    .shared {\n        width: 20px;\n    }\n}\n',
    'utf-8'
  );
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="UTF-8">',
      '<link rel="stylesheet" href="./styles.css">',
      '<link rel="stylesheet" href="./other.css">',
      '</head>',
      '<body>',
      '<div class="shared">x</div>',
      '</body>',
      '</html>',
      '',
    ].join('\n'),
    'utf-8'
  );
  t.after(() => {
    companionSettings.workspaceFolderProvider = previousProvider;
    fs.rmSync(dir, { recursive: true, force: true });
    resetCaches();
  });
  companionSettings.workspaceFolderProvider = () => dir;

  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssPath, Date.now());
  const base = issues.filter((i) => i.propertyName === 'width' && i.propertyValue === '10px');
  assert.equal(
    base.length,
    0,
    `analyzed base width:10px is active below 500px and must NOT be dimmed despite the sibling override above (got ${JSON.stringify(issues.map((i) => `${i.propertyName}:${i.propertyValue}`))})`
  );
});

test('unmodeled orientation: base overridden at the default viewport must NOT dim', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }
  resetCaches();
  const previousProvider = companionSettings.workspaceFolderProvider;
  // Default headless viewport (800x600) is landscape, so the landscape
  // override wins there and the base looks inactive — but it is active in
  // portrait, a context the width-viewport model cannot represent.
  // Reporting it would be a false positive from an unrecognized condition.
  const css = [
    '.orient {',
    '    width: 10px;',
    '}',
    '@media (orientation: landscape) {',
    '    .orient {',
    '        width: 20px;',
    '    }',
    '}',
    '',
  ].join('\n');
  const { dir, cssPath } = writeScratchFixture(css, '<div class="orient">x</div>');
  t.after(() => {
    companionSettings.workspaceFolderProvider = previousProvider;
    fs.rmSync(dir, { recursive: true, force: true });
    resetCaches();
  });
  companionSettings.workspaceFolderProvider = () => dir;

  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssPath, Date.now());
  const base = issues.filter((i) => i.propertyName === 'width' && i.propertyValue === '10px');
  assert.equal(
    base.length,
    0,
    `orientation-dependent base must NOT be dimmed from landscape-only evidence (got ${JSON.stringify(issues.map((i) => `${i.propertyName}:${i.propertyValue}`))})`
  );
});

test('unmodeled em unit: base overridden at the default width must NOT dim', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }
  resetCaches();
  const previousProvider = companionSettings.workspaceFolderProvider;
  // 10em matches at any plausible default root size at 800px, so the base
  // loses at the default viewport — but it is active below the em
  // threshold, whose px flip point the extractor cannot know.
  const css = [
    '.emsize {',
    '    width: 10px;',
    '}',
    '@media (min-width: 10em) {',
    '    .emsize {',
    '        width: 20px;',
    '    }',
    '}',
    '',
  ].join('\n');
  const { dir, cssPath } = writeScratchFixture(css, '<div class="emsize">x</div>');
  t.after(() => {
    companionSettings.workspaceFolderProvider = previousProvider;
    fs.rmSync(dir, { recursive: true, force: true });
    resetCaches();
  });
  companionSettings.workspaceFolderProvider = () => dir;

  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssPath, Date.now());
  const base = issues.filter((i) => i.propertyName === 'width' && i.propertyValue === '10px');
  assert.equal(
    base.length,
    0,
    `em-threshold base must NOT be dimmed from default-viewport-only evidence (got ${JSON.stringify(issues.map((i) => `${i.propertyName}:${i.propertyValue}`))})`
  );
});

test('budget: duplicate links and a sibling shared across companions stay bounded with cache reuse', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }
  resetCaches();
  const previousProvider = companionSettings.workspaceFolderProvider;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-responsive-dup-'));
  const cssPath = path.join(dir, 'styles.css');
  fs.writeFileSync(cssPath, '.dup {\n    width: 10px;\n}\n', 'utf-8');
  fs.writeFileSync(
    path.join(dir, 'shared.css'),
    '@media (min-width: 500px) {\n    .dup {\n        width: 20px;\n    }\n}\n',
    'utf-8'
  );
  const page = (extraLink: string) =>
    [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="UTF-8">',
      '<link rel="stylesheet" href="./styles.css">',
      extraLink,
      '<link rel="stylesheet" href="./shared.css">',
      '</head>',
      '<body>',
      '<div class="dup">x</div>',
      '</body>',
      '</html>',
      '',
    ].join('\n');
  // index.html references the analyzed sheet twice (duplicate href) and the
  // shared sibling; about.html shares the same sibling.
  fs.writeFileSync(path.join(dir, 'index.html'), page('<link rel="stylesheet" href="./styles.css">'), 'utf-8');
  fs.writeFileSync(path.join(dir, 'about.html'), page(''), 'utf-8');
  t.after(() => {
    companionSettings.workspaceFolderProvider = previousProvider;
    fs.rmSync(dir, { recursive: true, force: true });
    resetCaches();
  });
  companionSettings.workspaceFolderProvider = () => dir;

  const analyzer = new CdpAnalyzer();
  const first = await analyzer.analyzeCssFile(cssPath, Date.now());
  const baseFirst = first.filter((i) => i.propertyName === 'width' && i.propertyValue === '10px');
  assert.equal(
    baseFirst.length,
    0,
    `shared-sibling base active below 500px must NOT dim (got ${JSON.stringify(first.map((i) => `${i.propertyName}:${i.propertyValue}`))})`
  );
  const before = multiPassCache.stats();
  const second = await analyzer.analyzeCssFile(cssPath, Date.now());
  const after = multiPassCache.stats();
  assert.deepEqual(
    second.map((i) => `${i.selectorText}|${i.propertyName}|${i.propertyValue}`).sort(),
    first.map((i) => `${i.selectorText}|${i.propertyName}|${i.propertyValue}`).sort(),
    'identical inputs must reuse the cached responsive analysis deterministically'
  );
  assert.ok(after.mergedHits > before.mergedHits, 'the repeated responsive analysis must hit the merged cache');
});

test('container-one reproduction from the issue report is NOT dimmed on width:90%', { timeout: 120000 }, async (t) => {
  if (await skipIfNoChromium(t)) {
    return;
  }
  resetCaches();
  const previousProvider = companionSettings.workspaceFolderProvider;
  const css = [
    '.container-one {',
    '    display: flex;',
    '    width: 100%;',
    '    gap: 10px;',
    '    margin: 20px auto;',
    '    flex-wrap: wrap;',
    '}',
    '',
    '.container-one div {',
    '    width: 90%;',
    '    background-color: #eee;',
    '    color: black;',
    '    text-align: center;',
    '}',
    '',
    '.container-one div p:first-child {',
    '    font-weight: bold;',
    '}',
    '',
    '.container-one div p:nth-child(2) {',
    '    font-weight: lighter;',
    '    font-size: 0.8em;',
    '}',
    '',
    '@media (min-width: 768px) {',
    '    .container-one div {',
    '        width: 45%;',
    '    }',
    '}',
    '',
    '@media (min-width: 992px) {',
    '    .container-one div {',
    '        width: 20%;',
    '    }',
    '}',
    '',
  ].join('\n');
  const body = '<div class="container-one"><div><p>title</p><p>sub</p></div></div>';
  const { dir, cssPath } = writeScratchFixture(css, body);
  t.after(() => {
    companionSettings.workspaceFolderProvider = previousProvider;
    fs.rmSync(dir, { recursive: true, force: true });
    resetCaches();
  });
  companionSettings.workspaceFolderProvider = () => dir;

  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssPath, Date.now());
  const base = issues.filter(
    (i) => i.selectorText === '.container-one div' && i.propertyName === 'width' && i.propertyValue === '90%'
  );
  assert.equal(
    base.length,
    0,
    `container-one base width:90% must NOT be reported (got ${JSON.stringify(issues.map((i) => `${i.selectorText} ${i.propertyName}:${i.propertyValue}`))})`
  );
});
