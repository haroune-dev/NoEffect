import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadinessState } from '../../environment/readiness';
import {
  collectDiagnostics,
  configuredPathValidity,
  setupHint,
} from '../../activation/diagnoseSetup';
import { ReadinessFacts } from '../../activation/statusViewModel';

/**
 * Phase 3 Diagnose Setup unit tests: deterministic, sanitized diagnostics -
 * no secrets, no environment variables, stale detection marked explicitly.
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
      ignoredFiles: ['*.min.css'],
      maxFileSizeKb: 512,
    },
    readiness: state('ready'),
    workspace: { isTrusted: true, kind: 'local' },
    detection: {
      status: 'found',
      detectedVia: 'auto_detect',
      executablePath: '/usr/bin/chromium',
      message: 'found',
      checkedAt: 1234,
    },
    firstRunCompleted: false,
    extensionVersion: '1.2.3',
    ...overrides,
  };
}

test('diagnostics start with a versioned header line', () => {
  const lines = collectDiagnostics(facts());
  assert.ok(lines[0].startsWith('NoEffect setup diagnostics (v1.2.3)'));
});

test('diagnostics include the hint as the last line', () => {
  const lines = collectDiagnostics(facts());
  assert.ok(lines[lines.length - 1].startsWith('Hint: '));
});

test('configured path validity is derived from detection', () => {
  assert.equal(configuredPathValidity(facts()), 'not_set');
  assert.equal(
    configuredPathValidity(
      facts({
        settings: { ...facts().settings, chromiumPath: '/usr/bin/chromium' },
        detection: { status: 'found', detectedVia: 'configured_override', executablePath: '/usr/bin/chromium', message: '', checkedAt: 1 },
      })
    ),
    'valid'
  );
  assert.equal(
    configuredPathValidity(
      facts({
        settings: { ...facts().settings, chromiumPath: '/bad/path' },
        detection: { status: 'path_invalid', message: '', checkedAt: 1 },
      })
    ),
    'invalid'
  );
  assert.equal(
    configuredPathValidity(
      facts({
        settings: { ...facts().settings, chromiumPath: '/usr/bin/chromium' },
        detection: { status: 'found', detectedVia: 'auto_detect', executablePath: '/usr/bin/chromium', message: '', checkedAt: 1 },
      })
    ),
    'unknown'
  );
});

test('setup hints map every readiness reason to an actionable line', () => {
  assert.match(setupHint(facts()), /No action needed/);
  assert.match(setupHint(facts({ settings: { ...facts().settings, enabled: false } })), /noEffect\.enabled/);
  assert.match(setupHint(facts({ readiness: state('browser_not_found') })), /noEffect\.chromiumPath/);
  assert.match(setupHint(facts({ readiness: state('browser_path_invalid') })), /noEffect\.chromiumPath/);
  assert.match(setupHint(facts({ readiness: state('untrusted_workspace') })), /Trust this workspace/);
  assert.match(setupHint(facts({ readiness: state('unsupported_workspace') })), /local folder/);
  assert.match(setupHint(facts({ readiness: state('file_too_large') })), /Show Status/);
  assert.match(setupHint(facts({ readiness: null })), /Run Diagnose Setup again/);
});

test('stale detection is marked explicitly', () => {
  const lines = collectDiagnostics(facts({ detection: { status: 'found', detectedVia: 'auto_detect', executablePath: '/x', message: '', checkedAt: 0 } }));
  assert.ok(lines.some((l) => l.includes('never (stale')));
});

test('no environment variables or secret-like content in diagnostics', () => {
  const lines = collectDiagnostics(facts()).join('\n');
  assert.ok(!lines.includes('process.env'));
  assert.ok(!lines.includes('HOME='));
  assert.ok(!lines.includes('API_KEY'));
  assert.ok(!lines.includes('TOKEN'));
});

test('workspace trust and support are reported', () => {
  const untrusted = collectDiagnostics(facts({ workspace: { isTrusted: false, kind: 'local' } }));
  assert.ok(untrusted.some((l) => l.includes('untrusted')));
  const remote = collectDiagnostics(facts({ workspace: { isTrusted: true, kind: 'unsupported' } }));
  assert.ok(remote.some((l) => l.includes('unsupported')));
});

test('readiness unknown when no snapshot exists', () => {
  const lines = collectDiagnostics(facts({ readiness: null }));
  assert.ok(lines.some((l) => l.includes('Readiness: unknown')));
});

test('current file line reports eligibility or reason', () => {
  const eligible = collectDiagnostics(facts({ currentFile: { fileName: 'style.css', eligible: true, reasonText: '' } }));
  assert.ok(eligible.some((l) => l.includes('style.css') && l.includes('eligible')));
  const ineligible = collectDiagnostics(
    facts({ currentFile: { fileName: 'big.css', eligible: false, reasonText: 'file_too_large' } })
  );
  assert.ok(ineligible.some((l) => l.includes('file_too_large')));
});
