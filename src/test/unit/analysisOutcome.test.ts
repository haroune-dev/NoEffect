import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOutcome, deriveStatus, RunMetrics } from '../../failure/outcome';
import { stateForOutcome, AnalysisOutcome } from '../../failure/model';
import { ChromiumNotFoundError } from '../../failure/errors';
import { workspaceUntrustedFailure } from '../../failure/classifier';

/**
 * The unified outcome contract: deterministic status derivation and metric
 * aggregation. Downstream layers must be able to derive everything they need
 * from the outcome alone.
 */

function input(overrides: Partial<Parameters<typeof buildOutcome>[0]> = {}): Parameters<typeof buildOutcome>[0] {
  return {
    issuesCount: 0,
    metrics: new RunMetrics(),
    ...overrides,
  };
}

test('deriveStatus: a cancelled run wins over everything else', () => {
  const metrics = new RunMetrics();
  metrics.skippedAll = true;
  assert.equal(deriveStatus(input({ cancelled: true, metrics })), 'cancelled');
});

test('deriveStatus: any fatal error makes the run failed', () => {
  const failure = new ChromiumNotFoundError('/x');
  assert.equal(deriveStatus(input({ errors: [failure] })), 'failed');
});

test('deriveStatus: skippedInput and explicit skipped failures mean skipped', () => {
  assert.equal(deriveStatus(input({ skippedInput: true })), 'skipped');
  assert.equal(deriveStatus(input({ skipped: [workspaceUntrustedFailure()] })), 'skipped');
});

test('deriveStatus: skippedAll metrics mean skipped even without failures', () => {
  const metrics = new RunMetrics();
  metrics.skippedAll = true;
  assert.equal(deriveStatus(input({ metrics })), 'skipped');
});

test('deriveStatus: warnings or skipped selectors mean partial', () => {
  const warnMetrics = new RunMetrics();
  warnMetrics.addWarning(workspaceUntrustedFailure());
  assert.equal(deriveStatus(input({ metrics: warnMetrics })), 'partial');

  const skipMetrics = new RunMetrics();
  skipMetrics.markSkipped('.a', 'no element matched');
  assert.equal(deriveStatus(input({ metrics: skipMetrics })), 'partial');
});

test('deriveStatus: a clean run with no issues is success', () => {
  assert.equal(deriveStatus(input()), 'success');
});

test('buildOutcome: success carries the analyzed/skipped counts', () => {
  const metrics = new RunMetrics();
  metrics.markAnalyzed();
  metrics.markAnalyzed();
  metrics.markSkipped('.a', 'reason');

  const outcome = buildOutcome(input({ metrics, issuesCount: 3 }));
  assert.equal(outcome.status, 'partial');
  assert.equal(outcome.analyzedSelectorsCount, 2);
  assert.equal(outcome.skippedSelectorsCount, 1);
  assert.equal(outcome.issuesCount, 3);
  assert.deepEqual(outcome.skippedReasons, ['.a \u2014 reason']);
});

test('buildOutcome: merges metrics warnings, extra warnings and skipped failures', () => {
  const metrics = new RunMetrics();
  metrics.addWarning(workspaceUntrustedFailure());

  const outcome = buildOutcome(
    input({
      metrics,
      warnings: [workspaceUntrustedFailure()],
      skipped: [workspaceUntrustedFailure()],
    })
  );

  assert.equal(outcome.warnings.length, 3);
  assert.deepEqual(outcome.errors, []);
});

test('buildOutcome: errors are fatal, warnings stay separate', () => {
  const failure = new ChromiumNotFoundError('/x');
  const outcome = buildOutcome(
    input({ errors: [failure], warnings: [workspaceUntrustedFailure()] })
  );

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.errors.length, 1);
  assert.equal(outcome.errors[0].code, 'CHROMIUM_NOT_FOUND');
  assert.equal(outcome.warnings.length, 1);
});

test('buildOutcome: a cancelled run is marked stale', () => {
  const outcome = buildOutcome(input({ cancelled: true }));
  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.stale, true);
});

test('buildOutcome: a normal run is never stale', () => {
  const outcome = buildOutcome(input());
  assert.equal(outcome.stale, undefined);
});

test('stateForOutcome maps failed to the failed state and everything else to ready', () => {
  const failed = buildOutcome(input({ errors: [new ChromiumNotFoundError('/x')] })) as AnalysisOutcome;
  const cancelled = buildOutcome(input({ cancelled: true }));
  const success = buildOutcome(input());

  assert.equal(stateForOutcome(failed), 'failed');
  assert.equal(stateForOutcome(cancelled), 'ready');
  assert.equal(stateForOutcome(success), 'ready');
});
