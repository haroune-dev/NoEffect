import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergedResultIsCacheable } from '../../services/cdpAnalyzer';
import { PassOutcome } from '../../engine/verdictMerge';

function pass(companionRank: number, success: boolean): PassOutcome {
  return {
    companionPath: `/fixture/page-${companionRank}.html`,
    companionRank,
    verdicts: new Map(),
    success,
  };
}

test('mergedResultIsCacheable: a run where every pass succeeded is cacheable', () => {
  assert.equal(
    mergedResultIsCacheable([pass(0, true), pass(1, true), pass(2, true)]),
    true
  );
});

test('mergedResultIsCacheable: a run with ANY failed pass is never cacheable', () => {
  assert.equal(mergedResultIsCacheable([pass(0, true), pass(1, false)]), false);
  assert.equal(mergedResultIsCacheable([pass(0, false), pass(1, true)]), false);
  assert.equal(mergedResultIsCacheable([pass(0, false)]), false);
});

test('mergedResultIsCacheable: a single successful pass is cacheable', () => {
  assert.equal(mergedResultIsCacheable([pass(0, true)]), true);
});

test('mergedResultIsCacheable: an empty run is vacuously cacheable (never occurs: K ≥ 1)', () => {
  assert.equal(mergedResultIsCacheable([]), true);
});