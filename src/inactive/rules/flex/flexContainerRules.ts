/**
 * PR6 Phase 2 — flex container rules.
 *
 * These properties distribute the container's items along the main or
 * cross axis, so the element must establish a flex (or, for the shared
 * alignment properties, a grid) formatting context.
 *
 * PR7 note: `align-content`/`place-content` keep their EXACT PR6
 * container-required semantics (inactive on `display: block` and every
 * other non-flex/grid display — as verified by the PR6 test suite). The
 * reference's `flex-wrap: nowrap` conflict is added as a PURELY ADDITIVE
 * condition: it only fires on real flex containers, where PR6 had no
 * flag at all, so no previously working rule is weakened or bypassed.
 * `justify-content` keeps flagging items of flex/grid containers, with a
 * distinct reason code for the item case (still inactive — same result,
 * more accurate message).
 */
import { InactiveRule } from '../../inactiveRule';
import { MatchedCssDeclaration } from '../../../engine/inactivePropertyEngine';
import { LayoutContext } from '../../../engine/layoutContext';
import { REASON_CODES } from '../../reasonCode';
import {
  createContainerRequirementRule,
  inactiveResult,
  isFlexContainer,
  isFlexOrGridContainer,
  isFlexOrGridOrGridLanesContainer,
  isFlexOrGridOrGridLanesItem,
  isGridContainer,
} from '../shared';

/** Reference FlexGridValidator (`justify-content`). */
const justifyContentRule: InactiveRule = {
  propertyName: 'justify-content',
  inspect(layout: LayoutContext, _declaration: MatchedCssDeclaration) {
    if (!layout.display) {
      return undefined;
    }
    if (isFlexOrGridOrGridLanesContainer(layout)) {
      return undefined;
    }
    // The element is a flex/grid item: justify-content only applies to
    // containers (the reference suggests justify-self instead).
    if (isFlexOrGridOrGridLanesItem(layout)) {
      return inactiveResult(
        'justify-content',
        REASON_CODES.NOT_APPLICABLE_TO_FLEX_GRID_ITEM,
        'justify-content has no effect because this element is a flex or grid item, ' +
          'but justify-content only applies to containers.'
      );
    }
    return inactiveResult(
      'justify-content',
      REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER,
      'justify-content has no effect because this element is not a flex or grid container.'
    );
  },
};

/**
 * PR6 semantics (unchanged): the element must establish a flex or grid
 * formatting context — `display: block` is INACTIVE, exactly as PR6
 * verified. PR7 adds the reference's `flex-wrap: nowrap` conflict as an
 * additive condition that only fires on real flex containers.
 */
function createAlignmentContentRule(propertyName: string): InactiveRule {
  return {
    propertyName,
    inspect(layout: LayoutContext, _declaration: MatchedCssDeclaration) {
      if (!layout.display) {
        return undefined;
      }
      if (!isFlexContainer(layout) && !isGridContainer(layout)) {
        return inactiveResult(
          propertyName,
          REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER,
          `${propertyName} has no effect because this element is not a flex or grid container.`
        );
      }
      // On a flex container, align-content only matters when items can
      // wrap; nowrap (the default) makes it a no-op.
      if (isFlexContainer(layout) && layout.getComputedStyle('flex-wrap') === 'nowrap') {
        return inactiveResult(
          propertyName,
          REASON_CODES.PREVENTED_BY_FLEX_WRAP_NOWRAP,
          `${propertyName} has no effect because the flex-wrap: nowrap property prevents it from having an effect.`
        );
      }
      return undefined;
    },
  };
}

export const flexContainerRules: readonly InactiveRule[] = [
  createContainerRequirementRule(
    'align-items',
    REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER,
    'a flex or grid container',
    isFlexOrGridContainer
  ),
  createContainerRequirementRule(
    'place-items',
    REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER,
    'a flex or grid container',
    isFlexOrGridContainer
  ),
  justifyContentRule,
  createAlignmentContentRule('align-content'),
  createAlignmentContentRule('place-content'),
];
