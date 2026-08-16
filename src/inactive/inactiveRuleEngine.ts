/**
 * PR6 Phase 2 — Inactive Rule Engine.
 *
 * The engine is deliberately tiny: it guards the input, resolves the
 * property through the registry, and dispatches to the single owning
 * rule. All reasoning lives in the rules; the engine holds no property
 * knowledge of its own, so adding a property never touches this file.
 *
 * Conflict resolution (PR6 Phase 3): the registry guarantees exactly one
 * rule per property and each rule returns at most one result, so a
 * declaration can never produce more than one inactive result — the most
 * specific condition inside the owning rule is the single winner.
 *
 * PR Level 3 + pseudo formatting contexts: a pseudo-element declaration is
 * dispatched in TWO stages. Stage 1 routes it to the pseudo-element rule
 * registered under `::<type>` ('::before', '::after', '::first-letter'),
 * which owns the pseudo-type applicability/eligibility question. When that
 * rule has no verdict (the property may apply to the pseudo box), Stage 2
 * evaluates the declaration against its regular PROPERTY rule — but with
 * the pseudo box's own LayoutContext (`layout.pseudoBoxContexts`), not the
 * origin element's: a `::first-letter` box is a non-replaced inline box, so
 * `margin-top` on it is caught by the inline-box suppression even though
 * the whitelist accepts the margin family. The pseudo box context derives
 * its display/float/position from the pseudo's own authored declarations
 * (`derivePseudoBoxLayout`); without those facts the engine falls back to
 * the origin context (conservative — same as before this feature). Unknown
 * pseudo types with no registered `::<type>` rule stay silent.
 *
 * Contract:
 *   - malformed declarations → `undefined` (never crash);
 *   - unknown property → `undefined` (active);
 *   - missing LayoutContext → `undefined` (rules depend on it — the
 *     analyzer always supplies one built once per node);
 *   - the rule's own decision is returned verbatim.
 */
import {
  InactivePropertyEngine,
  InactivePropertyResult,
  PropertyInspectionContext,
} from '../engine/inactivePropertyEngine';
import { logger } from '../utils/logger';
import { RuleRegistry } from './ruleRegistry';
import { REASON_CODES } from './reasonCode';

export class InactiveRuleEngine implements InactivePropertyEngine {
  constructor(private readonly registry: RuleRegistry) {}

  inspect(context: PropertyInspectionContext): InactivePropertyResult | undefined {
    const { declaration, layout } = context;

    // Malformed declarations must never crash the engine.
    if (!declaration || typeof declaration.propertyName !== 'string') {
      return undefined;
    }

    // A declaration that loses the cascade for its property on the
    // inspected node provably has no effect: an earlier duplicate inside
    // its own block, or a loss to another rule / the inline attribute
    // (higher specificity, later source order, `!important`). The
    // override fact is definitive, so it never consults a context rule
    // (the rule cannot override it).
    if (declaration.isOverridden) {
      if (declaration.isCrossRuleOverride) {
        const winnerSelector = declaration.overriddenBy?.selectorText?.trim();
        logger.debug(
          `[InactiveEngine] Inactive: OVERRIDDEN_BY_CROSS_RULE_DECLARATION ` +
          `(${declaration.propertyName}, winner '${winnerSelector ?? 'inline style'}')`
        );
        return {
          inactive: true,
          propertyName: declaration.propertyName,
          reasonCode: REASON_CODES.OVERRIDDEN_BY_CROSS_RULE_DECLARATION,
          reasonText: winnerSelector
            ? `Overridden by '${winnerSelector}' — that rule wins the cascade for this element, ` +
              `so this declaration has no effect here.`
            : 'Overridden by the inline style attribute — it wins the cascade for this element, ' +
              'so this declaration has no effect here.',
        };
      }
      logger.debug(
        `[InactiveEngine] Inactive: OVERRIDDEN_BY_LATER_DECLARATION (${declaration.propertyName})`
      );
      return {
        inactive: true,
        propertyName: declaration.propertyName,
        reasonCode: REASON_CODES.OVERRIDDEN_BY_LATER_DECLARATION,
        reasonText:
          'Overridden by the later declaration of the same property — this one has no effect.',
      };
    }

    const pseudoElement = declaration.pseudoElement?.trim().toLowerCase();

    // Pseudo declarations: the ::<type> rule owns the eligibility question.
    if (pseudoElement) {
      const pseudoRule = this.registry.lookup(`::${pseudoElement}`);
      if (!pseudoRule) {
        // No registered reasoning for this pseudo type — stay silent.
        return undefined;
      }
      if (!layout) {
        return undefined;
      }
      logger.debug(`[InactiveEngine] Rule matched: ::${pseudoElement}`);
      const pseudoResult = pseudoRule.inspect(layout, declaration);
      if (pseudoResult) {
        logger.debug(
          `[InactiveEngine] Inactive: ${pseudoResult.reasonCode} (pseudo-element rule)`
        );
        return pseudoResult;
      }

      // The pseudo type accepts the property. Let the property's own rule
      // judge the formatting context of the BOX the pseudo generates — not
      // the element's own box. Without derived pseudo-box facts this falls
      // back to the origin context (conservative).
      const propertyRule = this.registry.lookup(declaration.propertyName);
      if (!propertyRule) {
        return undefined;
      }
      const pseudoLayout = layout.pseudoBoxContexts?.get(pseudoElement) ?? layout;
      logger.debug(
        `[InactiveEngine] Pseudo ${pseudoElement} accepted ${declaration.propertyName} ` +
        `— consulting ${declaration.propertyName} rule`
      );
      const result = propertyRule.inspect(pseudoLayout, declaration);
      if (!result) {
        logger.debug(`[InactiveEngine] Skipped: ${declaration.propertyName} — no inactive result`);
      }
      return result;
    }

    // Element-level dispatch: the property's own rule.
    const rule = this.registry.lookup(declaration.propertyName);
    if (!rule) {
      return undefined;
    }
    logger.debug(`[InactiveEngine] Rule matched: ${declaration.propertyName}`);

    // Rules rely on the prebuilt LayoutContext; without it there is no
    // decision (conservative: false negatives preferred).
    if (!layout) {
      logger.debug(`[InactiveEngine] Skipped: ${declaration.propertyName} — insufficient context`);
      return undefined;
    }

    const result = rule.inspect(layout, declaration);
    if (!result) {
      logger.debug(`[InactiveEngine] Skipped: ${declaration.propertyName} — no inactive result`);
    }
    return result;
  }
}
