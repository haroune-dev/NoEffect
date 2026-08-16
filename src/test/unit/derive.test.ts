import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  companionCoverageLines,
  countsCaption,
  coverageLines,
  coverageSummaryLine,
  deriveOutcome,
  evidenceLine,
  rowKey,
} from '../../status/derive';
import { buildOutcome, RunMetrics } from '../../failure/outcome';
import { ChromiumNotFoundError } from '../../failure/errors';
import { emptyModeCounts } from '../../failure/coverage';
import { AnalysisOutcome } from '../../failure/model';

/**
 * Single-derivation contract: status bar text, tooltips and Show Status
 * text all come from one set of functions over the same axis data, so no
 * surface can ever disagree with another about a run's state.
 */

function outcome(overrides: Partial<Parameters<typeof buildOutcome>[0]> = {}): AnalysisOutcome {
  return buildOutcome({
    issuesCount: 0,
    metrics: new RunMetrics(),
    ...overrides,
  });
}

test('deriveOutcome: a clean success with issues reports the count in text', () => {
  const metrics = new RunMetrics();
  metrics.markAnalyzed();
  metrics.markAnalyzed();
  const row = deriveOutcome(
    outcome({ issuesCount: 2, metrics })
  );
  assert.equal(row.state, 'ready');
  assert.equal(row.text, 'NoEffect: 2 issue(s) found');
  assert.equal(row.tooltip, 'Analysis complete — 2 selector(s) inspected.');
});

test('deriveOutcome: no outcome falls back to an idle row', () => {
  const row = deriveOutcome(null);
  assert.equal(row.state, 'idle');
  assert.equal(row.text, 'NoEffect: Idle');
  assert.equal(row.visible, true);
});

test('deriveOutcome: a stale/superseded outcome maps to idle, not failure', () => {
  const stale = outcome({ cancelled: true });
  const row = deriveOutcome(stale);
  assert.equal(row.state, 'idle');
  assert.equal(row.tooltip.includes('Superseded'), true);
});

test('deriveOutcome: running renders the analyzing row', () => {
  const row = deriveOutcome(null, { running: true });
  assert.equal(row.state, 'analyzing');
  assert.equal(row.text, 'NoEffect: Analyzing…');
});

test('deriveOutcome: failed outcome carries the failure code, not the message', () => {
  const row = deriveOutcome(outcome({ errors: [new ChromiumNotFoundError('/x')] }));
  assert.equal(row.state, 'failed');
  assert.equal(row.text, 'NoEffect: Failed');
  assert.equal(row.tooltip.includes('CHROMIUM_NOT_FOUND'), true);
});

test('deriveOutcome: disabled hides the item', () => {
  const row = deriveOutcome(null, { disabled: true });
  assert.equal(row.state, 'disabled');
  assert.equal(row.visible, false);
});

test('countsCaption: collapses to a short core when fully fed', () => {
  const caption = countsCaption({
    totalSelectors: 5,
    targets: 5,
    queryable: 5,
    feedable: 5,
    feedFailures: 0,
    feedSynthetic: 0,
  });
  assert.equal(caption, 'queryable 5/5');
});

test('countsCaption: includes skipped count when targets were lost', () => {
  const caption = countsCaption({
    ...emptyModeCounts,
    queryable: 3,
    targets: 5,
    feedFailures: 2,
  });
  assert.equal(caption, 'queryable 3/5 (2 skipped)');
});

test('coverageLines: build a provenance-aware section from the outcome envelope', () => {
  const metrics = new RunMetrics();
  metrics.markAnalyzed();
  metrics.markSkipped('.ghost', 'no element matched');
  const built = outcome({ metrics });

  const lines = coverageLines(built);
  assert.ok(lines.length >= 2, 'expected an analysis coverage section');
  const labels = lines.map((l) => l.label).join('\n');
  assert.equal(labels.includes('Analysis mode: limited'), true);
  assert.equal(labels.includes('Selectors inspected: 1/2'), true);
});

test('coverageLines: nothing for an outcome without an envelope (cancelled)', () => {
  const cancelled = outcome({ cancelled: true });
  assert.deepEqual(coverageLines(cancelled), []);
});

test('coverageSummaryLine: falls back to raw counts without envelope', () => {
  assert.equal(coverageSummaryLine(outcome({})), 'analyzed 0, skipped 0');
});

test('rowKey: hidden is stable regardless of state', () => {
  assert.equal(rowKey({ state: 'ready', text: 'x', tooltip: 't', visible: false }), 'hidden');
  assert.equal(
    rowKey({ state: 'idle', text: 'NoEffect: Idle', tooltip: 't', visible: true }),
    'idle|NoEffect: Idle'
  );
});

test('Simulated limited run (unqueryable targets) derives a limited row', () => {
  const metrics = new RunMetrics();
  metrics.markAnalyzed();
  metrics.markSkipped('.x:hover', 'pseudo-class-only selector cannot be targeted');
  const built = outcome({ metrics });
  const row = deriveOutcome(built);
  assert.equal(row.state, 'partial');
  assert.equal(built.mode, 'limited');
  assert.equal(built.coverage?.overall.counts.feedFailures, 1);
});

// ── Companion evidence section & bounded-evidence note (Level 11) ────────

function companionOutcome(
  companions: NonNullable<Parameters<typeof buildOutcome>[0]>['metrics']['companionCoverage']
): AnalysisOutcome {
  const metrics = new RunMetrics();
  if (companions) {
    metrics.setCompanionCoverage(companions);
  }
  metrics.markAnalyzed();
  return outcome({ metrics });
}

test('companionCoverageLines: no companion envelope → no section', () => {
  assert.deepEqual(companionCoverageLines(outcome({})), []);
});

test('companionCoverageLines: analyzed/failed/skipped drawn from the ranked envelope, never invented', () => {
  const built = companionOutcome({
    analyzed: ['/p/index.html', '/p/pages/a.html'],
    failed: [],
    skipped: ['/p/pages/b.html'],
    total: 3,
    selected: 2,
  });

  const lines = companionCoverageLines(built);
  const labels = lines.map((l) => l.label).join('\n');
  const details = lines.map((l) => l.detail ?? '').join('\n');

  assert.equal(labels.includes('Companions: 2 analyzed · 0 failed · 1 not selected'), true);
  assert.equal(details.includes('Evidence budget 2/3 linking document(s)'), true);
  assert.equal(labels.includes('Companion documents analyzed'), true);
  assert.equal(details.includes('/p/index.html; /p/pages/a.html'), true, 'rank order preserved');
  assert.equal(
    details.includes('beyond the Top-2 budget: /p/pages/b.html'),
    true,
    'skipped companions show the budget that excluded them'
  );
});

test('companionCoverageLines: a failed companion is surfaced without inventing lattice evidence', () => {
  const built = companionOutcome({
    analyzed: ['/p/index.html'],
    failed: ['/p/pages/a.html'],
    skipped: [],
    total: 2,
    selected: 2,
  });
  const labels = companionCoverageLines(built).map((l) => l.label).join('\n');
  assert.equal(labels.includes('Companions: 1 analyzed · 1 failed · 0 not selected'), true);
  assert.equal(labels.includes('Companion passes failed'), true);
});

test('evidenceLine: behavior table row M=1, N=1, I=1 → null (suppressed)', () => {
  assert.equal(evidenceLine(1, 1, 1), null, 'single-companion runs add no information');
});

test('evidenceLine: M=2, N=1, I=1 uses the canonical 1/2 wording', () => {
  assert.equal(evidenceLine(1, 1, 2), 'No effect in 1 of 2 analyzed pages.');
});

test('evidenceLine: M=3, N=2, I=2 uses the canonical 2/3 wording', () => {
  assert.equal(evidenceLine(2, 2, 3), 'No effect in 2 of 3 analyzed pages.');
});

test('evidenceLine: M=2, N=2, I=2 has no separate all-pages wording', () => {
  assert.equal(evidenceLine(2, 2, 2), 'No effect in 2 of 2 analyzed pages.');
});

test('evidenceLine: behavior table row M=3, N=2, I=1 → null (defensive; merged would be A)', () => {
  assert.equal(evidenceLine(2, 1, 3), null, 'i != n contradicts the active-wins lattice');
});

test('evidenceLine: corruption guard — i > n → null', () => {
  assert.equal(evidenceLine(1, 2, 3), null, 'i > n is impossible for a merged-I issue');
  assert.equal(evidenceLine(2, 3, 3), null);
});

test('evidenceLine: all applicable multi-companion counts share the exact pattern and omit legacy wording', () => {
  assert.equal(evidenceLine(5, 5, 6), 'No effect in 5 of 6 analyzed pages.');
  const rendered = [evidenceLine(1, 1, 2), evidenceLine(2, 2, 3), evidenceLine(2, 2, 2), evidenceLine(5, 5, 6)];
  for (const line of rendered) {
    assert.ok(line, 'a rendered line exists');
    assert.match(line!, /^No effect in \d+ of \d+ analyzed pages\.$/);
    assert.equal(line!.includes('Inactive in all'), false, 'the all-pages wording is forbidden');
    assert.equal(line!.includes('No effective use was observed'), false, 'the legacy observed-use wording is forbidden');
    assert.equal(line!.includes('any of the'), false, 'the "any of the" wording is forbidden');
    assert.equal(line!.includes('pages that exercised it'), false, 'the exercised-pages wording is forbidden');
    assert.equal(line!.includes('(of '), false, 'the "(of X analyzed)" phrasing is forbidden');
    assert.equal(line!.includes('inactive everywhere'), false, 'the universal wording is forbidden');
  }
});

test('tooltip contract: the primary reason remains unchanged and precedes secondary evidence', () => {
  // This test deliberately reads the TypeScript source instead of importing
  // the VS Code-bound DecorationManager into the Node-only unit suite.
  const decorationsSource = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'src', 'diagnostics', 'decorations.ts'),
    'utf-8'
  );
  const primaryReason =
    'md.appendMarkdown(issue.reason?.trim() || createInactivePropertyExplanation(issue.propertyName));';
  const evidenceDerivation = 'const evidence = evidenceLine(evaluatedCount, inactiveCount, analyzedCompanions);';

  assert.ok(decorationsSource.includes(primaryReason), 'the primary reason rendering must remain unchanged');
  assert.ok(
    decorationsSource.indexOf(primaryReason) < decorationsSource.indexOf(evidenceDerivation),
    'the evidence must remain subordinate to the primary reason'
  );
  assert.ok(
    decorationsSource.includes('md.appendMarkdown(`\\n\\n_${evidence}_`);'),
    'the evidence remains the existing italic secondary paragraph'
  );
});
