/**
 * PR6 Phase 3 — the `float` rule.
 *
 * `float` is ignored when the element is taken out of flow by
 * absolute/fixed positioning (float computes to none), is a flex/grid
 * item (items are blockified, float does not apply), or generates no box
 * at all (`display: contents`). In every other formatting context float
 * has a potential effect and stays active.
 *
 * Condition precedence (most specific first): box suppressed →
 * absolutely positioned → flex/grid item. An absolutely positioned child
 * of a flex container is NOT a flex item; checking position first keeps
 * the reason code honest.
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

export const floatRule: InactiveRule = {
  propertyName: 'float',
  inspect(layout: LayoutContext, _declaration: MatchedCssDeclaration): InactiveResult | undefined {
    if (!layout.display) {
      return undefined;
    }
    if (isBoxSuppressed(layout)) {
      return inactiveResult(
        'float',
        REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX,
        boxSuppressedReasonText('float')
      );
    }
    if (isAbsoluteOrFixed(layout)) {
      return inactiveResult(
        'float',
        REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX,
        'float has no effect because this element is out of flow (position: absolute or fixed).'
      );
    }
    if (layout.isFlexItem || layout.isGridItem) {
      return inactiveResult(
        'float',
        REASON_CODES.NOT_APPLICABLE_TO_FLEX_GRID_ITEM,
        'float has no effect because this element is a flex or grid item.'
      );
    }
    return undefined;
  },
};
