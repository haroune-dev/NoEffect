/**
 * Bounded-wait primitives (Phase 5).
 *
 * Every await in the session/analysis path is bounded — `withTimeout` turns
 * any slow promise into a bounded rejection (without leaving an unhandled
 * rejection behind), and `sleep` is the single gatekeeper used by retry
 * backoff and bounded polling. There is deliberately no unbounded await
 * helper here.
 */

import { AnalysisCancelledError, AnalysisTimeoutError } from '../failure/errors';
import { CancellationTokenLike } from '../failure/cancellation';

/**
 * Resolve with the result of `promise` unless `timeoutMs` elapses first, in
 * which case reject with a typed `AnalysisTimeoutError` carrying `reason`.
 * The underlying promise is tamed (no-op catch attached) so it can never
 * surface as an unhandled rejection; it simply keeps settling silently.
 *
 * When a `token` is provided, its cancellation immediately settles the race
 * (typed `AnalysisCancelledError`) and the internal timer is disarmed — a
 * cancelled operation must never keep the event loop alive up to the full
 * timeout budget.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  reason: string,
  token?: CancellationTokenLike
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let subscription: { dispose(): void } | undefined;

    const settle = (run: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (subscription) {
        subscription.dispose();
        subscription = undefined;
      }
      run();
    };

    timer = setTimeout(() => {
      settle(() => reject(new AnalysisTimeoutError(`${reason} (${timeoutMs}ms)`)));
    }, timeoutMs);

    if (token && !token.isCancellationRequested) {
      subscription = token.onCancellationRequested(() => {
        settle(() => reject(new AnalysisCancelledError(`${reason} — cancelled while bounded wait in flight`)));
      });
    } else if (token) {
      settle(() => reject(new AnalysisCancelledError(`${reason} — already cancelled before bounded wait`)));
    }

    promise.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error))
    );
  });
}

/** Sleep for `ms`. Used only for bounded retry backoff and polling. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}