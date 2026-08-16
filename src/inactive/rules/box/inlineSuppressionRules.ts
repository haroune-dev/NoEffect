/**
 * Advanced-context (Level 2) — inline box-model suppression rules.
 *
 * Non-replaced elements with `display: inline` do not participate in block
 * layout, so the browser ignores their vertical box geometry and their
 * geometric transforms:
 *
 *   - vertical margins (`margin-top`, `margin-bottom`) do not move the
 *     line box or affect surrounding layout,
 *   - `transform` / `perspective` (and by extension the transform-family
 *     properties already covered by `transformRules`) do not apply to
 *     non-transformable inline boxes.
 *
 * Vertical paddings (`padding-top`/`padding-bottom`) share the same
 * line-box suppression (they never influence the line height, only the
 * painted extent) and live in `paddingRules` — the rule that owns the
 * padding properties — so the whole padding family stays in one place.
 *
 * Replaced inline elements (`<img>`, `<video>`, `<canvas>`, ...) DO honor
 * these properties, so the node name is consulted through the shared
 * `isInlineNonReplacedElement` eligibility check. Only the properties above
 * are targeted — no blanket rule over every property on inline elements.
 */
import { InactiveRule } from '../../inactiveRule';
import { MatchedCssDeclaration } from '../../../engine/inactivePropertyEngine';
import { LayoutContext } from '../../../engine/layoutContext';
import { REASON_CODES } from '../../reasonCode';
import { inactiveResult, isInlineNonReplacedElement } from '../shared';

function createInlineSuppressionRule(propertyName: string): InactiveRule {
  return {
    propertyName,
    inspect(layout: LayoutContext, _declaration: MatchedCssDeclaration) {
      if (!layout.display) {
        return undefined;
      }
      if (isInlineNonReplacedElement(layout) === true) {
        return inactiveResult(
          propertyName,
          REASON_CODES.NOT_APPLICABLE_TO_INLINE_BOX,
          `${propertyName} has no effect because this element is a non-replaced ` +
            `inline element (display: inline).`
        );
      }
      return undefined;
    },
  };
}

export const inlineSuppressionRules: readonly InactiveRule[] = [
  createInlineSuppressionRule('margin-top'),
  createInlineSuppressionRule('margin-bottom'),
  createInlineSuppressionRule('transform'),
  createInlineSuppressionRule('perspective'),
];
