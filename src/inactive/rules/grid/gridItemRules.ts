/**
 * PR6 Phase 2 — grid item rules.
 *
 * These properties position/align the element within the grid track
 * lines, so the element's PARENT must be a grid container.
 *
 * PR7 added `grid-row-start`/`grid-row-end` (reference GridItemValidator)
 * and widened the grid-positioning properties to also accept grid-lanes
 * parents, exactly like the reference.
 *
 * Advanced-context (Level 2): the rules are built through
 * `createOutOfFlowAwareItemRule`, which adds the compound condition where
 * an out-of-flow child (`position: absolute | fixed`) of a grid container
 * stops being an item and its item properties lose their effect. The
 * Level-2 property list also covers `grid-column-start`/`grid-column-end`
 * (the remaining line-placement longhands).
 */
import { InactiveRule } from '../../inactiveRule';
import { REASON_CODES } from '../../reasonCode';
import { createOutOfFlowAwareItemRule, isGridItem, isGridOrGridLanesItem } from '../shared';

export const gridItemRules: readonly InactiveRule[] = [
  createOutOfFlowAwareItemRule(
    'justify-self',
    REASON_CODES.REQUIRES_GRID_ITEM,
    'a grid item',
    isGridItem
  ),
  createOutOfFlowAwareItemRule(
    'grid-column',
    REASON_CODES.REQUIRES_GRID_ITEM,
    'a grid item',
    isGridOrGridLanesItem
  ),
  createOutOfFlowAwareItemRule(
    'grid-row',
    REASON_CODES.REQUIRES_GRID_ITEM,
    'a grid item',
    isGridOrGridLanesItem
  ),
  createOutOfFlowAwareItemRule(
    'grid-area',
    REASON_CODES.REQUIRES_GRID_ITEM,
    'a grid item',
    isGridOrGridLanesItem
  ),
  createOutOfFlowAwareItemRule(
    'grid-row-start',
    REASON_CODES.REQUIRES_GRID_ITEM,
    'a grid item',
    isGridOrGridLanesItem
  ),
  createOutOfFlowAwareItemRule(
    'grid-row-end',
    REASON_CODES.REQUIRES_GRID_ITEM,
    'a grid item',
    isGridOrGridLanesItem
  ),
  createOutOfFlowAwareItemRule(
    'grid-column-start',
    REASON_CODES.REQUIRES_GRID_ITEM,
    'a grid item',
    isGridOrGridLanesItem
  ),
  createOutOfFlowAwareItemRule(
    'grid-column-end',
    REASON_CODES.REQUIRES_GRID_ITEM,
    'a grid item',
    isGridOrGridLanesItem
  ),
];
