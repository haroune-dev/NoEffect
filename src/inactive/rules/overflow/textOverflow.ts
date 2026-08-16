/**
 * Advanced-context (Level 2) — composite text-truncation rule.
 *
 * `text-overflow: ellipsis` only takes effect when BOTH supporting
 * prerequisites are present at the same time:
 *
 *   1. the effective overflow is not `visible` on the inline axis
 *      (`hidden` / `scroll` / `auto` / `clip`) so the box actually clips,
 *   2. `white-space` prevents wrapping (`nowrap`), so the content really
 *      overflows a single line.
 *
 * The rule flags `text-overflow: ellipsis` as INACTIVE when EITHER
 * prerequisite is provably missing, and stays conservative: if a
 * condition cannot be proven from the computed styles (missing value) no
 * decision is made — false negatives are preferred.
 */
import { InactiveRule } from '../../inactiveRule';
import { MatchedCssDeclaration } from '../../../engine/inactivePropertyEngine';
import { LayoutContext } from '../../../engine/layoutContext';
import { REASON_CODES } from '../../reasonCode';
import {
  inactiveResult,
  isProvablyVisibleOverflow,
  isProvablyWrappingWhiteSpace,
} from '../shared';

export const textOverflowRule: InactiveRule = {
  propertyName: 'text-overflow',
  inspect(layout: LayoutContext, declaration: MatchedCssDeclaration) {
    if (!layout.display) {
      return undefined;
    }
    // The composite rule only reasons about the ellipsis truncation case;
    // any other value is outside its scope.
    const value = declaration.propertyValue.trim().toLowerCase();
    if (value !== 'ellipsis') {
      return undefined;
    }

    if (isProvablyVisibleOverflow(layout)) {
      return inactiveResult(
        'text-overflow',
        REASON_CODES.REQUIRES_TRUNCATION_PRECONDITIONS,
        'text-overflow: ellipsis has no effect because truncation requires overflow ' +
          'to be non-visible (computed overflow is visible).'
      );
    }
    if (isProvablyWrappingWhiteSpace(layout)) {
      return inactiveResult(
        'text-overflow',
        REASON_CODES.REQUIRES_TRUNCATION_PRECONDITIONS,
        'text-overflow: ellipsis has no effect because truncation requires ' +
          'white-space: nowrap (the computed white-space allows wrapping).'
      );
    }
    return undefined;
  },
};
