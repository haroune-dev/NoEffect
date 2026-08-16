/**
 * Final-PR7 — transform / visual-effect rules (`transform-box`,
 * `transform-origin`, `backface-visibility`, `backdrop-filter`).
 *
 *   - `transform-box` / `transform-origin` / `backface-visibility` only
 *     take effect when a transform is actually applied (`transform: none`
 *     → no effect), and they never apply to non-transformable inline
 *     elements (`display: inline`, not a replaced element).
 *   - `backdrop-filter` blurs the backdrop behind the element's box: it
 *     is provably inactive only when the element generates no box at all
 *     (`display: contents`) — there is no backdrop to filter.
 */
import { InactiveRule } from '../../inactiveRule';
import { MatchedCssDeclaration } from '../../../engine/inactivePropertyEngine';
import { LayoutContext } from '../../../engine/layoutContext';
import { REASON_CODES } from '../../reasonCode';
import { createBoxSuppressedRule, inactiveResult, isPossiblyReplacedElement } from '../shared';

function createTransformRule(propertyName: string): InactiveRule {
  return {
    propertyName,
    inspect(layout: LayoutContext, _declaration: MatchedCssDeclaration) {
      if (!layout.display) {
        return undefined;
      }
      // Most specific: no transform is applied at all.
      const transform = layout.getComputedStyle('transform');
      if (transform !== undefined && transform === 'none') {
        return inactiveResult(
          propertyName,
          REASON_CODES.REQUIRES_TRANSFORM,
          `${propertyName} has no effect because no transform is applied (transform: none).`
        );
      }
      // Non-transformable inline elements: display: inline, non-replaced.
      if (layout.display === 'inline') {
        if (!layout.nodeName) {
          return undefined;
        }
        if (!isPossiblyReplacedElement(layout.nodeName)) {
          return inactiveResult(
            propertyName,
            REASON_CODES.REQUIRES_TRANSFORMABLE_ELEMENT,
            `${propertyName} has no effect because this inline element is not transformable.`
          );
        }
      }
      return undefined;
    },
  };
}

export const transformRules: readonly InactiveRule[] = [
  createTransformRule('transform-box'),
  createTransformRule('transform-origin'),
  createTransformRule('backface-visibility'),
];

/**
 * `backdrop-filter` is provably inactive only on `display: contents`
 * (no box → no backdrop). On any real box (including plain blocks) the
 * browser genuinely filters the backdrop, so it stays active.
 */
export const backdropFilterRule: InactiveRule = createBoxSuppressedRule('backdrop-filter');
