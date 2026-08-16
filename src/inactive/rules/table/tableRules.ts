/**
 * Final-PR7 — table-property rules (`border-spacing`, `empty-cells`,
 * `caption-side`).
 *
 * These properties only apply to elements participating in table layout:
 * the table boxes themselves, row/column groups, rows, columns, cells and
 * captions. On any other display (block, inline, flex, ...) they are
 * inert.
 */
import { InactiveRule } from '../../inactiveRule';
import { REASON_CODES } from '../../reasonCode';
import { createContainerRequirementRule, isTableElement } from '../shared';

export const tableRules: readonly InactiveRule[] = [
  createContainerRequirementRule(
    'border-spacing',
    REASON_CODES.REQUIRES_TABLE,
    'a table element',
    isTableElement
  ),
  createContainerRequirementRule(
    'empty-cells',
    REASON_CODES.REQUIRES_TABLE,
    'a table element',
    isTableElement
  ),
  createContainerRequirementRule(
    'caption-side',
    REASON_CODES.REQUIRES_TABLE,
    'a table element',
    isTableElement
  ),
];
