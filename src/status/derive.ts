/**
 * Status derivation — the single function that turns an analysis outcome
 * (and its coverage envelope) into the exact text shown in the status bar,
 * the Show Status view, and the output channel.
 *
 * Downstream layers never format status/coverage themselves: they consume
 * `deriveOutcomeRow` and `coverageLines` so a skip reason or a failure code
 * reads identically everywhere. Pure, deterministic, no `vscode` dependency.
 */

import { AnalysisOutcome } from '../failure/model';
import { CompanionCoverage, ModeCounts } from '../failure/coverage';
import type { StatusPresentation } from '../activation/statusModel';

export interface OutcomeRowOptions {
  disabled?: boolean;
  running?: boolean;
  seenIssues?: boolean;
}

/**
 * The status-bar row for the most recent outcome. `null` outcome (or a
 * stale/superseded one) falls back to a neutral idle row — the superseding
 * run owns the slot and will overwrite it. `running` forces the analyzing
 * row, so a command wiring path can render the in-flight state.
 */
export function deriveOutcome(outcome: AnalysisOutcome | null, options: OutcomeRowOptions = {}): StatusPresentation {
  if (options.disabled) {
    return {
      state: 'disabled',
      text: 'NoEffect: Disabled',
      tooltip: 'NoEffect is disabled by the noEffect.enabled setting.',
      visible: false,
    };
  }

  if (options.running) {
    return {
      state: 'analyzing',
      text: 'NoEffect: Analyzing…',
      tooltip: 'Inspecting the active file with Chromium…',
      visible: true,
    };
  }

  if (!outcome || outcome.stale) {
    return {
      state: outcome?.stale ? 'idle' : 'idle',
      text: 'NoEffect: Idle',
      tooltip: outcome?.stale
        ? 'Superseded by a newer analysis — click to show details.'
        : 'No analysis run yet — click to show status.',
      visible: true,
    };
  }

  switch (outcome.status) {
    case 'failed':
      return {
        state: 'failed',
        text: 'NoEffect: Failed',
        tooltip: `Analysis failed — ${outcome.errors[0]?.code ?? 'unknown failure'}. Click to show status.`,
        visible: true,
      };
    case 'skipped':
      return {
        state: 'limited',
        text: 'NoEffect: Skipped',
        tooltip:
          outcome.warnings[0]?.message ??
          outcome.modeReason ??
          'The analysis was intentionally skipped.',
        visible: true,
      };
    case 'partial':
      return {
        state: 'partial',
        text: outcome.issuesCount > 0 ? `NoEffect: ${outcome.issuesCount} issue(s) found` : 'NoEffect: Partial',
        tooltip: partialTooltip(outcome),
        visible: true,
      };
    default:
      return {
        state: 'ready',
        text: outcome.issuesCount > 0 ? `NoEffect: ${outcome.issuesCount} issue(s) found` : 'NoEffect: Ready',
        tooltip:
          `Analysis complete — ${outcome.analyzedSelectorsCount} selector(s) inspected.` +
          (outcome.skippedSelectorsCount > 0
            ? ` ${outcome.skippedSelectorsCount} skipped.`
            : ''),
        visible: true,
      };
  }
}

function partialTooltip(outcome: AnalysisOutcome): string {
  if (outcome.issuesCount > 0 && outcome.skippedSelectorsCount > 0) {
    return `${outcome.modeReason ?? 'Some selectors were skipped.'} ${outcome.issuesCount} inactive propert(y/ies) found.`;
  }
  return outcome.warnings[0]?.message ?? outcome.modeReason ?? 'Some selectors could not be inspected.';
}

/** Short counts caption, e.g. `queryable 3/5 (1 skipped)`. */
export function countsCaption(counts: ModeCounts): string {
  const skipped = counts.feedFailures;
  const core = `queryable ${counts.queryable}/${counts.targets}`;
  if (counts.feedable === counts.queryable && skipped === 0) {
    return core;
  }
  return `${core} (${skipped} skipped)`;
}

export interface StatusLineText {
  label: string;
  detail?: string;
}

/**
 * The "Coverage" section for the Show Status view, derived from the outcome
 * envelope. Every row is provenance-aware text — never a raw error message.
 */
export function coverageLines(outcome: AnalysisOutcome | null): StatusLineText[] {
  if (!outcome?.coverage) {
    return [];
  }
  const { overall, currentRun } = outcome.coverage;
  const lines: StatusLineText[] = [];

  lines.push({ label: `Analysis mode: ${overall.mode}`, detail: overall.modeReason });
  if (currentRun) {
    lines.push({ label: `Stage: ${currentRun.stage}`, detail: `selector ${currentRun.selectorStatus}` });
    lines.push({
      label: `Selectors inspected: ${currentRun.counts.queryable}/${currentRun.counts.targets}`,
      detail: `feed ${currentRun.counts.feedable}, ${currentRun.counts.feedFailures} failure(s)`,
    });
    if (currentRun.counts.feedSynthetic > 0) {
      lines.push({
        label: `Synthetic directives: ${currentRun.counts.feedSynthetic}`,
        detail: 'created for properties whose target cannot be authored directly',
      });
    }
  }
  const skipReasons = collectSkipReasons(outcome);
  if (skipReasons.length > 0) {
    lines.push({
      label: `Skipped selectors: ${skipReasons.length}`,
      detail: skipReasons.slice(0, 3).join('; '),
    });
  }
  lines.push(...companionCoverageLines(outcome));
  return lines;
}

/** Max raw companion list entries rendered in one line (derivation-only). */
const MAX_COMPANION_LINES = 3;

/**
 * The "Companions" section of the Show Status view (Level 11), derived from
 * the coverage envelope's companion bookkeeping. Counts and lists only —
 * ranked order preserved, concise, never a universal claim.
 */
export function companionCoverageLines(outcome: AnalysisOutcome): StatusLineText[] {
  const companions: CompanionCoverage | undefined = outcome.coverage?.companions;
  if (!companions) {
    return [];
  }

  const lines: StatusLineText[] = [];
  lines.push({
    label:
      `Companions: ${companions.analyzed.length} analyzed · ` +
      `${companions.failed.length} failed · ${companions.skipped.length} not selected`,
    detail: `Evidence budget ${companions.selected}/${companions.total} linking document(s)`,
  });
  if (companions.analyzed.length > 0) {
    lines.push({
      label: 'Companion documents analyzed',
      detail: companions.analyzed.slice(0, MAX_COMPANION_LINES).join('; '),
    });
  }
  if (companions.failed.length > 0) {
    lines.push({
      label: 'Companion passes failed',
      detail: companions.failed.slice(0, MAX_COMPANION_LINES).join('; '),
    });
  }
  if (companions.skipped.length > 0) {
    lines.push({
      label: 'Companions not selected',
      detail: `beyond the Top-${companions.selected} budget: ` +
        companions.skipped.slice(0, MAX_COMPANION_LINES).join('; '),
    });
  }
  return lines;
}

/**
 * The bounded-evidence line for a dimmed declaration's tooltip (Level 11 /
 * Phase 6). PURE formatter — the ONLY function that derives this text; the
 * hover builder consumes it and renders the result as a secondary italic
 * footnote paragraph, never as a second verdict. NEVER a universal claim:
 * the property is dimmed only when no observed real context gave it effect
 * (merged verdict `I`), so the wording stays bounded to the analyzed pages.
 * Returns null when the line must be suppressed.
 *
 * Invariant (active-wins lattice): a merged-I result necessarily has
 * I == N — any effective (`A`) pass would have suppressed the issue itself.
 * Enforced here by a defensive guard and locked by unit tests.
 *
 * Ordered display rules (n = evaluatedCount, i = inactiveCount,
 * m = analyzedCompanions):
 *   1. DEFENSIVE GUARD: i != n → null (never emit a bounded-evidence claim
 *      that contradicts the lattice); n < 1 is equally impossible for a
 *      legitimately dimmed issue.
 *   2. m == 1 → null (single-companion runs add no information).
 *   3. i == n (the only legitimate remaining case):
 *      - n <= m → `No effect in ${n} of ${m} analyzed pages.`
 *   Any other combination (n > m, …) → null.
 *   The string is exact — no paraphrasing or special all-pages variant.
 */
export function evidenceLine(n: number, i: number, m: number): string | null {
  if (i !== n || n < 1) {
    return null; // defensive guard — contradicts the active-wins lattice
  }
  if (m === 1) {
    return null; // single-companion runs add no information
  }
  if (n <= m) {
    return `No effect in ${n} of ${m} analyzed pages.`;
  }
  return null;
}

/** Deterministic skip-reason recap (deduped, order-stable). */
export function collectSkipReasons(outcome: AnalysisOutcome): string[] {
  const seen = new Set<string>();
  const reasons: string[] = [];
  for (const reason of outcome.skippedReasons) {
    if (seen.has(reason)) {
      continue;
    }
    seen.add(reason);
    reasons.push(reason);
  }
  return reasons;
}

/**
 * One-line, deterministic coverage summary for the output channel — the
 * single log form of outcomes: no free-form prose, only derived numbers.
 */
export function coverageSummaryLine(outcome: AnalysisOutcome): string {
  const coverage = outcome.coverage;
  if (coverage) {
    return countsCaption(coverage.overall.counts);
  }
  return `analyzed ${outcome.analyzedSelectorsCount}, skipped ${outcome.skippedSelectorsCount}`;
}

/** The stable state label used only for dedup keys (internal). */
export function rowKey(row: StatusPresentation): string {
  return row.visible ? `${row.state}|${row.text}` : 'hidden';
}
