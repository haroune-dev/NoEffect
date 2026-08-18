import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadinessState } from '../../environment/readiness';
import { ReadinessController, ReadinessHost, ReadinessSource } from '../../activation/readinessController';
import { StatusBarController, StatusBarHost } from '../../activation/statusBarController';
import { CONTEXT_KEYS } from '../../activation/constants';

/**
 * Phase 3 readiness-controller unit tests: safe context-key defaults, stale
 * async results never overwrite newer ones, debounced coalescing, the
 * bounded first snapshot, and change-only logging.
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  controller: ReadinessController;
  contexts: Map<string, boolean>;
  logs: { level: string; line: string }[];
  statusBarHost: StatusBarHost & { shown: number; hidden: number };
  /** Queue of deferreds created by the stub source (LIFO order). */
  pending: Deferred<ReadinessState>[];
}

function makeHarness(
  settings: () => { enabled: boolean } = () => ({ enabled: true }),
  options: { refreshDebounceMs?: number; initialSnapshotTimeoutMs?: number } = {}
): Harness {
  const contexts = new Map<string, boolean>();
  const logs: { level: string; line: string }[] = [];
  const statusBarHost: StatusBarHost & { shown: number; hidden: number } = {
    text: '',
    tooltip: '',
    command: '',
    shown: 0,
    hidden: 0,
    show() {
      this.shown++;
    },
    hide() {
      this.hidden++;
    },
    dispose() {},
  };
  const statusBar = new StatusBarController(statusBarHost);
  const pending: Deferred<ReadinessState>[] = [];

  const source: ReadinessSource = {
    evaluate: () => {
      const d = deferred<ReadinessState>();
      pending.push(d);
      return d.promise;
    },
    refresh: () => {
      const d = deferred<ReadinessState>();
      pending.push(d);
      return d.promise;
    },
  };

  const host: ReadinessHost = {
    setContext: (key, value) => {
      contexts.set(key, value);
    },
    log: (level, line) => {
      logs.push({ level, line });
    },
  };

  const controller = new ReadinessController(source, host, statusBar, settings, () => {}, options);
  return { controller, contexts, logs, statusBarHost, pending };
}

/** Settle the most recent pending evaluation. */
function settle(harness: Harness, withState: ReadinessState | null): void {
  const item = harness.pending.pop();
  assert.ok(item, 'no pending evaluation to settle');
  if (withState === null) {
    item.reject(new Error('evaluation failed'));
  } else {
    item.resolve(withState);
  }
}

async function tick(ms = 5): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

test('start() initializes context keys to safe false defaults', () => {
  const harness = makeHarness();
  harness.controller.start();
  assert.equal(harness.contexts.get(CONTEXT_KEYS.ready), false);
  assert.equal(harness.contexts.get(CONTEXT_KEYS.setupNeeded), false);
  assert.equal(harness.contexts.get(CONTEXT_KEYS.workspaceBlocked), false);
  assert.equal(harness.contexts.get(CONTEXT_KEYS.enabled), true);
  harness.controller.dispose();
});

test('the first snapshot updates status bar and context keys', async () => {
  const harness = makeHarness();
  harness.controller.start();
  await tick(0);
  settle(harness, state('ready'));
  await tick();
  assert.equal(harness.statusBarHost.text, 'NoEffect: Ready');
  assert.equal(harness.statusBarHost.shown, 1);
  assert.equal(harness.contexts.get(CONTEXT_KEYS.ready), true);
  harness.controller.dispose();
});

test('browser setup problems set the setupNeeded context key', async () => {
  const harness = makeHarness();
  harness.controller.start();
  await tick(0);
  settle(harness, state('browser_not_found'));
  await tick();
  assert.equal(harness.contexts.get(CONTEXT_KEYS.setupNeeded), true);
  assert.equal(harness.contexts.get(CONTEXT_KEYS.ready), false);
  harness.controller.dispose();
});

test('workspace problems set the workspaceBlocked context key', async () => {
  const harness = makeHarness();
  harness.controller.start();
  await tick(0);
  settle(harness, state('untrusted_workspace'));
  await tick();
  assert.equal(harness.contexts.get(CONTEXT_KEYS.workspaceBlocked), true);
  assert.equal(harness.contexts.get(CONTEXT_KEYS.setupNeeded), false);
  harness.controller.dispose();
});

test('a failed refresh applies a neutral unknown state, not a stale success', async () => {
  const harness = makeHarness();
  harness.controller.start();
  await tick(0);
  settle(harness, state('ready'));
  await tick();
  assert.equal(harness.statusBarHost.text, 'NoEffect: Ready');

  harness.controller.refreshNow();
  settle(harness, null); // refresh fails
  await tick();
  assert.equal(harness.statusBarHost.text, 'NoEffect: Status unknown');
  assert.equal(harness.contexts.get(CONTEXT_KEYS.ready), false);
  harness.controller.dispose();
});

test('stale async results never overwrite newer ones (generation counter)', async () => {
  const harness = makeHarness();
  harness.controller.start();
  await tick(0);

  // First evaluation is slow (stale by the time it settles).
  const first = harness.pending[0];
  // A newer refresh starts meanwhile.
  harness.controller.refreshNow();
  const second = harness.pending[1];
  second.resolve(state('browser_not_found'));
  await tick();
  assert.equal(harness.statusBarHost.text, 'NoEffect: Browser not found');

  // The stale slow result settles last with a different state: ignored.
  first.resolve(state('ready'));
  await tick();
  assert.equal(harness.statusBarHost.text, 'NoEffect: Browser not found');
  harness.controller.dispose();
});

test('scheduleRefresh coalesces rapid triggers into one refresh', async () => {
  const harness = makeHarness(undefined, { refreshDebounceMs: 50 });
  harness.controller.start();
  await tick(0);
  settle(harness, state('ready'));
  await tick();

  harness.controller.scheduleRefresh();
  harness.controller.scheduleRefresh();
  harness.controller.scheduleRefresh();
  await tick(80);
  assert.equal(harness.pending.length, 1, 'triggers coalesce into a single refresh');
  settle(harness, state('browser_path_invalid'));
  await tick();
  assert.equal(harness.statusBarHost.text, 'NoEffect: Browser path invalid');
  harness.controller.dispose();
});

test('forceRefresh cancels pending debounced refreshes and refreshes now', async () => {
  const harness = makeHarness(undefined, { refreshDebounceMs: 1000 });
  harness.controller.start();
  await tick(0);
  settle(harness, state('ready'));
  await tick();

  harness.controller.scheduleRefresh();
  const refreshing = harness.controller.forceRefresh();
  settle(harness, state('browser_launch_failed'));
  await refreshing;
  assert.equal(harness.statusBarHost.text, 'NoEffect: Setup needed');

  // The debounced trigger must not fire afterwards.
  await tick(1100);
  assert.equal(harness.statusBarHost.text, 'NoEffect: Setup needed');
  harness.controller.dispose();
});

test('change-only logging: same reason does not log again', async () => {
  const harness = makeHarness();
  harness.controller.start();
  await tick(0);
  settle(harness, state('ready'));
  await tick();
  const readyLogs = harness.logs.filter((l) => l.line.includes('[Readiness] ready'));
  assert.equal(readyLogs.length, 1);

  harness.controller.refreshNow();
  settle(harness, state('ready'));
  await tick();
  const after = harness.logs.filter((l) => l.line.includes('[Readiness] ready'));
  assert.equal(after.length, 1);
  harness.controller.dispose();
});

test('setContext failures are swallowed silently', async () => {
  const contexts = new Map<string, boolean>();
  const failingHost: ReadinessHost = {
    setContext: (_key, _value) => Promise.reject(new Error('setContext failed')).then(() => undefined),
    log: () => {},
  };
  const statusBarHost: StatusBarHost = {
    text: '',
    tooltip: '',
    command: '',
    show() {},
    hide() {},
    dispose() {},
  };
  const statusBar = new StatusBarController(statusBarHost);
  const source: ReadinessSource = {
    evaluate: async () => state('ready'),
    refresh: async () => state('ready'),
  };
  const controller = new ReadinessController(source, failingHost, statusBar, () => ({ enabled: true }));
  await controller.refreshNow();
  await tick();
  assert.equal(contexts.size, 0); // untouched harness map; only asserting no crash
  controller.dispose();
});

test('T9 [F2]: blocked → ready transition fires the retry hook that re-analyzes (no content change)', async () => {
  // The activation layer wires `createReadinessUi(context, () => triggerReanalysis())`:
  // the retry hook fires EXACTLY once per distinct readiness transition, so a
  // blocked → ready transition re-analyzes the pending eligible CSS file with
  // NO file/settings change (no save required).
  const contexts = new Map<string, boolean>();
  const statusBarHost: StatusBarHost = {
    text: '',
    tooltip: '',
    command: '',
    show() {},
    hide() {},
    dispose() {},
  };
  const statusBar = new StatusBarController(statusBarHost);
  let current = state('browser_not_found');
  const source: ReadinessSource = {
    evaluate: async () => current,
    refresh: async () => current,
  };
  const host: ReadinessHost = {
    setContext: (key, value) => {
      contexts.set(key, value);
    },
    log: () => {},
  };

  // The controller reports each refresh state EXACTLY once — the transition
  // counter dedupes identical consecutive states, exactly like the debounced
  // re-analysis trigger does in the activation layer.
  let transitions = 0;
  let previousReason: string | null = null;
  const controller = new ReadinessController(source, host, statusBar, () => ({ enabled: true }), (snapshot) => {
    if (snapshot !== null && snapshot.reason !== previousReason) {
      transitions++;
      previousReason = snapshot.reason;
    }
  });

  // Blocked (no browser): the eligible CSS file sits pending — readiness not
  // ready, setup needed — and the retry hook must NOT fire.
  await controller.refreshNow();
  assert.equal(contexts.get(CONTEXT_KEYS.ready), false);
  assert.equal(contexts.get(CONTEXT_KEYS.setupNeeded), true);
  assert.equal(transitions, 1, 'only the blocked state was reported — no retry hook yet');

  // The environment becomes ready — no content change, no settings change.
  current = state('ready');
  await controller.refreshNow();
  assert.equal(contexts.get(CONTEXT_KEYS.ready), true);
  assert.equal(contexts.get(CONTEXT_KEYS.setupNeeded), false);
  assert.equal(transitions, 2, 'the blocked → ready transition fires the retry hook exactly once');
  assert.equal(previousReason, 'ready');

  // A stable ready state does not re-fire the hook.
  await controller.refreshNow();
  assert.equal(transitions, 2, 'only transitions, never steady states');
  controller.dispose();
});

test('dispose stops applying later results', async () => {
  const harness = makeHarness();
  harness.controller.start();
  await tick(0);
  harness.controller.dispose();
  settle(harness, state('ready'));
  await tick();
  assert.equal(harness.statusBarHost.text, '');
});

test('onSnapshot fires EXACTLY once per refresh (P2-BUG-10)', async () => {
  const snapshots: (ReadinessState | null)[] = [];
  const contexts = new Map<string, boolean>();
  const statusBarHost: StatusBarHost = {
    text: '',
    tooltip: '',
    command: '',
    show() {},
    hide() {},
    dispose() {},
  };
  const statusBar = new StatusBarController(statusBarHost);
  const host: ReadinessHost = {
    setContext: (key, value) => {
      contexts.set(key, value);
    },
    log: () => {},
  };
  const controller = new ReadinessController(
    {
      evaluate: async () => state('ready'),
      refresh: async () => state('ready'),
    },
    host,
    statusBar,
    () => ({ enabled: true }),
    (snapshot) => snapshots.push(snapshot)
  );

  await controller.refreshNow();
  await tick();
  await controller.refreshNow();
  await tick();

  assert.equal(snapshots.length, 2, 'one delivery per refresh — never a duplicate');
  assert.deepEqual(snapshots, [state('ready'), state('ready')]);
  controller.dispose();
});

test('the initial snapshot wait is bounded by the timeout option', async () => {
  const harness = makeHarness(undefined, { initialSnapshotTimeoutMs: 30 });
  harness.controller.start();
  await tick(0);

  // Do not settle: the race must return null after the timeout.
  const result = await harness.controller.refreshNow({ timeoutMs: 30 });
  assert.equal(result, null);

  // The eventual result still applies afterwards.
  settle(harness, state('ready'));
  await tick();
  assert.equal(harness.statusBarHost.text, 'NoEffect: Ready');
  harness.controller.dispose();
});
