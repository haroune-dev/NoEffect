/**
 * PR7 — sizing rules for inline elements (reference SizingValidator).
 *
 * `width`/`height` do not apply to non-replaced inline elements — an
 * inline box sizes to its content. Replaced inline elements (`<img>`,
 * `<video>`, ...) DO honor them, so the node name (from the LayoutContext)
 * is consulted before flagging, exactly like the reference's
 * `isPossiblyReplacedElement` check.
 *
 * See "Applies to" in https://www.w3.org/TR/css-sizing-3/#propdef-width
 * and https://www.w3.org/TR/css-sizing-3/#propdef-height.
 */
import { InactiveRule } from '../../inactiveRule';
import { MatchedCssDeclaration } from '../../../engine/inactivePropertyEngine';
import { LayoutContext } from '../../../engine/layoutContext';
import { REASON_CODES } from '../../reasonCode';
import {
  boxSuppressedReasonText,
  inactiveResult,
  isBoxSuppressed,
  isInlineElement,
  isPossiblyReplacedElement,
} from '../shared';

function createInlineSizingRule(propertyName: string): InactiveRule {
  return {
    propertyName,
    inspect(layout: LayoutContext, _declaration: MatchedCssDeclaration) {
      if (!layout.display || !layout.nodeName) {
        return undefined;
      }
      // Final-PR7: display: contents generates no box — width/height have
      // nothing to size (most specific condition).
      if (isBoxSuppressed(layout)) {
        return inactiveResult(
          propertyName,
          REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX,
          boxSuppressedReasonText(propertyName)
        );
      }
      if (!isInlineElement(layout)) {
        return undefined;
      }
      // Replaced inline elements honor width/height.
      if (isPossiblyReplacedElement(layout.nodeName)) {
        return undefined;
      }
      return inactiveResult(
        propertyName,
        REASON_CODES.NOT_APPLICABLE_TO_INLINE_BOX,
        `${propertyName} has no effect because this element is an inline element (display: inline).`
      );
    },
  };
}

export const sizingRules: readonly InactiveRule[] = [
  createInlineSizingRule('width'),
  createInlineSizingRule('height'),
];
