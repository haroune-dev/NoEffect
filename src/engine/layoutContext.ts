/**
 * PR6 Phase 1 — Layout Context infrastructure.
 *
 * A strongly typed, immutable snapshot of everything layout-related that
 * inactive-property rules need to know about ONE DOM node:
 *
 *   - the element's own (normalized) computed `display`,
 *   - whether it is a flex/grid container (inline-flex and inline-grid
 *     included),
 *   - the (normalized) computed `display` of its parent element,
 *   - whether it is a flex/grid item,
 *   - the (normalized) computed `position` and whether it is positioned
 *     (relative/absolute/fixed/sticky),
 *   - the full set of cached computed styles for O(1) lookups.
 *
 * The context is built ONCE per node by the LayoutContextBuilder and then
 * shared by every rule — rules must never query CDP or re-normalize values
 * themselves.
 *
 * This module is deliberately free of any `vscode` / browser dependency:
 * normalization and detection are unit-testable on their own.
 */

/** Displays that establish a flex formatting context on the element itself. */
export const FLEX_CONTAINER_DISPLAYS: ReadonlySet<string> = new Set([
  'flex',
  'inline-flex',
]);

/** Displays that establish a grid formatting context on the element itself. */
export const GRID_CONTAINER_DISPLAYS: ReadonlySet<string> = new Set([
  'grid',
  'inline-grid',
]);

/** Default parent display when the element has no usable parent. */
export const NO_PARENT_DISPLAY = 'none';

/**
 * Position values that take the element out of the static flow and make
 * the offset properties (`top`/`right`/`bottom`/`left`/`inset`) apply.
 */
export const POSITIONED_POSITIONS: ReadonlySet<string> = new Set([
  'relative',
  'absolute',
  'fixed',
  'sticky',
]);

/**
 * A single node's layout facts, immutable after creation.
 *
 * `computedStyles` is the full cached set of computed styles collected in
 * ONE protocol pass; rules read individual properties through it (O(1))
 * or through {@link LayoutContext.getComputedStyle}.
 */
export interface LayoutContext {
  /** Normalized computed `display` of the element ('' when unavailable). */
  readonly display: string;

  /** True when the element establishes a flex container (`flex`/`inline-flex`). */
  readonly isFlexContainer: boolean;

  /** True when the element establishes a grid container (`grid`/`inline-grid`). */
  readonly isGridContainer: boolean;

  /** Normalized computed `display` of the parent element ('none' when unavailable). */
  readonly parentDisplay: string;

  /** True when the parent establishes a flex container. */
  readonly isFlexItem: boolean;

  /** True when the parent establishes a grid container. */
  readonly isGridItem: boolean;

  /** Normalized computed `position` of the element ('' when unavailable). */
  readonly position: string;

  /** True when `position` is relative/absolute/fixed/sticky. */
  readonly isPositioned: boolean;

  /**
   * True when the element is taken out of the static flow by absolute or
   * fixed positioning (`position: absolute | fixed`). Out-of-flow boxes
   * stop participating in their parent's flex/grid formatting context, so
   * item-dependent properties no longer apply. Advanced-context rules use
   * this to combine the position condition with the parent's display.
   */
  readonly isOutOfFlow: boolean;

  /**
   * Normalized (lowercase) tag name of the element (e.g. 'div', 'img' —
   * '' when unavailable). PR7: required by rules that distinguish replaced
   * inline elements (`width`/`height` on an inline `<img>` still apply).
   */
  readonly nodeName: string;

  /**
   * True when some ancestor (parent, grandparent, ... up to the document
   * root) is a scroll-snap container: a scrollable box (overflow not
   * visible/clip) whose computed `scroll-snap-type` is not 'none'.
   * Final-PR7: required by the scroll-snap-align / scroll-margin rules.
   * `undefined` means the ancestor chain could not be resolved
   * conservatively (CDP failure) — rules must NOT flag then.
   */
  readonly hasScrollSnapAncestor?: boolean;

  /**
   * Cascade-winning DECLARED `content` value per generated pseudo-element
   * of the node (keyed by pseudo type, e.g. 'before', 'after'). A pseudo
   * type is ABSENT from the map when no `content` is declared on it.
   *
   * PR Level 3: consumed by the ::before/::after content rules — a pseudo
   * without a real `content` value generates no box, so every property
   * declared on it is inactive. `undefined` means the pseudo facts could
   * not be collected (no decision — conservative).
   */
  readonly pseudoContent?: ReadonlyMap<string, string>;

  /**
   * True when SOME ancestor (parent, grandparent, up to the document root)
   * is a table box (computed `display: table | inline-table`). Context
   * hardening: a `display: table-cell` element only participates in table
   * layout through a real table box — a `<table>` wrapper explicitly set
   * to `display: block` breaks the context, so cell properties such as
   * `vertical-align` lose their effect.
   *
   * `undefined` means the ancestor chain could not be resolved
   * conservatively (CDP failure) — rules must NOT flag then.
   */
  readonly hasTableBoxAncestor?: boolean;

  /**
   * Cascade-winning AUTHORED `display` declaration of the element (the
   * `display` value written by the author/user stylesheet, NOT the
   * computed value). Only explicit declarations count — UA-origin rules
   * (`div { display: block }`) are filtered out. `undefined` means no
   * author `display` declaration matched the element.
   *
   * Context hardening: consumed by the place-self decomposition — an
   * explicit plain-block `display` override (`.item { display: block;
   * place-self: center }`) takes the element out of the Box Alignment
   * placement context even though it remains a flex/grid item.
   */
  readonly declaredDisplay?: string;

  /**
   * True when the parent display is a SYNTHETIC artifact of the analysis
   * wrapper page (the element is a top-level wrapper child, `parentDisplay`
   * is reported as 'none'). The wrapper guarantees such an element is
   * NEVER the document root — so rules that only hold back because the
   * parent might be the root (z-index) may decide. Genuinely unknown
   * parents (real document root, unreadable parent) keep the ambiguity.
   */
  readonly parentIsSynthetic: boolean;

  /**
   * True when the element TYPE (`nodeName`) is a SYNTHETIC artifact of the
   * analysis wrapper page, not a fact from the user's real document. The
   * CSS-file flow fabricates an element per selector: a bare class/id
   * selector (`.hero`) gets a plain `<div>` stand-in, while a tag-naming
   * selector (`img.hero`, `video.x`) gets its real element. A fabricated
   * type must never be treated as PROOF of replaced-ness — the real
   * element behind `.hero` could be an `<img>` — so type-dependent rules
   * (`object-fit`/`object-position`) abstain on fabricated types instead
   * of flagging them.
   */
  readonly typeIsSynthetic: boolean;

  /**
   * The LayoutContext of each of this node's pseudo-element boxes, keyed by
   * pseudo type ('before', 'after', 'first-letter'). A pseudo box is NOT
   * the element: its display defaults to `inline`, can be overridden by
   * the pseudo's own authored `display`, is blockified when floated, and
   * its parent is the origin element. Rules that reason about a pseudo
   * declaration's formatting context must use the pseudo BOX context, not
   * the origin's. `undefined` when the pseudo box facts were not
   * collected — the engine then falls back to the origin context.
   */
  readonly pseudoBoxContexts?: ReadonlyMap<string, LayoutContext>;

  /**
   * Computed box facts for each pseudo-element reported by Chromium.  In
   * addition to the box formatting values used to derive
   * {@link pseudoBoxContexts}, `computedContent` records whether a
   * `::before`/`::after` box is actually generated.  This is browser truth:
   * it wins over the declared-content fallback when both are available.
   */
  readonly pseudoBoxFacts?: ReadonlyMap<string, PseudoBoxFacts>;

  /** Cached computed styles of the element (single protocol pass, O(1) reads). */
  readonly computedStyles: ReadonlyMap<string, string>;

  /** O(1) computed-style lookup ('' is never returned — missing is `undefined`). */
  getComputedStyle(property: string): string | undefined;
}

/**
 * Normalize a raw display value: trim outer whitespace, collapse inner
 * whitespace and lowercase everything. Missing or whitespace-only values
 * normalize to ''.
 */
export function normalizeDisplay(value: string | undefined): string {
  if (!value) {
    return '';
  }
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Normalize a raw DOM tag name: trim and lowercase. CDP reports element
 * node names in uppercase ('IMG'), while the replaced-element allow-list
 * is lowercase — normalizing here keeps every rule case-safe.
 */
export function normalizeNodeName(value: string | undefined): string {
  if (!value) {
    return '';
  }
  return value.trim().toLowerCase();
}

/** Whether a normalized display establishes a flex container. */
export function isFlexContainerDisplay(display: string): boolean {
  return FLEX_CONTAINER_DISPLAYS.has(display);
}

/** Whether a normalized display establishes a grid container. */
export function isGridContainerDisplay(display: string): boolean {
  return GRID_CONTAINER_DISPLAYS.has(display);
}

/**
 * Overflow values that make a box a scroll container (per CSS Overflow):
 * `hidden` boxes are still programmatically scrollable, so they count.
 * `visible` and `clip` do NOT produce a scroll container.
 */
export const SCROLLABLE_OVERFLOW_VALUES: ReadonlySet<string> = new Set([
  'hidden',
  'auto',
  'scroll',
]);

/** Whether a single overflow value makes the box scrollable. */
export function isScrollableOverflowValue(value: string): boolean {
  return SCROLLABLE_OVERFLOW_VALUES.has(value);
}

/** Inputs used to build a {@link LayoutContext}. */
export interface LayoutContextInit {
  /** Raw computed `display` of the element (normalized on build). */
  display: string;

  /** Raw computed `display` of the parent (normalized on build). */
  parentDisplay: string;

  /**
   * Raw computed `position` of the element (normalized on build; '' when
   * unavailable). Optional so Phase 1 call sites keep working unchanged.
   */
  position?: string;

  /**
   * Raw DOM tag name of the element (normalized on build; '' when
   * unavailable). Optional so existing call sites keep working unchanged.
   */
  nodeName?: string;

  /**
   * Whether an ancestor is a scroll-snap container (see
   * {@link LayoutContext.hasScrollSnapAncestor}). Optional — callers that
   * cannot resolve the ancestor chain leave it `undefined`.
   */
  hasScrollSnapAncestor?: boolean;

  /**
   * Cascade-winning declared `content` per pseudo-element (see
   * {@link LayoutContext.pseudoContent}). Optional — callers without the
   * matched-styles pseudo facts leave it `undefined`, and rules then make
   * no pseudo-related decision.
   */
  pseudoContent?: ReadonlyMap<string, string>;

  /**
   * Whether an ancestor is a table box (see
   * {@link LayoutContext.hasTableBoxAncestor}). Optional — callers that
   * cannot resolve the ancestor chain leave it `undefined`.
   */
  hasTableBoxAncestor?: boolean;

  /**
   * Cascade-winning authored `display` declaration (see
   * {@link LayoutContext.declaredDisplay}). Optional — callers without the
   * matched-styles display facts leave it `undefined`.
   */
  declaredDisplay?: string;

  /**
   * Whether the parent display is a synthetic wrapper artifact (see
   * {@link LayoutContext.parentIsSynthetic}). Optional — defaults to
   * `false`.
   */
  parentIsSynthetic?: boolean;

  /**
   * Whether the element type is a synthetic wrapper artifact (see
   * {@link LayoutContext.typeIsSynthetic}). Optional — defaults to
   * `false`.
   */
  typeIsSynthetic?: boolean;

  /**
   * Computed pseudo-box facts per pseudo-element of the node (see
   * {@link PseudoBoxFacts}). Optional — the derived pseudo box contexts
   * (see {@link LayoutContext.pseudoBoxContexts}) are only built when the
   * analyzer collected these facts.
   */
  pseudoBoxFacts?: ReadonlyMap<string, PseudoBoxFacts>;

  /** Full computed-style map collected in a single protocol pass. */
  computedStyles: ReadonlyMap<string, string> | Map<string, string>;
}

/**
 * Computed box facts of ONE pseudo-element, per pseudo type. Pseudo boxes
 * do not have a DOM node of their own, so this browser data is used to
 * derive their layout context (see {@link derivePseudoBoxLayout}).
 */
export interface PseudoBoxFacts {
  /** Computed `display` value for the pseudo box ('', absent when unreadable). */
  display?: string;
  /** Computed `float` value for the pseudo box ('' when unreadable). */
  float?: string;
  /** Computed `position` value for the pseudo box ('' when unreadable). */
  position?: string;
  /**
   * Computed `content` value for the pseudo box.  `none` and `normal` mean
   * that ::before/::after generates no box; any other value generates one.
   * Undefined means Chromium did not provide this fact.
   */
  computedContent?: string;
}

/** Whether computed pseudo facts prove that a generated pseudo box exists. */
function hasComputedGeneratedPseudoBox(type: string, facts: PseudoBoxFacts): boolean {
  if (type !== 'before' && type !== 'after') {
    return true;
  }
  // An unreadable/absent content fact must stay conservative: the pseudo
  // rule can still use its declared-content fallback, but this layer must
  // not pretend it has proof either way.
  if (facts.computedContent === undefined || facts.computedContent.trim().length === 0) {
    return true;
  }
  const content = facts.computedContent.trim().toLowerCase();
  return content !== 'none' && content !== 'normal';
}

/**
 * CSS Display Level 3 blockification for a floated box: a float never
 * establishes an inline-level box. Inline outer display types compute to
 * their block-level counterparts; values that are already block-level map
 * to themselves.
 */
const BLOCKIFY_DISPLAYS: Readonly<Record<string, string>> = {
  inline: 'block',
  'inline-block': 'block',
  'inline-flex': 'flex',
  'inline-grid': 'grid',
  'inline-table': 'table',
  'run-in': 'block',
};

/**
 * Derive the LayoutContext of a pseudo-element box from its origin
 * element's context and the pseudo's COMPUTED box-model styles.
 *
 * The pseudo box is a child of the origin element and follows the generic
 * CSS rules for pseudo boxes:
 *   - display: the browser computes the box's real display (a
 *     `::first-letter` box stays `inline` even when `display: flex` is
 *     authored — the box ignores it; a floated pseudo box computes to a
 *     block-level display). `facts.display` carries that computed value;
 *     it defaults to `inline` when absent;
 *   - float: a non-none computed float blockifies the display (safety net
 *     for any browser that reports a pre-blockified display);
 *   - position: the computed position (Chromium computes `static` for the
 *     `::first-letter` box regardless of authored `position`; authored
 *     `position` is honored on `::before`/`::after`);
 *   - the parent is the ORIGIN element, so the origin's display is the
 *     pseudo box's parent display (a direct pseudo child of a flex/grid
 *     container is an item of it);
 *   - replaced-ness is witnessed by the origin's node name (a pseudo box
 *     is never itself a replaced element).
 *
 * Pure and dependency-free: unit-testable on its own.
 */
export function derivePseudoBoxLayout(
  origin: LayoutContext,
  facts?: PseudoBoxFacts
): LayoutContext {
  const authoredDisplay = normalizeDisplay(facts?.display);
  const float = normalizeDisplay(facts?.float);
  const floated = float.length > 0 && float !== 'none';

  const baseDisplay = authoredDisplay || (floated ? 'block' : 'inline');
  const display = floated ? (BLOCKIFY_DISPLAYS[baseDisplay] ?? baseDisplay) : baseDisplay;
  const position = normalizeDisplay(facts?.position) || 'static';

  return createLayoutContext({
    display,
    parentDisplay: origin.display,
    position,
    nodeName: origin.nodeName,
    pseudoContent: origin.pseudoContent,
    computedStyles: origin.computedStyles,
    typeIsSynthetic: origin.typeIsSynthetic,
  });
}

/**
 * Build the immutable LayoutContext for one node. Values are normalized
 * here — and only here — so every rule receives normalized values.
 */
export function createLayoutContext(init: LayoutContextInit): LayoutContext {
  // Defensive copy: the caller keeps its own working map, the context owns
  // an immutable copy so no external reference can mutate it.
  const computedStyles = new Map(init.computedStyles);
  const display = normalizeDisplay(init.display);
  const parentDisplay = normalizeDisplay(init.parentDisplay);
  const position = normalizeDisplay(init.position);
  const nodeName = normalizeNodeName(init.nodeName);

  const context: LayoutContext = {
    display,
    isFlexContainer: isFlexContainerDisplay(display),
    isGridContainer: isGridContainerDisplay(display),
    parentDisplay,
    isFlexItem: isFlexContainerDisplay(parentDisplay),
    isGridItem: isGridContainerDisplay(parentDisplay),
    position,
    isPositioned: POSITIONED_POSITIONS.has(position),
    isOutOfFlow: position === 'absolute' || position === 'fixed',
    nodeName,
    ...(init.hasScrollSnapAncestor === undefined
      ? {}
      : { hasScrollSnapAncestor: init.hasScrollSnapAncestor }),
    ...(init.pseudoContent === undefined
      ? {}
      : { pseudoContent: new Map(init.pseudoContent) }),
    ...(init.hasTableBoxAncestor === undefined
      ? {}
      : { hasTableBoxAncestor: init.hasTableBoxAncestor }),
    ...(init.declaredDisplay === undefined
      ? {}
      : { declaredDisplay: init.declaredDisplay }),
    parentIsSynthetic: init.parentIsSynthetic === true ? true : false,
    typeIsSynthetic: init.typeIsSynthetic === true ? true : false,
    computedStyles,
    getComputedStyle(property: string): string | undefined {
      return computedStyles.get(property);
    },
  };

  if (init.pseudoBoxFacts) {
    const pseudoBoxFacts = new Map<string, PseudoBoxFacts>();
    for (const [type, facts] of init.pseudoBoxFacts) {
      const normalized = type.trim().toLowerCase().replace(/^::/, '');
      if (normalized.length > 0) {
        pseudoBoxFacts.set(normalized, facts);
      }
    }
    Object.freeze(pseudoBoxFacts);
    (context as { pseudoBoxFacts?: ReadonlyMap<string, PseudoBoxFacts> }).pseudoBoxFacts =
      pseudoBoxFacts;

    const pseudoBoxContexts = new Map<string, LayoutContext>();
    for (const [type, facts] of pseudoBoxFacts) {
      if (hasComputedGeneratedPseudoBox(type, facts)) {
        pseudoBoxContexts.set(type, derivePseudoBoxLayout(context, facts));
      }
    }
    if (pseudoBoxContexts.size > 0) {
      Object.freeze(pseudoBoxContexts);
      (context as { pseudoBoxContexts?: ReadonlyMap<string, LayoutContext> }).pseudoBoxContexts =
        pseudoBoxContexts;
    }
  }

  return Object.freeze(context);
}
