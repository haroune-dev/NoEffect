/**
 * Token-level containment scan (Level 11 evidence expansion).
 *
 * A pure superset check: "may this document contain an element matched by
 * any of these queryable selectors?" For every compound part of every
 * selector the class/id/tag tokens are extracted, and a part contributes
 * only when every token appears in the document at word boundaries.
 * The check is CONSERVATIVE (may over-report, never under-reports): any
 * element a real pass could match is always signaled, and the worst a
 * false positive costs is one extra narrow pass whose verdicts still come
 * from real DOM evidence.
 *
 * Pure module (no `vscode`, no browser, no caches) — unit-testable on its
 * own; the cached wrapper lives in `companionSelection.ts`.
 */

const CLASS_OR_ID_TOKEN = /[.#]([A-Za-z][A-Za-z0-9_-]*)/g;
const TAG_TOKEN = /^[A-Za-z][A-Za-z0-9_-]*/;
const PART_SPLIT = /[\s>]+/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The tokens of one selector: the class/id names and the tag name of every
 * compound part (`*` and empty parts contribute nothing). A part like
 * `a.nav-link` yields its tag AND its class — the pass needs both on one
 * element, and requiring both tokens keeps the superset check tight.
 */
export function selectorTokensFor(selector: string): string[] {
  const tokens: string[] = [];
  for (const part of selector.split(PART_SPLIT)) {
    if (!part || part === '*') {
      continue;
    }
    let matched = false;
    for (const token of part.matchAll(CLASS_OR_ID_TOKEN)) {
      tokens.push(token[1]);
      matched = true;
    }
    const tag = part.match(TAG_TOKEN);
    if (tag) {
      tokens.push(tag[0]);
      matched = true;
    }
    if (!matched) {
      tokens.push(part.replace(/^[.#]/, ''));
    }
  }
  return tokens;
}

/**
 * Word-boundary presence of a single token, mirrored so every analysis
 * run and every freshness probe applies the exact same superset rule.
 */
const boundaryCache = new Map<string, RegExp>();

function htmlHasToken(html: string, token: string): boolean {
  let boundary = boundaryCache.get(token);
  if (!boundary) {
    boundary = new RegExp(`\\b${escapeRegExp(token)}\\b`);
    boundaryCache.set(token, boundary);
  }
  return boundary.test(html);
}

/**
 * The conservative superset check: true when the document contains the
 * tokens of at least one selector. Every real element match implies a
 * hit, by construction; a hit may still turn out to match nothing (the
 * tokens are only a superset of the document state the pass needs).
 */
export function htmlContainsAnySelector(html: string, selectors: readonly string[]): boolean {
  for (const selector of selectors) {
    const tokens = selectorTokensFor(selector);
    if (tokens.length === 0) {
      continue;
    }
    if (tokens.every((token) => htmlHasToken(html, token))) {
      return true;
    }
  }
  return false;
}

/** Tokens that can be probed at a word boundary in document text. */
const WORD_TOKEN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Evidence gate for the deployment-basename companion fallback (see
 * `matchRoot`): true when the document shows text evidence of using the
 * stylesheet — the word tokens of at least one selector are all present.
 *
 * Unlike {@link htmlContainsAnySelector} (which deliberately over-expands
 * the evidence tail), this gate VETOES a pairing, so it must never reject
 * on selectors it cannot judge: a selector with no word-boundary-probable
 * token (e.g. `*`, `:root`, bare attribute selectors) cannot be disproven
 * by a text scan and therefore never vetoes — the pairing is allowed.
 * Every queryable selector the analysis produces carries at least one
 * word token in practice, so unrelated pages (deployment hrefs pointing
 * nowhere + a coincidental basename) are rejected while genuine
 * deployment pages — which use the stylesheet's classes — always pass.
 */
export function htmlContainsStylesheetEvidence(html: string, selectors: readonly string[]): boolean {
  for (const selector of selectors) {
    const probed = selectorTokensFor(selector).filter((token) => WORD_TOKEN.test(token));
    if (probed.length === 0) {
      return true;
    }
    if (probed.every((token) => htmlHasToken(html, token))) {
      return true;
    }
  }
  return false;
}