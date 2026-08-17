import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisCancelledError } from '../../failure/errors';
import {
  CancellationTokenLike,
  raceCancellation,
  throwIfCancelled,
} from '../../failure/cancellation';

/**
 * Cancellation primitives: a cancelled run must reject promptly with an
 * AnalysisCancelledError — including the P3-LOG-23 TOCTOU between the
 * pre-registration check and the listener registration.
 */

async function tick(ms = 0): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function settlingToken<T>(value: T): Promise<T> {
  return Promise.resolve(value);
}

function hanging(): Promise<never> {
  return new Promise<never>(() => {
    // never settles
  });
}

test('throwIfCancelled throws only when the token is cancelled', () => {
  const cancelled: CancellationTokenLike = {
    isCancellationRequested: true,
    onCancellationRequested() {
      return { dispose() {} };
    },
  };
  const notCancelled: CancellationTokenLike = {
    isCancellationRequested: false,
    onCancellationRequested() {
      return { dispose() {} };
    },
  };
  assert.throws(() => throwIfCancelled(cancelled), AnalysisCancelledError);
  assert.doesNotThrow(() => throwIfCancelled(notCancelled));
  assert.doesNotThrow(() => throwIfCancelled(undefined));
});

test('raceCancellation resolves with the underlying value when never cancelled', async () => {
  const token: CancellationTokenLike = {
    isCancellationRequested: false,
    onCancellationRequested() {
      return { dispose() {} };
    },
  };
  const result = await raceCancellation(settlingToken(42), token);
  assert.equal(result, 42);
});

test('raceCancellation rejects immediately when already cancelled', async () => {
  const token: CancellationTokenLike = {
    isCancellationRequested: true,
    onCancellationRequested() {
      return { dispose() {} };
    },
  };
  await assert.rejects(() => raceCancellation(hanging(), token), AnalysisCancelledError);
});

test('raceCancellation rejects promptly when cancelled after registration', async () => {
  const listeners: Array<() => void> = [];
  const token: CancellationTokenLike = {
    isCancellationRequested: false,
    onCancellationRequested(listener) {
      listeners.push(listener);
      return { dispose() {} };
    },
  };

  let settled: string = 'pending';
  const raced = raceCancellation(hanging(), token);
  raced.then(
    () => {
      settled = 'resolved';
    },
    (err: unknown) => {
      settled = err instanceof AnalysisCancelledError ? 'cancelled' : 'other';
    }
  );
  await tick();
  assert.equal(settled, 'pending', 'still awaiting the slow underlying promise');

  listeners[0]();
  await tick();
  assert.equal(settled, 'cancelled', 'cancellation rejects promptly, no hang');
});

test('raceCancellation re-checks the token after registration (P3-LOG-23)', async () => {
  // A token that flips to cancelled between the first read and the listener
  // registration, and whose onCancellationRequested does NOT replay past
  // cancellations to new listeners — the re-check closes that gap.
  let reads = 0;
  const token: CancellationTokenLike = {
    get isCancellationRequested() {
      reads++;
      return reads > 1;
    },
    onCancellationRequested() {
      return { dispose() {} };
    },
  };
  await assert.rejects(() => raceCancellation(hanging(), token), AnalysisCancelledError);
});