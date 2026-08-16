/**
 * Unified retry / timeout policy (Phase 5).
 *
 * Every bounded wait and every retry decision in the session/analysis path
 * reads from this ONE typed table. There are no scattered magic numbers:
 * tests assert the table, callers consume it, and the numbers can only
 * change here.
 *
 * Rules (invariants, enforced by construction):
 *   - `maxRetries` = number of ADDITIONAL attempts after the first (so
 *     "max retries 1" means at most 2 tries in total),
 *   - only transient failures are retried (see `isTransientFailure`);
 *     permanent failures go through once and fail fast,
 *   - every retry is preceded by `backoffFor(operation, attempt)`,
 *   - every wait is bounded by `timeoutMsFor(operation)`,
 *   - retries and timeouts are logged with a stable reason code from
 *     {@link policyReasonCodes}.
 */

import { FailureKind } from '../failure/model';

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

  /** Per-attempt budget in milliseconds. */
  timeoutMs: number;
}

/**
 * The whole cold rebuild (browser launch + CDP connect + domain setup)
 * runs under ONE budget (`session_build`). The table must therefore
 * budget it as the SUM of its real phases — `browser_launch` (15 s) +
 * `cdp_connect` retries (3 × 5 s) + setup slack — not as a cleanup cap:
 * a 4 s cap made every cold first analysis fail its companion passes on
 * machines whose browser takes longer than 4 s to expose its DevTools
 * port (observed: 11 s with a system google-chrome), yielding a poisoned
 * ⊥ merge and "nothing dimmed on first open".
 */

/** The typed policy table — the single source of timeout truth. */
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
export const RETRY_BACKOFF_MS = [250, 500, 1000] as const;

/** Deterministic backoff for the 1-based `attempt` (1 = first retry). */
export function backoffFor(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), RETRY_BACKOFF_MS.length) - 1;
  return RETRY_BACKOFF_MS[index];
}

/** Whether an operation is allowed to retry at all. */
export function isRetriable(operation: RetryOperation): boolean {
  return RETRY_POLICY[operation].maxRetries > 0;
}

/**
 * Failure kinds the policy treats as TRANSIENT (safe to retry once the
 * wait budget allows). Everything else is permanent and fails fast.
 *
 * Transient: network/WS drops, timeouts, one-off load errors, port races,
 * a browser that came up but died during startup. Permanent: anything that
 * will not change by retrying (missing binary, invalid path, workspace or
 * file gating, capability notes).
 */
const TRANSIENT_KINDS: ReadonlySet<FailureKind> = new Set([
  'browser_crashed',
  'cdp_connection_failed',
  'page_load_failed',
  'page_load_timeout',
  'devserver_port_busy',
  'devserver_start_failed',
  'analysis_timeout',
]);

const PERMANENT_KINDS: ReadonlySet<FailureKind> = new Set([
  'chromium_missing',
  'chromium_path_invalid',
  'workspace_untrusted',
  'workspace_unsupported',
  'file_unsaved',
  'file_too_large',
  'file_ignored',
  'selector_not_queryable',
  'no_companion_html',
  'analysis_context_missing',
  'disabled',
  'live_analysis_unavailable',
]);

/** True when a classified failure is worth retrying. */
export function isTransientKind(kind: FailureKind): boolean {
  return TRANSIENT_KINDS.has(kind);
}

/** True when a failure must fail fast (never retry). */
export function isPermanentKind(kind: FailureKind): boolean {
  return PERMANENT_KINDS.has(kind);
}

/** Stable, short reason codes used in logs, events and reports. */
export const policyReason = (
  operation: RetryOperation,
  phase: 'retry' | 'timeout' | 'gave_up' | 'born'
): string => `${operation}.${phase}`;