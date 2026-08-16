import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadinessState } from '../../environment/readiness';
import {
  buildStatusView,
  OPEN_SETTINGS_COMMAND,
  ReadinessFacts,
  SHOW_OUTPUT_COMMAND,
} from '../../activation/statusViewModel';
import { COMMAND_IDS } from '../../activation/constants';
import { buildOutcome, RunMetrics } from '../../failure/outcome';

/**
 * Phase 3 status-view-model unit tests: safe, deterministic Show Status
 * content - no raw error messages, no full browser paths, declarative
 * actions only.
 */

function state(reason: ReadinessState['reason']): ReadinessState {
  return {
    ready: reason === 'ready',
    reason,
    severity: reason === 'ready' ? 'info' : 'fatal',
    recoverable: true,
    message: `msg for ${reason}`,
    warnings: [],
  };
}

function facts(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    settings: {
      enabled: true,
      analyzeOnSave: true,
      analyzeOnType: false,
      chromiumPath: '',
      ignoredFiles: [],
      maxFileSizeKb: 512,
    },
    readiness: state('ready'),
    workspace: { isTrusted: true, kind: 'local' },
    detection: {
      status: 'found',
      detectedVia: 'auto_detect',
      executablePath: '/home/user/.cache/chromium',
      message: 'found',
      checkedAt: 1234,
    },
    firstRunCompleted: false,
    extensionVersion: '1.2.3',
    ...overrides,
  };
}

test('heading reflects the derived status text', () => {
  assert.equal(buildStatusView(facts()).heading, 'NoEffect: Ready');
  assert.equal(
    buildStatusView(facts({ readiness: state('browser_not_found') })).heading,
    'NoEffect: Browser not found'
  );
});

test('disabled extension yields a minimal view without details', () => {
  const view = buildStatusView(facts({ settings: { ...facts().settings, enabled: false } }));
  assert.equal(view.heading, 'NoEffect: Disabled');
  assert.ok(view.lines.some((l) => l.label.includes('disabled')));
  assert.ok(!view.lines.some((l) => l.label.includes('Browser:')));
  assert.ok(!view.lines.some((l) => l.label.includes('Current file:')));
});

test('no readiness snapshot renders safely (never crashes, neutral heading)', () => {
  const view = buildStatusView(facts({ readiness: null }));
  assert.ok(view.heading.length > 0);
  assert.ok(view.lines.some((l) => l.label.includes('Browser:')));
});

test('current file is listed with eligibility detail', () => {
  const view = buildStatusView(
    facts({
      currentFile: { fileName: 'style.css', eligible: false, reasonText: 'file_too_large' },
    })
  );
  const line = view.lines.find((l) => l.label.startsWith('Current file:'));
  assert.ok(line);
  assert.equal(line.detail, 'file_too_large');
});

test('no raw browser paths appear anywhere in the view', () => {
  const view = buildStatusView(facts());
  const text = [view.heading, ...view.lines.map((l) => `${l.label} ${l.detail ?? ''}`)].join('\n');
  assert.ok(!text.includes('/home/user/'));
});

test('browser detection source is described in plain words', () => {
  const auto = buildStatusView(facts());
  const line = auto.lines.find((l) => l.label.startsWith('Browser:'));
  assert.ok(line);
  assert.equal(line.detail, 'via auto-detected');

  const configured = buildStatusView(
    facts({ detection: { status: 'found', detectedVia: 'configured_override', executablePath: '/x', message: '', checkedAt: 1 } })
  );
  const line2 = configured.lines.find((l) => l.label.startsWith('Browser:'));
  assert.ok(line2, 'browser line present');
  assert.equal(line2.detail, 'via configured browser path');
});

test('warnings are summarized by code, never dumped raw', () => {
  const readiness = state('ready');
  readiness.warnings = [
    {
      kind: 'cdp_connection_failed',
      code: 'BR_WARN',
      severity: 'warning',
      recoverable: true,
      source: 'cdp',
      message: 'something is slightly off',
    },
  ];
  const view = buildStatusView(facts({ readiness }));
  const line = view.lines.find((l) => l.label.startsWith('Warnings:'));
  assert.ok(line);
  assert.match(line.label, /BR_WARN/);
  assert.ok(!line.label.includes('something is slightly off'));
});

test('actions are declarative command data', () => {
  const view = buildStatusView(facts());
  const commands = view.actions.map((a) => a.command);
  assert.ok(commands.includes(COMMAND_IDS.analyzeCurrentFile));
  assert.ok(commands.includes(COMMAND_IDS.diagnoseSetup));
  assert.ok(commands.includes(OPEN_SETTINGS_COMMAND));
  assert.ok(commands.includes(SHOW_OUTPUT_COMMAND));
  for (const action of view.actions) {
    assert.equal(typeof action.title, 'string');
    assert.equal(typeof action.command, 'string');
  }
});

test('version detail appears when provided and is absent otherwise', () => {
  assert.ok(buildStatusView(facts()).lines[0].detail === 'v1.2.3');
  assert.equal(buildStatusView(facts({ extensionVersion: undefined })).lines[0].detail, undefined);
});

test('first-run state is surfaced as a plain line', () => {
  const view = buildStatusView(facts({ firstRunCompleted: true }));
  assert.ok(view.lines.some((l) => l.label.includes('shown')));
});

test('coverage section renders from the last outcome envelope', () => {
  const metrics = new RunMetrics();
  metrics.markAnalyzed();
  metrics.markAnalyzed();
  metrics.markSkipped('.ghost', 'no element matched');
  const outcome = buildOutcome({ issuesCount: 1, metrics });

  const view = buildStatusView(facts({ outcome }));
  const labels = view.lines.map((l) => l.label).join('\n');
  assert.ok(labels.includes('─ Coverage (last analysis) ─'));
  assert.ok(labels.includes('Analysis mode: limited'));
  assert.ok(labels.includes('Selectors inspected: 2/3'));
});
