/**
 * Final-PR7 — scroll-context rules (`resize`, `overflow-clip-margin`,
 * `scroll-snap-type`, `scroll-snap-align`, `scroll-margin`).
 *
 * PR Level 3 adds `scrollbar-gutter` and `overscroll-behavior`: both only
 * take effect on scroll containers, so on a box whose effective overflow
 * is `visible`/`clip` (both axes) they are a no-op. Chromium never resets
 * their COMPUTED values (a probe on `overflow: visible` still reports
 * `scrollbar-gutter: stable` and `overscroll-behavior-x: contain`), so the
 * only reliable signal is the scroll-container check — the same condition
 * the existing rules already use, via the effective overflow longhands
 * that CDP reports pre-resolved (visible+auto → auto/auto, clip+scroll →
 * hidden/scroll, ...).
 *
 *   - `resize` needs a scrollable box (computed overflow hidden/auto/
 *     scroll); with `overflow: visible` or `clip` it is a no-op.
 *   - `overflow-clip-margin` only takes effect with `overflow: clip` — on
 *     every other known overflow it is a no-op.
 *   - `scroll-snap-type` only makes the element a scroll-snap container
 *     when the element itself is a scroll container.
 *   - `scroll-snap-align` / `scroll-margin` define the snap area of an
 *     element inside its nearest scroll-snap container ancestor — without
 *     any such ancestor (resolved by the LayoutContextBuilder walk) they
 *     have no effect.
 *
 * Every check is conservative: when the relevant computed value is
 * missing (CDP did not provide it) no decision is made.
 */
import { InactiveRule } from '../../inactiveRule';
import { MatchedCssDeclaration } from '../../../engine/inactivePropertyEngine';
import { LayoutContext } from '../../../engine/layoutContext';
import { REASON_CODES } from '../../reasonCode';
import { inactiveResult } from '../shared';

/** Overflow values that provably produce NO scroll container. */
const NON_SCROLLABLE_OVERFLOWS: ReadonlySet<string> = new Set(['visible', 'clip']);

/**
 * Whether the element's effective overflow is provably non-scrollable:
 * the computed `overflow` shorthand is visible/clip, or both longhands
 * are. Missing values → not provable → false.
 */
function isProvablyNonScrollable(layout: LayoutContext): boolean {
  const overflow = layout.getComputedStyle('overflow');
  if (overflow !== undefined) {
    return NON_SCROLLABLE_OVERFLOWS.has(overflow);
  }
  const overflowX = layout.getComputedStyle('overflow-x');
  const overflowY = layout.getComputedStyle('overflow-y');
  if (overflowX === undefined || overflowY === undefined) {
    return false;
  }
  return NON_SCROLLABLE_OVERFLOWS.has(overflowX) && NON_SCROLLABLE_OVERFLOWS.has(overflowY);
}

/**
 * Whether the element's overflow is provably NOT fully `clip`: any known
 * longhand (or the shorthand) is something else. `overflow-clip-margin`
 * only takes effect when the used overflow is `clip` on both axes.
 */
function isProvablyNotClip(layout: LayoutContext): boolean {
  const overflow = layout.getComputedStyle('overflow');
  if (overflow !== undefined) {
    return overflow !== 'clip';
  }
  const overflowX = layout.getComputedStyle('overflow-x');
  const overflowY = layout.getComputedStyle('overflow-y');
  if (overflowX === undefined && overflowY === undefined) {
    return false;
  }
  return (
    (overflowX !== undefined && overflowX !== 'clip') ||
    (overflowY !== undefined && overflowY !== 'clip')
  );
}

function createRequiresScrollContainerRule(propertyName: string): InactiveRule {
  return {
    propertyName,
    inspect(layout: LayoutContext, _declaration: MatchedCssDeclaration) {
      if (!layout.display) {
        return undefined;
      }
      if (!isProvablyNonScrollable(layout)) {
        return undefined;
      }
      return inactiveResult(
        propertyName,
        REASON_CODES.REQUIRES_SCROLL_CONTAINER,
        `${propertyName} has no effect because this element is not a scroll container ` +
          `(computed overflow is visible or clip).`
      );
    },
  };
}

const overflowClipMarginRule: InactiveRule = {
  propertyName: 'overflow-clip-margin',
  inspect(layout: LayoutContext, _declaration: MatchedCssDeclaration) {
    if (!layout.display) {
      return undefined;
    }
    if (!isProvablyNotClip(layout)) {
      return undefined;
    }
    return inactiveResult(
      'overflow-clip-margin',
      REASON_CODES.REQUIRES_CLIP_OVERFLOW,
      'overflow-clip-margin has no effect because it only applies when the box is clipped ' +
        '(overflow: clip).'
    );
  },
};

function createRequiresSnapContainerRule(propertyName: string): InactiveRule {
  return {
    propertyName,
    inspect(layout: LayoutContext, _declaration: MatchedCssDeclaration) {
      if (!layout.display) {
        return undefined;
      }
      if (layout.hasScrollSnapAncestor === undefined) {
        return undefined;
      }
      if (layout.hasScrollSnapAncestor) {
        return undefined;
      }
      return inactiveResult(
        propertyName,
        REASON_CODES.REQUIRES_SCROLL_SNAP_CONTAINER,
        `${propertyName} has no effect because this element has no scroll-snap container ancestor.`
      );
    },
  };
}

export const scrollRules: readonly InactiveRule[] = [
  createRequiresScrollContainerRule('resize'),
  overflowClipMarginRule,
  createRequiresScrollContainerRule('scroll-snap-type'),
  createRequiresSnapContainerRule('scroll-snap-align'),
  createRequiresSnapContainerRule('scroll-margin'),
  // PR Level 3 — scroll-container-dependent properties: the scrollbar
  // gutter and the overscroll behavior only take effect when the element
  // is a scroll container.
  createRequiresScrollContainerRule('scrollbar-gutter'),
  createRequiresScrollContainerRule('overscroll-behavior'),
];
