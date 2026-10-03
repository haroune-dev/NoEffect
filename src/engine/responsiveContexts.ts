/**
 * Responsive-context evaluation (media-query viewport coverage).
 *
 * A declaration must NOT be classified as globally ineffective merely
 * because it loses the cascade in the current viewport. Effectiveness is
 * a function of (CSS, DOM, viewport/media environment): a declaration that
 * is active in at least one valid responsive context must not be reported
 * as globally ineffective.
 *
 * This module is pure (no `vscode`, no browser, no filesystem). It answers
 * only ONE question: which bounded, deterministic set of viewport widths
 * covers the responsive ranges that can affect the page?
 *
 * The actual effectiveness under each viewport is ALWAYS determined by the
 * real Chromium/CDP evaluation (matched styles + cascade + computed
 * layout) — never by regex inference. The breakpoints extracted here only
 * select viewports; they never decide active/inactive.
 *
 * Scope (initial implementation):
 *   - viewport-width media features in `px`: `min-width`, `max-width`,
 *     `width` (including modern range syntax `width >= 768px`).
 *   - other media features (height, orientation, prefers-*, container
 *     queries, etc.) are NOT modeled — see the limitations note below.
 *   - `@container` queries are NEVER modeled: container size is a layout
 *     dimension orthogonal to viewport width, so any `@container` presence
 *     forces the conservative path via {@link hasUnmodeledMediaConditions}.
 */

import type { PassVerdict } from './verdictMerge';
import { isOverrideReasonCode } from '../inactive/reasonCode';
import { CssAstParser } from '../parser/cssAst';

export interface ResponsiveViewport {
  /** Viewport width in CSS px. */
  width: number;

  /** Viewport height in CSS px (fixed; width is the modeled dimension). */
  height: number;

  /** Human-readable label for logs/diagnostics (e.g. "<768px", "768px"). */
  label: string;
}

/**
 * Version of the responsive-context selection semantics. Bump when the
 * breakpoint extraction or viewport generation changes — cache keys that
 * include this version then differ by construction and stale single-viewport
 * evidence is never reused.
 */
export const RESPONSIVE_CONTEXT_VERSION = 1;

/** Fixed viewport height for all responsive contexts (width is modeled). */
export const RESPONSIVE_VIEWPORT_HEIGHT = 800;

/** Headless Chromium's default viewport width (preserved when non-responsive). */
export const DEFAULT_VIEWPORT_WIDTH = 800;

/** Headless Chromium's default viewport height. */
export const DEFAULT_VIEWPORT_HEIGHT = 600;

/** Hard bound on evaluated viewport contexts (deterministic, bounded). */
export const MAX_VIEWPORT_CONTEXTS = 7;

/**
 * Maximum distinct width breakpoints with exact (exhaustive) coverage.
 * The viewport set is `[B0-1, B0…Bn, Bn+1]` (distinct thresholds + 2
 * boundary representatives), so up to this many distinct thresholds are
 * covered with one representative per responsive interval and no sampling.
 */
export const MAX_EXACT_BREAKPOINTS = MAX_VIEWPORT_CONTEXTS - 2;

/** Absolute clamp for generated widths (CDP accepts any positive int). */
const MIN_VIEWPORT_WIDTH = 1;
const MAX_VIEWPORT_WIDTH = 8192;

/**
 * Extract viewport-width breakpoints (in px) from raw stylesheet texts.
 *
 * Only `@media` preludes are scanned, so ordinary `width: 768px`
 * declarations never produce breakpoints. Only `px` lengths are modeled;
 * `em`/`rem`/other units and non-width media features are ignored by
 * design (documented limitation).
 *
 * Handles:
 *   - `(min-width: 768px)`, `(max-width: 992px)`, `(width: 768px)`
 *   - modern range syntax: `(width >= 768px)`, `(768px <= width)`, etc.
 */
export function extractWidthBreakpoints(cssTexts: readonly string[]): number[] {
  const found = new Set<number>();
  for (const text of cssTexts) {
    if (!text || typeof text !== 'string') {
      continue;
    }
    // Scan each `@media` prelude (up to its opening `{`) — never the
    // rule bodies — so `width:` declarations cannot leak in.
    const mediaPrelude = /@media\b([^{]*)\{/gi;
    let preludeMatch: RegExpExecArray | null;
    while ((preludeMatch = mediaPrelude.exec(text)) !== null) {
      const prelude = preludeMatch[1] ?? '';
      // Classic: (min-width: 768px) / (max-width: 992px) / (width: 500px).
      const classic = /\(\s*(min-width|max-width|width)\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*(px)?\s*\)/gi;
      let m: RegExpExecArray | null;
      while ((m = classic.exec(prelude)) !== null) {
        const unit = (m[3] ?? 'px').toLowerCase();
        // Unitless zero is valid CSS (`min-width: 0`); other unitless
        // lengths are ignored conservatively.
        if (unit !== 'px' && !(m[2] === '0' && !m[3])) {
          continue;
        }
        const value = Math.round(Number(m[2]));
        if (Number.isFinite(value)) {
          found.add(clampWidth(value));
        }
      }
      // Range syntax: (width >= 768px), (width <= 992px), (768px <= width).
      const range = /\(\s*(?:width\s*(>=|<=|>|<|=)\s*([0-9]+(?:\.[0-9]+)?)\s*(px)?|([0-9]+(?:\.[0-9]+)?)\s*(px)?\s*(>=|<=|>|<)\s*width)\s*\)/gi;
      while ((m = range.exec(prelude)) !== null) {
        const raw = m[2] ?? m[4];
        const unit = (m[3] ?? m[5] ?? 'px').toLowerCase();
        if (raw === undefined) {
          continue;
        }
        if (unit !== 'px' && !(raw === '0' && !(m[3] ?? m[5]))) {
          continue;
        }
        const value = Math.round(Number(raw));
        if (Number.isFinite(value)) {
          found.add(clampWidth(value));
        }
      }
    }
  }
  return [...found].sort((a, b) => a - b);
}

function clampWidth(width: number): number {
  if (width < MIN_VIEWPORT_WIDTH) {
    return MIN_VIEWPORT_WIDTH;
  }
  if (width > MAX_VIEWPORT_WIDTH) {
    return MAX_VIEWPORT_WIDTH;
  }
  return width;
}

/**
 * Generate the bounded, deterministic set of representative viewport widths
 * covering the responsive ranges induced by `breakpoints`.
 *
 * Partition argument (integer px): every width condition (`min-width: T`
 * true iff w >= T; `max-width: T` true iff w <= T) flips at the T|T+1
 * boundary, so the sorted thresholds partition the width line into
 * intervals (-inf,B0], (B0,B1], ..., (Bn,inf) — equivalently, before-split
 * intervals (-inf,B0-1], [B0,B1-1], ..., [Bn,inf). The set
 * `[B0-1, B0, B1, ..., Bn, Bn+1]` hits every interval under BOTH splits,
 * so one representative per interval is evaluated regardless of whether
 * the author used min-width, max-width, exact width, ranges, or overlaps.
 *
 * Examples:
 *   [768, 992] → [767, 768, 992, 993] (below 768 / 768-991 / 992+)
 *   [600]      → [599, 600, 601]      (at-or-below / above)
 *
 * When no breakpoints exist, a single default viewport is returned and the
 * caller must NOT apply any CDP override (preserves the exact pre-existing
 * single-viewport behavior for non-responsive CSS).
 */
export function viewportWidthsForBreakpoints(breakpoints: readonly number[]): number[] {
  const widths = candidateWidthsForBreakpoints(breakpoints);
  if (widths.length > MAX_VIEWPORT_CONTEXTS) {
    return downsampleWidths(widths);
  }
  return widths;
}

/**
 * Candidate viewport widths BEFORE bounding (one per responsive interval).
 * Exported for coverage reasoning: exact coverage holds iff this set fits
 * within {@link MAX_VIEWPORT_CONTEXTS}.
 */
export function candidateWidthsForBreakpoints(breakpoints: readonly number[]): number[] {
  const sorted = [...new Set(breakpoints)].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return [DEFAULT_VIEWPORT_WIDTH];
  }
  const candidates = new Set<number>();
  candidates.add(clampWidth(sorted[0] - 1));
  for (const breakpoint of sorted) {
    candidates.add(clampWidth(breakpoint));
  }
  candidates.add(clampWidth(sorted[sorted.length - 1] + 1));
  return [...candidates].sort((a, b) => a - b);
}

/**
 * True when the breakpoint set is covered EXHAUSTIVELY (one representative
 * per responsive interval, no sampling). Typical stylesheets (at most
 * {@link MAX_EXACT_BREAKPOINTS} distinct width thresholds) are always
 * exact; larger sets are downsampled (see {@link downsampleWidths}) and
 * the production evaluator treats the resulting incomplete coverage as
 * incomplete evidence (globally-inactive verdicts suppressed — incomplete
 * evidence must never dim).
 */
export function isViewportCoverageComplete(breakpoints: readonly number[]): boolean {
  return candidateWidthsForBreakpoints(breakpoints).length <= MAX_VIEWPORT_CONTEXTS;
}

/** Coverage completeness directly from stylesheet texts. */
export function isViewportCoverageCompleteForCss(cssTexts: readonly string[]): boolean {
  return isViewportCoverageComplete(extractWidthBreakpoints(cssTexts));
}

function downsampleWidths(widths: number[]): number[] {
  // Keep the extremes (below-first and above-last are the most informative)
  // and sample the middle evenly. Deterministic: sorted input, fixed stride.
  if (widths.length <= MAX_VIEWPORT_CONTEXTS) {
    return widths;
  }
  const first = widths[0];
  const last = widths[widths.length - 1];
  const middle = widths.slice(1, -1);
  const keepMiddle = MAX_VIEWPORT_CONTEXTS - 2;
  const stride = middle.length / keepMiddle;
  const sampled: number[] = [];
  for (let i = 0; i < keepMiddle; i++) {
    sampled.push(middle[Math.floor(i * stride)]);
  }
  return [...new Set([first, ...sampled, last])].sort((a, b) => a - b);
}

/**
 * The bounded viewport contexts to evaluate for the given stylesheet texts.
 * Pure selection only — effectiveness under each context is determined by
 * real CDP evaluation, never here.
 */
export function responsiveViewportsFor(cssTexts: readonly string[]): ResponsiveViewport[] {
  const breakpoints = extractWidthBreakpoints(cssTexts);
  const widths = viewportWidthsForBreakpoints(breakpoints);
  const smallest = breakpoints.length > 0 ? breakpoints[0] : null;
  const largest = breakpoints.length > 0 ? breakpoints[breakpoints.length - 1] : null;
  return widths.map((width) => ({
    width,
    height: RESPONSIVE_VIEWPORT_HEIGHT,
    label: labelForWidth(width, smallest, largest, breakpoints.length === 0),
  }));
}

/** Whether the viewport set requires a CDP override (i.e. responsive). */
export function needsViewportOverride(cssTexts: readonly string[]): boolean {
  return extractWidthBreakpoints(cssTexts).length > 0;
}

/**
 * True when the stylesheets contain a conditional rule whose applicability
 * the width-viewport model cannot represent.
 *
 * Two independent sources mark the set as unmodeled:
 *
 *   1. `@container` presence (anywhere, case-insensitive). Container queries
 *      depend on container size — a layout dimension orthogonal to viewport
 *      width that the viewport set never varies. A declaration inside
 *      `@container` can be inactive at the evaluated container size while
 *      active at another, so any `@container` forces the conservative path.
 *   2. An unmodeled `@media` condition (see below).
 *
 * A `@media` prelude is *modeled* iff every parenthesized condition in it
 * is a supported viewport-width comparison in `px` (the classic
 * `min-width`/`max-width`/`width` forms and the single-comparison range
 * forms handled by {@link extractWidthBreakpoints}); bare media keywords
 * (`screen`, `all`, `only`, `not`, `and`, `or`, commas) and screen-never
 * matching types with no conditions (`print`, `speech`) need no viewport
 * evidence. Anything else — `orientation`, `height`, `prefers-*`,
 * `resolution`, non-`px` lengths (`em`, `vw`, …), multi-comparison ranges
 * such as `(768px <= width < 992px)` — marks the whole evaluated text set
 * as unmodeled.
 *
 * Rationale: an unmodeled condition can match at the evaluated
 * viewport(s) while failing in another real context (or vice versa), so a
 * declaration that looks inactive everywhere evaluated may still be active
 * where the unmodeled condition flips. Unknown responsive evidence must
 * never be sufficient to dim (see {@link applyViewportCoveragePolicy}).
 * This check intentionally does NOT broaden parsing: unrecognized forms
 * stay unrecognized, they just force the conservative path.
 */
export function hasUnmodeledMediaConditions(cssTexts: readonly string[]): boolean {
  for (const text of cssTexts) {
    if (!text || typeof text !== 'string') {
      continue;
    }
    // Container queries are never modeled by viewport widths (see above).
    // Checked first so `@container` alone — with no `@media` at all —
    // still forces suppression through the shared coverage policy.
    if (/@container\b/i.test(text)) {
      return true;
    }
    const mediaPrelude = /@media\b([^{]*)\{/gi;
    let preludeMatch: RegExpExecArray | null;
    while ((preludeMatch = mediaPrelude.exec(text)) !== null) {
      if (preludeHasUnmodeledCondition(preludeMatch[1] ?? '')) {
        return true;
      }
    }
  }
  return false;
}

function preludeHasUnmodeledCondition(prelude: string): boolean {
  let rest = prelude;
  // Strip exactly the conditions extractWidthBreakpoints understands (same
  // acceptance rules, including the unitless-zero exception).
  rest = rest.replace(
    /\(\s*(min-width|max-width|width)\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*(px)?\s*\)/gi,
    (m, _feature: string, num: string, unit: string | undefined) =>
      unit == null ? (num === '0' ? '' : m) : (unit.toLowerCase() === 'px' ? '' : m)
  );
  rest = rest.replace(
    /\(\s*(?:width\s*(>=|<=|>|<|=)\s*([0-9]+(?:\.[0-9]+)?)\s*(px)?|([0-9]+(?:\.[0-9]+)?)\s*(px)?\s*(>=|<=|>|<)\s*width)\s*\)/gi,
    (
      m: string,
      _op1: string | undefined,
      n1: string | undefined,
      u1: string | undefined,
      n2: string | undefined,
      u2: string | undefined
    ) => {
      const raw = n1 ?? n2;
      const unit = (u1 ?? u2 ?? 'px').toLowerCase();
      if (raw === undefined) {
        return m;
      }
      if (unit !== 'px' && !(raw === '0' && !(u1 ?? u2))) {
        return m;
      }
      return '';
    }
  );
  // Structural keywords and comma separators carry no applicability of
  // their own. `print`/`speech` never match the screen evaluation context,
  // so their rules can neither override screen declarations nor contribute
  // screen verdicts — they need no viewport evidence either.
  rest = rest.replace(/\b(and|or|not|only|screen|all|print|speech)\b/gi, '');
  rest = rest.replace(/[(),\s]/g, '');
  return rest.length > 0;
}

/** True when any evaluated text contains a container query. */
export function hasContainerQueries(cssTexts: readonly string[]): boolean {
  for (const text of cssTexts) {
    if (typeof text === 'string' && /@container\b/i.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Lowercased property names declared inside UNMODELED `@media` blocks
 * (see {@link hasUnmodeledMediaConditions}; `@container` blocks are NOT
 * included — container presence forces the global conservative path, so
 * this set is only consulted when no container query is present).
 *
 * Only verdicts that such a rule could plausibly influence are treated as
 * unsafe: an override loss for the same (aliasing-aware) property, or a
 * layout verdict while unmodeled layout inputs exist (see
 * {@link shouldSuppressInactiveVerdict}). A sibling animation-only block
 * such as FontAwesome's `prefers-reduced-motion` reset therefore suppresses
 * nothing about `width` or `list-style-type` verdicts.
 */
export function unmodeledMediaDeclarationProperties(cssTexts: readonly string[]): Set<string> {
  const properties = new Set<string>();
  for (const text of cssTexts) {
    if (!text || typeof text !== 'string') {
      continue;
    }
    const mediaPrelude = /@media\b([^{]*)\{/gi;
    let preludeMatch: RegExpExecArray | null;
    while ((preludeMatch = mediaPrelude.exec(text)) !== null) {
      if (!preludeHasUnmodeledCondition(preludeMatch[1] ?? '')) {
        continue;
      }
      const openIdx = preludeMatch.index + preludeMatch[0].length - 1;
      const closeIdx = findMatchingBrace(text, openIdx);
      if (closeIdx === -1) {
        continue;
      }
      // Parse ONLY the unmodeled block body: nested rules (including nested
      // `@media`) stay under unmodeled ancestry, so their properties count.
      // A fresh parser per block keeps this helper free of shared state.
      let rules: ReturnType<CssAstParser['parse']>;
      try {
        rules = new CssAstParser().parse(text.slice(openIdx + 1, closeIdx), '');
      } catch {
        continue;
      }
      for (const rule of rules) {
        for (const declaration of rule.declarations) {
          if (typeof declaration.name === 'string' && declaration.name.length > 0) {
            properties.add(declaration.name.trim().toLowerCase());
          }
        }
      }
    }
  }
  return properties;
}

/** Index of the `}` closing the block opened at `openIdx`, or -1. */
function findMatchingBrace(text: string, openIdx: number): number {
  let depth = 0;
  let inString: string | null = null;
  let inComment = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inComment) {
      if (c === '*' && next === '/') {
        inComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (c === '\\') {
        i++;
      } else if (c === inString) {
        inString = null;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      inComment = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = c;
      continue;
    }
    if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Authored property names whose computed values feed inactive verdicts:
 * `display`/`position`/`float` (layout fields), every computed property
 * the rules read directly, and `content` (pseudo-element verdicts).
 * Compared aliasing-aware (see {@link propertyNamesMatch}).
 */
const LAYOUT_INPUT_PROPERTIES: ReadonlySet<string> = new Set([
  'display',
  'position',
  'float',
  'overflow',
  'overflow-x',
  'overflow-y',
  'white-space',
  'text-wrap',
  'text-wrap-mode',
  'transform',
  'translate',
  'rotate',
  'scale',
  'flex-wrap',
  'flex-flow',
  'column-width',
  'column-count',
  'columns',
  'scroll-snap-type',
  'content',
]);

/** Explicit non-hyphen shorthand/longhand pairs (`inset` ↔ `top`, …). */
const EXPLICIT_PROPERTY_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ['inset', ['top', 'right', 'bottom', 'left']],
  ['flex-flow', ['flex-wrap', 'flex-direction']],
  ['columns', ['column-width', 'column-count']],
  ['text-wrap', ['text-wrap-mode']],
]);

/**
 * True when two authored property names can refer to the same cascade
 * slot: equal names, hyphen shorthand/longhand pairs (`margin` vs
 * `margin-top`, `overflow` vs `overflow-x`, `border` vs
 * `border-top-width`), or the explicit pairs above. Distinct cascade
 * properties (`transform` vs `translate`, `white-space` vs
 * `text-wrap-mode`) never match.
 */
export function propertyNamesMatch(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (left === right) {
    return true;
  }
  if (left.startsWith(`${right}-`) || right.startsWith(`${left}-`)) {
    return true;
  }
  return (
    EXPLICIT_PROPERTY_ALIASES.get(left)?.includes(right) === true ||
    EXPLICIT_PROPERTY_ALIASES.get(right)?.includes(left) === true
  );
}

/**
 * Per-declaration safety gate for a confirmed inactive result (pure,
 * unit-testable). Returns true when the verdict must be dropped (⊥) because
 * unmodeled media could hide its only ACTIVE context:
 *
 *   - override verdicts (`OVERRIDDEN_*`): unsafe iff an unmodeled rule
 *     declares the same (aliasing-aware) property — only a same-property
 *     competitor can revive the victim where the unmodeled condition flips.
 *     Modeled winners and unrelated unmodeled blocks (animation resets,
 *     theming) leave the verdict standing;
 *   - layout/applicability verdicts: unsafe iff the unmodeled set touches a
 *     layout input (computed facts the rules read). Unmodeled blocks that
 *     only theme colors or kill animations cannot reshape layout evidence.
 *
 * `unmodeledProps` is {@link unmodeledMediaDeclarationProperties} of the
 * evaluated text union (empty when fully modeled — nothing is suppressed).
 */
export function shouldSuppressInactiveVerdict(options: {
  reasonCode: string | undefined;
  propertyName: string;
  unmodeledProps: ReadonlySet<string>;
}): boolean {
  if (options.unmodeledProps.size === 0) {
    return false;
  }
  // The universal `all` reset touches every property slot.
  if (options.unmodeledProps.has('all')) {
    return true;
  }
  const property = options.propertyName.trim().toLowerCase();
  if (isOverrideReasonCode(options.reasonCode)) {
    for (const candidate of options.unmodeledProps) {
      if (propertyNamesMatch(candidate, property)) {
        return true;
      }
    }
    return false;
  }
  for (const candidate of options.unmodeledProps) {
    if (isLayoutInputProperty(candidate)) {
      return true;
    }
  }
  return false;
}

/** True when an authored name feeds layout verdict evidence (alias-aware). */
function isLayoutInputProperty(name: string): boolean {
  for (const input of LAYOUT_INPUT_PROPERTIES) {
    if (propertyNamesMatch(name, input)) {
      return true;
    }
  }
  return false;
}

function labelForWidth(
  width: number,
  smallest: number | null,
  largest: number | null,
  isDefault: boolean
): string {
  if (isDefault) {
    return 'default';
  }
  if (smallest !== null && width < smallest) {
    return `<${smallest}px`;
  }
  if (largest !== null && width > largest) {
    return `>${largest}px`;
  }
  return `${width}px`;
}

/**
 * Stable fingerprint of a viewport set for cache keys. The widths (not the
 * labels) plus the selection version define the identity: the same CSS
 * content always yields the same widths, and a version bump invalidates
 * stale single-viewport evidence.
 */
export function responsiveFingerprintForViewports(viewports: readonly ResponsiveViewport[]): string {
  return `v${RESPONSIVE_CONTEXT_VERSION}|${viewports.map((v) => v.width).join(',')}`;
}

/**
 * Coverage policy for merged viewport verdicts (pure, unit-testable).
 *
 * Global suppression applies ONLY to width-dimension downsampling and to
 * container queries (see {@link hasContainerQueries}): a merged I under
 * either is unsafe and dropped (only `A` survives). Unmodeled `@media`
 * conditions are handled one level down, per declaration, at the
 * single-viewport inspection site (see
 * {@link shouldSuppressInactiveVerdict}) — an unrelated animation or
 * theming block never silences verdicts it cannot influence.
 *
 * When coverage is complete, the merged map is returned unchanged: a
 * merged I truly means inactive in EVERY responsive interval. When
 * INCOMPLETE, suppression guarantees incomplete evidence can only hide a
 * truly-inactive declaration (conservative false negative), never dim one
 * that is active outside the evaluated contexts (no false positive) — the
 * same "incomplete evidence must never dim" contract the multi-companion
 * merge upholds for failed passes.
 */
export function applyViewportCoveragePolicy(
  merged: ReadonlyMap<string, PassVerdict>,
  cssTexts: readonly string[]
): { verdicts: Map<string, PassVerdict>; suppressedInactiveCount: number; coverageComplete: boolean } {
  const coverageComplete =
    isViewportCoverageCompleteForCss(cssTexts) && !hasContainerQueries(cssTexts);
  if (coverageComplete) {
    return { verdicts: new Map(merged), suppressedInactiveCount: 0, coverageComplete: true };
  }
  const surviving = new Map<string, PassVerdict>();
  let suppressedInactiveCount = 0;
  for (const [key, verdict] of merged) {
    if (verdict.verdict === 'A') {
      surviving.set(key, verdict);
    } else if (verdict.verdict === 'I') {
      suppressedInactiveCount++;
    }
  }
  return { verdicts: surviving, suppressedInactiveCount, coverageComplete: false };
}

/**
 * Coverage and scope contract (by design, documented for the acceptance
 * report):
 *
 *   - only viewport-WIDTH media features in px are modeled;
 *   - height, orientation, resolution, prefers-*, scripting, container
 *     queries, and non-px units (em/rem/vw/...) fall back to the default
 *     single-viewport evaluation for those dimensions;
 *   - breakpoint SOURCES: the viewport set is the union of width
 *     breakpoints from the analyzed stylesheet(s) AND every linked
 *     stylesheet on the evaluated pages (companion documents / analyzed
 *     HTML). A breakpoint in another linked sheet therefore widens the
 *     evaluated set — it can never silently narrow coverage and flip an
 *     ACTIVE declaration to globally INACTIVE. Stylesheets on
 *     non-evaluated pages (outside the companion evidence budget) are out
 *     of scope by design (bounded evidence, never a universal claim);
 *   - BOUNDED enumeration (MAX_VIEWPORT_CONTEXTS): up to
 *     MAX_EXACT_BREAKPOINTS distinct width thresholds are covered
 *     exhaustively (one representative per responsive interval, both sides
 *     of every inclusive/exclusive boundary — see
 *     {@link applyViewportCoveragePolicy}). Larger sets are downsampled
 *     deterministically (extremes preserved, middle sampled evenly) and the
 *     production evaluator treats that incomplete coverage as incomplete
 *     evidence: globally-inactive verdicts are SUPPRESSED (conservative
 *     abstain — incomplete evidence must never dim), so downsampling can
 *     only hide a truly-inactive declaration (false negative), never dim a
 *     declaration that is active in a skipped interval (no false positive).
 *   - UNMODELED media safety (per declaration, not per file): preludes
 *     containing anything beyond supported viewport-width `px` comparisons
 *     (see {@link hasUnmodeledMediaConditions} — orientation, height,
 *     `prefers-*`, resolution, non-`px` lengths, multi-comparison ranges)
 *     gate verdict creation through {@link shouldSuppressInactiveVerdict}:
 *     an override loss is dropped only when an unmodeled rule declares the
 *     same (aliasing-aware) property, and a layout verdict only when the
 *     unmodeled set touches a layout input. Unrelated blocks (animation
 *     resets, color theming) suppress nothing they cannot influence.
 *     Screen-never-matching types (`print`, `speech`) and bare media
 *     keywords need no viewport evidence and do not trigger this.
 *     Shorthand/longhand splits across the modeled boundary
 *     (`margin` vs `margin-top`) are matched aliasing-aware; anything
 *     beyond that is a documented remaining corner.
 *   - UNMODELED container safety: any `@container` presence forces the
 *     global conservative path (via {@link hasContainerQueries}), because
 *     container size is never varied by the viewport set. Like downsampling,
 *     this suppression is global by design (all `I` verdicts in the
 *     evaluated text set are dropped) — it can only hide truly-inactive
 *     declarations (false negatives), never dim container-active ones.
 */
