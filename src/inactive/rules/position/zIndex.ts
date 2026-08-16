/**
 * PR6 Phase 3 — the `z-index` rule.
 *
 * `z-index` participates in stacking only when the element is positioned,
 * is a flex/grid item, or is the document root. Anything else cannot be
 * judged safely and stays active (false negatives preferred).
 *
 * Ambiguity guards:
 *   - unknown position data → no decision;
 *   - a parent display of 'none' means the element may be the document
 *     root, where `z-index` is meaningful → no decision. This does NOT
 *     apply to the synthetic parent of the standalone CSS-file flow: the
 *     analysis wrapper provably places the element on a real (non-root)
 *     node, so the root ambiguity is impossible and the rule can decide.
 */
import { MatchedCssDeclaration } from '../../../engine/inactivePropertyEngine';
import { LayoutContext, NO_PARENT_DISPLAY } from '../../../engine/layoutContext';
import { InactiveResult, InactiveRule } from '../../inactiveRule';
import { REASON_CODES } from '../../reasonCode';
import { boxSuppressedReasonText, inactiveResult, isBoxSuppressed } from '../shared';

const REASON_TEXT =
  'z-index has no effect because this element is not positioned and is not a flex or grid item.';

export const zIndexRule: InactiveRule = {
  propertyName: 'z-index',
  inspect(layout: LayoutContext, _declaration: MatchedCssDeclaration): InactiveResult | undefined {
    if (!layout.display) {
      return undefined;
    }
    if (isBoxSuppressed(layout)) {
      return inactiveResult(
        'z-index',
        REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX,
        boxSuppressedReasonText('z-index')
      );
    }
    // Missing position data → cannot prove inactivity.
    if (!layout.position) {
      return undefined;
    }
    if (layout.isPositioned || layout.isFlexItem || layout.isGridItem) {
      return undefined;
    }
    // 'none' means the parent is unknown or the element is the document
    // root — the root element's z-index is meaningful, so do not flag.
    // A SYNTHETIC wrapper parent (standalone CSS-file flow) provably
    // cannot be the document root, so the ambiguity does not exist there.
    if (
      !layout.parentIsSynthetic &&
      (!layout.parentDisplay || layout.parentDisplay === NO_PARENT_DISPLAY)
    ) {
      return undefined;
    }
    return inactiveResult('z-index', REASON_CODES.REQUIRES_POSITIONED_OR_FLEX_GRID_ITEM, REASON_TEXT);
  },
};
