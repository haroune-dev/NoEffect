/**
 * Unified failure taxonomy and outcome contract.
 *
 * Phase 1 of the failures/hardening plan: every runtime condition of the
 * analysis pipeline is mapped into a deterministic, machine-readable
 * `FailureKind` / failure code pair, and every analysis run produces a
 * normalized `AnalysisOutcome` that downstream UI layers (status bar,
 * output channel) can consume without ever looking at raw exceptions.
 *
 * Classification logic itself lives in `./classifier.ts`; this module only
 * defines the contracts and the deterministic kind → code / severity
 * tables.
 */

/**
 * Coarse failure categories. A single kind can represent several explicit
 * error codes (e.g. `cdp_connection_failed` covers both `CDP_CONNECTION_FAILED`
 * and `CDP_DISCONNECTED`); the code is always the precise signal.
 */
export type FailureKind =
  | 'chromium_missing'
  | 'chromium_path_invalid'
  | 'devserver_port_busy'
  | 'devserver_start_failed'
  | 'browser_crashed'
  | 'cdp_connection_failed'
  | 'page_load_failed'
  | 'page_load_timeout'
  | 'workspace_untrusted'
  | 'workspace_unsupported'
  | 'file_unsaved'
  | 'file_too_large'
  | 'file_ignored'
  | 'selector_not_queryable'
  | 'no_companion_html'
  | 'analysis_context_missing'
  | 'companion_failed'
  | 'analysis_cancelled'
  | 'analysis_timeout'
  | 'disabled'
  | 'live_analysis_unavailable'
  | 'unknown';

export type FailureSeverity = 'fatal' | 'recoverable' | 'warning' | 'info';

export type FailureSource =
  | 'browser'
  | 'cdp'
  | 'devserver'
  | 'filesystem'
  | 'analysis'
  | 'mapping'
  | 'selector'
  | 'unknown';

/**
 * A classified failure. Everything the pipeline knows about a problem fits
 * in this contract — never a bare `Error` and never an untyped throw.
 */
export interface AnalysisFailure {
  /** Coarse failure category (stable across concrete error codes). */
  kind: FailureKind;

  /** Explicit, deterministic machine-readable code (e.g. `CDP_DISCONNECTED`). */
  code: string;

  severity: FailureSeverity;

  /**
   * Whether retrying the same analysis, without any user or environment
   * change, can plausibly succeed (e.g. a recoverable CDP session loss).
   */
  recoverable: boolean;

  /** Subsystem the failure surfaced from. */
  source: FailureSource;

  /** Stable diagnostic message (technical, for the output channel). */
  message: string;

  /** Optional, safe-for-users message (reserved for a later UX phase). */
  userMessage?: string;

  /** Longer technical context (e.g. a wrapped stack — debug scope only). */
  details?: string;

  /** The original thrown value, when one exists. */
  cause?: unknown;

  /** Free-form structured context (paths, sizes, selectors, …). */
  context?: Record<string, unknown>;
}

/** Every explicit failure code the classifier can emit. */
export const FAILURE_CODES = {
  CHROMIUM_NOT_FOUND: 'CHROMIUM_NOT_FOUND',
  CHROMIUM_PATH_INVALID: 'CHROMIUM_PATH_INVALID',
  BROWSER_LAUNCH_FAILED: 'BROWSER_LAUNCH_FAILED',
  BROWSER_CRASHED: 'BROWSER_CRASHED',
  DEVSERVER_PORT_BUSY: 'DEVSERVER_PORT_BUSY',
  DEVSERVER_START_FAILED: 'DEVSERVER_START_FAILED',
  CDP_CONNECTION_FAILED: 'CDP_CONNECTION_FAILED',
  CDP_DISCONNECTED: 'CDP_DISCONNECTED',
  PAGE_LOAD_FAILED: 'PAGE_LOAD_FAILED',
  PAGE_LOAD_TIMEOUT: 'PAGE_LOAD_TIMEOUT',
  WORKSPACE_UNTRUSTED: 'WORKSPACE_UNTRUSTED',
  WORKSPACE_UNSUPPORTED: 'WORKSPACE_UNSUPPORTED',
  FILE_UNSAVED: 'FILE_UNSAVED',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  FILE_IGNORED: 'FILE_IGNORED',
  SELECTOR_NOT_QUERYABLE: 'SELECTOR_NOT_QUERYABLE',
  SELECTORS_UNQUERYABLE: 'SELECTORS_UNQUERYABLE',
  NO_COMPANION_HTML: 'NO_COMPANION_HTML',
  ANALYSIS_CONTEXT_MISSING: 'ANALYSIS_CONTEXT_MISSING',
  COMPANION_FAILED: 'COMPANION_FAILED',
  ANALYSIS_CANCELLED: 'ANALYSIS_CANCELLED',
  ANALYSIS_TIMEOUT: 'ANALYSIS_TIMEOUT',
  EXTENSION_DISABLED: 'EXTENSION_DISABLED',
  LIVE_ANALYSIS_UNAVAILABLE: 'LIVE_ANALYSIS_UNAVAILABLE',
  UNKNOWN_FAILURE: 'UNKNOWN_FAILURE',
} as const;

export type FailureCode = (typeof FAILURE_CODES)[keyof typeof FAILURE_CODES];

/** The deterministic default code for every kind. */
export const KIND_TO_CODE: Record<FailureKind, FailureCode> = {
  chromium_missing: FAILURE_CODES.CHROMIUM_NOT_FOUND,
  chromium_path_invalid: FAILURE_CODES.CHROMIUM_PATH_INVALID,
  devserver_port_busy: FAILURE_CODES.DEVSERVER_PORT_BUSY,
  devserver_start_failed: FAILURE_CODES.DEVSERVER_START_FAILED,
  browser_crashed: FAILURE_CODES.BROWSER_CRASHED,
  cdp_connection_failed: FAILURE_CODES.CDP_CONNECTION_FAILED,
  page_load_failed: FAILURE_CODES.PAGE_LOAD_FAILED,
  page_load_timeout: FAILURE_CODES.PAGE_LOAD_TIMEOUT,
  workspace_untrusted: FAILURE_CODES.WORKSPACE_UNTRUSTED,
  workspace_unsupported: FAILURE_CODES.WORKSPACE_UNSUPPORTED,
  file_unsaved: FAILURE_CODES.FILE_UNSAVED,
  file_too_large: FAILURE_CODES.FILE_TOO_LARGE,
  file_ignored: FAILURE_CODES.FILE_IGNORED,
  selector_not_queryable: FAILURE_CODES.SELECTOR_NOT_QUERYABLE,
  no_companion_html: FAILURE_CODES.NO_COMPANION_HTML,
  analysis_context_missing: FAILURE_CODES.ANALYSIS_CONTEXT_MISSING,
  companion_failed: FAILURE_CODES.COMPANION_FAILED,
  analysis_cancelled: FAILURE_CODES.ANALYSIS_CANCELLED,
  analysis_timeout: FAILURE_CODES.ANALYSIS_TIMEOUT,
  disabled: FAILURE_CODES.EXTENSION_DISABLED,
  live_analysis_unavailable: FAILURE_CODES.LIVE_ANALYSIS_UNAVAILABLE,
  unknown: FAILURE_CODES.UNKNOWN_FAILURE,
};

/**
 * Deterministic base severity + recoverability profile per kind. The
 * classifier may refine a kind to a more specific code (e.g.
 * `cdp_connection_failed` → `CDP_DISCONNECTED`, which is recoverable).
 */
export const KIND_PROFILE: Record<FailureKind, { severity: FailureSeverity; recoverable: boolean }> = {
  chromium_missing: { severity: 'fatal', recoverable: false },
  chromium_path_invalid: { severity: 'fatal', recoverable: false },
  devserver_port_busy: { severity: 'fatal', recoverable: false },
  devserver_start_failed: { severity: 'fatal', recoverable: false },
  browser_crashed: { severity: 'fatal', recoverable: true },
  cdp_connection_failed: { severity: 'fatal', recoverable: false },
  page_load_failed: { severity: 'fatal', recoverable: false },
  page_load_timeout: { severity: 'recoverable', recoverable: true },
  workspace_untrusted: { severity: 'warning', recoverable: false },
  workspace_unsupported: { severity: 'warning', recoverable: false },
  file_unsaved: { severity: 'warning', recoverable: false },
  file_too_large: { severity: 'warning', recoverable: false },
  file_ignored: { severity: 'info', recoverable: false },
  selector_not_queryable: { severity: 'warning', recoverable: false },
  no_companion_html: { severity: 'info', recoverable: false },
  analysis_context_missing: { severity: 'warning', recoverable: false },
  companion_failed: { severity: 'warning', recoverable: false },
  analysis_cancelled: { severity: 'info', recoverable: true },
  analysis_timeout: { severity: 'recoverable', recoverable: true },
  disabled: { severity: 'info', recoverable: true },
  live_analysis_unavailable: { severity: 'info', recoverable: false },
  unknown: { severity: 'fatal', recoverable: false },
};

/** Normalized status emitted by an analysis run. */
export type AnalysisStatus = 'success' | 'partial' | 'skipped' | 'failed' | 'cancelled';

/** Run-level status without the lifecycle-only `cancelled`. */
export type AnalysisRunStatus = Exclude<AnalysisStatus, 'cancelled'>;

/**
 * Axis 1 — lifecycle: where the run sits relative to its own lifetime.
 * `running` is entered when a run starts; `settled` when it produced an
 * outcome; `idle` when no run has happened (or the last one was superseded).
 */
export type AnalysisLifecycle = 'idle' | 'running' | 'settled';

/**
 * Axis 2 — mode: the input-level feeding condition of a run, describing
 * *how much of the target could feed into the browser* regardless of the
 * per-selector outcome:
 *   - `active`: every target selector was inspectable,
 *   - `limited`: some targets were skipped (unqueryable selectors, no
 *     companion page, environment gating such as an unsaved file),
 *   - `failed`: the run did not complete (fatal classified failure).
 */
export type AnalysisMode = 'active' | 'limited' | 'failed';

/**
 * Unified outcome contract of an analysis run. Downstream UI layers consume
 * this object instead of raw issue arrays or raw errors.
 *
 * The outcome is three axes in one object: `status`/`lifecycle` (did the
 * run complete?), `mode` (how much of the input fed into the browser?) and
 * `coverage` (what was inspected, skipped, or made synthetic — with
 * provenance). Every presentation surface derives its text from the same
 * axes so nothing is ever reported inconsistently.
 */
export interface AnalysisOutcome {
  status: AnalysisStatus;

  /** Axis 1 — lifecycle of the run that produced this outcome. */
  lifecycle?: AnalysisLifecycle;

  /** Axis 2 — input-level feeding mode of the run. */
  mode?: AnalysisMode;

  /** Human-readable reason behind `mode` (from a classified failure). */
  modeReason?: string;

  /**
   * Axis 3 — coverage envelope: per-stage skip counts with provenance.
   * Absent for trivial/blocked productions; derive text from the axes
   * above when it is missing.
   */
  coverage?: import('./coverage').CoverageData;

  /** Number of confirmed inactive-property issues produced by the run. */
  issuesCount: number;

  /** Number of selectors successfully inspected by the browser. */
  analyzedSelectorsCount: number;

  /** Number of selectors the run could not inspect (with reasons). */
  skippedSelectorsCount: number;

  /** Non-fatal classified problems (degraded quality, not a failure). */
  warnings: AnalysisFailure[];

  /** Fatal classified failures — the run did not complete. */
  errors: AnalysisFailure[];

  /** Human-readable reasons for everything that was skipped. */
  skippedReasons: string[];

  /**
   * True when this outcome describes a run that was superseded by a newer
   * one (cancellation) — consumers should ignore it for UI purposes.
   */
  stale?: boolean;

  /**
   * Session epoch the run belonged to (Phase 5). Outcomes produced against
   * an old session (the browser was restarted mid-run) are dropped by the
   * command layer — the epoch is the single flow that stamps every outcome,
   * blocked or not, so the comparison is always meaningful.
   */
  epoch?: number;
}

/**
 * Deterministic internal extension state machine. The outcome contracts
 * map onto it so a single status vocabulary drives every layer.
 */
export type AnalysisState = 'initializing' | 'ready' | 'analyzing' | 'failed' | 'disabled';

/** Map a finished outcome onto the extension state machine. */
export function stateForOutcome(outcome: AnalysisOutcome): AnalysisState {
  switch (outcome.status) {
    case 'failed':
      return 'failed';
    case 'cancelled':
      // A cancelled run was superseded — the machine goes back to ready
      // (the superseding run flips it to `analyzing`).
      return 'ready';
    default:
      return 'ready';
  }
}