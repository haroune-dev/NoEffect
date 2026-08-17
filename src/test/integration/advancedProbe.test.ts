import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { CdpAnalyzer } from '../../services/cdpAnalyzer';
import { defaultLifecycle } from '../../browser/lifecycleManager';
import { resolveCompanionsAll } from '../../services/companionResolver';
import { companionSettings } from '../../services/companionSettings';
import { companionCache } from '../../cache/companionCache';
import { multiPassCache } from '../../cache/multiPassCache';
import { REASON_CODES } from '../../inactive/reasonCode';
import * as fs from 'fs';

const FIXTURE = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'test',
  'test-multipage--advanced',
  'manual-multipage-stress'
);

test('ADVANCED-PROBE: dump + assert verdicts for the advanced multipage fixture', { timeout: 300000 }, async () => {
  const cssFilePath = path.join(FIXTURE, 'css', 'styles.css');
  multiPassCache.reset();
  companionCache.reset();
  companionSettings.workspaceFolderProvider = () => FIXTURE;

  const cssReal = path.normalize(path.resolve(cssFilePath));
  const primaryRoot = companionSettings.workspaceFolderProvider?.(cssFilePath) ?? path.dirname(cssReal);
  companionCache.set(`${primaryRoot}|${cssReal}`, await resolveCompanionsAll({ cssFilePath }));

  const analyzer = new CdpAnalyzer();
  const issues = await analyzer.analyzeCssFile(cssFilePath, Date.now());

  console.log('=== SELECTED RANKED COMPANIONS ===');
  const entry = companionCache.getValidatedEntry(`${primaryRoot}|${cssReal}`);
  console.log(
    (entry?.resolutions ?? []).map((r, i) => `${i}: ${r.htmlPath}`).join('\n')
  );
  console.log(`maxCompanions = ${companionSettings.maxCompanions}`);

  console.log('=== ISSUES (dimmed) ===');
  for (const issue of issues) {
    console.log(
      `DIMMED ${issue.selectorText} -> ${issue.propertyName}: ${issue.propertyValue} [${issue.reasonCode}]`
    );
  }

  // ── Stress-suite regression gate ────────────────────────────────────────
  // The fixture asserts per-selector expectations (see styles.css). A
  // declaration effective in ANY judged page must stay active (join-max);
  // only provably-inert declarations may dim. These assertions pin the
  // five reported failures: item-context evidence (active-somewhere,
  // flex-item-only, grid-item-only), replaced-element evidence
  // (replaced-sensitive via the <img> page), and the generated-pseudo
  // generated pseudo-box context.
  const dimmedKey = (selector: string, property: string) =>
    issues.some((i) => i.selectorText === selector && i.propertyName === property);
  const assertActive = (selector: string, property: string, why: string) => {
    assert.equal(dimmedKey(selector, property), false, `${selector} ${property}: ${why}`);
  };
  const assertDimmed = (selector: string, property: string, reasonCode: string) => {
    const issue = issues.find((i) => i.selectorText === selector && i.propertyName === property);
    assert.ok(issue, `${selector} ${property} must be dimmed`);
    assert.equal(issue.reasonCode, reasonCode);
  };

  assertActive('.active-somewhere', 'align-self', 'a real flex item exists on about.html');
  assertActive('.replaced-sensitive', 'object-fit', 'the <img> page proves it effective');
  assertActive('.flex-item-only', 'flex-grow', 'a real flex item exists on deep/b');
  assertActive('.grid-item-only', 'grid-column', 'a real grid item exists on deep/b');
  assertActive('.context-flex', 'justify-content', 'the flex container page wins');
  assertActive('.context-grid', 'grid-template-columns', 'the grid container page wins');
  assertActive('.truncation-sensitive', 'text-overflow', 'the inline preconditions are satisfied');
  assertActive(
    '.pseudo-sensitive::before',
    'display',
    'generated content creates a real pseudo box that can establish flex layout'
  );
  assertDimmed('.always-block', 'justify-content', REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);
  assertDimmed('.secondary-only', 'justify-content', REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);
  assertDimmed('.contents-sensitive', 'width', REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX);

  console.log('=== METRICS ===');
  const metrics = analyzer.getRunMetrics();
  console.log(`analyzed selectors: ${metrics.analyzedSelectorCount}`);
  for (const reason of metrics.skippedReasons) {
    console.log(`SKIPPED ${reason}`);
  }

  console.log(`CSS content ts: ${fs.existsSync(cssFilePath)}`);
});

// Tear down the persistent browser/DevServer session so a standalone run of
// this file exits cleanly (no orphaned Chromium/DevServer process).
after(() => defaultLifecycle.dispose());
