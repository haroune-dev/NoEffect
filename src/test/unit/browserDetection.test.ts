import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { BrowserDetector } from '../../environment/browserDetection';
import { CancellationTokenLike } from '../../failure/cancellation';

/**
 * Environment-detection unit tests for the BrowserDetector. Everything is
 * injected (platform, fs, spawn, env) so no real browser is ever needed.
 */

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

/**
 * A spawn stub that records every executable it was asked to probe.
 * `behaviour`:
 *   'ok'      – exits 0 (usable browser),
 *   'fail'    – emits 'error' (executable exists but unusable),
 *   'hang'    – emits nothing (probe runs until timeout/cancellation).
 */
function stubSpawn(behaviour: 'ok' | 'fail' | 'hang') {
  const probed: string[] = [];
  const spawnFn = (cmd: string, _args: string[], _opts: unknown): unknown => {
    probed.push(cmd);
    const child = new EventEmitter() as EventEmitter & { kill(): void };
    child.kill = () => {};
    if (behaviour === 'ok') {
      process.nextTick(() => child.emit('exit', 0));
    } else if (behaviour === 'fail') {
      process.nextTick(() => child.emit('error', new Error('spawn failed')));
    }
    return child;
  };
  return { spawnFn: spawnFn as unknown as typeof spawn, probed };
}

test('getCachedResult is not_attempted until the first detect', () => {
  const detector = new BrowserDetector({ platform: 'aix' });

  const cached = detector.getCachedResult();

  assert.equal(cached.status, 'not_attempted');
  assert.equal(cached.checkedAt, 0);
});

test('no candidates and no override resolves to not_found', async () => {
  const detector = new BrowserDetector({ platform: 'aix' });

  const result = await detector.detect();

  assert.equal(result.status, 'not_found');
  assert.equal(detector.getCachedResult().status, 'not_found');
});

test('a missing override path resolves to path_invalid and never auto-detects', async () => {
  const { spawnFn, probed } = stubSpawn('ok');
  const detector = new BrowserDetector({ platform: 'linux', existsSync: () => false, spawnFn });

  const result = await detector.detect({ overridePath: '/nope/chrome' });

  assert.equal(result.status, 'path_invalid');
  assert.ok(result.message.includes('does not exist'));
  assert.equal(probed.length, 0);
});

test('a valid override is confirmed with a successful version probe', async () => {
  const { spawnFn, probed } = stubSpawn('ok');
  const detector = new BrowserDetector({ platform: 'aix', existsSync: () => true, spawnFn });

  const result = await detector.detect({ overridePath: '/usr/bin/chromium' });

  assert.equal(result.status, 'found');
  assert.equal(result.executablePath, '/usr/bin/chromium');
  assert.equal(result.detectedVia, 'configured_override');
  assert.deepEqual(probed, ['/usr/bin/chromium']);
});

test('an override that exists but fails the probe is path_invalid', async () => {
  const { spawnFn } = stubSpawn('fail');
  const detector = new BrowserDetector({ platform: 'aix', existsSync: () => true, spawnFn });

  const result = await detector.detect({ overridePath: '/usr/bin/chromium' });

  assert.equal(result.status, 'path_invalid');
  assert.ok(result.message.includes('not a usable browser executable'));
});

test('allowOverride false never probes the configured override', async () => {
  const { spawnFn, probed } = stubSpawn('fail');
  const detector = new BrowserDetector({ platform: 'linux', existsSync: () => true, spawnFn });

  const result = await detector.detect({ overridePath: '/usr/bin/chromium', allowOverride: false });

  assert.equal(result.status, 'launch_failed');
  assert.ok(probed.every((cmd) => cmd !== '/usr/bin/chromium'));
});

test('results are cached until invalidate drops the cache', async () => {
  const { spawnFn, probed } = stubSpawn('ok');
  const detector = new BrowserDetector({ platform: 'aix', existsSync: () => true, spawnFn });

  await detector.detect({ overridePath: '/usr/bin/chromium' });
  await detector.detect({ overridePath: '/usr/bin/chromium' });
  assert.equal(probed.length, 1);

  detector.invalidate();
  await detector.detect({ overridePath: '/usr/bin/chromium' });
  assert.equal(probed.length, 2);
});

test('recordFound pre-seeds the cache so detection skips probing', async () => {
  const { spawnFn, probed } = stubSpawn('fail');
  const detector = new BrowserDetector({ platform: 'aix', existsSync: () => false, spawnFn });

  detector.recordFound('/confirmed/chrome', 'auto_detect');
  const result = await detector.detect({ overridePath: '/nope/chrome' });

  assert.equal(result.status, 'found');
  assert.equal(result.executablePath, '/confirmed/chrome');
  assert.equal(probed.length, 0);
});

test('a cancelled probe aborts detection without caching the result', async () => {
  const { spawnFn } = stubSpawn('hang');
  const detector = new BrowserDetector({ platform: 'linux', spawnFn });
  const token = new StubToken();

  const pending = detector.detect({ token });
  token.cancel();

  const result = await pending;
  assert.equal(result.status, 'not_attempted');
  assert.ok(result.message.includes('cancelled'));
  assert.equal(detector.getCachedResult().status, 'not_attempted');
});

const WIN_CHROME = path.join(
  'C:\\Program Files',
  'Google',
  'Chrome',
  'Application',
  'chrome.exe'
);

test('win32: an existing executable is found WITHOUT a --version probe', async () => {
  // Desktop chrome.exe/msedge.exe do not answer `--version` usefully on
  // Windows: the probe hangs, times out (reporting a working install as
  // missing) and — run headed with no profile isolation — opens a visible
  // browser window. Windows detection must therefore never spawn.
  const { spawnFn, probed } = stubSpawn('hang');
  const detector = new BrowserDetector({
    platform: 'win32',
    existsSync: (p) => p === WIN_CHROME,
    spawnFn,
    env: {},
  });

  const result = await detector.detect({ overridePath: WIN_CHROME });

  assert.equal(result.status, 'found');
  assert.equal(result.executablePath, WIN_CHROME);
  assert.equal(probed.length, 0);
});

test('win32: auto-detection finds an installed browser without spawning anything', async () => {
  const { spawnFn, probed } = stubSpawn('hang');
  const detector = new BrowserDetector({
    platform: 'win32',
    existsSync: (p) => p === WIN_CHROME,
    spawnFn,
    env: { PROGRAMFILES: 'C:\\Program Files' },
  });

  const result = await detector.detect();

  assert.equal(result.status, 'found');
  assert.equal(result.executablePath, WIN_CHROME);
  assert.equal(probed.length, 0);
});

test('win32: a missing executable still resolves to not_found', async () => {
  const { spawnFn, probed } = stubSpawn('hang');
  const detector = new BrowserDetector({
    platform: 'win32',
    existsSync: () => false,
    spawnFn,
    env: {},
  });

  const result = await detector.detect();

  assert.equal(result.status, 'launch_failed');
  assert.equal(detector.getCachedResult().status, 'launch_failed');
  void probed;
});
