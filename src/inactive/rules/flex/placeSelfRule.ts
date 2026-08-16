/**
 * Advanced-context (Level 2) — `place-self`, the item-level member of the
 * `place-*` alignment family.
 *
 * The `place-*` family covers the two container shorthands
 * (`place-items`, `place-content` — registered by the flex container
 * rules) and the item shorthand `place-self`. Where the container members
 * require a flex/grid CONTAINER, `place-self` decomposes into its item
 * longhands — `align-self` + `justify-self` — and therefore requires a
 * flex/grid ITEM. On a standard block box (`display: block` / inline-block
 * with no flex/grid context) it has no effect.
 *
 * The decomposition itself lives in the shared helper `hasPlaceSelfEffect`;
 * this rule only owns the `place-self` property and reports the grouped
 * place-* decision. Conservative: an unknown parent ('none') yields no
 * decision.
 */
import { InactiveRule } from '../../inactiveRule';
import { MatchedCssDeclaration } from '../../../engine/inactivePropertyEngine';
import { LayoutContext } from '../../../engine/layoutContext';
import { REASON_CODES } from '../../reasonCode';
import { hasPlaceSelfEffect, inactiveResult } from '../shared';

export const placeSelfRule: InactiveRule = {
  propertyName: 'place-self',
  inspect(layout: LayoutContext, _declaration: MatchedCssDeclaration) {
    if (!layout.display) {
      return undefined;
    }
    const effect = hasPlaceSelfEffect(layout);
    if (effect === undefined || effect) {
      return undefined;
    }
    return inactiveResult(
      'place-self',
      REASON_CODES.REQUIRES_FLEX_OR_GRID_ITEM,
      'place-self has no effect because it decomposes into align-self/justify-self, ' +
        'which only apply to flex or grid items (this element is neither).'
    );
  },
};
