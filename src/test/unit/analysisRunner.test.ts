import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import {
  AnalysisRunner,
  defaultFailureCleanup,
  MAX_ANALYZABLE_FILE_BYTES,
  RunRequest,
} from '../../services/analysisRunner';
import { AnalysisProvider } from '../../services/analyzer';
import { RunMetrics } from '../../failure/outcome';
import { AnalysisCancelledError, ChromiumNotFoundError, DevServerPortBusyError } from '../../failure/errors';
import { RETRY_POLICY } from '../../session/policy';
import { CancellationTokenLike, neverCancelled } from '../../failure/cancellation';
import { AnalysisFailure, FAILURE_CODES } from '../../failure/model';
import { CssIssue } from '../../models';
import { BrowserDetector } from '../../environment/browserDetection';

/**
 * Orchestration-layer tests for the AnalysisRunner: input classification,
 * cancellation semantics and the never-throws outcome contract.
 */

function issue(selector: string): CssIssue {
  return {
    propertyName: 'color',
    propertyValue: 'red',
    selector,
    location: {
      filePath: '/project/styles.css',
      startLine: 0,
      startColumn: 0,
      endLine: 0,
      endColumn: 1,
    },
  };
}

class StubToken implements CancellationTokenLike {
  isCancellationRequested: boolean = false;
  private listeners: Array<() => void> = [];

  onCancellationRequested(listener: () => void): { dispose(): void } {
    this.listeners.push(listener);
    return { dispose: () => void this.listeners.splice(this.listeners.indexOf(listener), 1) };
  }

  cancel(): void {
    this.isCancellationRequested = true;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

class StubProvider implements AnalysisProvider {
  issues: CssIssue[] = [];
  rejectWith: unknown = null;
  metrics = new RunMetrics();
  calls: string[] = [];
  contextFingerprint: string | null = null;
  private deferred: { promise: Promise<CssIssue[]>; resolve: (v: CssIssue[]) => void } | null = null;

  analyzeCssFile(cssFilePath: string, _startTime: number, token?: CancellationTokenLike): Promise<CssIssue[]> {
    this.calls.push(`css:${cssFilePath}`);
    if (token?.isCancellationRequested) {
      return Promise.reject(new AnalysisCancelledError());
    }
    if (this.rejectWith !== null) {
      return Promise.reject(this.rejectWith);
    }
    if (this.deferred) {
      return this.deferred.promise;
    }
    return Promise.resolve(this.issues);
  }

  analyzeHtmlFile(htmlFilePath: string, _startTime: number, token?: CancellationTokenLike): Promise<CssIssue[]> {
    this.calls.push(`html:${htmlFilePath}`);
    if (token?.isCancellationRequested) {
      return Promise.reject(new AnalysisCancelledError());
    }
    if (this.rejectWith !== null) {
      return Promise.reject(this.rejectWith);
    }
    return Promise.resolve(this.issues);
  }

  getRunMetrics(): RunMetrics {
    return this.metrics;
  }

  getLastContextFingerprint(): string | null {
    return this.contextFingerprint;
  }

  hang(): void {
    let resolve!: (v: CssIssue[]) => void;
    this.deferred = { promise: new Promise<CssIssue[]>((r) => (resolve = r)), resolve };
  }
}

class StubCleanup {
  cleaned: AnalysisFailure[] = [];
  async cleanup(failure: AnalysisFailure): Promise<void> {
    this.cleaned.push(failure);
  }
}

function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    filePath: '/project/styles.css',
    extension: '.css',
    isDirty: false,
    workspaceUntrusted: false,
    sizeBytes: 100,
    chromiumPath: '',
    ...overrides,
  };
}

/** Stub spawn for the detector: emits a synthetic exit/error for each probe. */
function stubSpawn(behaviour: 'ok' | 'fail') {
  const spawnFn = (_cmd: string, _args: string[], _opts: unknown): unknown => {
    const child = new EventEmitter() as EventEmitter & { kill(): void };
    child.kill = () => {};
    if (behaviour === 'ok') {
      process.nextTick(() => child.emit('exit', 0));
    } else {
      process.nextTick(() => child.emit('error', new Error('spawn failed')));
    }
    return child;
  };
  return spawnFn as unknown as typeof spawn;
}

test('a clean run resolves to a success outcome with the issues payload', async () => {
  const provider = new StubProvider();
  provider.issues = [issue('.a')];
  const runner = new AnalysisRunner({ analyzer: provider });

  const { outcome, issues } = await runner.run(request(), 0, neverCancelled);

  assert.equal(outcome.status, 'success');
  assert.equal(outcome.issuesCount, 1);
  assert.deepEqual(issues, [issue('.a')]);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0], 'css:/project/styles.css');
});

test('a .html request is dispatched to the HTML entry point', async () => {
  const provider = new StubProvider();
  const runner = new AnalysisRunner({ analyzer: provider });

  await runner.run(request({ filePath: '/project/index.html', extension: '.html' }), 0);

  assert.equal(provider.calls[0], 'html:/project/index.html');
});

test('getLastContextFingerprint surfaces the run-time snapshot identity', async () => {
  const provider = new StubProvider();
  provider.contextFingerprint = 'companions:a,b;max:2';
  const runner = new AnalysisRunner({ analyzer: provider });

  await runner.run(request(), 0);
  assert.equal(
    runner.getLastContextFingerprint(),
    'companions:a,b;max:2',
    'the fingerprint the run judged against is the one the caller records under'
  );
});

test('getLastContextFingerprint is null when the analyzer never recorded one', async () => {
  const provider = new StubProvider();
  const runner = new AnalysisRunner({ analyzer: provider });

  await runner.run(request(), 0);
  assert.equal(runner.getLastContextFingerprint(), null, 'no companion context → no identity to record under');
});

test('an unsupported file type is skipped before anything runs', async () => {
  const provider = new StubProvider();
  const runner = new AnalysisRunner({ analyzer: provider });

  const { outcome, issues } = await runner.run(request({ extension: '.scss' }), 0);

  assert.equal(outcome.status, 'skipped');
  assert.deepEqual(issues, []);
  assert.equal(provider.calls.length, 0);
  assert.ok(outcome.skippedReasons.some((r) => r.includes('Unsupported file type')));
});

test('an untrusted workspace is classified as WORKSPACE_UNTRUSTED and skipped', async () => {
  const provider = new StubProvider();
  const runner = new AnalysisRunner({ analyzer: provider });

  const { outcome } = await runner.run(request({ workspaceUntrusted: true }), 0);

  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.warnings[0].code, FAILURE_CODES.WORKSPACE_UNTRUSTED);
  assert.equal(provider.calls.length, 0);
});

test('a dirty file is classified as FILE_UNSAVED and skipped', async () => {
  const provider = new StubProvider();
  const runner = new AnalysisRunner({ analyzer: provider });

  const { outcome } = await runner.run(request({ isDirty: true }), 0);

  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.warnings[0].code, FAILURE_CODES.FILE_UNSAVED);
  assert.equal(provider.calls.length, 0);
});

test('an oversized file is classified as FILE_TOO_LARGE and skipped', async () => {
  const provider = new StubProvider();
  const runner = new AnalysisRunner({ analyzer: provider });

  const { outcome } = await runner.run(
    request({ sizeBytes: MAX_ANALYZABLE_FILE_BYTES + 1 }),
    0
  );

  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.warnings[0].code, FAILURE_CODES.FILE_TOO_LARGE);
  assert.equal(provider.calls.length, 0);
});

test('an unsupported workspace is classified as WORKSPACE_UNSUPPORTED and skipped', async () => {
  const provider = new StubProvider();
  const runner = new AnalysisRunner({ analyzer: provider });

  const { outcome } = await runner.run(request({ workspaceUnsupported: true }), 0);

  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.warnings[0].code, FAILURE_CODES.WORKSPACE_UNSUPPORTED);
  assert.equal(provider.calls.length, 0);
});

test('a request-level maxFileSizeBytes override gates the run', async () => {
  const provider = new StubProvider();
  const runner = new AnalysisRunner({ analyzer: provider });

  const { outcome } = await runner.run(
    request({ sizeBytes: 2048, maxFileSizeBytes: 1024 }),
    0
  );

  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.warnings[0].code, FAILURE_CODES.FILE_TOO_LARGE);
  assert.equal(provider.calls.length, 0);
});

test('a file matching an ignored pattern is classified as FILE_IGNORED and skipped', async () => {
  const provider = new StubProvider();
  const runner = new AnalysisRunner({ analyzer: provider });

  const { outcome } = await runner.run(
    request({ filePath: '/project/temp/a.css', ignoredPatterns: ['**/temp/**'] }),
    0
  );

  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.warnings[0].code, FAILURE_CODES.FILE_IGNORED);
  assert.equal(provider.calls.length, 0);
});

test('a generated bundle is classified as FILE_IGNORED and skipped', async () => {
  const provider = new StubProvider();
  const runner = new AnalysisRunner({ analyzer: provider });

  const { outcome } = await runner.run(request({ filePath: '/project/styles.min.css' }), 0);

  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.warnings[0].code, FAILURE_CODES.FILE_IGNORED);
  assert.equal(provider.calls.length, 0);
});

test('a detected-but-missing browser blocks the run with CHROMIUM_NOT_FOUND', async () => {
  const provider = new StubProvider();
  const detector = new BrowserDetector({ platform: 'aix' });
  await detector.detect();
  const runner = new AnalysisRunner({ analyzer: provider, detector });

  const { outcome } = await runner.run(request(), 0);

  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.warnings[0].code, FAILURE_CODES.CHROMIUM_NOT_FOUND);
  assert.equal(provider.calls.length, 0);
});

test('an invalid configured browser path blocks the run with CHROMIUM_PATH_INVALID', async () => {
  const provider = new StubProvider();
  const detector = new BrowserDetector({ platform: 'aix', existsSync: () => false });
  await detector.detect({ overridePath: '/missing/chrome' });
  const runner = new AnalysisRunner({ analyzer: provider, detector });

  const { outcome } = await runner.run(request({ chromiumPath: '/missing/chrome' }), 0);

  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.warnings[0].code, FAILURE_CODES.CHROMIUM_PATH_INVALID);
  assert.equal(provider.calls.length, 0);
});

test('an existing-but-unlaunchable browser blocks the run with BROWSER_LAUNCH_FAILED', async () => {
  const provider = new StubProvider();
  const detector = new BrowserDetector({ platform: 'linux', spawnFn: stubSpawn('fail') });
  await detector.detect();
  const runner = new AnalysisRunner({ analyzer: provider, detector });

  const { outcome } = await runner.run(request(), 0);

  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.warnings[0].code, FAILURE_CODES.BROWSER_LAUNCH_FAILED);
  assert.equal(provider.calls.length, 0);
});

test('a detected-and-usable browser does not block the run', async () => {
  const provider = new StubProvider();
  const detector = new BrowserDetector({ platform: 'aix', existsSync: () => true, spawnFn: stubSpawn('ok') });
  await detector.detect({ overridePath: '/usr/bin/chromium' });
  const runner = new AnalysisRunner({ analyzer: provider, detector });

  const { outcome } = await runner.run(request({ chromiumPath: '/usr/bin/chromium' }), 0);

  assert.equal(outcome.status, 'success');
  assert.equal(provider.calls.length, 1);
});

test('a pre-cancelled token yields a clean cancelled outcome', async () => {
  const provider = new StubProvider();
  const runner = new AnalysisRunner({ analyzer: provider });
  const token = new StubToken();
  token.cancel();

  const { outcome } = await runner.run(request(), 0, token);

  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.stale, true);
  assert.equal(provider.calls.length, 0);
});

test('a cancellation that arrives mid-run cancels a hung analysis cleanly', async () => {
  const provider = new StubProvider();
  provider.hang();
  const runner = new AnalysisRunner({ analyzer: provider });
  const token = new StubToken();

  const pending = runner.run(request(), 0, token);
  token.cancel();

  const { outcome } = await pending;
  assert.equal(outcome.status, 'cancelled');
});

test('a fatal typed failure produces a failed outcome and runs cleanup', async () => {
  const provider = new StubProvider();
  provider.rejectWith = new ChromiumNotFoundError('/usr/bin/chromium');
  const cleanup = new StubCleanup();
  const runner = new AnalysisRunner({ analyzer: provider, cleanup });

  const { outcome } = await runner.run(request(), 0);

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.errors.length, 1);
  assert.equal(outcome.errors[0].code, FAILURE_CODES.CHROMIUM_NOT_FOUND);
  assert.equal(cleanup.cleaned.length, 1);
  assert.equal(cleanup.cleaned[0].code, FAILURE_CODES.CHROMIUM_NOT_FOUND);
});

test('an unclassifiable raw error still yields a failed outcome via UNKNOWN_FAILURE', async () => {
  const provider = new StubProvider();
  provider.rejectWith = new Error('something unexpected');
  const cleanup = new StubCleanup();
  const runner = new AnalysisRunner({ analyzer: provider, cleanup });

  const { outcome } = await runner.run(request(), 0);

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.errors[0].code, FAILURE_CODES.UNKNOWN_FAILURE);
  assert.equal(cleanup.cleaned.length, 1);
});

test('the runner never throws: every condition resolves to an outcome', async () => {
  const provider = new StubProvider();
  provider.rejectWith = new DevServerPortBusyError(9222);
  const runner = new AnalysisRunner({ analyzer: provider, cleanup: { cleanup: async () => {} } });

  await assert.doesNotReject(() => runner.run(request(), 0));
});

test('warnings during a run degrade success into partial', async () => {
  const provider = new StubProvider();
  provider.metrics.addWarning({ kind: 'no_companion_html', code: FAILURE_CODES.NO_COMPANION_HTML, severity: 'info', recoverable: false, source: 'selector', message: 'no companion html' });
  const runner = new AnalysisRunner({ analyzer: provider });

  const { outcome } = await runner.run(request(), 0);

  assert.equal(outcome.status, 'partial');
  assert.deepEqual(outcome.warnings, provider.metrics.warnings);
});

test('defaultFailureCleanup: recoverable kinds never tear down the lifecycle', async () => {
  const timeouts: AnalysisFailure = {
    kind: 'page_load_timeout',
    code: FAILURE_CODES.PAGE_LOAD_TIMEOUT,
    severity: 'recoverable',
    recoverable: true,
    source: 'browser',
    message: 'timed out',
  };
  await assert.doesNotReject(() => defaultFailureCleanup.cleanup(timeouts));
});

test('defaultFailureCleanup: fatal runtime kinds dispose the lifecycle without throwing', async () => {
  const missing: AnalysisFailure = {
    kind: 'chromium_missing',
    code: FAILURE_CODES.CHROMIUM_NOT_FOUND,
    severity: 'fatal',
    recoverable: false,
    source: 'browser',
    message: 'not found',
  };
  await assert.doesNotReject(() => defaultFailureCleanup.cleanup(missing));
});

test('epoch: a successful run favours the analyzer\u2019s prepared session epoch', async () => {
  const provider = new StubProvider();
  provider.issues = [issue('.a'), issue('.b')];
  (provider as AnalysisProvider & { getLastSessionEpoch?(): number }).getLastSessionEpoch = () => 42;
  const runner = new AnalysisRunner({
    analyzer: provider,
    epochSource: () => 7,
  });

const { outcome } = await runner.run(request(), 0);
  assert.equal(outcome.epoch, 42, "the analyzer's epoch wins");
  assert.equal(outcome.issuesCount, 2);
});

test('success: without an analyzer epoch, the runner falls back to the epoch source', async () => {
  const provider = new StubProvider();
  const runner = new AnalysisRunner({
    analyzer: provider,
    epochSource: () => 99,
  });

  const { outcome } = await runner.run(request(), 0);
  assert.equal(outcome.epoch, 99);
});

test('input-blocked runs are stamped with the current epoch', async () => {
  const provider = new StubProvider();
  const runner = new AnalysisRunner({
    analyzer: provider,
    epochSource: () => 5,
  });

  const { outcome } = await runner.run(request({ isDirty: true }), 0);
  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.epoch, 5);
});

test('the full_analysis policy bounds a hung run into an ANALYSIS_TIMEOUT outcome', async () => {
  const provider = new StubProvider();
  provider.hang();

  // The policy table is the single source of truth; the only sanctioned
  // mutation point is tests, so shrink the budget for this check.
  const policy = RETRY_POLICY;
  const original = policy.full_analysis.timeoutMs;
  policy.full_analysis.timeoutMs = 50;

  try {
    const runner = new AnalysisRunner({ analyzer: provider });
    const { outcome } = await runner.run(request(), 0);
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.errors[0].code, FAILURE_CODES.ANALYSIS_TIMEOUT);
  } finally {
    policy.full_analysis.timeoutMs = original;
  }
});
