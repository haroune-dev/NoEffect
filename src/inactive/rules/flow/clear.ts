/**
 * PR6 Phase 3 — the `clear` rule.
 *
 * `clear` only pushes a block-level box below preceding floats, so it is
 * inactive when:
 *
 *   - the element is a flex/grid item (clear does not apply to items),
 *   - the element is taken out of flow by absolute/fixed positioning,
 *   - the element is an inline box (clear applies to block-level boxes
 *     only) — BUT only when its own computed `float` is `none`: a floated
 *     inline element is blockified and clear applies to it,
 *   - the element generates no box at all (`display: contents`).
 *
 * Whether there actually ARE preceding floats cannot be known from the
 * context, so a plain block-level element always stays active (false
 * negatives preferred).
 */
import { MatchedCssDeclaration } from '../../../engine/inactivePropertyEngine';
import { LayoutContext } from '../../../engine/layoutContext';
import { InactiveResult, InactiveRule } from '../../inactiveRule';
import { REASON_CODES } from '../../reasonCode';
import {
  boxSuppressedReasonText,
  inactiveResult,
  isAbsoluteOrFixed,
  isBoxSuppressed,
} from '../shared';

export const clearRule: InactiveRule = {
  propertyName: 'clear',
  inspect(layout: LayoutContext, _declaration: MatchedCssDeclaration): InactiveResult | undefined {
    if (!layout.display) {
      return undefined;
    }
    if (isBoxSuppressed(layout)) {
      return inactiveResult(
        'clear',
        REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX,
        boxSuppressedReasonText('clear')
      );
    }
    if (isAbsoluteOrFixed(layout)) {
      return inactiveResult(
        'clear',
        REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX,
        'clear has no effect because this element is out of flow (position: absolute or fixed).'
      );
    }
    if (layout.isFlexItem || layout.isGridItem) {
      return inactiveResult(
        'clear',
        REASON_CODES.NOT_APPLICABLE_TO_FLEX_GRID_ITEM,
        'clear has no effect because this element is a flex or grid item.'
      );
    }
    if (layout.display === 'inline') {
      const floatValue = layout.getComputedStyle('float');
      // Missing float data → cannot rule out blockification → no decision.
      if (floatValue === undefined || floatValue === '') {
        return undefined;
      }
      if (floatValue === 'none') {
        return inactiveResult(
          'clear',
          REASON_CODES.NOT_APPLICABLE_TO_INLINE_BOX,
          'clear has no effect because this element is an inline box.'
        );
      }
      // A floated inline element is blockified — clear applies.
      return undefined;
    }
    return undefined;
  },
};
