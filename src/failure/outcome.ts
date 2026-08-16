/**
 * Outcome building and per-run metrics.
 *
 * `RunMetrics` is the per-run bookkeeping the analyzer fills in as it goes
 * (how many selectors were inspected vs skipped, and non-fatal warnings).
 * `buildOutcome` turns metrics + classified failures into the single
 * deterministic `AnalysisOutcome` contract consumed by every downstream
 * layer.
 */

import {
  AnalysisFailure,
  AnalysisLifecycle,
  AnalysisMode,
  AnalysisOutcome,
  AnalysisRunStatus,
  AnalysisStatus,
} from './model';
import { classifyMode, collectCoverage, CompanionCoverage, CoverageData, ModeCounts } from './coverage';

export class RunMetrics {
  analyzedSelectorCount: number = 0;
  skippedSelectorCount: number = 0;

  /** True when the whole run was skipped (nothing was inspectable). */
  skippedAll: boolean = false;

  readonly skippedReasons: string[] = [];

  /** Non-fatal, pre-classified problems observed during the run. */
  readonly warnings: AnalysisFailure[] = [];

  /** Companion bookkeeping of a multi-companion run (Level 11), if any. */
  companionCoverage: CompanionCoverage | undefined;

  markAnalyzed(): void {
    this.analyzedSelectorCount++;
  }

  markSkipped(selector: string, reason: string): void {
    this.skippedSelectorCount++;
    this.skippedReasons.push(`${selector} — ${reason}`);
  }

  markSkippedAll(reason: string): void {
    this.skippedAll = true;
    this.skippedReasons.push(reason);
  }

  addWarning(failure: AnalysisFailure): void {
    this.warnings.push(failure);
  }

  setCompanionCoverage(coverage: CompanionCoverage): void {
    this.companionCoverage = coverage;
  }
}

export interface OutcomeBuildInput {
  issuesCount: number;
  metrics: RunMetrics;

  /** Fatal failures — the run did not complete. */
  errors?: AnalysisFailure[];

  /** Extra non-fatal warnings (e.g. input-classification notes). */
  warnings?: AnalysisFailure[];

  /**
   * Input-level skips that prevented the run from starting (kept in
   * `warnings` for visibility but force status `skipped`).
   */
  skipped?: AnalysisFailure[];

  /**
   * Force status `skipped` even when no classified failure exists (e.g.
   * an unsupported file type, which has no taxonomy entry).
   */
  skippedInput?: boolean;

  /** Extra skipped-reason strings (used for input-level skips). */
  skippedReasons?: string[];

  /** True when the run was superseded by a newer trigger. */
  cancelled?: boolean;

  /** Axis 1 — lifecycle of the run being built (defaults to `settled`). */
  lifecycle?: AnalysisLifecycle;

  /** Axis 2 — explicit feeding mode; defaults to a deterministic classify. */
  mode?: AnalysisMode;

  /** Reason behind the explicit `mode`. */
  modeReason?: string;

  /**
   * Axis 3 — explicit coverage envelope. When omitted, a best-effort
   * envelope is derived from the run metrics and classified failures.
   */
  coverage?: CoverageData;

  /**
   * Session epoch of the run (Phase 5). When provided, the built outcome
   * carries it so the command layer can drop stale-session results.
   */
  epoch?: number;
}

/**
 * Derive the deterministic `AnalysisStatus` for a finished run.
 *
 *   cancelled  – superseded by a newer run
 *   failed     – at least one fatal failure
 *   skipped    – an input/capability limitation prevented the run
 *   partial    – the run completed but with warnings or skipped selectors
 *   success    – everything that could be inspected was inspected cleanly
 */
export function deriveStatus(input: OutcomeBuildInput): AnalysisStatus {
  if (input.cancelled) {
    return 'cancelled';
  }
  if (input.errors && input.errors.length > 0) {
    return 'failed';
  }
  if (input.skippedInput || (input.skipped && input.skipped.length > 0)) {
    return 'skipped';
  }
  if (input.metrics.skippedAll) {
    return 'skipped';
  }
  const hasWarnings =
    ((input.warnings && input.warnings.length > 0) ?? false) || input.metrics.warnings.length > 0;
  if (hasWarnings || input.metrics.skippedSelectorCount > 0) {
    return 'partial';
  }
  return 'success';
}

/** Build the unified outcome contract from a finished run's parts. */
export function buildOutcome(input: OutcomeBuildInput): AnalysisOutcome {
  const errors = [...(input.errors ?? [])];
  const warnings = [
    ...(input.warnings ?? []),
    ...(input.skipped ?? []),
    ...input.metrics.warnings,
  ];
  const skippedReasons = [...(input.skippedReasons ?? []), ...input.metrics.skippedReasons];

  const cancelled = input.cancelled === true;
  const status = deriveStatus(input);
  const modeInfo = resolveMode(input);
  const coverage = resolveCoverage(input, status);

  return {
    status,
    lifecycle: cancelled ? 'idle' : (input.lifecycle ?? 'settled'),
    mode: modeInfo.mode,
    modeReason: modeInfo.reason,
    coverage,
    issuesCount: input.issuesCount,
    analyzedSelectorsCount: input.metrics.analyzedSelectorCount,
    skippedSelectorsCount: input.metrics.skippedSelectorCount,
    warnings,
    errors,
    skippedReasons,
    stale: cancelled ? true : undefined,
    ...(input.epoch !== undefined ? { epoch: input.epoch } : {}),
  };
}

/**
 * Resolve axis 2 (mode). An explicit `mode` wins; otherwise the classified
 * failures decide, and metric-only skips (no classified failure exists for
 * them) further downgrade `active` to `limited`.
 */
function resolveMode(input: OutcomeBuildInput): { mode: AnalysisMode; reason: string } {
  if (input.mode) {
    return { mode: input.mode, reason: input.modeReason ?? 'full analysis' };
  }

  const failures = [...(input.errors ?? []), ...(input.warnings ?? []), ...(input.skipped ?? [])];
  const classified = classifyMode(failures);
  if (classified.mode !== 'active') {
    return classified;
  }

  if (input.metrics.skippedAll || input.metrics.skippedSelectorCount > 0) {
    return {
      mode: 'limited',
      reason:
        input.metrics.skippedAll
          ? 'nothing could be inspected'
          : `${input.metrics.skippedSelectorCount} selector(s) were skipped`,
    };
  }

  if (input.metrics.analyzedSelectorCount === 0 && input.metrics.skippedSelectorCount === 0) {
    return { mode: 'limited', reason: skippedReasonsFor(input) ?? 'no selectors were inspected' };
  }

  return classified;
}

function skippedReasonsFor(input: OutcomeBuildInput): string | undefined {
  return input.metrics.skippedReasons[0] ?? input.skippedReasons?.[0];
}

/**
 * Resolve axis 3 (coverage). An explicit envelope wins; otherwise a
 * best-effort one is collected from the metrics so every non-trivial run
 * still gets a deterministic coverage surface.
 */
function resolveCoverage(input: OutcomeBuildInput, status: AnalysisStatus): CoverageData | undefined {
  if (input.coverage) {
    return input.coverage;
  }
  if (input.cancelled) {
    return undefined;
  }
  if (input.metrics.skippedAll) {
    return undefined;
  }

  const rawSelectors =
    input.metrics.analyzedSelectorCount +
    input.metrics.skippedSelectorCount +
    input.metrics.skippedReasons.length +
    (input.skippedReasons?.length ?? 0);
  if (rawSelectors === 0) {
    // A no-op run (nothing was ever targeted, nothing was skipped): there
    // is no coverage to speak of. Consumers fall back to counts.
    return undefined;
  }

  const counts: ModeCounts = {
    totalSelectors: input.metrics.analyzedSelectorCount + input.metrics.skippedSelectorCount,
    targets: input.metrics.analyzedSelectorCount + input.metrics.skippedSelectorCount,
    queryable: input.metrics.analyzedSelectorCount,
    feedable: input.metrics.analyzedSelectorCount,
    feedSynthetic: 0,
    feedFailures: input.metrics.skippedSelectorCount,
  };
  const ran = counts.targets > 0;

  const { mode, reason } = resolveMode(input);
  const runStatus = runStatusFrom(status);

  return collectCoverage({
    mode,
    modeReason: reason,
    stage: 'decoration',
    counts,
    selectorStatus: counts.queryable > 0 ? 'analyzed' : 'skip',
    selectorSkipReason: input.metrics.skippedReasons[0] ?? null,
    runStatus,
    // A run that never reached the analyzer still reports its envelope
    // (blocks/targets = 0) once; the 'pre' stage captures that.
    ...(ran ? {} : { stage: 'pre' as const }),
    ...(input.metrics.companionCoverage ? { companions: input.metrics.companionCoverage } : {}),
  });
}

function runStatusFrom(status: AnalysisRunStatus | AnalysisStatus): AnalysisRunStatus {
  return status === 'cancelled' ? 'skipped' : status;
}

/** A fresh, empty metrics instance (for convenience). */
export function emptyMetrics(): RunMetrics {
  return new RunMetrics();
}