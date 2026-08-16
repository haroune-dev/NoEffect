/**
 * PR6 Phase 3 — the `vertical-align` rule.
 *
 * `vertical-align` participates in inline formatting: it applies to
 * inline-level boxes (inline, inline-block, inline-flex, inline-grid,
 * inline-table, ruby family) and to table cells. On any block-level box
 * it has no effect.
 *
 * The active set is enumerated from the inline-level values of CSS
 * Display Level 3; anything outside it is provably not inline-level and
 * is flagged. `display: contents` (no box at all) uses the dedicated
 * box-suppressed code.
 *
 * Context hardening: `display: table-cell` alone is not enough — the cell
 * must sit inside a real table formatting context. When the `<table>`
 * wrapper is explicitly overridden to `display: block`, no table box
 * exists in the ancestor chain and the cell loses its native table-cell
 * formatting context, so `vertical-align` has no effect. The context
 * field `hasTableBoxAncestor` is resolved by the LayoutContextBuilder;
 * `undefined` (chain unresolved) yields no decision — conservative.
 */
import { MatchedCssDeclaration } from '../../../engine/inactivePropertyEngine';
import { LayoutContext } from '../../../engine/layoutContext';
import { InactiveResult, InactiveRule } from '../../inactiveRule';
import { REASON_CODES } from '../../reasonCode';
import { boxSuppressedReasonText, inactiveResult, isBoxSuppressed } from '../shared';

const REASON_TEXT =
  'vertical-align has no effect because this element is neither inline-level nor a table cell.';
const BROKEN_TABLE_REASON_TEXT =
  'vertical-align has no effect because this element is a table cell whose table ' +
  'formatting context is broken (no table box ancestor — the table wrapper ' +
  'may have been overridden to display: block).';

function isInlineLevel(display: string): boolean {
  return (
    display.startsWith('inline') ||
    display === 'table-cell' ||
    display.startsWith('ruby')
  );
}

export const verticalAlignRule: InactiveRule = {
  propertyName: 'vertical-align',
  inspect(layout: LayoutContext, _declaration: MatchedCssDeclaration): InactiveResult | undefined {
    if (!layout.display) {
      return undefined;
    }
    if (isBoxSuppressed(layout)) {
      return inactiveResult(
        'vertical-align',
        REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX,
        boxSuppressedReasonText('vertical-align')
      );
    }
    if (isInlineLevel(layout.display)) {
      // A table cell additionally needs a real table box in its ancestor
      // chain; an unresolved chain must never produce a flag.
      if (layout.display === 'table-cell') {
        if (layout.hasTableBoxAncestor === undefined) {
          return undefined;
        }
        if (!layout.hasTableBoxAncestor) {
          return inactiveResult(
            'vertical-align',
            REASON_CODES.BROKEN_TABLE_CONTEXT,
            BROKEN_TABLE_REASON_TEXT
          );
        }
      }
      return undefined;
    }
    return inactiveResult(
      'vertical-align',
      REASON_CODES.REQUIRES_INLINE_LEVEL_OR_TABLE_CELL,
      REASON_TEXT
    );
  },
};
