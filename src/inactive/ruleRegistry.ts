/**
 * PR6 Phase 2 — Rule Registry.
 *
 * A registry owns the mapping property name → rule. Lookup normalizes the
 * requested name (trim, collapse whitespace, lowercase) so callers can
 * never accidentally miss a rule, and an exact Map lookup means scanning
 * unrelated rules costs nothing.
 *
 * The registry is deliberately a plain data structure: it holds no logic
 * and performs no CDP calls. Registration is centralized in
 * `registerDefaultRules()`, which is the single place that decides which
 * rules ship with the extension.
 */
import { InactiveRule } from './inactiveRule';
import { flexContainerRules } from './rules/flex/flexContainerRules';
import { flexItemRules } from './rules/flex/flexItemRules';
import { flexOnlyContainerRules } from './rules/flex/flexOnlyContainerRules';
import { gridContainerRules } from './rules/grid/gridContainerRules';
import { gridItemRules } from './rules/grid/gridItemRules';
import { gridTemplateRules } from './rules/grid/gridTemplateRules';
import { topRightBottomLeftRules } from './rules/position/topRightBottomLeft';
import { insetRule } from './rules/position/inset';
import { zIndexRule } from './rules/position/zIndex';
import { positionAnchorRule } from './rules/position/positionAnchorRules';
import { floatRule } from './rules/flow/float';
import { clearRule } from './rules/flow/clear';
import { listRules } from './rules/flow/listRules';
import { overflowRule } from './rules/overflow/overflow';
import { overflowXRule } from './rules/overflow/overflowX';
import { overflowYRule } from './rules/overflow/overflowY';
import { scrollRules } from './rules/overflow/scrollRules';
import { textOverflowRule } from './rules/overflow/textOverflow';
import { pointerEventsRule } from './rules/misc/pointerEvents';
import { verticalAlignRule } from './rules/misc/verticalAlign';
import { objectFitRules } from './rules/misc/objectFit';
import { paddingRules } from './rules/table/paddingRules';
import { tableRules } from './rules/table/tableRules';
import { sizingRules } from './rules/box/sizingRules';
import { boxSuppressionRules } from './rules/box/boxSuppressionRules';
import { inlineSuppressionRules } from './rules/box/inlineSuppressionRules';
import { transformRules, backdropFilterRule } from './rules/box/transformRules';
import { placeSelfRule } from './rules/flex/placeSelfRule';
import { pseudoRules } from './rules/pseudo/pseudoRules';
import { logger } from '../utils/logger';

/** Normalize a property name: trim, collapse inner whitespace, lowercase. */
export function normalizePropertyName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export class RuleRegistry {
  private readonly rules = new Map<string, InactiveRule>();

  /**
   * Register one rule. Throws when the property is already registered —
   * two rules claiming the same property would make dispatch ambiguous.
   */
  register(rule: InactiveRule): void {
    const key = normalizePropertyName(rule.propertyName);
    if (!key) {
      throw new Error('[RuleRegistry] Refusing to register a rule with an empty property name');
    }
    if (this.rules.has(key)) {
      throw new Error(`[RuleRegistry] Duplicate rule for property "${key}"`);
    }
    logger.debug(`[RuleRegistry] Registered rule: ${key}`);
    this.rules.set(key, rule);
  }

  /** Register many rules in order (first duplicate throws). */
  registerAll(rules: Iterable<InactiveRule>): void {
    for (const rule of rules) {
      this.register(rule);
    }
  }

  /** Look up the rule for a property (normalized), or undefined. */
  lookup(propertyName: string): InactiveRule | undefined {
    const rule = this.rules.get(normalizePropertyName(propertyName));
    if (!rule) {
      logger.debug(`[RuleRegistry] No rule for property: ${propertyName}`);
    }
    return rule;
  }

  /** Whether a rule exists for the property (normalized). */
  has(propertyName: string): boolean {
    return this.rules.has(normalizePropertyName(propertyName));
  }

  /** Number of registered rules. */
  get size(): number {
    return this.rules.size;
  }

  /** All registered canonical property names. */
  get propertyNames(): readonly string[] {
    return [...this.rules.keys()];
  }
}

/**
 * Register every default rule. This is the single centralized entry point
 * for the extension's rule set — adding a rule means adding it here (and
 * nowhere in the analyzer).
 */
export function registerDefaultRules(registry: RuleRegistry): void {
  registry.registerAll([
    // PR6 Phase 2 — flex/grid families.
    ...flexContainerRules,
    ...flexItemRules,
    ...gridContainerRules,
    ...gridItemRules,
    // PR7 — flex-only / grid-template container families.
    ...flexOnlyContainerRules,
    ...gridTemplateRules,
    // PR6 Phase 3 — position family.
    ...topRightBottomLeftRules,
    insetRule,
    zIndexRule,
    // PR7 — anchor positioning.
    positionAnchorRule,
    // PR6 Phase 3 — flow family.
    floatRule,
    clearRule,
    // Final-PR7 — list-marker family.
    ...listRules,
    // PR6 Phase 3 — overflow family.
    overflowRule,
    overflowXRule,
    overflowYRule,
    // Advanced-context — composite text-truncation rule.
    textOverflowRule,
    // Final-PR7 — scroll-context family.
    ...scrollRules,
    // PR Level 3 — pseudo-element family.
    ...pseudoRules,
    // PR6 Phase 3 — misc family.
    pointerEventsRule,
    verticalAlignRule,
    ...objectFitRules,
    // PR7 — table-internal padding and inline sizing families.
    ...paddingRules,
    ...sizingRules,
    // Final-PR7 — table / box-suppression / transform families.
    ...tableRules,
    ...boxSuppressionRules,
    ...transformRules,
    backdropFilterRule,
    // Advanced-context (Level 2) — compound multi-condition families.
    ...inlineSuppressionRules,
    placeSelfRule,
  ]);
}

/** Convenience factory: a fully registered default registry. */
export function createDefaultRuleRegistry(): RuleRegistry {
  const registry = new RuleRegistry();
  registerDefaultRules(registry);
  return registry;
}
