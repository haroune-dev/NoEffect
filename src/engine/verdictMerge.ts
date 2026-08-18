/**
 * Multi-companion verdict merging (Level 11).
 *
 * Per-pass engine verdicts form a three-element chain and merge as the
 * lattice JOIN (= component-wise max):
 *
 *   ⊥ ≤ I ≤ A        (no evidence ≤ provably inactive ≤ provably effective)
 *
 *   A ⊔ x = A        effective anywhere ⇒ active
 *   I ⊔ I = I        inactive in every evaluating pass ⇒ inactive
 *   I ⊔ ⊥ = I        uncontradicted inactive evidence stands
 *   ⊥ is the identity
 *
 * Because the order is total, commutativity, associativity and idempotence
 * hold by construction (still locked by exhaustive property-style unit
 * tests — see verdictMerge.test.ts).
 *
 * The lattice contains ONLY usable semantic evidence from SUCCESSFUL
 * passes:
 *   - `A` = the engine evaluation positively established "effective";
 *   - `I` = the engine evaluation established "ineffective" (with its
 *     reason code and the mapped issue);
 *   - `⊥` = no usable semantic verdict in this pass (selector unmatched,
 *     rule not applicable, abstention, or node not located).
 *
 * Execution failures (page-load failure, CDP timeout, parse failure,
 * aborted pass) are NOT lattice elements: a failed pass contributes NO
 * semantic evidence and `I ⊔ ⊥ = I` never means "a failed companion proved
 * inactive". Pipeline order is never interleaved: semantic merge →
 * coverage/execution metadata → derivation.
 *
 * Pure module (no `vscode`, no browser, no filesystem): declarations are
 * keyed companion-independently on the PARSED LOCAL declaration range
 * (from the CSS AST) — never on CDP ranges, node ids or companion paths.
 */

import { CssIssue, CssLocation } from '../models';

/** The three-element semantic verdict chain: ⊥ ≤ I ≤ A. */
export type Verdict = 'bottom' | 'I' | 'A';

/** Lattice rank: bottom is the identity, A is absorbing. */
const VERDICT_RANK: Record<Verdict, number> = { bottom: 0, I: 1, A: 2 };

/** The lattice JOIN (= max): merge two semantic verdicts. */
export function mergeVerdicts(a: Verdict, b: Verdict): Verdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}

/** A parsed, companion-independent local range of a declaration. */
export interface ParsedDeclarationRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/**
 * The merge key of a declaration: the analyzed stylesheet, the sheet
 * identity (path | content hash — identical for every pass over the same
 * CSS), the PARSED LOCAL declaration range and the property name. Never
 * contains CDP ranges, node ids or companion paths, so two passes over
 * different companions always produce the same key for the same authored
 * declaration — and the k-th authored duplicate inside one declaration
 * block keeps its own distinct parsed range and therefore its own key.
 */
export function declarationKeyFor(
  cssFilePath: string,
  sheetIdentity: string,
  range: ParsedDeclarationRange,
  propertyName: string
): string {
  return [
    cssFilePath,
    sheetIdentity,
    range.startLine,
    range.startColumn,
    range.endLine,
    range.endColumn,
    propertyName,
  ].join('|');
}

/** One semantic verdict of one pass, keyed by {@link declarationKeyFor}. */
export interface PassVerdict {
  /** Companion-independent merge key of the authored declaration. */
  key: string;

  verdict: Verdict;

  /** Stable engine reason code (only meaningful for `I`). */
  reasonCode?: string;

  /** Concise engine reason text (only meaningful for `I`). */
  reasonText?: string;

  /**
   * The fully mapped local issue of this pass (only for `I` verdicts that
   * could be mapped). The merged result takes it from the HIGHEST-RANKED
   * (lowest-index) pass that issued `I`.
   */
  issue?: CssIssue;
}

/**
 * The complete output of ONE companion pass. `success:false` passes carry
 * NO semantic evidence (they are recorded as explicit pass failures in
 * coverage, never merged).
 */
export interface PassOutcome {
  /** Absolute path of the analyzed companion document. */
  companionPath: string;

  /** Rank of the companion in the ranked selection (0 = closest). */
  companionRank: number;

  /** Per-declaration verdicts of this pass (completeness: ⊥ where nothing evaluated). */
  verdicts: Map<string, PassVerdict>;

  /** Whether the pass executed and produced usable semantic evidence. */
  success: boolean;

  /** Diagnostic message of a failed pass (only when `success` is false). */
  error?: string;
}

/** The merged view of ONE declaration across all successful passes. */
export interface MergedResult {
  /** Companion-independent merge key. */
  key: string;

  /** Joined verdict: `A` when ANY evaluated pass said effective. */
  verdict: Verdict;

  /**
   * The mapped issue of the highest-ranked pass that issued `I` (only for
   * a merged `I`).
   */
  issue?: CssIssue;

  /** Passes emitting `A` or `I` for this declaration. */
  evaluatedCount: number;

  /** Passes emitting `I` for this declaration. */
  inactiveCount: number;

  /**
   * Rank of the pass whose verdict decided the merged result: the first
   * `A` pass for merged `A`, the `I` pass that supplied the issue for
   * merged `I`, -1 when there is nothing to attribute.
   */
  sourceRank: number;
}

/**
 * Join every successful pass into one merged verdict map. Failed passes
 * contribute nothing (no lattice elements, no counts). The issue of a
 * merged `I` comes from the highest-ranked pass that issued it; evaluated/
 * inactive counts count only successful passes emitting `A` or `I`.
 *
 * Deterministic: the outcome depends only on the pass maps and their
 * ranks — not on pass order in the input array (ranks are the only order).
 */
export function mergePassOutcomes(outcomes: readonly PassOutcome[]): Map<string, MergedResult> {
  const keys = new Set<string>();
  for (const outcome of outcomes) {
    if (!outcome.success) {
      continue;
    }
    for (const key of outcome.verdicts.keys()) {
      keys.add(key);
    }
  }

  const merged = new Map<string, MergedResult>();
  for (const key of keys) {
    let verdict: Verdict = 'bottom';
    let evaluatedCount = 0;
    let inactiveCount = 0;
    let firstARank: number | null = null;
    let issueSource: { rank: number; issue: CssIssue } | null = null;

    for (const outcome of outcomes) {
      if (!outcome.success) {
        continue;
      }
      const passVerdict = outcome.verdicts.get(key);
      if (!passVerdict) {
        continue;
      }
      if (passVerdict.verdict !== 'bottom') {
        evaluatedCount++;
      }
      if (passVerdict.verdict === 'I') {
        inactiveCount++;
        // The issue of a merged `I` comes from the HIGHEST-RANKED pass
        // that issued it — rank, not input order (P3-LOG-32).
        if (
          passVerdict.issue &&
          (issueSource === null || outcome.companionRank < issueSource.rank)
        ) {
          issueSource = { rank: outcome.companionRank, issue: passVerdict.issue };
        }
      } else if (passVerdict.verdict === 'A' && (firstARank === null || outcome.companionRank < firstARank)) {
        firstARank = outcome.companionRank;
      }
      verdict = mergeVerdicts(verdict, passVerdict.verdict);
    }

    if (verdict === 'bottom') {
        // No usable semantic evidence in ANY successful pass: the
        // declaration never materializes (⊥ is the identity).
        continue;
      }
      merged.set(key, {
        key,
        verdict,
        ...(verdict === 'I' && issueSource ? { issue: issueSource.issue } : {}),
        evaluatedCount,
        inactiveCount,
        // Attribution follows the DECIDING verdict: the first `A` pass for
        // a merged `A`; the pass that supplied the issue for a merged `I`.
        sourceRank: verdict === 'A' ? (firstARank ?? -1) : (issueSource?.rank ?? -1),
      });
  }

  return merged;
}

/** True when the merged verdict is `A` — the declaration is effective somewhere. */
export function isEffectiveInAnyPass(result: MergedResult): boolean {
  return result.verdict === 'A';
}

/** Stable fingerprint helper for issue metadata consumers (tests). */
export function locationDimensions(location: CssLocation): string {
  return [
    location.startLine,
    location.startColumn,
    location.endLine,
    location.endColumn,
  ].join('|');
}