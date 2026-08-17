import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RETRY_POLICY, backoffFor, isTransientKind, isPermanentKind } from '../../session/policy';
import { SessionHealth } from '../../session/health';
import { EventLog } from '../../session/eventLog';
import { buildKillPlan } from '../../session/processTree';
import { createTempDir, removeTempDir, listStaleTempDirs, sweepStaleTempDirs } from '../../session/tempProfile';
import { redact, redactLine, shortenPath } from '../../session/redaction';
import { messageForFailure, shouldNotify, NotificationDedupe } from '../../session/notifications';
import { runCheck, buildReport, renderReport, overallStatus } from '../../session/report';
import { buildOutcome, RunMetrics } from '../../failure/outcome';
import { CdpDisconnectedError, BrowserLaunchError } from '../../failure/errors';
import { classifyFailure } from '../../failure/classifier';

/**
 * Phase 5 unit tests: the typed retry/timeout policy, the session-health
 * state machine, the bounded event log, process-tree kill plans, temp-dir
 * hygiene, redaction, the notification allow-list + dedupe, the diagnose
 * report model, and the epoch stamping contract.
 */

// ── policy.ts ─────────────────────────────────────────────────────────────

test('retry policy offers a typed, positive row for every operation', () => {
  const operations = [
    'browser_launch',
    'cdp_connect',
    'cdp_reattach',
    'cdp_command',
    'page_load',
    'dev_server_start',
    'graceful_close',
    'full_analysis',
    'session_build',
    'restart_cleanup',
    'temp_dir_cleanup',
  ] as const;
  for (const op of operations) {
    const entry = RETRY_POLICY[op];
    assert.ok(entry.maxRetries >= 0, `${op} must define maxRetries`);
    assert.ok(entry.timeoutMs > 0, `${op} must define a positive timeout`);
  }
});

test('policy: the session-build budget covers the sum of its phases', () => {
  // The cold rebuild (launch + CDP connect + domain setup) runs under ONE
  // budget — it must be at least the launch budget + one connect attempt,
  // or slow browsers would make every first analysis fail its passes.
  const build = RETRY_POLICY.session_build.timeoutMs;
  const launch = RETRY_POLICY.browser_launch.timeoutMs;
  const connect = RETRY_POLICY.cdp_connect.timeoutMs;
  assert.ok(build >= launch + connect, 'session_build must cover launch + connect');
  // Cleanup escalation stays a short local cap (process-tree SIGKILL path).
  assert.ok(
    RETRY_POLICY.restart_cleanup.timeoutMs < launch,
    'restart_cleanup remains a cleanup cap, not a build budget'
  );
});

test('policy: transient and permanent failure kinds are disjoint claims', () => {
  // Transient — safe to retry after a wait.
  assert.equal(isTransientKind('browser_crashed'), true);
  assert.equal(isTransientKind('cdp_connection_failed'), true);
  assert.equal(isTransientKind('page_load_timeout'), true);
  assert.equal(isTransientKind('devserver_port_busy'), true);
  assert.equal(isTransientKind('analysis_timeout'), true);
  // Permanent — retrying cannot change the outcome.
  assert.equal(isTransientKind('chromium_missing'), false);
  assert.equal(isTransientKind('workspace_untrusted'), false);
  assert.equal(isTransientKind('file_too_large'), false);
  assert.equal(isPermanentKind('chromium_missing'), true);
  assert.equal(isPermanentKind('file_ignored'), true);
});

test('policy: backoff grows within the fixed table and is bounded', () => {
  assert.equal(backoffFor(1), 250);
  assert.equal(backoffFor(2), 500);
  assert.equal(backoffFor(3), 1000);
  // Attempts beyond the table stay bounded at the max delay.
  assert.equal(backoffFor(10), 1000);
  assert.equal(backoffFor(0), 250);
});

// ── processTree.ts ─────────────────────────────────────────────────────────

test('kill plan builds taskkill on Windows and a signal on POSIX', () => {
  assert.deepEqual(buildKillPlan(1234, 'win32'), { taskkill: ['/pid', '1234', '/T', '/F'] });
  assert.deepEqual(buildKillPlan(1234, 'linux'), { signal: 'SIGTERM' });
});

// ── sessionHealth.ts ──────────────────────────────────────────────────────

test('session health: valid cold-start lifecycle transitions', () => {
  const health = new SessionHealth();
  const seen: string[] = [];
  health.onTransition((change) => seen.push(`${change.from}>${change.to}:${change.reasonCode}`));

  assert.equal(health.state, 'none');
  health.markTransition('starting', 'session.start');
  health.markTransition('ready', 'session.ready');
  health.markTransition('recovering', 'crash.midrun');
  health.markTransition('ready', 'session.ready');
  health.markTransition('dead', 'crash.browser_exit');
  health.markTransition('starting', 'restart.recovery');
  health.markTransition('ready', 'session.ready');

  assert.deepEqual(seen, [
    'none>starting:session.start',
    'starting>ready:session.ready',
    'ready>recovering:crash.midrun',
    'recovering>ready:session.ready',
    'ready>dead:crash.browser_exit',
    'dead>starting:restart.recovery',
    'starting>ready:session.ready',
  ]);
});

test('session health: counters reflect crashes, recoveries and restarts', () => {
  const health = new SessionHealth();
  health.markTransition('starting', 'session.start');
  health.markTransition('ready', 'session.ready');
  health.markTransition('recovering', 'cdp.session_lost');
  health.markTransition('ready', 'session.ready');
  health.markTransition('dead', 'crash.browser_exit');
  health.markTransition('starting', 'restart.recovery');

  const counters = health.counters;
  assert.equal(counters.crashes, 1, 'one crash recorded at ->dead');
  assert.equal(counters.recoveries, 1, 'recovery recorded at ->recovering');
  assert.equal(counters.reconnects, 1, 'reconnect recorded at ->recovering');
  assert.equal(counters.restarts, 1, 'restart recorded when starting from a non-none state');
});

test('session health: illegal arcs are guarded (no state corruption)', () => {
  const health = new SessionHealth();
  const events: string[] = [];
  health.onTransition((change) => events.push(change.reasonCode));

  // ready -> none is not an allowed arc.
  health.markTransition('ready', 'should.not.happen');
  // none -> ready is not an allowed arc either.
  health.markTransition('ready', 'case.also.illegal');

  assert.equal(health.state, 'none');
  assert.equal(events.filter((e) => e === 'state.guard').length, 2);
});

test('session health: epoch bumps give each session identity a fresh number', () => {
  const health = new SessionHealth();
  assert.equal(health.epoch, 0);
  health.bumpEpoch();
  assert.equal(health.epoch, 1);
  health.bumpEpoch();
  assert.equal(health.epoch, 2);
  assert.equal(health.snapshot().epoch, 2);
});

test('session health: snapshot carries state, epoch, counters and reason', () => {
  const health = new SessionHealth();
  health.markTransition('starting', 'session.start');
  const snapshot = health.snapshot();
  assert.equal(snapshot.state, 'starting');
  assert.equal(snapshot.lastReasonCode, 'session.start');
  assert.equal(typeof snapshot.lastChangeTs, 'number');
  assert.equal(snapshot.counters.crashes, 0);
});

// ── eventLog.ts ───────────────────────────────────────────────────────────

test('event log is a bounded ring buffer (oldest dropped first)', () => {
  const log = new EventLog(2);
  log.push({ ts: 1, code: 'a', detail: 'x' });
  log.push({ ts: 2, code: 'b', detail: 'y' });
  log.push({ ts: 3, code: 'c', detail: 'z' });

  assert.equal(log.size, 2);
  assert.deepEqual(
    log.snapshot().map((entry) => entry.code),
    ['b', 'c']
  );
  log.clear();
  assert.equal(log.size, 0);
});

// ── tempProfile.ts ────────────────────────────────────────────────────────

test('temp profile: create/remove round-trips and removal on a missing dir is safe', async () => {
  const dir = createTempDir();
  assert.ok(fs.existsSync(dir), 'temp dir must exist after creation');
  assert.ok(path.basename(dir).startsWith('noeffect-'), 'temp dir keeps the standard prefix');

  const removed = await removeTempDir(dir);
  assert.equal(removed, true, 'temp dir is removed');
  assert.ok(!fs.existsSync(dir));

  const removedAgain = await removeTempDir(dir);
  assert.equal(removedAgain, true, 'removing a missing dir is a successful no-op');
});

test('temp profile: a stale dir is listed and swept (best effort)', async () => {
  const dir = createTempDir();
  const oldMtime = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(dir, oldMtime, oldMtime);

  const stale = listStaleTempDirs(60 * 60 * 1000);
  assert.ok(stale.includes(dir), 'the aged-out dir must be listed as stale');

  const sweepCount = await sweepStaleTempDirs(60 * 60 * 1000);
  assert.ok(sweepCount >= 1, 'sweep must remove at least the stale dir');
  assert.ok(!fs.existsSync(dir));
});

test('temp profile: removal refuses paths outside the noeffect-* temp namespace', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'other-'));
  try {
    assert.equal(await removeTempDir(outside), false, 'an off-namespace dir is refused');
    assert.ok(fs.existsSync(outside), 'the refused dir is left untouched');

    assert.equal(
      await removeTempDir(path.join(os.tmpdir(), 'noeffect-missing')),
      true,
      'a missing noeffect-* name is a successful no-op'
    );
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// ── redaction.ts ──────────────────────────────────────────────────────────

test('redaction scrubs assignment values, tokens and home paths', () => {
  assert.equal(redact('TOKEN=secret123'), 'TOKEN=REDACTED');
  assert.equal(redact('KEY = value'), 'KEY = REDACTED');
  assert.ok(!redact('PAYLOAD=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3').includes('a1b2c3d4e5f6a1b2c3d'));
  const homeScrubbed = redact(os.homedir());
  assert.ok(!homeScrubbed.includes(os.homedir()), 'home path must not appear');
  assert.ok(homeScrubbed.includes('REDACTED_HOME'));
});

test('redaction scrubs structured JSON values (P2-SEC-04)', () => {
  const json = redact('{"apiKey": "secret123", "token": "abc", "file": "styles.css"}');
  assert.ok(!json.includes('secret123'), 'JSON string values are redacted');
  assert.ok(!json.includes('"abc"'), 'multi-key JSON values are redacted');
  assert.ok(json.includes('"apiKey": REDACTED'), 'the JSON key structure survives');
  assert.ok(json.includes('"file": REDACTED'), 'every string value is scrubbed');

  const escaped = redact('{"note": "say \\"hi\\" now"}');
  assert.ok(!escaped.includes('say'), 'an escaped quote inside a JSON value cannot defeat the pass');
  assert.ok(escaped.includes('REDACTED'));
});

test('redaction scrubs lowercase keys (P2-SEC-04)', () => {
  assert.equal(redact('api_key=secret123'), 'api_key=REDACTED', 'lowercase bare keys are redacted');
  assert.equal(
    redact('https://host/?token=abc123&x=1'),
    'https://host/?token=REDACTED',
    'a lowercase key floating in a URL query is redacted (value through the next separator) ' +
      'while the URL scheme stays intact'
  );
  assert.equal(
    redact('https://host/path?a=b'),
    'https://host/path?a=REDACTED',
    'the scheme prefix is never swallowed by the key pass'
  );
});

test('redactLine bounds long excerpts and keeps short lines intact', () => {
  const original = 'API_KEY=abc ' + 'x'.repeat(400);
  const line = redactLine(original);
  assert.ok(line.length <= 301, 'line is bounded to 300 chars plus ellipsis');
  assert.ok(line.endsWith('…'));
  assert.ok(!line.includes('abc '));

  assert.equal(redactLine('short line'), 'short line');
});

test('shortenPath truncates long tails and is stable for short paths', () => {
  const short = shortenPath('/usr/bin/chromium');
  assert.equal(short, '/usr/bin/chromium');

  const long = shortenPath('/a'.repeat(100));
  assert.ok(long.length <= 61);
  assert.ok(long.startsWith('…'));
});

// ── notifications.ts ──────────────────────────────────────────────────────

test('notification allow-list: known codes map to entries; unknown codes never notify', () => {
  const crash = classifyFailure(new BrowserLaunchError('garbage'));
  const mapped = messageForFailure(crash);
  assert.equal(mapped.code, 'BROWSER_CRASHED');
  assert.ok(mapped.actions.length >= 1);

  const unknown = classifyFailure(new Error('a mystery failure'));
  const fallback = messageForFailure(unknown);
  assert.equal(fallback.notifyable, false);
  assert.ok(fallback.actions.length >= 1);
});
test('shouldNotify only fires for notifyable failures blocking explicit work', () => {
  const crash = classifyFailure(new BrowserLaunchError('boom'));
  assert.equal(shouldNotify(crash, false), false, 'routine/blurred failures never notify');
  assert.equal(shouldNotify(crash, true), true, 'a blocking explicit analysis may notify');

  const disconnected = classifyFailure(new CdpDisconnectedError());
  assert.equal(disconnected.code, 'CDP_DISCONNECTED');
  assert.equal(
    shouldNotify(disconnected, true),
    false,
    'self-healing CDP loss must never notify even when blocking'
  );
});

test('notification dedupe: one per code per state key, resets with the state', () => {
  const dedupe = new NotificationDedupe();
  assert.equal(dedupe.shouldSend('BROWSER_CRASHED', 'epoch5'), true);
  assert.equal(dedupe.shouldSend('BROWSER_CRASHED', 'epoch5'), false);
  assert.equal(dedupe.shouldSend('BROWSER_CRASHED', 'epoch6'), true);
  dedupe.reset();
  assert.equal(dedupe.shouldSend('BROWSER_CRASHED', 'epoch6'), true);
});

// ── report.ts ─────────────────────────────────────────────────────────────

test('report: a thrown check is isolated and cannot break the report', () => {
  const result = runCheck(() => {
    throw new Error('boom');
  }) as { status: 'fail'; detail: string };
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /boom/);
});

test('report: build/render/overall compose deterministically', () => {
  const report = buildReport({
    version: '1.2.3',
    vsCodeVersion: '1.90',
    os: 'linux',
    sectionGroups: [
      {
        group: 'environment',
        checks: [
          { id: 'a', label: 'ext on', status: 'ok' },
          { id: 'b', label: 'trust', status: 'fail', detail: 'untrusted' },
          { id: 'c', label: 'support', status: 'warn', detail: 'remote' },
          { id: 'd', label: 'no file', status: 'skipped', skipReason: 'none open' },
        ],
      },
    ],
  });

  assert.equal(overallStatus(report), 'fail');

  const rendered = renderReport(report);
  assert.ok(rendered.includes('# NoEffect Diagnose Report'));
  assert.ok(rendered.includes('❌'));
  assert.ok(rendered.includes('⚠️'));
  assert.ok(rendered.includes('⏭️'));
  assert.ok(rendered.includes('untrusted'));
});

// ── epoch stamping (failure/outcome + AnalysisRunner) ─────────────────────

test('outcome: an explicit epoch is stamped onto the built outcome', () => {
  const outcome = buildOutcome({
    issuesCount: 2,
    metrics: new RunMetrics(),
    epoch: 7,
  });
  assert.equal(outcome.epoch, 7);
});

test('outcome: no epoch given means no epoch field (backward compatible)', () => {
  const outcome = buildOutcome({ issuesCount: 0, metrics: new RunMetrics() });
  assert.equal(outcome.epoch, undefined);
});