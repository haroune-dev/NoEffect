import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { BrowserRunner } from '../../browser/browserRunner';

/**
 * BrowserRunner unit tests with an injected spawn: verifies launch flags,
 * the isolated temp profile (never the user's real profile) and cleanup.
 */

const DEBUG_URL = 'ws://127.0.0.1:1/devtools/browser/abc';

/**
 * Spawn stub that emits the DevTools URL on stderr (as a real Chromium
 * headless instance does) after a short tick. Records every invocation.
 */
function stubSpawn() {
  const calls: { cmd: string; args: string[] }[] = [];
  const spawnFn = (cmd: string, args: string[], _opts: unknown): unknown => {
    calls.push({ cmd, args });
    const child = new EventEmitter() as EventEmitter & { pid?: number; kill(): void } & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.pid = 1000 + calls.length;
    child.kill = () => {};
    // The real runner listens on the child's stdout/stderr streams; point
    // both at the child so a single 'data' emit reaches the listener.
    child.stdout = child;
    child.stderr = child;
    process.nextTick(() => child.emit('data', Buffer.from(`DevTools listening on ${DEBUG_URL}\n`)));
    return child;
  };
  return { calls, spawnFn: spawnFn as unknown as typeof spawn };
}

const createdDirs: string[] = [];

function tempDirFn(): string {
  const dir = `/tmp/noeffect-profile-${createdDirs.length}`;
  createdDirs.push(dir);
  return dir;
}

test('launch uses the injected spawn with the isolated temp profile', async () => {
  const { calls, spawnFn } = stubSpawn();
  const runner = new BrowserRunner({ spawnFn: spawnFn as unknown as typeof spawn, tempDirFn });

  const url = await runner.launch('/usr/bin/chromium');

  assert.equal(url, DEBUG_URL);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, '/usr/bin/chromium');
  const userDataDir = calls[0].args.find((a) => a.startsWith('--user-data-dir='));
  assert.ok(userDataDir, 'launch must pass an isolated --user-data-dir');
  assert.ok(userDataDir?.includes('noeffect-profile-'), 'profile must come from the temp provider');

  await runner.shutdown();
});

test('launch disables irrelevant browser features', async () => {
  const { calls, spawnFn } = stubSpawn();
  const runner = new BrowserRunner({ spawnFn: spawnFn as unknown as typeof spawn, tempDirFn });

  await runner.launch('/usr/bin/chromium');
  await runner.shutdown();

  const args = calls[0].args.join(' ');
  assert.ok(args.includes('--headless'));
  assert.ok(args.includes('--remote-debugging-port=0'));
  assert.ok(args.includes('--no-default-browser-check'));
  assert.ok(args.includes('--disable-background-networking'));
  assert.ok(args.includes('--no-first-run'));
});

test('recordFound-level confirmation is exercised via a successful launch', async () => {
  const { calls, spawnFn } = stubSpawn();
  const runner = new BrowserRunner({ spawnFn: spawnFn as unknown as typeof spawn, tempDirFn });

  await runner.launch('/usr/bin/chromium');
  assert.equal(runner.isRunning, true);

  await runner.shutdown();
  assert.equal(runner.isRunning, false);
  assert.ok(calls.length > 0);
});

/**
 * A spawn stub that emits caller-provided output chunks on its streams
 * (simulating real Chromium startup bytes, including CRLF endings and
 * chunk boundaries that split the endpoint line).
 */
function stubSpawnEmitting(chunks: Buffer[]) {
  const spawnFn = (_cmd: string, _args: string[], _opts: unknown): unknown => {
    const child = new EventEmitter() as EventEmitter & { pid?: number; kill(): void } & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.pid = 4242;
    child.kill = () => {};
    child.stdout = child;
    child.stderr = child;
    let i = 0;
    const emitNext = () => {
      if (i < chunks.length) {
        child.emit('data', chunks[i]);
        i += 1;
        process.nextTick(emitNext);
      }
    };
    process.nextTick(emitNext);
    return child;
  };
  return { spawnFn: spawnFn as unknown as typeof spawn };
}

test('Windows CRLF output: the captured CDP URL has no trailing carriage return', async () => {
  const { spawnFn } = stubSpawnEmitting([
    Buffer.from(`DevTools listening on ${DEBUG_URL}\r\n`),
  ]);
  const runner = new BrowserRunner({ spawnFn, tempDirFn });

  const url = await runner.launch('/usr/bin/chromium');

  assert.equal(url, DEBUG_URL);
  await runner.shutdown();
});

test('the endpoint line split across chunks is still matched', async () => {
  const { spawnFn } = stubSpawnEmitting([
    Buffer.from('[ERROR] some noise\nDevTools listening'),
    Buffer.from(` on ${DEBUG_URL}\n`),
  ]);
  const runner = new BrowserRunner({ spawnFn, tempDirFn });

  const url = await runner.launch('/usr/bin/chromium');

  assert.equal(url, DEBUG_URL);
  await runner.shutdown();
});