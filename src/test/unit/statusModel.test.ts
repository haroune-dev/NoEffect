import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadinessState } from '../../environment/readiness';
import { deriveStatus, STATUS_BAR_COMMAND } from '../../activation/statusModel';
import { COMMAND_IDS } from '../../activation/constants';

/**
 * Phase 3 status-model unit tests: the pure mapping from readiness to the
 * status-bar presentation (text, tooltip, visibility), including the
 * disabled/initializing/unknown corner cases.
 */

function state(reason: ReadinessState['reason']): ReadinessState {
  return {
    ready: reason === 'ready',
    reason,
    severity: reason === 'ready' ? 'info' : 'fatal',
    recoverable: reason !== 'unsupported_workspace',
    message: `message for ${reason}`,
    warnings: [],
  };
}

test('status bar item always opens the Show Status command', () => {
  assert.equal(STATUS_BAR_COMMAND, COMMAND_IDS.showStatus);
});

test('disabled extension maps to a hidden Disabled presentation', () => {
  const p = deriveStatus(false, state('ready'));
  assert.equal(p.state, 'disabled');
  assert.equal(p.visible, false);
  assert.match(p.tooltip, /noEffect\.enabled/);
});

test('null readiness with unknown flag maps to neutral Unknown, never success', () => {
  const p = deriveStatus(true, null, true);
  assert.equal(p.state, 'unknown');
  assert.equal(p.visible, true);
  assert.match(p.text, /unknown/i);
});

test('null readiness before the first snapshot maps to Initializing', () => {
  const p = deriveStatus(true, null, false);
  assert.equal(p.state, 'initializing');
  assert.equal(p.visible, true);
  assert.match(p.text, /Initializing/);
});

test('ready environment maps to a visible Ready presentation', () => {
  const p = deriveStatus(true, state('ready'), false);
  assert.equal(p.state, 'ready');
  assert.equal(p.visible, true);
  assert.equal(p.text, 'NoEffect: Ready');
});

test('browser problems map to setup-facing presentations', () => {
  const cases: ReadinessState['reason'][] = [
    'browser_not_found',
    'browser_path_invalid',
    'browser_launch_failed',
  ];
  for (const reason of cases) {
    const p = deriveStatus(true, state(reason), true);
    assert.equal(p.visible, true);
    assert.match(p.tooltip, /click|settings|diagnose/i);
  }
  assert.equal(deriveStatus(true, state('browser_not_found')).state, 'browser_not_found');
  assert.equal(deriveStatus(true, state('browser_path_invalid')).state, 'browser_path_invalid');
  assert.equal(deriveStatus(true, state('browser_launch_failed')).state, 'browser_launch_failed');
});

test('workspace problems map to workspace-facing presentations', () => {
  assert.equal(deriveStatus(true, state('untrusted_workspace')).state, 'workspace_untrusted');
  assert.equal(deriveStatus(true, state('unsupported_workspace')).state, 'workspace_unsupported');
  assert.equal(deriveStatus(true, state('untrusted_workspace')).visible, true);
});

test('file-level readiness reasons never surface as distinct status-bar states', () => {
  for (const reason of ['file_ineligible', 'file_too_large', 'file_ignored'] as const) {
    const p = deriveStatus(true, state(reason), true);
    assert.equal(p.state, 'unknown');
  }
});
