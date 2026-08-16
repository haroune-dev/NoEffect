/**
 * PR Level 3 — pseudo-element rules.
 *
 * Pseudo declarations are collected by the matched-styles collector from
 * the origin element's `pseudoElements` section and dispatched to the
 * pseudo-element rule that owns them (the engine looks up `::before`,
 * `::after` and `::first-letter` by the declaration's pseudoElement tag).
 *
 *   - `::before` / `::after`: a generated-content pseudo whose cascade
 *     winning `content` is missing, `none` or `normal` generates NO box —
 *     every other property declared on it has no effect. The `content`
 *     declaration itself is never flagged (it is how the box is produced
 *     or suppressed on purpose).
 *   - `::first-letter`: Chromium honors only the properties in
 *     `FIRST_LETTER_SUPPORTED_PROPERTIES` on the first-letter box; every
 *     other declaration computes identically to an unstyled control and is
 *     inactive.
 *
 * The pseudo-type rules only answer the pseudo-level question (does the
 * property apply to this pseudo type at all). When they abstain, the
 * ENGINE additionally consults the property's own formatting-context rule
 * against the pseudo box's LayoutContext (see `InactiveRuleEngine`).
 *
 * Every check is conservative: missing layout data or missing pseudo facts
 * yield no decision.
 */
import { InactiveResult, InactiveRule } from '../../inactiveRule';
import { MatchedCssDeclaration } from '../../../engine/inactivePropertyEngine';
import { LayoutContext } from '../../../engine/layoutContext';
import { REASON_CODES } from '../../reasonCode';
import { hasGeneratedContent, inactiveResult, supportsFirstLetterProperty } from '../shared';

/**
 * Build the content-guard rule for ONE generated pseudo type (`before` or
 * `after`). Registered under the `::<type>` pseudo selector key.
 */
function createGeneratedContentRule(pseudoType: string): InactiveRule {
  const pseudoSelector = `::${pseudoType}`;
  return {
    propertyName: pseudoSelector,
    inspect(layout: LayoutContext, declaration: MatchedCssDeclaration): InactiveResult | undefined {
      // Dispatch sanity: the engine only routes declarations tagged with
      // this pseudo type to this rule.
      if (declaration.pseudoElement !== pseudoType) {
        return undefined;
      }
      // The content declaration itself is meaningful: it is how the pseudo
      // box is produced (or intentionally suppressed).
      if (declaration.propertyName === 'content') {
        return undefined;
      }
      if (!layout.display) {
        return undefined;
      }
      const generates = hasGeneratedContent(layout, pseudoType);
      if (generates !== false) {
        // A generated pseudo is a real box. Continue into the normal
        // property rule, which evaluates its Chromium-derived pseudo-box
        // LayoutContext and may still find a property ineffective for an
        // ordinary formatting-context reason.
        return undefined;
      }
      return inactiveResult(
        declaration.propertyName,
        REASON_CODES.GENERATED_PSEUDO_MISSING,
        `${declaration.propertyName} has no effect because the ${pseudoSelector} ` +
          `pseudo-element generates no box (content is missing, none or normal).`
      );
    },
  };
}

/** ::first-letter property-eligibility rule (registered under '::first-letter'). */
const firstLetterRule: InactiveRule = {
  propertyName: '::first-letter',
  inspect(layout: LayoutContext, declaration: MatchedCssDeclaration): InactiveResult | undefined {
    if (declaration.pseudoElement !== 'first-letter') {
      return undefined;
    }
    if (!layout.display) {
      return undefined;
    }
    if (supportsFirstLetterProperty(declaration.propertyName)) {
      return undefined;
    }
    return inactiveResult(
      declaration.propertyName,
      REASON_CODES.FIRST_LETTER_UNSUPPORTED_PROPERTY,
      `${declaration.propertyName} has no effect on the ::first-letter pseudo-element ` +
        `because it is not a property the browser applies to the first letter.`
    );
  },
};

export const pseudoRules: readonly InactiveRule[] = [
  createGeneratedContentRule('before'),
  createGeneratedContentRule('after'),
  firstLetterRule,
];
