/**
 * PR6 Phase 3 / Final-PR7 — `object-fit` and `object-position` rules.
 *
 * Both properties describe how a replaced element's content is fitted
 * into its box, so they ONLY apply to replaced elements (`<img>`,
 * `<video>`, `<canvas>`, `<svg>`, `<iframe>`, `<embed>`, `<object>`,
 * `<audio>` and image inputs). On any other element (a plain `<div>`,
 * `<span>`, `<p>`, ...) the used value is ignored.
 *
 * Replaced-ness is observable through the node name captured by the
 * LayoutContextBuilder (no extra CDP round trip). The node name IS the
 * operative element type: the real document tag in the HTML flow, the
 * wrapper-emitted tag in the CSS-file flow (tag-naming selectors like
 * `img.x` produce a real `<img>`; bare class/id selectors fabricate a
 * `<div>`). A FABRICATED type is not a document fact — the element behind
 * `.x` could be an `<img>` — so the rule abstains on fabricated types
 * (see {@link LayoutContext.typeIsSynthetic}) instead of flagging them.
 * A real `<div>` (and an explicitly tagged `div.x` in the CSS flow) is
 * provably non-replaced and is dimmed exactly like any other div.
 * Conditions, in order:
 *
 *   1. `display: contents` — no box at all, nothing to fit (most specific);
 *   2. the element type is a fabricated wrapper stand-in — cannot prove
 *      replaced-ness (no decision);
 *   3. the node name is unknown — cannot prove replaced-ness (no decision);
 *   4. the node is a (possibly) replaced element — active;
 *   5. everything else — inactive (`REQUIRES_REPLACED_ELEMENT`).
 */
import { InactiveRule } from '../../inactiveRule';
import { MatchedCssDeclaration } from '../../../engine/inactivePropertyEngine';
import { LayoutContext } from '../../../engine/layoutContext';
import { REASON_CODES } from '../../reasonCode';
import { inactiveResult, isBoxSuppressed, isPossiblyReplacedElement, boxSuppressedReasonText } from '../shared';

function createReplacedElementRule(propertyName: string): InactiveRule {
  return {
    propertyName,
    inspect(layout: LayoutContext, _declaration: MatchedCssDeclaration) {
      if (!layout.display) {
        return undefined;
      }
      if (isBoxSuppressed(layout)) {
        return inactiveResult(
          propertyName,
          REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX,
          boxSuppressedReasonText(propertyName)
        );
      }
      // The element type is a fabricated wrapper stand-in (bare class/id in
      // the CSS-file flow), not a fact from the user's document — the real
      // element could be replaced, so there is no basis to flag.
      if (layout.typeIsSynthetic) {
        return undefined;
      }
      if (!layout.nodeName) {
        return undefined;
      }
      if (isPossiblyReplacedElement(layout.nodeName)) {
        return undefined;
      }
      return inactiveResult(
        propertyName,
        REASON_CODES.REQUIRES_REPLACED_ELEMENT,
        `${propertyName} has no effect because this element is not a replaced element ` +
          `(<img>, <video>, <canvas>, <svg>, <iframe>, <embed>, <object>, <audio> or an image input).`
      );
    },
  };
}

export const objectFitRules: readonly InactiveRule[] = [
  createReplacedElementRule('object-fit'),
  createReplacedElementRule('object-position'),
];
