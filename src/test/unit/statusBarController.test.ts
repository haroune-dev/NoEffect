import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatusBarController, StatusBarHost } from '../../activation/statusBarController';
import { deriveStatus } from '../../activation/statusModel';
import { STATUS_BAR_COMMAND } from '../../activation/statusModel';
import { ReadinessState } from '../../environment/readiness';

/**
 * Phase 3 status-bar-controller unit tests: the item is created once, is
 * always pointed at Show Status, and redundant updates are skipped.
 */

function makeHost() {
  let shown = 0;
  let hidden = 0;
  let disposed = 0;
  const host: StatusBarHost & { shown: number; hidden: number; disposed: number } = {
    text: '',
    tooltip: '',
    command: '',
    shown: 0,
    hidden: 0,
    disposed: 0,
    show() {
      shown++;
      this.shown = shown;
    },
    hide() {
      hidden++;
      this.hidden = hidden;
    },
    dispose() {
      disposed++;
      this.disposed = disposed;
    },
  };
  return host;
}

function state(reason: ReadinessState['reason']): ReadinessState {
  return {
    ready: reason === 'ready',
    reason,
    severity: reason === 'ready' ? 'info' : 'fatal',
    recoverable: true,
    message: 'msg',
    warnings: [],
  };
}

test('item command defaults to Show Status and is set once', () => {
  const host = makeHost();
  new StatusBarController(host);
  assert.equal(host.command, STATUS_BAR_COMMAND);
  new StatusBarController(host, 'noEffect.analyzeCurrentFile');
  assert.equal(host.command, 'noEffect.analyzeCurrentFile');
});

test('first visible update renders text, tooltip and shows the item', () => {
  const host = makeHost();
  const controller = new StatusBarController(host);
  controller.update(deriveStatus(true, state('ready'), true));
  assert.equal(host.text, 'NoEffect: Ready');
  assert.ok(host.tooltip.length > 0);
  assert.equal(host.shown, 1);
  assert.equal(host.hidden, 0);
});

test('redundant updates of the same state are skipped', () => {
  const host = makeHost();
  const controller = new StatusBarController(host);
  controller.update(deriveStatus(true, state('ready'), true));
  controller.update(deriveStatus(true, state('ready'), true));
  assert.equal(host.shown, 1);
  assert.equal(host.text, 'NoEffect: Ready');
});

test('a real state change re-renders the item', () => {
  const host = makeHost();
  const controller = new StatusBarController(host);
  controller.update(deriveStatus(true, state('ready'), true));
  controller.update(deriveStatus(true, state('browser_not_found'), true));
  assert.equal(host.shown, 2);
  assert.equal(host.text, 'NoEffect: Browser not found');
});

test('hidden presentations hide the item and collapse into one key', () => {
  const host = makeHost();
  const controller = new StatusBarController(host);
  controller.update(deriveStatus(false, state('ready')));
  assert.equal(host.hidden, 1);
  assert.equal(host.shown, 0);
  controller.update(deriveStatus(false, state('browser_not_found')));
  assert.equal(host.hidden, 1, 'redundant hidden state is skipped');
});

test('transition between visible and hidden states switches the item', () => {
  const host = makeHost();
  const controller = new StatusBarController(host);
  controller.update(deriveStatus(true, state('ready'), true));
  controller.update(deriveStatus(false, state('ready')));
  controller.update(deriveStatus(true, state('ready'), true));
  assert.equal(host.shown, 2);
  assert.equal(host.hidden, 1);
});

test('dispose releases the host item exactly once', () => {
  const host = makeHost();
  const controller = new StatusBarController(host);
  controller.dispose();
  assert.equal(host.disposed, 1);
});
