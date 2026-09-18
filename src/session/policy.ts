/**
 * Retry and timeout numbers for session and analysis work.
 *
 * Everything reads from this table so timeouts stay in one place.
 * `maxRetries` counts extra tries after the first attempt.
 */

export type RetryOperation =
  | 'browser_launch'
  | 'cdp_connect'
  | 'cdp_reattach'
  | 'cdp_command'
  | 'page_load'
  | 'dev_server_start'
  | 'graceful_close'
  | 'full_analysis'
  | 'session_build'
  | 'restart_cleanup'
  | 'temp_dir_cleanup';

export interface RetryPolicyEntry {
  /**
   * Additional attempts after the first (0 = exactly one try, no retry).
   */
  maxRetries: number;

  timeoutMs: number;
}

/**
 * `session_build` covers the whole cold start (launch + connect + setup),
 * so keep it near the sum of those steps. A small value here used to fail
 * first analyses on slower machines, where the browser needed about 11s
 * to open its debugging port.
 */
export const RETRY_POLICY: Readonly<Record<RetryOperation, RetryPolicyEntry>> = {
  browser_launch: { maxRetries: 1, timeoutMs: 15_000 },
  cdp_connect: { maxRetries: 2, timeoutMs: 5_000 },
  cdp_reattach: { maxRetries: 2, timeoutMs: 5_000 },
  cdp_command: { maxRetries: 1, timeoutMs: 5_000 },
  page_load: { maxRetries: 1, timeoutMs: 10_000 },
  dev_server_start: { maxRetries: 1, timeoutMs: 5_000 },
  graceful_close: { maxRetries: 0, timeoutMs: 2_000 },
  full_analysis: { maxRetries: 0, timeoutMs: 30_000 },
  session_build: { maxRetries: 0, timeoutMs: 30_000 },
  restart_cleanup: { maxRetries: 0, timeoutMs: 4_000 },
  temp_dir_cleanup: { maxRetries: 0, timeoutMs: 2_000 },
};

/** Backoff delays between retry attempts, applied as `attempt` grows. */
const RETRY_BACKOFF_MS = [250, 500, 1000] as const;

/** Deterministic backoff for the 1-based `attempt` (1 = first retry). */
export function backoffFor(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), RETRY_BACKOFF_MS.length) - 1;
  return RETRY_BACKOFF_MS[index];
}