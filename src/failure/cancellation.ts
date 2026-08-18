/**
 * Cancellation primitives.
 *
 * `CancellationTokenLike` is the structural shape of `vscode.CancellationToken`
 * that all async analysis pipelines accept. It is deliberately defined here
 * (structural, not the vscode type) so the failure/cancellation logic stays
 * loadable — and unit-testable — outside the extension host.
 */

import { AnalysisCancelledError } from './errors';

export interface CancellationTokenLike {
  isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

/** A token that is never cancelled (default parameter). */
export const neverCancelled: CancellationTokenLike = {
  isCancellationRequested: false,
  onCancellationRequested(): { dispose(): void } {
    return { dispose(): void {} };
  },
};

export function throwIfCancelled(token: CancellationTokenLike | undefined, message?: string): void {
  if (token?.isCancellationRequested) {
    throw new AnalysisCancelledError(message ?? 'Analysis cancelled');
  }
}

/**
 * Resolve with `promise` unless the token is cancelled first, in which case
 * the caller gets a reject with an `AnalysisCancelledError`. This gives a
 * superseding run prompt, clean cancellation even while the underlying task
 * is still awaiting a slow CDP call — without leaving an unhandled rejection
 * (the underlying promise keeps settling on its own and is ignored).
 */
export function raceCancellation<T>(
  promise: Promise<T>,
  token: CancellationTokenLike | undefined
): Promise<T> {
  if (!token) {
    return promise;
  }
  if (token.isCancellationRequested) {
    return Promise.reject(new AnalysisCancelledError('Analysis cancelled'));
  }
  return new Promise<T>((resolve, reject) => {
    // Registered after `rejectCancelled` is defined (its listener) and read
    // by the promise handlers below — the declare-then-assign shape is
    // required, prefer-const cannot see through the closures.
    // eslint-disable-next-line prefer-const
    let subscription: { dispose(): void };
    const rejectCancelled = (): void => {
      subscription.dispose();
      reject(new AnalysisCancelledError('Analysis cancelled'));
    };
    subscription = token.onCancellationRequested(rejectCancelled);
    // TOCTOU close (P3-LOG-23): a cancellation between the check above and
    // this registration fires the listener; a cancellation that already
    // happened on a token implementation that does NOT replay past
    // cancellations to new listeners is caught by this re-check — a
    // cancelled run must reject, never sit on the underlying promise.
    if (token.isCancellationRequested) {
      rejectCancelled();
    }
    promise.then(
      (value) => {
        subscription.dispose();
        resolve(value);
      },
      (error) => {
        subscription.dispose();
        reject(error);
      }
    );
  });
}