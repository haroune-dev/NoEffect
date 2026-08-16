/**
 * Analysis-page construction for analyzing the active editor's file.
 *
 * The CDP pipeline inspects a DOM element per selector. For a CSS file there
 * is no real page, so a minimal wrapper page is generated in memory that:
 *   - links the analyzed stylesheet (served from disk), and
 *   - contains one element structure per queryable rule selector.
 *
 * Pure module (no `vscode`, no browser): the selector filtering and the
 * wrapper HTML are unit-testable on their own.
 */

import { CssRule } from '../parser/cssAst';

/** Characters that make a selector impossible to match with a static wrapper. */
const PART_COMBINATOR = /[\s>]+/;

/**
 * Human-readable reason a whole rule selector cannot be queried against a
 * static wrapper, or null when it can be. Mirrors the old `isQueryablePart`
 * checks exactly so the classifier and the filter never drift.
 */
export function unqueryableReason(selector: string): string | null {
  if (!selector) {
    return 'empty selector';
  }
  if (selector.startsWith('@')) {
    return 'at-rule prelude';
  }
  if (selector.startsWith('>') || selector.startsWith('~') || selector.startsWith('+')) {
    return 'leading combinator has no anchored ancestor';
  }
  const parts = selector.split(PART_COMBINATOR).filter((p) => p.length > 0);
  if (parts.length === 0) {
    return 'no selector parts';
  }
  if (parts[0] === '*') {
    return 'bare universal selector has no anchored ancestor';
  }
  for (const part of parts) {
    // The universal selector is queryable as an ANCHORED part (`X > *`,
    // `X *` — wrapped as a plain div); a bare/leading `*` was already
    // rejected above.
    if (part === '*') {
      continue;
    }
    if (part.includes(':')) {
      return part.includes('::')
        ? `pseudo-element '${part}' cannot be queried directly`
        : `pseudo-class '${part}' cannot be reproduced statically`;
    }
    if (part.includes('+') || part.includes('~')) {
      return `sibling combinator in '${part}' cannot be reproduced statically`;
    }
    if (part.includes('[')) {
      return `attribute selector '${part}' cannot be reproduced statically`;
    }
    if (!/^(?:\.|#)?[A-Za-z]/.test(part)) {
      return `unknown selector syntax '${part}'`;
    }
  }
  return null;
}

/** Whether a whole rule selector can be queried against the wrapper page. */
function isQueryableSelector(selector: string): boolean {
  return unqueryableReason(selector) === null;
}

/** A dropped selector part with the deterministic reason it was dropped. */
export interface DroppedSelector {
  selector: string;
  reason: string;
}

/**
 * Extract the queryable selectors AND report every part that was dropped,
 * with its deterministic reason. The drop report feeds the classified
 * `SELECTOR_NOT_QUERYABLE` / `SELECTORS_UNQUERYABLE` warnings.
 */
export function extractQueryableSelectorsDetailed(
  rules: CssRule[]
): { queryable: string[]; dropped: DroppedSelector[] } {
  const queryable = new Set<string>();
  const dropped: DroppedSelector[] = [];

  for (const rule of rules) {
    for (const part of rule.selector.split(',')) {
      const selector = part.trim();
      const reason = unqueryableReason(selector);
      if (reason === null) {
        queryable.add(selector);
        continue;
      }
      // A pseudo-ELEMENT selector is dropped as a DOM node, but its origin
      // (`.a` of `.a::before`) stays queryable — only report the origin
      // when THAT is unqueryable too.
      const origin = originOfPseudoElementSelector(selector);
      const originReason = origin ? unqueryableReason(origin) : null;
      if (originReason === null && origin) {
        queryable.add(origin);
        continue;
      }
      dropped.push({ selector, reason: originReason ?? reason });
    }
  }

  return { queryable: Array.from(queryable), dropped };
}

/**
 * Extract the queryable selectors from parsed rules.
 *
 * Comma-separated selector lists are split into individual selectors, and
 * selectors that cannot be matched by a static wrapper (pseudo-classes,
 * sibling combinators, attribute selectors, at-rule preludes, bare/leading
 * combinators or universal selectors) are dropped. An anchored universal
 * part (`X > *`, `X *` — final PR7, needed for child-of-`*` rules like
 * `.non-grid > *`) IS kept and wrapped as a plain div.
 *
 * PR Level 3: a pseudo-ELEMENT selector (`.a::before`, `#b::first-letter`)
 * cannot be queried directly — the pseudo is never a DOM node. Instead its
 * ORIGIN selector (`.a`, `#b`) is emitted, because pseudo declarations
 * flow through the origin element's `pseudoElements` section of the CDP
 * matched styles. Selectors that still contain a pseudo-CLASS after the
 * strip (`.a:hover::before`) stay dropped — the static wrapper cannot
 * reproduce the hover state.
 *
 * Order is preserved, duplicates are removed.
 */
export function extractQueryableSelectors(rules: CssRule[]): string[] {
  return extractQueryableSelectorsDetailed(rules).queryable;
}

/**
 * The origin a pseudo-element selector attaches to: everything before the
 * first `::`. Returns '' when the selector has no pseudo-element.
 */
function originOfPseudoElementSelector(selector: string): string {
  const index = selector.indexOf('::');
  if (index === -1) {
    return '';
  }
  return selector.slice(0, index).trim();
}

/**
 * Whether a selector has NO ancestor structure — a single compound part
 * (e.g. `.flex-item`, `#a.b`, `div.x`). The wrapper page places such
 * selectors as top-level elements directly under `<body>`, so their parent
 * context is a synthetic artifact of the wrapper, not the element's real
 * document parent. Selectors with combinators (`.non-flex > span`,
 * `.a .b`) nest their elements, so the innermost element's parent IS a
 * real wrapper element with trustworthy computed styles.
 */
export function isStandaloneSelector(selector: string): boolean {
  const parts = selector.split(PART_COMBINATOR).filter((p) => p.length > 0);
  return parts.length === 1;
}

/** Build one element from a simple-selector part (`.a#b` / `div.a` / `#id`). */
function elementForPart(part: string): string {
  const idMatch = part.match(/#([A-Za-z0-9_-]+)/);
  const classes = part.match(/\.([A-Za-z0-9_-]+)/g) ?? [];
  const tagMatch = part.match(/^([A-Za-z][A-Za-z0-9-]*)/);

  const tag = tagMatch && !part.startsWith('.') && !part.startsWith('#')
    ? tagMatch[1]
    : 'div';
  const attrs: string[] = [];
  if (idMatch) {
    attrs.push(`id="${idMatch[1]}"`);
  }
  if (classes.length > 0) {
    attrs.push(`class="${classes.map((c) => c.slice(1)).join(' ')}"`);
  }
  return `<${tag}${attrs.length > 0 ? ' ' + attrs.join(' ') : ''}></${tag}>`;
}

/**
 * Whether a selector's INNERMOST compound part (the element the selector
 * actually matches) explicitly names a tag — e.g. `img.hero`, `video.x`,
 * `a` — as opposed to a bare class/id/universal part (`.hero`, `#x`,
 * `*`). Mirrors `elementForPart`: only a part that does not start with
 * `.`, `#` or `*` and begins with a letter gets a real tag; anything else
 * is fabricated as a `<div>`.
 *
 * The wrapper's fabricated `<div>` is a stand-in for an UNKNOWN element of
 * the user's document, so its type must not be treated as a provable
 * fact. Type-dependent rules use this to abstain on fabricated types while
 * still trusting explicitly-tagged elements.
 */
export function hasExplicitTag(selector: string): boolean {
  const parts = selector.split(PART_COMBINATOR).filter((p) => p.length > 0);
  if (parts.length === 0) {
    return false;
  }
  const innermost = parts[parts.length - 1];
  return (
    !innermost.startsWith('.') &&
    !innermost.startsWith('#') &&
    !innermost.startsWith('*') &&
    /^[A-Za-z][A-Za-z0-9-]*/.test(innermost)
  );
}

/**
 * Build the wrapper page for a CSS file: a minimal document that links the
 * stylesheet and contains an element structure for every queryable selector
 * (nested for descendant/child combinators). Tag-naming selectors
 * (`img.x`) produce their real element; bare class/id selectors default to
 * a `<div>` — the operative element type of the analysis page.
 */
export function buildWrapperPage(selectors: string[], cssHref: string): string {
  const bodies = selectors.map((selector) => {
    // Innermost compound part first: each iteration wraps the accumulated
    // structure, so `.a .b` produces <div class="a"><div class="b">...</div></div>.
    const parts = selector.split(PART_COMBINATOR).filter((p) => p.length > 0).reverse();
    let html = '';
    for (const part of parts) {
      html = elementForPart(part).replace('></', `>${html}</`);
    }
    return html;
  });

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    `<link rel="stylesheet" href="${cssHref}">`,
    '<title>NoEffect Analysis Page</title>',
    '</head>',
    '<body>',
    ...bodies,
    '</body>',
    '</html>',
  ].join('\n');
}
