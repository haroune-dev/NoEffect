import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadinessState } from '../../environment/readiness';
import {
  composeFirstRunMessage,
  createWorkspaceActions,
  decideFirstRun,
  FirstRunAction,
  FirstRunCoordinator,
  FirstRunMessage,
  FirstRunMessenger,
  FirstRunStore,
  FIRST_RUN_MESSAGES,
  TRUST_MANAGE_COMMAND,
} from '../../activation/firstRun';
import { COMMAND_IDS, FIRST_RUN_STATE_KEY } from '../../activation/constants';

/**
 * Phase 3 first-run unit tests: one-time welcome policy (shown at most
 * once, quiet when disabled/unknown, marked complete even when the
 * environment is unready, quiet failures).
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

function makeStore(initial = false, failMark = false, failRead = false): FirstRunStore & { marks: number; completed: boolean } {
  const store = {
    marks: 0,
    completed: initial,
    hasCompleted() {
      if (failRead) {
        throw new Error('read failed');
      }
      return this.completed;
    },
    markCompleted() {
      this.marks++;
      if (failMark) {
        throw new Error('write failed');
      }
      this.completed = true;
    },
  };
  return store;
}

function makeMessenger() {
  const calls: { message: FirstRunMessage; actionTitles: string[] }[] = [];
  const messenger: FirstRunMessenger & { calls: typeof calls } = {
    calls,
    async show(message, actions: FirstRunAction[]) {
      this.calls.push({ message, actionTitles: actions.map((a) => a.title) });
    },
  };
  return messenger;
}

test('decision: ready environment shows the ready welcome', () => {
  assert.equal(decideFirstRun(true, state('ready')), 'ready');
});

test('decision: browser problems show the setup message', () => {
  for (const reason of ['browser_not_found', 'browser_path_invalid', 'browser_launch_failed'] as const) {
    assert.equal(decideFirstRun(true, state(reason)), 'setup');
  }
});

test('decision: workspace problems show the workspace message', () => {
  for (const reason of ['untrusted_workspace', 'unsupported_workspace'] as const) {
    assert.equal(decideFirstRun(true, state(reason)), 'workspace');
  }
});

test('decision: disabled or unknown snapshots stay quiet', () => {
  assert.equal(decideFirstRun(false, state('ready')), 'none');
  assert.equal(decideFirstRun(true, null), 'none');
  for (const reason of ['file_ineligible', 'file_too_large', 'disabled'] as const) {
    assert.equal(decideFirstRun(true, state(reason)), 'none');
  }
});

test('first-run is shown exactly once for a ready environment', async () => {
  const store = makeStore();
  const messenger = makeMessenger();
  const coordinator = new FirstRunCoordinator(store, messenger);

  await coordinator.runOnce(true, state('ready'));
  await coordinator.runOnce(true, state('ready'));
  await coordinator.runOnce(true, state('ready'));

  assert.equal(messenger.calls.length, 1);
  assert.deepEqual(messenger.calls[0].message, FIRST_RUN_MESSAGES.ready);
  assert.equal(store.marks, 1);
});

test('an already-completed run is never re-shown', async () => {
  const store = makeStore(true);
  const messenger = makeMessenger();
  const coordinator = new FirstRunCoordinator(store, messenger);

  await coordinator.runOnce(true, state('ready'));

  assert.equal(messenger.calls.length, 0);
});

test('an unready environment still marks the run as completed', async () => {
  const store = makeStore();
  const messenger = makeMessenger();
  const coordinator = new FirstRunCoordinator(store, messenger);

  await coordinator.runOnce(true, state('browser_not_found'));

  assert.equal(messenger.calls.length, 1);
  assert.deepEqual(messenger.calls[0].message, FIRST_RUN_MESSAGES.setup);
  assert.equal(store.completed, true, 'persistent problems must not re-notify');
});

test('the workspace message is used for workspace problems', async () => {
  const store = makeStore();
  const messenger = makeMessenger();
  const coordinator = new FirstRunCoordinator(store, messenger);

  await coordinator.runOnce(true, state('untrusted_workspace'));

  assert.deepEqual(messenger.calls[0].message, FIRST_RUN_MESSAGES.workspace);
});

test('the workspace message text is the stable exact product string', () => {
  const title = FIRST_RUN_MESSAGES.workspace.title;
  const body = FIRST_RUN_MESSAGES.workspace.body;
  assert.equal(title, 'NoEffect needs a trusted workspace');
  assert.equal(body, 'Trust this local workspace to analyze rendering behavior.');
  assert.equal(
    composeFirstRunMessage(FIRST_RUN_MESSAGES.workspace),
    'NoEffect needs a trusted workspace — Trust this local workspace to analyze rendering behavior.'
  );
});

test('workspace actions: Trust Workspace first, Diagnose Setup second, both run the right commands', async () => {
  const executed: string[] = [];
  const actions = createWorkspaceActions(async (id) => {
    executed.push(id);
  });

  assert.deepEqual(
    actions.map((a) => a.title),
    ['Trust Workspace', 'Diagnose Setup']
  );

  for (const action of actions) {
    await action.run();
  }
  assert.deepEqual(executed, [TRUST_MANAGE_COMMAND, COMMAND_IDS.diagnoseSetup]);
});

test('the workspace prompt bypasses the one-time global completion flag', async () => {
  const store = makeStore(true);
  const messenger = makeMessenger();
  const coordinator = new FirstRunCoordinator(store, messenger);

  await coordinator.runOnce(true, state('untrusted_workspace'));

  assert.equal(messenger.calls.length, 1, 'completed onboarding must not suppress the trust prompt');
  assert.deepEqual(messenger.calls[0].message, FIRST_RUN_MESSAGES.workspace);
});

test('the workspace prompt never writes the one-time completion flag', async () => {
  const store = makeStore();
  const messenger = makeMessenger();
  const coordinator = new FirstRunCoordinator(store, messenger);

  await coordinator.runOnce(true, state('unsupported_workspace'));

  assert.equal(messenger.calls.length, 1);
  assert.equal(store.marks, 0, 'a security prompt must not consume the onboarding flag');
});

test('the workspace prompt shows at most once per activation (no duplicates on file switching)', async () => {
  const store = makeStore();
  const messenger = makeMessenger();
  const coordinator = new FirstRunCoordinator(store, messenger);

  await coordinator.runOnce(true, state('untrusted_workspace'));
  await coordinator.runOnce(true, state('untrusted_workspace'));
  await coordinator.runOnce(true, state('untrusted_workspace'));

  assert.equal(messenger.calls.length, 1);
  assert.equal(store.marks, 0);
});

test('trusted mode is quiet for the trust prompt: ready environments welcome normally', async () => {
  const store = makeStore();
  const messenger = makeMessenger();
  const coordinator = new FirstRunCoordinator(store, messenger);

  await coordinator.runOnce(true, state('ready'));

  assert.deepEqual(messenger.calls[0].message, FIRST_RUN_MESSAGES.ready, 'no trust toast in trusted mode');
});

test('workspace prompt still shows even when the onboarding store is unreadable', async () => {
  const store = makeStore(false, false, true);
  const messenger = makeMessenger();
  const coordinator = new FirstRunCoordinator(store, messenger);

  await coordinator.runOnce(true, state('untrusted_workspace'));

  assert.equal(messenger.calls.length, 1);
  assert.deepEqual(messenger.calls[0].message, FIRST_RUN_MESSAGES.workspace);
});

test('workspace actions are passed through to the notification', async () => {
  const store = makeStore();
  const messenger = makeMessenger();
  const actions: Record<'ready' | 'setup' | 'workspace', FirstRunAction[]> = {
    ready: [],
    setup: [],
    workspace: createWorkspaceActions(async () => {}),
  };
  const coordinator = new FirstRunCoordinator(store, messenger, actions);

  await coordinator.runOnce(true, state('untrusted_workspace'));

  assert.deepEqual(messenger.calls[0].actionTitles, ['Trust Workspace', 'Diagnose Setup']);
});

test('messenger actions are passed through for the matching decision', async () => {
  const store = makeStore();
  const messenger = makeMessenger();
  const actions: Record<'ready' | 'setup' | 'workspace', FirstRunAction[]> = {
    ready: [{ title: 'Analyze CSS', run: () => {} }],
    setup: [{ title: 'Open Settings', run: () => {} }],
    workspace: [],
  };
  const coordinator = new FirstRunCoordinator(store, messenger, actions);

  await coordinator.runOnce(true, state('ready'));

  assert.deepEqual(messenger.calls[0].actionTitles, ['Analyze CSS']);
});

test('a messenger failure stays quiet, latches for the session, and never marks completion (P3-LOG-25)', async () => {
  const store = makeStore();
  const messenger: FirstRunMessenger = {
    async show() {
      throw new Error('notification failed');
    },
  };
  const coordinator = new FirstRunCoordinator(store, messenger);

  await coordinator.runOnce(true, state('ready'));
  assert.equal(store.marks, 0);
  assert.equal(store.completed, false);

  // The failure must latch for this activation: a broken messenger must
  // not re-attempt (and re-fail) on every subsequent snapshot — the
  // notification is never re-shown, never nagged.
  await coordinator.runOnce(true, state('ready'));
  await coordinator.runOnce(true, state('ready'));
  assert.equal(store.marks, 0, 'no persistence write happened behind a failed show');
  assert.equal(store.completed, false, 'the global completion flag stays untouched');
});

test('a persistence failure never crashes the run', async () => {
  const store = makeStore(false, true);
  const messenger = makeMessenger();
  const coordinator = new FirstRunCoordinator(store, messenger);

  await coordinator.runOnce(true, state('ready'));

  assert.equal(messenger.calls.length, 1);
  assert.equal(store.completed, false);
});

test('an unreadable store resets safely and still shows once', async () => {
  const store = makeStore(false, false, true);
  const messenger = makeMessenger();
  const coordinator = new FirstRunCoordinator(store, messenger);

  await coordinator.runOnce(true, state('ready'));
  await coordinator.runOnce(true, state('ready'));

  assert.equal(messenger.calls.length, 1, 'read failure must not cause a re-show loop');
});

test('disabled activation is fully quiet', async () => {
  const store = makeStore();
  const messenger = makeMessenger();
  const coordinator = new FirstRunCoordinator(store, messenger);

  await coordinator.runOnce(false, state('ready'));

  assert.equal(messenger.calls.length, 0);
  assert.equal(store.marks, 0);
});

test('onShown callback fires only when the message is actually shown', async () => {
  const store = makeStore();
  const messenger = makeMessenger();
  let shown = 0;
  const coordinator = new FirstRunCoordinator(store, messenger, undefined, () => {
    shown++;
  });

  await coordinator.runOnce(true, state('ready'));
  await coordinator.runOnce(true, state('ready'));

  assert.equal(shown, 1);
});

test('the persistence key is the stable versioned global-state key', () => {
  assert.equal(FIRST_RUN_STATE_KEY, 'noEffect:firstRunShown.v2');
});

test('composeFirstRunMessage produces a single compact line without long command names', () => {
  const text = composeFirstRunMessage(FIRST_RUN_MESSAGES.ready);
  assert.ok(text.startsWith('NoEffect is ready — '));
  assert.ok(text.includes('Open a CSS or HTML file'));
  assert.ok(!text.includes('NoEffect: Analyze'));
  assert.equal(composeFirstRunMessage({ title: 'Only' }), 'Only');
});

test('forceShow re-shows the message even after completion, without marking again', async () => {
  const store = makeStore(true);
  const messenger = makeMessenger();
  const coordinator = new FirstRunCoordinator(store, messenger);

  await coordinator.forceShow(true, state('ready'));

  assert.equal(messenger.calls.length, 1);
  assert.deepEqual(messenger.calls[0].message, FIRST_RUN_MESSAGES.ready);
  assert.equal(store.marks, 0, 'forceShow never writes the completion flag');
});

test('forceShow falls back to the ready message when the decision is quiet', async () => {
  const store = makeStore();
  const messenger = makeMessenger();
  const coordinator = new FirstRunCoordinator(store, messenger);

  await coordinator.forceShow(false, null);

  assert.equal(messenger.calls.length, 1);
  assert.deepEqual(messenger.calls[0].message, FIRST_RUN_MESSAGES.ready);
});
