/**
 * PR6 Phase 2 — grid container rules.
 *
 * `justify-items` is grid-only (the flexbox spec has no inline-axis item
 * alignment). PR7 reworked the gap family to match the reference
 * MulticolFlexGridValidator: `gap`/`row-gap`/`column-gap` (and their
 * deprecated `grid-gap` aliases) also apply to multicol containers and to
 * grid-lanes containers, so those share a dedicated reason code.
 */
import { InactiveRule } from '../../inactiveRule';
import { REASON_CODES } from '../../reasonCode';
import {
  createContainerRequirementRule,
  isFlexOrGridOrMulticolContainer,
  isGridContainer,
} from '../shared';

const GAP_PROPERTIES = ['gap', 'row-gap', 'column-gap', 'grid-gap', 'grid-column-gap', 'grid-row-gap'];

const gapRules: readonly InactiveRule[] = GAP_PROPERTIES.map((propertyName) =>
  createContainerRequirementRule(
    propertyName,
    REASON_CODES.REQUIRES_FLEX_GRID_OR_MULTICOL_CONTAINER,
    'a flex, grid or multicol container',
    isFlexOrGridOrMulticolContainer
  )
);

export const gridContainerRules: readonly InactiveRule[] = [
  createContainerRequirementRule(
    'justify-items',
    REASON_CODES.REQUIRES_GRID_CONTAINER,
    'a grid container',
    isGridContainer
  ),
  ...gapRules,
];
