/**
 * PR7 — flex-only container rules (reference FlexContainerValidator).
 *
 * `flex-direction`, `flex-flow` and `flex-wrap` configure the flex
 * container itself, so they are inactive unless the element establishes a
 * flex formatting context. Unlike the shared alignment properties they do
 * NOT apply to grid containers.
 */
import { InactiveRule } from '../../inactiveRule';
import { REASON_CODES } from '../../reasonCode';
import { createContainerRequirementRule, isFlexContainer } from '../shared';

export const flexOnlyContainerRules: readonly InactiveRule[] = [
  createContainerRequirementRule(
    'flex-direction',
    REASON_CODES.REQUIRES_FLEX_CONTAINER,
    'a flex container',
    isFlexContainer
  ),
  createContainerRequirementRule(
    'flex-flow',
    REASON_CODES.REQUIRES_FLEX_CONTAINER,
    'a flex container',
    isFlexContainer
  ),
  createContainerRequirementRule(
    'flex-wrap',
    REASON_CODES.REQUIRES_FLEX_CONTAINER,
    'a flex container',
    isFlexContainer
  ),
];
