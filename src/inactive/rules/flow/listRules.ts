/**
 * Final-PR7 — list-marker rules (`list-style-type`, `list-style-position`,
 * `list-style-image`).
 *
 * The `list-style-*` properties decorate the marker box of a list item,
 * so they only apply to elements with `display: list-item`. On any other
 * display the marker box does not exist and the properties are inert.
 */
import { InactiveRule } from '../../inactiveRule';
import { REASON_CODES } from '../../reasonCode';
import { createContainerRequirementRule, isListItem } from '../shared';

export const listRules: readonly InactiveRule[] = [
  createContainerRequirementRule(
    'list-style-type',
    REASON_CODES.REQUIRES_LIST_ITEM,
    'a list item (display: list-item)',
    isListItem
  ),
  createContainerRequirementRule(
    'list-style-position',
    REASON_CODES.REQUIRES_LIST_ITEM,
    'a list item (display: list-item)',
    isListItem
  ),
  createContainerRequirementRule(
    'list-style-image',
    REASON_CODES.REQUIRES_LIST_ITEM,
    'a list item (display: list-item)',
    isListItem
  ),
];
