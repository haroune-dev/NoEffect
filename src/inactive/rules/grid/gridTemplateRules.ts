/**
 * PR7 — grid container template rules (reference GridContainerValidator).
 *
 * The `grid` shorthand and the `grid-template-*`/`grid-auto-*` families
 * configure the grid tracks themselves, so the element must establish a
 * grid (or experimental grid-lanes) formatting context. Unlike the gap
 * family they do NOT apply to flex containers.
 */
import { InactiveRule } from '../../inactiveRule';
import { REASON_CODES } from '../../reasonCode';
import { createContainerRequirementRule, isGridOrGridLanesContainer } from '../shared';

const GRID_TEMPLATE_PROPERTIES = [
  'grid',
  'grid-auto-columns',
  'grid-auto-flow',
  'grid-auto-rows',
  'grid-template',
  'grid-template-areas',
  'grid-template-columns',
  'grid-template-rows',
];

export const gridTemplateRules: readonly InactiveRule[] = GRID_TEMPLATE_PROPERTIES.map(
  (propertyName) =>
    createContainerRequirementRule(
      propertyName,
      REASON_CODES.REQUIRES_GRID_CONTAINER,
      'a grid container',
      isGridOrGridLanesContainer
    )
);
