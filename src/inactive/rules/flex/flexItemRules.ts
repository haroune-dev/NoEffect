/**
 * PR6 Phase 2 — flex item rules.
 *
 * These properties apply to the ITEMS of a flex container:
 *
 *   - `align-self` also applies to grid items (both are self-alignment
 *     properties), so it uses the FLEX_OR_GRID_ITEM code;
 *   - `order` is honored by grid items in Chromium too, so it is kept
 *     conservative (FLEX_OR_GRID_ITEM) to avoid false positives;
 *   - `flex-grow`/`flex-shrink`/`flex-basis` and the `flex` shorthand are
 *     flex-only and use REQUIRES_FLEX_ITEM.
 *
 * Advanced-context (Level 2): the rules are built through
 * `createOutOfFlowAwareItemRule`, which adds the compound condition where
 * an out-of-flow child (`position: absolute | fixed`) of a flex/grid
 * container stops being an item and its item properties lose their effect.
 */
import { InactiveRule } from '../../inactiveRule';
import { REASON_CODES } from '../../reasonCode';
import {
  createOutOfFlowAwareItemRule,
  isFlexItem,
  isFlexOrGridItem,
} from '../shared';

export const flexItemRules: readonly InactiveRule[] = [
  createOutOfFlowAwareItemRule(
    'align-self',
    REASON_CODES.REQUIRES_FLEX_OR_GRID_ITEM,
    'a flex or grid item',
    isFlexOrGridItem
  ),
  createOutOfFlowAwareItemRule(
    'order',
    REASON_CODES.REQUIRES_FLEX_OR_GRID_ITEM,
    'a flex or grid item',
    isFlexOrGridItem
  ),
  createOutOfFlowAwareItemRule(
    'flex-grow',
    REASON_CODES.REQUIRES_FLEX_ITEM,
    'a flex item',
    isFlexItem
  ),
  createOutOfFlowAwareItemRule(
    'flex-shrink',
    REASON_CODES.REQUIRES_FLEX_ITEM,
    'a flex item',
    isFlexItem
  ),
  createOutOfFlowAwareItemRule(
    'flex-basis',
    REASON_CODES.REQUIRES_FLEX_ITEM,
    'a flex item',
    isFlexItem
  ),
  // `flex` shorthand: flex-grow/flex-shrink/flex-basis in one declaration.
  createOutOfFlowAwareItemRule(
    'flex',
    REASON_CODES.REQUIRES_FLEX_ITEM,
    'a flex item',
    isFlexItem
  ),
];
