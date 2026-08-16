import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMode,
  collectCoverage,
  CoverageSignals,
  emptyCoverage,
  emptyModeCounts,
} from '../../failure/coverage';
import {
  noCompanionHtmlFailure,
  selectorNotQueryableFailure,
  workspaceUntrustedFailure,
  workspaceUnsupportedFailure,
} from '../../failure/classifier';
import { ChromiumNotFoundError } from '../../failure/errors';

/**
 * Axis 3 (coverage): the collector is the single, deterministic source for
 * every skip-reason surface. It must derive stable modes from classified
 * failures and never invent counts.
 */

const baseSignals = (overrides: Partial<CoverageSignals> = {}): CoverageSignals => ({
  mode: 'active',
  stage: 'decoration',
  counts: { ...emptyModeCounts, totalSelectors: 5, targets: 5, queryable: 5, feedable: 5 },
  selectorStatus: 'analyzed',
  runStatus: 'success',
  ...overrides,
});

test('classifyMode: no failures means active', () => {
  assert.deepEqual(classifyMode([]), {
    mode: 'active',
    reason: 'all target selectors were inspected',
  });
});

test('classifyMode: a fatal failure forces failed mode', () => {
  const result = classifyMode([new ChromiumNotFoundError('/x')]);
  assert.equal(result.mode, 'failed');
});

test('classifyMode: input limitations (unsaved/too-large/ignored) decode to limited', () => {
  assert.equal(classifyMode([workspaceUntrustedFailure()]).mode, 'limited');
  assert.equal(classifyMode([workspaceUnsupportedFailure('x')]).mode, 'limited');
});

test('classifyMode: selector and feed limitations decode to limited', () => {
  assert.equal(classifyMode([selectorNotQueryableFailure('.a', 'no element')]).mode, 'limited');
  assert.equal(classifyMode([noCompanionHtmlFailure('/a.css')]).mode, 'limited');
});

test('collectCoverage: preserves provenance and per-run counts', () => {
  const data = collectCoverage(
    baseSignals({
      mode: 'limited',
      modeReason: '2 selectors could not be inspected',
      counts: {
        totalSelectors: 5,
        targets: 5,
        queryable: 3,
        feedable: 3,
        feedFailures: 2,
        feedSynthetic: 0,
      },
      selectorStatus: 'skip',
      selectorSkipReason: 'no element matched',
      runStatus: 'partial',
    })
  );

  assert.equal(data.overall.mode, 'limited');
  assert.equal(data.overall.modeReason, '2 selectors could not be inspected');
  assert.equal(data.currentRun?.runStatus, 'partial');
  assert.equal(data.currentRun?.counts.queryable, 3);
  assert.equal(data.currentRun?.counts.feedFailures, 2);
  assert.equal(data.currentRun?.stage, 'decoration');
  assert.equal(data.currentRun?.selectorStatus, 'skip');
  assert.equal(data.currentRun?.selectorSkipReason, 'no element matched');
});

test('collectCoverage: active mode gets a neutral fallback reason', () => {
  const data = collectCoverage(baseSignals());
  assert.equal(data.overall.mode, 'active');
  assert.equal(data.overall.modeReason, 'all target selectors were inspected');
  assert.equal(data.currentRun?.selectorStatus, 'analyzed');
});

test('collectCoverage: empty envelope stays zeroed and neutral', () => {
  const empty = emptyCoverage();
  assert.equal(empty.overall.mode, 'active');
  assert.equal(empty.overall.counts.targets, 0);
  assert.equal(empty.currentRun, null);
});

test('emptyModeCounts is fully zeros', () => {
  assert.deepEqual(emptyModeCounts, {
    totalSelectors: 0,
    targets: 0,
    queryable: 0,
    feedable: 0,
    feedSynthetic: 0,
    feedFailures: 0,
  });
});