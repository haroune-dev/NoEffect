/**
 * PR7 — padding applicability rules (reference PaddingValidator).
 *
 * The padding family is a single rule set with two provably-inactive
 * contexts:
 *
 *   1. Table-internal boxes: row groups, rows and column boxes ignore
 *      `padding` (and all four paddings). The reference flags ALL five
 *      padding properties on these displays — there is no padding-bottom
 *      exception.
 *   2. Vertical paddings on a non-replaced inline box: an inline box's
 *      contribution to the line box height comes from `line-height` alone,
 *      so `padding-top`/`padding-bottom` never move the line — the values
 *      only paint the background/border extent beyond the line box. The
 *      horizontal paddings DO take effect (they widen the inline box and
 *      push the line), and so does the `padding` shorthand (it also sets
 *      the effective horizontal paddings) — only the two vertical longhands
 *      are suppressed, mirroring the vertical-margin suppression in
 *      `inlineSuppressionRules`. Replaced inline elements honor vertical
 *      padding, hence the `isInlineNonReplacedElement` eligibility check.
 */
import { InactiveRule } from '../../inactiveRule';
import { MatchedCssDeclaration } from '../../../engine/inactivePropertyEngine';
import { LayoutContext } from '../../../engine/layoutContext';
import { REASON_CODES } from '../../reasonCode';
import {
  boxSuppressedReasonText,
  inactiveResult,
  isBoxSuppressed,
  isInlineNonReplacedElement,
} from '../shared';

const TABLE_INTERNAL_DISPLAYS: ReadonlySet<string> = new Set([
  'table-row-group',
  'table-header-group',
  'table-footer-group',
  'table-row',
  'table-column-group',
  'table-column',
]);

const INLINE_SUPPRESSED_VERTICAL_PADDINGS: ReadonlySet<string> = new Set([
  'padding-top',
  'padding-bottom',
]);

const PADDING_PROPERTIES = ['padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left'];

export const paddingRules: readonly InactiveRule[] = PADDING_PROPERTIES.map((propertyName) => ({
  propertyName,
  inspect(layout: LayoutContext, _declaration: MatchedCssDeclaration) {
    if (!layout.display) {
      return undefined;
    }
    // Final-PR7: display: contents generates no box — padding has nothing
    // to pad (most specific condition).
    if (isBoxSuppressed(layout)) {
      return inactiveResult(
        propertyName,
        REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX,
        boxSuppressedReasonText(propertyName)
      );
    }
    if (TABLE_INTERNAL_DISPLAYS.has(layout.display)) {
      return inactiveResult(
        propertyName,
        REASON_CODES.NOT_APPLICABLE_TO_TABLE_INTERNAL_BOX,
        `${propertyName} has no effect because padding does not apply to table-internal boxes ` +
          `(display: ${layout.display}).`
      );
    }
    if (
      INLINE_SUPPRESSED_VERTICAL_PADDINGS.has(propertyName) &&
      isInlineNonReplacedElement(layout) === true
    ) {
      return inactiveResult(
        propertyName,
        REASON_CODES.NOT_APPLICABLE_TO_INLINE_BOX,
        `${propertyName} has no effect because this element is a non-replaced ` +
          `inline element (display: inline).`
      );
    }
    return undefined;
  },
}));
