/**
 * PR7 — position-anchor rule (reference PositionAnchorValidator).
 *
 * `position-anchor` only takes effect on anchor-positioned elements:
 * `position: absolute` or `fixed`. On any other position the declaration
 * is inactive (an anchor was defined but the element is not
 * anchor-positioned); a hidden element (`display: none`) generates no box
 * to position either.
 *
 * Conservative deviation from the reference: a missing `position` (CDP
 * degraded) yields no decision instead of assuming `static`.
 */
import { InactiveRule } from '../../inactiveRule';
import { MatchedCssDeclaration } from '../../../engine/inactivePropertyEngine';
import { LayoutContext } from '../../../engine/layoutContext';
import { REASON_CODES } from '../../reasonCode';
import { inactiveResult } from '../shared';

export const positionAnchorRule: InactiveRule = {
  propertyName: 'position-anchor',
  inspect(layout: LayoutContext, _declaration: MatchedCssDeclaration) {
    if (!layout.display || !layout.position) {
      return undefined;
    }
    if (layout.position !== 'absolute' && layout.position !== 'fixed') {
      return inactiveResult(
        'position-anchor',
        REASON_CODES.REQUIRES_ABSOLUTE_OR_FIXED_POSITION,
        `position-anchor has no effect because this element is not anchor-positioned ` +
          `(position: ${layout.position}).`
      );
    }
    if (layout.display === 'none') {
      return inactiveResult(
        'position-anchor',
        REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX,
        'position-anchor has no effect because this element is hidden (display: none).'
      );
    }
    return undefined;
  },
};
