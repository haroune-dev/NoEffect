import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractWidthBreakpoints,
  responsiveViewportsFor,
  viewportWidthsForBreakpoints,
  candidateWidthsForBreakpoints,
  isViewportCoverageComplete,
  isViewportCoverageCompleteForCss,
  hasUnmodeledMediaConditions,
  applyViewportCoveragePolicy,
  responsiveFingerprintForViewports,
  MAX_VIEWPORT_CONTEXTS,
  MAX_EXACT_BREAKPOINTS,
} from '../../engine/responsiveContexts';
import {
  mergePassOutcomes,
  PassOutcome,
  PassVerdict,
} from '../../engine/verdictMerge';
import { CssIssue } from '../../models';

/**
 * Regression tests for responsive CSS (media-query) false positives.
 *
 * A declaration must NOT be classified as globally ineffective merely
 * because it loses the cascade in the current viewport. Effectiveness is
 * f(CSS, DOM, viewport): active in at least one valid responsive context
 * ⇒ globally ACTIVE.
 *
 * These unit tests lock:
 *   - breakpoint extraction (min-width / max-width / overlaps / in-out),
 *   - bounded deterministic viewport generation,
 *   - lattice merging across responsive contexts (A wins).
 *
 * Real-browser CDP evaluation under each viewport lives in
 * `src/test/integration/responsive.integration.test.ts`.
 */

function issueFor(propertyName: string, value: string, startLine: number): CssIssue {
  return {
    propertyName,
    propertyValue: value,
    selector: '.foo',
    selectorText: '.foo',
    reason: 'overridden',
    reasonCode: 'OVERRIDDEN_BY_CROSS_RULE_DECLARATION',
    location: {
      filePath: '/p/styles.css',
      startLine,
      startColumn: 2,
      endLine: startLine,
      endColumn: 20,
    },
    propertyNameRange: {
      filePath: '/p/styles.css',
      startLine,
      startColumn: 2,
      endLine: startLine,
      endColumn: 2 + propertyName.length,
    },
  };
}

function viewportPass(rank: number, verdicts: PassVerdict[]): PassOutcome {
  return {
    companionPath: `/viewport/${rank}`,
    companionRank: rank,
    verdicts: new Map(verdicts.map((v) => [v.key, v])),
    success: true,
  };
}

// ── Breakpoint extraction ──

test('extracts multiple min-width breakpoints', () => {
  const css = `
.foo { width: 90%; }
@media (min-width: 768px) { .foo { width: 45%; } }
@media (min-width: 992px) { .foo { width: 20%; } }
`;
  assert.deepEqual(extractWidthBreakpoints([css]), [768, 992]);
});

test('extracts max-width breakpoints', () => {
  const css = `@media (max-width: 600px) { .a { display: block; } }`;
  assert.deepEqual(extractWidthBreakpoints([css]), [600]);
});

test('handles overlapping media queries', () => {
  const css = `
@media (min-width: 500px) { .a { color: red; } }
@media (max-width: 800px) { .a { color: blue; } }
@media (min-width: 768px) and (max-width: 1024px) { .a { color: green; } }
`;
  assert.deepEqual(extractWidthBreakpoints([css]), [500, 768, 800, 1024]);
});

test('ignores ordinary width declarations (only @media preludes count)', () => {
  const css = `.foo { width: 768px; min-width: 992px; }`;
  assert.deepEqual(extractWidthBreakpoints([css]), []);
});

test('ignores non-px units and non-width features', () => {
  const css = `
@media (min-width: 48em) { .a { color: red; } }
@media (orientation: landscape) { .a { color: blue; } }
@media (prefers-color-scheme: dark) { .a { color: black; } }
`;
  assert.deepEqual(extractWidthBreakpoints([css]), []);
});

test('handles range syntax (width >= 768px)', () => {
  const css = `@media (width >= 768px) { .a { color: red; } }`;
  const breakpoints = extractWidthBreakpoints([css]);
  assert.ok(breakpoints.includes(768), `expected 768 in ${breakpoints}`);
});

test('deduplicates and sorts breakpoints across sheets', () => {
  const a = `@media (min-width: 992px) { .x { color: red; } }`;
  const b = `@media (min-width: 768px) { .x { color: blue; } } @media (min-width: 768px) { .y { color: green; } }`;
  assert.deepEqual(extractWidthBreakpoints([a, b]), [768, 992]);
});

// ── Viewport generation ──

test('viewport widths cover below/at/above for [768, 992]', () => {
  const widths = viewportWidthsForBreakpoints([768, 992]);
  // Below 768, at 768 (covers 768-991), at 992 (covers 992+), above 992.
  assert.ok(widths.includes(767), `below-768 representative missing in ${widths}`);
  assert.ok(widths.includes(768), `768 representative missing in ${widths}`);
  assert.ok(widths.includes(992), `992 representative missing in ${widths}`);
  assert.ok(widths.includes(993), `above-992 representative missing in ${widths}`);
  assert.deepEqual(widths, [...widths].sort((x, y) => x - y), 'deterministic sorted order');
});

test('single breakpoint yields below/at/above', () => {
  const widths = viewportWidthsForBreakpoints([600]);
  assert.deepEqual(widths, [599, 600, 601]);
});

test('no breakpoints yields the single default viewport (no override)', () => {
  const viewports = responsiveViewportsFor(['.a { color: red; }']);
  assert.equal(viewports.length, 1);
  assert.equal(viewports[0].label, 'default');
});

test('responsive CSS yields multiple labeled viewports', () => {
  const css = `
.foo { width: 90%; }
@media (min-width: 768px) { .foo { width: 45%; } }
@media (min-width: 992px) { .foo { width: 20%; } }
`;
  const viewports = responsiveViewportsFor([css]);
  assert.ok(viewports.length >= 3, `expected >=3 viewports, got ${viewports.length}`);
  assert.ok(viewports.some((v) => v.label === '<768px'), 'below-768 label missing');
  assert.ok(viewports.length <= MAX_VIEWPORT_CONTEXTS, 'bounded enumeration');
});

test('viewport enumeration is bounded', () => {
  const thresholds = Array.from({ length: 50 }, (_, i) => 100 + i * 50);
  const widths = viewportWidthsForBreakpoints(thresholds);
  assert.ok(widths.length <= MAX_VIEWPORT_CONTEXTS, `must stay bounded, got ${widths.length}`);
  // Extremes preserved: below-first and above-last always covered.
  assert.equal(widths[0], 99);
  assert.equal(widths[widths.length - 1], 2551);
});

test('responsive fingerprint differs by viewport set and version', () => {
  const a = responsiveViewportsFor(['@media (min-width: 768px) { .a { color: red; } }']);
  const b = responsiveViewportsFor(['.a { color: red; }']);
  assert.notEqual(
    responsiveFingerprintForViewports(a),
    responsiveFingerprintForViewports(b),
    'responsive vs default must differ (cache invalidation)'
  );
});

// ── Lattice merging across responsive contexts ──
// Each "pass" below is one responsive viewport context. The production code
// merges viewport verdicts with the SAME lattice (⊥ ≤ I ≤ A, JOIN = max)
// used for multi-companion merging, so these tests lock the required
// global semantics without needing a browser.

const KEY_90 = 'css|hash|3|2|3|20|width';
const KEY_45 = 'css|hash|7|2|7|20|width';
const KEY_20 = 'css|hash|11|2|11|20|width';

test('Test 1+4: width:90% ACTIVE below 768 ⇒ globally ACTIVE despite overrides elsewhere', () => {
  // <768px: width:90% ACTIVE (only matching rule).
  // 768-991px: width:90% OVERRIDDEN (I), width:45% ACTIVE.
  // >=992px: width:90% OVERRIDDEN (I), width:45% OVERRIDDEN (I), width:20% ACTIVE.
  const merged = mergePassOutcomes([
    viewportPass(0, [{ key: KEY_90, verdict: 'A' }]),
    viewportPass(1, [
      { key: KEY_90, verdict: 'I', issue: issueFor('width', '90%', 3) },
      { key: KEY_45, verdict: 'A' },
    ]),
    viewportPass(2, [
      { key: KEY_90, verdict: 'I', issue: issueFor('width', '90%', 3) },
      { key: KEY_45, verdict: 'I', issue: issueFor('width', '45%', 7) },
      { key: KEY_20, verdict: 'A' },
    ]),
  ]);
  assert.equal(merged.get(KEY_90)?.verdict, 'A', 'active in ≥1 context ⇒ globally ACTIVE (do NOT dim)');
  assert.equal(merged.get(KEY_90)?.issue, undefined, 'absorbed I issue is dropped');
  assert.equal(merged.get(KEY_45)?.verdict, 'A', 'width:45% active in its range ⇒ ACTIVE');
  assert.equal(merged.get(KEY_20)?.verdict, 'A', 'width:20% active in its range ⇒ ACTIVE');
});

test('Test 2: at 768-991px width:90% OVERRIDDEN and width:45% ACTIVE', () => {
  const merged = mergePassOutcomes([
    viewportPass(1, [
      { key: KEY_90, verdict: 'I', issue: issueFor('width', '90%', 3) },
      { key: KEY_45, verdict: 'A' },
    ]),
  ]);
  assert.equal(merged.get(KEY_90)?.verdict, 'I');
  assert.equal(merged.get(KEY_45)?.verdict, 'A');
});

test('Test 3: at >=992px width:90%/45% OVERRIDDEN and width:20% ACTIVE', () => {
  const merged = mergePassOutcomes([
    viewportPass(2, [
      { key: KEY_90, verdict: 'I', issue: issueFor('width', '90%', 3) },
      { key: KEY_45, verdict: 'I', issue: issueFor('width', '45%', 7) },
      { key: KEY_20, verdict: 'A' },
    ]),
  ]);
  assert.equal(merged.get(KEY_90)?.verdict, 'I');
  assert.equal(merged.get(KEY_45)?.verdict, 'I');
  assert.equal(merged.get(KEY_20)?.verdict, 'A');
});

test('Test 5: genuinely inactive in EVERY viewport stays ineffective', () => {
  const key = 'css|hash|5|2|5|20|color';
  const merged = mergePassOutcomes([
    viewportPass(0, [{ key, verdict: 'I', issue: issueFor('color', 'red', 5) }]),
    viewportPass(1, [{ key, verdict: 'I', issue: issueFor('color', 'red', 5) }]),
    viewportPass(2, [{ key, verdict: 'I', issue: issueFor('color', 'red', 5) }]),
  ]);
  assert.equal(merged.get(key)?.verdict, 'I', 'inactive everywhere ⇒ still reported');
  assert.ok(merged.get(key)?.issue, 'merged I carries an issue');
});

test('Test 6: active-only-inside-media (display:flex) recognized as active', () => {
  const keyBlock = 'css|hash|1|2|1|20|display';
  const keyFlex = 'css|hash|5|2|5|20|display';
  const merged = mergePassOutcomes([
    // Narrow: only `display: block` matches (media does not apply) — the
    // flex declaration has no verdict here (⊥, absent from the pass).
    viewportPass(0, [{ key: keyBlock, verdict: 'A' }]),
    // Wide: media applies — block overridden, flex ACTIVE.
    viewportPass(1, [
      { key: keyBlock, verdict: 'I', issue: issueFor('display', 'block', 1) },
      { key: keyFlex, verdict: 'A' },
    ]),
  ]);
  assert.equal(merged.get(keyFlex)?.verdict, 'A', 'media-only declaration active in its range ⇒ ACTIVE');
});

test('unknown/evaluation-failure viewport contributes no evidence (⊥)', () => {
  // A failed viewport contributes NO lattice element: I ⊔ ⊥ = I never
  // means "a failed viewport proved inactive", and A from any successful
  // viewport still absorbs.
  const merged = mergePassOutcomes([
    viewportPass(0, [{ key: KEY_90, verdict: 'A' }]),
    { companionPath: '/viewport/failed', companionRank: 1, verdicts: new Map(), success: false, error: 'CDP timeout' },
  ]);
  assert.equal(merged.get(KEY_90)?.verdict, 'A');
});

test('multi-page aggregation preserved: ACTIVE on one page/viewport wins over INACTIVE elsewhere', () => {
  const merged = mergePassOutcomes([
    viewportPass(0, [{ key: KEY_90, verdict: 'I', issue: issueFor('width', '90%', 3) }]),
    viewportPass(1, [{ key: KEY_90, verdict: 'A' }]),
  ]);
  assert.equal(merged.get(KEY_90)?.verdict, 'A', 'ACTIVE anywhere ⇒ ACTIVE globally');
});

// ── Boundary semantics: max-width is inclusive (w <= T), min-width is ──
// ── inclusive (w >= T). The adjacent pair max-width:767 / min-width:768 ──
// ── is complementary (no gap, no overlap); the exact-boundary viewport ──
// ── (767 and 768 respectively) must always be evaluated.              ──

test('boundary: adjacent max-width:767 / min-width:768 yields both sides', () => {
  const widths = viewportWidthsForBreakpoints([767, 768]);
  assert.deepEqual(widths, [766, 767, 768, 769]);
});

test('boundary: exact-threshold viewport is always evaluated (inclusive match)', () => {
  // (max-width: T) matches AT T; (min-width: T) matches AT T. The set
  // always contains T itself, so the inclusive edge is really evaluated.
  assert.ok(viewportWidthsForBreakpoints([767]).includes(767), 'max-width edge 767 evaluated');
  assert.ok(viewportWidthsForBreakpoints([768]).includes(768), 'min-width edge 768 evaluated');
  assert.deepEqual(viewportWidthsForBreakpoints([768]), [767, 768, 769]);
});

test('boundary: exact width (width: 768px) evaluates active + both inactive sides', () => {
  const widths = viewportWidthsForBreakpoints([768]);
  assert.deepEqual(widths, [767, 768, 769], 'active-at-768 plus both inactive neighbors');
});

test('boundary: complementary pair covers both media behaviors with real semantics', () => {
  // Pure CSS truth table (no browser needed for the semantics themselves):
  // max-width:767 ⇔ w<=767, min-width:768 ⇔ w>=768.
  const maxMatches = (w: number) => w <= 767;
  const minMatches = (w: number) => w >= 768;
  const widths = viewportWidthsForBreakpoints([767, 768]);
  const behaviors = new Set(widths.map((w) => `${maxMatches(w)}|${minMatches(w)}`));
  assert.ok(behaviors.has('true|false'), 'narrow side (max only) represented');
  assert.ok(behaviors.has('false|true'), 'wide side (min only) represented');
  // Complementary pair: no width matches both, none matches neither.
  for (const w of widths) {
    assert.notEqual(maxMatches(w), minMatches(w), `width ${w} must match exactly one side`);
  }
});

test('boundary: extraction keeps both thresholds of a complementary pair', () => {
  const css = [
    '@media (max-width: 767px) { .foo { width: 20%; } }',
    '@media (min-width: 768px) { .foo { width: 30%; } }',
  ].join('\n');
  assert.deepEqual(extractWidthBreakpoints([css]), [767, 768]);
});

// ── Bounded enumeration: exact coverage limit, determinism, and the ──
// ── no-false-positive guarantee via coverage policy.                 ──

test('bounded: up to MAX_EXACT_BREAKPOINTS thresholds are covered exactly', () => {
  assert.equal(MAX_EXACT_BREAKPOINTS, MAX_VIEWPORT_CONTEXTS - 2);
  const five = [100, 200, 300, 400, 500];
  assert.equal(isViewportCoverageComplete(five), true);
  assert.deepEqual(viewportWidthsForBreakpoints(five), candidateWidthsForBreakpoints(five));
  assert.equal(viewportWidthsForBreakpoints(five).length, 7);
  const six = [100, 200, 300, 400, 500, 600];
  assert.equal(isViewportCoverageComplete(six), false, '6 thresholds → 8 candidates > 7 → sampled');
});

test('bounded: downsampling is deterministic, sorted, and preserves extremes', () => {
  const thresholds = Array.from({ length: 50 }, (_, i) => 100 + i * 50);
  const first = viewportWidthsForBreakpoints(thresholds);
  const second = viewportWidthsForBreakpoints(thresholds);
  assert.deepEqual(first, second, 'same input → same viewports');
  assert.deepEqual(first, [...first].sort((x, y) => x - y), 'sorted order');
  assert.equal(first[0], 99, 'below-first extreme preserved');
  assert.equal(first[first.length - 1], 2551, 'above-last extreme preserved');
});

test('bounded: incomplete coverage suppresses globally-inactive (no false positive)', () => {
  // Craft CSS with 8 distinct thresholds → incomplete coverage.
  const many = Array.from({ length: 8 }, (_, i) => `@media (min-width: ${(i + 1) * 100}px) { .a${i} { color: red; } }`).join('\n');
  assert.equal(isViewportCoverageCompleteForCss([many]), false);
  const merged = new Map([
    ['k-active', { key: 'k-active', verdict: 'A' } as PassVerdict],
    ['k-dead', { key: 'k-dead', verdict: 'I', issue: issueFor('color', 'red', 5) } as PassVerdict],
  ]);
  const policy = applyViewportCoveragePolicy(merged, [many]);
  assert.equal(policy.coverageComplete, false);
  assert.equal(policy.suppressedInactiveCount, 1, 'the unsafe I is counted as suppressed');
  assert.equal(policy.verdicts.get('k-active')?.verdict, 'A', 'proven-active survives');
  assert.equal(policy.verdicts.has('k-dead'), false, 'unproven-inactive never dims');
});

test('bounded: complete coverage passes verdicts through untouched', () => {
  const css = '@media (min-width: 768px) { .a { color: red; } }';
  const merged = new Map([
    ['k', { key: 'k', verdict: 'I', issue: issueFor('color', 'red', 5) } as PassVerdict],
  ]);
  const policy = applyViewportCoveragePolicy(merged, [css]);
  assert.equal(policy.coverageComplete, true);
  assert.equal(policy.suppressedInactiveCount, 0);
  assert.equal(policy.verdicts.get('k')?.verdict, 'I', 'exact coverage: genuine I still reported');
});

// ── Cross-stylesheet breakpoint union (selection level): a breakpoint in ──
// ── ANY evaluated sheet widens the viewport set, so it can never narrow ──
// ── coverage and flip ACTIVE → INACTIVE.                              ──

test('union: sibling-sheet breakpoints widen the viewport set', () => {
  const analyzed = '.shared { width: 10px; }';
  const sibling = '@media (min-width: 500px) { .shared { width: 20px; } }';
  assert.deepEqual(extractWidthBreakpoints([analyzed]), [], 'analyzed alone: non-responsive');
  assert.deepEqual(extractWidthBreakpoints([analyzed, sibling]), [500], 'union picks up the sibling breakpoint');
  const widths = viewportWidthsForBreakpoints(extractWidthBreakpoints([analyzed, sibling]));
  assert.deepEqual(widths, [499, 500, 501], 'both sides of the sibling threshold evaluated');
  assert.equal(isViewportCoverageCompleteForCss([analyzed, sibling]), true);
});

test('union: merged ACTIVE across union viewports stays ACTIVE (sibling scenario)', () => {
  // Base width:10px (analyzed, no media) vs sibling width:20px @>=500px:
  // narrow (499): base ACTIVE; wide (500/501): base OVERRIDDEN.
  const KEY_BASE = 'css|hash|1|2|1|20|width';
  const merged = mergePassOutcomes([
    viewportPass(0, [{ key: KEY_BASE, verdict: 'A' }]),
    viewportPass(1, [{ key: KEY_BASE, verdict: 'I', issue: issueFor('width', '10px', 1) }]),
    viewportPass(2, [{ key: KEY_BASE, verdict: 'I', issue: issueFor('width', '10px', 1) }]),
  ]);
  assert.equal(merged.get(KEY_BASE)?.verdict, 'A', 'active below 500 ⇒ globally ACTIVE despite sibling override above');
});

// ── Unsupported media-query safety: an unrecognized condition must never ──
// ── hide the only ACTIVE context (conservative abstain, no parsing      ──
// ── broadening).                                                        ──

test('unmodeled: supported width forms are fully modeled', () => {
  const supported = [
    '@media (min-width: 768px) { .a { color: red; } }',
    '@media (max-width: 767px) { .a { color: red; } }',
    '@media (width: 768px) { .a { color: red; } }',
    '@media (width >= 768px) { .a { color: red; } }',
    '@media (width > 768px) { .a { color: red; } }',
    '@media (768px <= width) { .a { color: red; } }',
    '@media (768px < width) { .a { color: red; } }',
    '@media screen and (min-width: 768px) { .a { color: red; } }',
    '@media (min-width: 768px) and (max-width: 992px) { .a { color: red; } }',
  ];
  for (const css of supported) {
    assert.equal(hasUnmodeledMediaConditions([css]), false, `should be modeled: ${css}`);
  }
});

test('unmodeled: non-width and non-px conditions force the conservative path', () => {
  const unmodeled = [
    '@media (orientation: landscape) { .a { color: red; } }',
    '@media (min-height: 600px) { .a { color: red; } }',
    '@media (prefers-color-scheme: dark) { .a { color: red; } }',
    '@media (resolution: 2dppx) { .a { color: red; } }',
    '@media (min-width: 48em) { .a { color: red; } }',
    '@media (min-width: 50vw) { .a { color: red; } }',
    '@media (768px <= width < 992px) { .a { color: red; } }',
    '@media (min-width: 768px) and (orientation: landscape) { .a { color: red; } }',
  ];
  for (const css of unmodeled) {
    assert.equal(hasUnmodeledMediaConditions([css]), true, `should be unmodeled: ${css}`);
  }
});

test('unmodeled: screen-never-matching types need no viewport evidence', () => {
  assert.equal(hasUnmodeledMediaConditions(['@media print { .a { color: red; } }']), false);
  assert.equal(hasUnmodeledMediaConditions(['.a { color: red; }']), false, 'no @media at all is modeled');
});

test('unmodeled: extraction stays narrow (no parsing broadening)', () => {
  // The unsupported forms above must not leak thresholds into the viewport
  // set: parsing is unchanged, only the safety flag is new.
  assert.deepEqual(extractWidthBreakpoints(['@media (min-width: 48em) { .a { color: red; } }']), []);
  assert.deepEqual(extractWidthBreakpoints(['@media (orientation: landscape) { .a { color: red; } }']), []);
  assert.deepEqual(extractWidthBreakpoints(['@media (768px <= width < 992px) { .a { color: red; } }']), []);
});

test('unmodeled: policy suppresses I even when the width set itself is exact', () => {
  // One px threshold (exact width coverage) plus an orientation override:
  // the orientation flip point is unknown, so a merged I is unsafe.
  const css = [
    '.u { width: 10px; }',
    '@media (min-width: 500px) { .u { width: 20px; } }',
    '@media (orientation: landscape) { .u { width: 30px; } }',
  ].join('\n');
  assert.deepEqual(extractWidthBreakpoints([css]), [500]);
  assert.equal(isViewportCoverageCompleteForCss([css]), true, 'width coverage alone is exact');
  assert.equal(hasUnmodeledMediaConditions([css]), true);
  const merged = new Map([
    ['k', { key: 'k', verdict: 'I', issue: issueFor('width', '10px', 1) } as PassVerdict],
    ['k2', { key: 'k2', verdict: 'A' } as PassVerdict],
  ]);
  const policy = applyViewportCoveragePolicy(merged, [css]);
  assert.equal(policy.coverageComplete, false);
  assert.equal(policy.suppressedInactiveCount, 1);
  assert.equal(policy.verdicts.has('k'), false, 'unsafe I never dims');
  assert.equal(policy.verdicts.get('k2')?.verdict, 'A', 'proven A survives');
});

// ── Budget safety: viewport evaluation stays bounded no matter how many ──
// ── sheets/companions/duplicates feed the breakpoint union.            ──

test('budget: viewport count is independent of sheet count and duplicates', () => {
  const sheet = '@media (min-width: 768px) { .a { color: red; } }';
  const once = responsiveViewportsFor([sheet]);
  const duplicated = responsiveViewportsFor([sheet, sheet, sheet]);
  assert.deepEqual(
    duplicated.map((v) => v.width),
    once.map((v) => v.width),
    'duplicate sheet texts must not inflate the viewport set'
  );
  const manySheets = responsiveViewportsFor([
    '@media (min-width: 100px) { .a { color: red; } }',
    '@media (min-width: 200px) { .b { color: red; } }',
    '@media (min-width: 300px) { .c { color: red; } }',
  ]);
  assert.ok(
    manySheets.length <= MAX_VIEWPORT_CONTEXTS,
    `union across sheets stays bounded (${manySheets.length})`
  );
});

test('budget: many thresholds across many sheets still bounded with suppression', () => {
  const sheets = Array.from(
    { length: 4 },
    (_, s) =>
      Array.from({ length: 3 }, (_, i) => `@media (min-width: ${s * 300 + (i + 1) * 100}px) { .s${s} { color: red; } }`).join('\n')
  );
  // 12 distinct thresholds → downsampled.
  assert.equal(extractWidthBreakpoints(sheets).length, 12);
  const viewports = responsiveViewportsFor(sheets);
  assert.ok(viewports.length <= MAX_VIEWPORT_CONTEXTS, `final CDP bound holds (${viewports.length})`);
  const policy = applyViewportCoveragePolicy(
    new Map([['k', { key: 'k', verdict: 'I', issue: issueFor('color', 'red', 5) } as PassVerdict]]),
    sheets
  );
  assert.equal(policy.coverageComplete, false);
  assert.equal(policy.verdicts.size, 0, 'incomplete union coverage suppresses I');
});
