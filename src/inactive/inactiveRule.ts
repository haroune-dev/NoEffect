/**
 * PR6 Phase 2 — the inactive-property Rule Engine contract.
 *
 * A rule owns exactly ONE CSS property (the registry is keyed by property
 * name, so no two rules may claim the same property). Rules are pure:
 * they read the prebuilt LayoutContext and the matched declaration, and
 * never touch CDP, the browser, or any cache.
 *
 * The contract is intentionally conservative:
 *   - `undefined` means "active" (or "no decision"): the property keeps
 *     its effect and no issue is reported;
 *   - incomplete or ambiguous layout data (missing display, unknown
 *     parent) MUST return `undefined` — false negatives are preferred
 *     over false positives;
 *   - rules must never throw on malformed values.
 */
import { MatchedCssDeclaration } from '../engine/inactivePropertyEngine';
import { LayoutContext } from '../engine/layoutContext';
import { ReasonCode } from './reasonCode';

/** The decision of one rule. `undefined` (from `inspect`) means active. */
export interface InactiveResult {
  readonly inactive: true;

  /** Canonical (lowercase, normalized) property name. */
  readonly propertyName: string;

  /** Standardized, machine-readable reason code. */
  readonly reasonCode: ReasonCode;

  /** Concise human-readable reason text. */
  readonly reasonText: string;
}

/**
 * One inactive-property rule.
 *
 * `inspect` receives the immutable LayoutContext built ONCE per node by
 * the LayoutContextBuilder and the declaration that matched it. Rules must
 * consume layout information through the context — never through the raw
 * style map or the declaration value.
 */
export interface InactiveRule {
  /** Canonical property name this rule owns (normalized at registration). */
  readonly propertyName: string;

  inspect(layout: LayoutContext, declaration: MatchedCssDeclaration): InactiveResult | undefined;
}
