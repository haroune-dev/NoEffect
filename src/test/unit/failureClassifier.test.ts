import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
  BrowserLaunchError,
  CdpConnectionError,
  CdpDisconnectedError,
  ChromiumNotFoundError,
  ChromiumPathInvalidError,
  DevServerError,
  DevServerPortBusyError,
  PageLoadError,
  PageLoadTimeoutError,
} from '../../failure/errors';
import {
  annotateFailureSource,
  classifyFailure,
  fileTooLargeFailure,
  fileUnsavedFailure,
  noCompanionHtmlFailure,
  selectorNotQueryableFailure,
  selectorsUnqueryableFailure,
  workspaceUntrustedFailure,
} from '../../failure/classifier';
import { FAILURE_CODES } from '../../failure/model';

/**
 * Determinism of the central failure classifier: the same thrown value must
 * always map to the same kind / code / severity / recoverability, and only
 * explicit signals may ever be classified — anything else falls through to
 * UNKNOWN_FAILURE instead of being guessed.
 */

test('typed errors classify verbatim (no inference required)', () => {
  const cases: Array<[Error, string, string]> = [
    [new AnalysisCancelledError(), 'analysis_cancelled', FAILURE_CODES.ANALYSIS_CANCELLED],
    [new AnalysisTimeoutError(), 'analysis_timeout', FAILURE_CODES.ANALYSIS_TIMEOUT],
    [new ChromiumNotFoundError('/usr/bin/chromium'), 'chromium_missing', FAILURE_CODES.CHROMIUM_NOT_FOUND],
    [new ChromiumPathInvalidError('/opt/nope'), 'chromium_path_invalid', FAILURE_CODES.CHROMIUM_PATH_INVALID],
    [new DevServerError('boom'), 'devserver_start_failed', FAILURE_CODES.DEVSERVER_START_FAILED],
    [new DevServerPortBusyError(9222), 'devserver_port_busy', FAILURE_CODES.DEVSERVER_PORT_BUSY],
    [new CdpConnectionError('refused'), 'cdp_connection_failed', FAILURE_CODES.CDP_CONNECTION_FAILED],
    [new CdpDisconnectedError(), 'cdp_connection_failed', FAILURE_CODES.CDP_DISCONNECTED],
    [new PageLoadError('navigation failed'), 'page_load_failed', FAILURE_CODES.PAGE_LOAD_FAILED],
    [new PageLoadTimeoutError('http://x'), 'page_load_timeout', FAILURE_CODES.PAGE_LOAD_TIMEOUT],
    [new BrowserLaunchError('boom', { code: FAILURE_CODES.BROWSER_LAUNCH_FAILED }), 'browser_crashed', FAILURE_CODES.BROWSER_LAUNCH_FAILED],
  ];

  for (const [err, kind, code] of cases) {
    const failure = classifyFailure(err);
    assert.equal(failure.kind, kind, `kind for ${err.constructor.name}`);
    assert.equal(failure.code, code, `code for ${err.constructor.name}`);
    assert.ok(failure.message.length > 0, `message for ${err.constructor.name}`);
  }
});

test('typed errors keep their explicit recoverability profile', () => {
  const disconnected = classifyFailure(new CdpDisconnectedError());
  assert.equal(disconnected.recoverable, true);
  assert.equal(disconnected.severity, 'fatal');

  const timeout = classifyFailure(new PageLoadTimeoutError());
  assert.equal(timeout.recoverable, true);
  assert.equal(timeout.severity, 'recoverable');

  const launch = classifyFailure(new ChromiumNotFoundError('/x'));
  assert.equal(launch.recoverable, false);
  assert.equal(launch.severity, 'fatal');
});

test('a raw ENOENT from the browser is chromium_missing when auto-detecting', () => {
  const failure = classifyFailure(Object.assign(new Error('spawn google-chrome ENOENT'), { code: 'ENOENT' }), {
    source: 'browser',
    chromiumPath: '',
  });
  assert.equal(failure.kind, 'chromium_missing');
  assert.equal(failure.code, FAILURE_CODES.CHROMIUM_NOT_FOUND);
  assert.equal(failure.source, 'browser');
});

test('a raw ENOENT from the browser is chromium_path_invalid when a path is configured', () => {
  const failure = classifyFailure(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), {
    source: 'browser',
    chromiumPath: '/opt/custom/chromium',
  });
  assert.equal(failure.kind, 'chromium_path_invalid');
  assert.equal(failure.code, FAILURE_CODES.CHROMIUM_PATH_INVALID);
});

test('a raw ENOENT from the dev server is a devserver start failure', () => {
  const failure = classifyFailure(Object.assign(new Error('spawn http-server ENOENT'), { code: 'ENOENT' }), {
    source: 'devserver',
  });
  assert.equal(failure.kind, 'devserver_start_failed');
});

test('a raw ENOENT with no subsystem context stays unknown (never guessed)', () => {
  const failure = classifyFailure(Object.assign(new Error('ENOENT somewhere'), { code: 'ENOENT' }));
  assert.equal(failure.kind, 'unknown');
  assert.equal(failure.code, FAILURE_CODES.UNKNOWN_FAILURE);
});

test('EADDRINUSE is always a dev-server port conflict', () => {
  const failure = classifyFailure(Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' }));
  assert.equal(failure.kind, 'devserver_port_busy');
  assert.equal(failure.code, FAILURE_CODES.DEVSERVER_PORT_BUSY);
});

test('connection-reset errnos classify as CDP connection failures', () => {
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'EPIPE']) {
    const failure = classifyFailure(Object.assign(new Error(code), { code }));
    assert.equal(failure.kind, 'cdp_connection_failed', code);
    assert.equal(failure.code, FAILURE_CODES.CDP_CONNECTION_FAILED, code);
  }
});

test('ETIMEDOUT is a CDP failure for browser/CDP sources, otherwise analysis timeout', () => {
  const cdp = classifyFailure(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }), { source: 'cdp' });
  assert.equal(cdp.kind, 'cdp_connection_failed');

  const analysis = classifyFailure(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }));
  assert.equal(analysis.kind, 'analysis_timeout');
  assert.equal(analysis.code, FAILURE_CODES.ANALYSIS_TIMEOUT);
});

test('an explicit WebSocket close code classifies as CDP_DISCONNECTED', () => {
  const failure = classifyFailure({
    message: 'socket closed',
    wsCloseCode: 1006,
    wsCloseReason: 'abnormal closure',
  });
  assert.equal(failure.kind, 'cdp_connection_failed');
  assert.equal(failure.code, FAILURE_CODES.CDP_DISCONNECTED);
  assert.deepEqual(failure.context, { wsCloseCode: 1006, wsCloseReason: 'abnormal closure' });
});

test('authored sentinel messages classify without guessing', () => {
  const wsClosed = classifyFailure(new Error('WebSocket closed while a request was in flight'));
  assert.equal(wsClosed.code, FAILURE_CODES.CDP_DISCONNECTED);

  const launchTimedOut = classifyFailure(new Error('Timed out waiting for Chromium CDP endpoint'));
  assert.equal(launchTimedOut.kind, 'browser_crashed');
  assert.equal(launchTimedOut.code, FAILURE_CODES.BROWSER_LAUNCH_FAILED);

  const exitedEarly = classifyFailure(new Error('Chromium exited before reporting its CDP endpoint'));
  assert.equal(exitedEarly.code, FAILURE_CODES.BROWSER_CRASHED);
});

test('a typed error always beats raw close-code hints', () => {
  const err = new DevServerPortBusyError(9222);
  // A raw-signal hint that would classify as CDP_DISCONNECTED if the
  // untrusted checks ever ran first — the typed branch must win.
  Object.assign(err as unknown as Record<string, unknown>, {
    wsCloseCode: 1006,
    wsCloseReason: 'abnormal closure',
  });
  const failure = classifyFailure(err);
  assert.equal(failure.kind, 'devserver_port_busy');
  assert.equal(failure.code, FAILURE_CODES.DEVSERVER_PORT_BUSY);
});

test('an unclassifiable error falls through to UNKNOWN_FAILURE with its source hint', () => {
  const raw = new Error('something entirely new happened');
  const failure = classifyFailure(raw, { source: 'cdp' });
  assert.equal(failure.kind, 'unknown');
  assert.equal(failure.code, FAILURE_CODES.UNKNOWN_FAILURE);
  assert.equal(failure.source, 'cdp');
  assert.equal(failure.cause, raw);
});

test('annotateFailureSource drives the classifier source, replacing an unknown default', () => {
  const raw = new Error('socket hiccup');
  annotateFailureSource(raw, 'cdp');
  const failure = classifyFailure(raw);
  assert.equal(failure.source, 'cdp');
});

test('classification is deterministic: the same input twice gives identical failures', () => {
  const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  const first = classifyFailure(err, { source: 'browser', chromiumPath: '' });
  const second = classifyFailure(err, { source: 'browser', chromiumPath: '' });
  assert.deepEqual(second, first);
});

test('null/undefined and primitive thrown values classify instead of crashing (P2-BUG-03)', () => {
  // `throw undefined`, `Promise.reject()`, `throw null` — the catch-all
  // boundary must never let a TypeError escape classification.
  for (const cause of [null, undefined]) {
    const failure = classifyFailure(cause as unknown);
    assert.equal(failure.kind, 'unknown', `kind for ${String(cause)}`);
    assert.equal(failure.code, FAILURE_CODES.UNKNOWN_FAILURE, `code for ${String(cause)}`);
    assert.ok(failure.message.length > 0, `a usable message for ${String(cause)}`);
  }

  const primitive = classifyFailure('string error');
  assert.equal(primitive.kind, 'unknown');
  assert.equal(primitive.message, 'string error');
});

test('input limitation factories emit their explicit codes', () => {
  assert.equal(workspaceUntrustedFailure().code, FAILURE_CODES.WORKSPACE_UNTRUSTED);
  assert.equal(fileUnsavedFailure('/a.css').code, FAILURE_CODES.FILE_UNSAVED);
  assert.equal(fileTooLargeFailure(2_000_000, 1_000_000).code, FAILURE_CODES.FILE_TOO_LARGE);
  assert.equal(selectorNotQueryableFailure('.x', 'reason').code, FAILURE_CODES.SELECTOR_NOT_QUERYABLE);
  assert.equal(selectorsUnqueryableFailure(3).code, FAILURE_CODES.SELECTORS_UNQUERYABLE);
  assert.equal(noCompanionHtmlFailure('/a.css').code, FAILURE_CODES.NO_COMPANION_HTML);
});
