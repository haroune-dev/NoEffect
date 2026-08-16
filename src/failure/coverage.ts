/**
 * Coverage: the third axis of an outcome (lifecycle * mode * coverage fold
 * into a single deterministic bookkeeping surface).
 *
 * Whereas `RunMetrics` is the per-run ledger the analyzer keeps while it
 * works, `CoverageData` is the derived, presentation-oriented view of
 * *everything that was inspected, skipped, or made synthetic* — with
 * provenance for every skip. The status bar, the Show Status view and the
 * output channel all derive their text from this one collector, so a skip
 * can never be reported inconsistently across surfaces.
 *
 * The collector is pure: it never touches the runtime, never throws, and
 * always produces the same output for the same signals.
 */

import { AnalysisFailure, AnalysisMode, AnalysisRunStatus, FailureKind } from './model';

/** Where a skip decision came from — the provenance axis of a skip. */
export type SkipSource =
  /** Input-level limitation (no companion page, unfeedable selectors). */
  | 'mode'
  /** A single selector that could not be inspected. */
  | 'selector'
  /** A pipeline stage that silently dropped targets (e.g. synthetic feed). */
  | 'stage'
  /** Environment gating (workspace trust, unsaved file, size, ignore). */
  | 'input'
  /** An engine/capability limit inside the analysis itself. */
  | 'analyzer'
  /** A companion document that was not successfully evaluated (Level 11). */
  | 'companion';

export interface CoverageSkipReason {
  source: SkipSource;
  selector?: string;
  reason: string;
}

/** Aggregate per-mode selector & feed counts. */
export interface ModeCounts {
  /** Raw selectors in the analyzed scope (eligible or not). */
  totalSelectors: number;
  /** Selectors targeted for analysis (after input gating). */
  targets: number;
  /** Targets the browser could actually inspect. */
  queryable: number;
  /** Directives mapped and fed into the browser. */
  feedable: number;
  /** Synthetic directives injected (e.g. position/anchor expansions). */
  feedSynthetic: number;
  /** Targets that failed to feed into the browser. */
  feedFailures: number;
}

/** Per-stage run status (sub-detail of {@link AnalysisStatus}). */
export type RunStageStatus = Exclude<AnalysisRunStatus, 'cancelled'>;

export interface OverallData {
  mode: AnalysisMode;
  /** Why the mode is what it is ("3 selectors could not be inspected"). */
  modeReason: string;
  counts: ModeCounts;
}

/** Where the current run is in its lifecycle. */
export type RunStage = 'pre' | 'analysis' | 'decoration';

export interface CurrentRunData {
  stage: RunStage;
  selectorStatus: 'queryable' | 'skip' | 'analyzed';
  /** The reason behind `selectorStatus`, when it is a skip. */
  selectorSkipReason: string | null;
  runStatus: RunStageStatus;
  counts: ModeCounts;
}

/** Per-document companion bookkeeping of a multi-companion run (Level 11). */
export interface CompanionCoverage {
  /** Companion documents successfully evaluated (rank order). */
  analyzed: string[];

  /** Companion documents whose pass failed (no semantic evidence). */
  failed: string[];

  /** Real linking documents beyond the selection (expansion tail excluded), rank order. */
  skipped: string[];

  /** All real linking documents found (before truncation). */
  total: number;

  /** Companions selected for this run (the Top-K). */
  selected: number;
}

/** The coverage contract every downstream text surface derives from. */
export interface CoverageData {
  overall: OverallData;
  /** The still-relevant finished/pre-run bookkeeping, if any. */
  currentRun: CurrentRunData | null;
  /** Companion evidence bookkeeping of a multi-companion run, if any. */
  companions?: CompanionCoverage;
}

/** Raw signals the pipeline stages provide to the collector. */
export interface CoverageSignals {
  mode: AnalysisMode;
  modeReason?: string;
  stage: RunStage;
  counts: ModeCounts;
  selectorStatus: CurrentRunData['selectorStatus'];
  selectorSkipReason?: string;
  runStatus: RunStageStatus;
  companions?: CompanionCoverage;
}

export const emptyModeCounts: ModeCounts = {
  totalSelectors: 0,
  targets: 0,
  queryable: 0,
  feedable: 0,
  feedSynthetic: 0,
  feedFailures: 0,
};

const FATAL_KINDS: ReadonlySet<FailureKind> = new Set([
  'chromium_missing',
  'chromium_path_invalid',
  'devserver_port_busy',
  'devserver_start_failed',
  'browser_crashed',
  'cdp_connection_failed',
  'page_load_failed',
  'page_load_timeout',
  'unknown',
]);

const INPUT_LIMIT_KINDS: ReadonlySet<FailureKind> = new Set([
  'file_unsaved',
  'file_too_large',
  'file_ignored',
  'workspace_untrusted',
  'workspace_unsupported',
]);

const SELECTOR_LIMIT_KINDS: ReadonlySet<FailureKind> = new Set(['selector_not_queryable']);

const FEED_LIMIT_KINDS: ReadonlySet<FailureKind> = new Set([
  'no_companion_html',
  'analysis_context_missing',
  'companion_failed',
  'disabled',
  'live_analysis_unavailable',
]);

/**
 * Deterministically classify which {@link AnalysisMode} a run operates in.
 * Mode is the input-level feeding condition, decoded from the classified
 * failures alone — never from guessing at messages.
 */
export function classifyMode(failures: AnalysisFailure[]): {
  mode: AnalysisMode;
  reason: string;
} {
  const fatal = failures.find((f) => FATAL_KINDS.has(f.kind));
  if (fatal) {
    return { mode: 'failed', reason: fatal.message };
  }

  const inputLimit = failures.find((f) => INPUT_LIMIT_KINDS.has(f.kind));
  if (inputLimit) {
    return { mode: 'limited', reason: inputLimit.message };
  }

  const selectorLimit = failures.find((f) => SELECTOR_LIMIT_KINDS.has(f.kind));
  if (selectorLimit) {
    return { mode: 'limited', reason: selectorLimit.message };
  }

  const feedLimit = failures.find((f) => FEED_LIMIT_KINDS.has(f.kind));
  if (feedLimit) {
    return { mode: 'limited', reason: feedLimit.message };
  }

  return { mode: 'active', reason: 'all target selectors were inspected' };
}

/**
 * Build the coverage envelope for a run. The single place skip reasons
 * become counts; every downstream text surface (status bar, Show Status,
 * output channel) derives from here so a skip is never reported
 * inconsistently in two places.
 */
export function collectCoverage(signals: CoverageSignals): CoverageData {
  const currentRun: CurrentRunData = {
    stage: signals.stage,
    selectorStatus: signals.selectorStatus,
    selectorSkipReason: signals.selectorSkipReason ?? null,
    runStatus: signals.runStatus,
    counts: signals.counts,
  };

  return {
    overall: {
      mode: signals.mode,
      modeReason: signals.modeReason ?? defaultModeReason(signals.mode),
      counts: signals.counts,
    },
    currentRun,
    ...(signals.companions ? { companions: signals.companions } : {}),
  };
}

/** Neutral fallback reason when the pipeline did not supply one. */
function defaultModeReason(mode: AnalysisMode): string {
  switch (mode) {
    case 'active':
      return 'all target selectors were inspected';
    case 'limited':
      return 'some selectors could not be inspected';
    case 'failed':
      return 'the run did not complete';
  }
}

/** An empty coverage envelope (used for "no run yet" states). */
export function emptyCoverage(): CoverageData {
  return {
    overall: {
      mode: 'active',
      modeReason: defaultModeReason('active'),
      counts: { ...emptyModeCounts },
    },
    currentRun: null,
  };
}