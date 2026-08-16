/**
 * PR6 Phase 2 — standardized, machine-readable reason codes.
 *
 * Every inactive result produced by a rule carries EXACTLY one of these
 * codes instead of a free-form string, so consumers (tests, reports, and
 * future features) can rely on stable values.
 *
 * The codes describe why the declaration has no effect:
 *
 *   - CONTAINER codes: the element itself must establish the named
 *     formatting context for the property to apply;
 *   - ITEM codes: the element must be a direct item of a container that
 *     establishes the named formatting context;
 *   - POSITION codes: the element must be positioned (or a flex/grid
 *     item) for the property to apply;
 *   - APPLICABILITY codes: the property simply does not apply to the
 *     element's current box/flow context (float/clear on flex items or
 *     absolutely positioned boxes, clear on inline boxes, or properties
 *     on `display: contents` elements that generate no box at all).
 *
 * PR7 adds the codes for the extended applicability families ported from
 * Chromium's CSSRuleValidator: flex-only container requirements
 * (`REQUIRES_FLEX_CONTAINER`), the grid-lanes-aware grid family, the gap
 * family (flex/grid/multicol), the table-internal padding rule, the
 * anchor-positioning rule and the `flex-wrap: nowrap` conflict. The final
 * PR7 batch adds the element-kind / context codes implemented directly
 * from rendering semantics (replaced elements, scroll/snap contexts,
 * tables, list items, transforms).
 */
export const REASON_CODES = {
  REQUIRES_FLEX_OR_GRID_CONTAINER: 'REQUIRES_FLEX_OR_GRID_CONTAINER',
  REQUIRES_FLEX_CONTAINER: 'REQUIRES_FLEX_CONTAINER',
  REQUIRES_GRID_CONTAINER: 'REQUIRES_GRID_CONTAINER',
  REQUIRES_FLEX_OR_GRID_ITEM: 'REQUIRES_FLEX_OR_GRID_ITEM',
  REQUIRES_FLEX_ITEM: 'REQUIRES_FLEX_ITEM',
  REQUIRES_GRID_ITEM: 'REQUIRES_GRID_ITEM',

  // PR6 Phase 3 — position / flow / box-applicability codes.
  REQUIRES_POSITIONED_ELEMENT: 'REQUIRES_POSITIONED_ELEMENT',
  REQUIRES_POSITIONED_OR_FLEX_GRID_ITEM: 'REQUIRES_POSITIONED_OR_FLEX_GRID_ITEM',
  NOT_APPLICABLE_TO_FLEX_GRID_ITEM: 'NOT_APPLICABLE_TO_FLEX_GRID_ITEM',
  NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX: 'NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX',
  NOT_APPLICABLE_TO_INLINE_BOX: 'NOT_APPLICABLE_TO_INLINE_BOX',
  REQUIRES_INLINE_LEVEL_OR_TABLE_CELL: 'REQUIRES_INLINE_LEVEL_OR_TABLE_CELL',
  NOT_APPLICABLE_WITHOUT_BOX: 'NOT_APPLICABLE_WITHOUT_BOX',

  // Context hardening — the element's own display matches the property's
  // "applies to" list, but its surrounding layout context is broken (e.g.
  // a `display: table-cell` box whose `<table>` wrapper was overridden to
  // `display: block`, so no real table box exists anywhere in the chain).
  BROKEN_TABLE_CONTEXT: 'BROKEN_TABLE_CONTEXT',

  // PR7 — extended applicability codes (ported from the reference).
  PREVENTED_BY_FLEX_WRAP_NOWRAP: 'PREVENTED_BY_FLEX_WRAP_NOWRAP',
  REQUIRES_FLEX_GRID_OR_MULTICOL_CONTAINER: 'REQUIRES_FLEX_GRID_OR_MULTICOL_CONTAINER',
  NOT_APPLICABLE_TO_TABLE_INTERNAL_BOX: 'NOT_APPLICABLE_TO_TABLE_INTERNAL_BOX',
  REQUIRES_ABSOLUTE_OR_FIXED_POSITION: 'REQUIRES_ABSOLUTE_OR_FIXED_POSITION',

  // Final PR7 — element-kind / context codes (implemented directly from
  // rendering semantics; absent from the reference files).
  REQUIRES_REPLACED_ELEMENT: 'REQUIRES_REPLACED_ELEMENT',
  REQUIRES_SCROLL_CONTAINER: 'REQUIRES_SCROLL_CONTAINER',
  REQUIRES_CLIP_OVERFLOW: 'REQUIRES_CLIP_OVERFLOW',
  REQUIRES_SCROLL_SNAP_CONTAINER: 'REQUIRES_SCROLL_SNAP_CONTAINER',
  REQUIRES_TABLE: 'REQUIRES_TABLE',
  REQUIRES_LIST_ITEM: 'REQUIRES_LIST_ITEM',
  REQUIRES_TRANSFORM: 'REQUIRES_TRANSFORM',
  REQUIRES_TRANSFORMABLE_ELEMENT: 'REQUIRES_TRANSFORMABLE_ELEMENT',

  // Advanced-context (Level 2) — compound multi-condition codes.
  REQUIRES_TRUNCATION_PRECONDITIONS: 'REQUIRES_TRUNCATION_PRECONDITIONS',

  // PR Level 3 — pseudo-element and scroll-context codes.
  GENERATED_PSEUDO_MISSING: 'GENERATED_PSEUDO_MISSING',
  FIRST_LETTER_UNSUPPORTED_PROPERTY: 'FIRST_LETTER_UNSUPPORTED_PROPERTY',

  // Stress-level — a flex/grid layout display on a generated pseudo-element:
  // the generated box contains only the content string (no children), so a
  // flex/grid formatting context has nothing to arrange.
  GENERATED_PSEUDO_LAYOUT_DISPLAY: 'GENERATED_PSEUDO_LAYOUT_DISPLAY',

  // Duplicate-declaration semantics: within ONE declaration block the last
  // declaration of a property wins, so every earlier one has no effect.
  OVERRIDDEN_BY_LATER_DECLARATION: 'OVERRIDDEN_BY_LATER_DECLARATION',

  // Cross-rule cascade semantics: for one inspected node, a DIFFERENT rule
  // (or the inline `style=""` attribute) wins the cascade for the property
  // — higher specificity, later source order, `!important`, or inline —
  // so this rule's declaration has no effect on that node.
  OVERRIDDEN_BY_CROSS_RULE_DECLARATION: 'OVERRIDDEN_BY_CROSS_RULE_DECLARATION',
} as const;

/**
 * True when the code is one of the override-family codes: the verdict is a
 * resolved cascade loss, and the issue may carry an `overrideTarget` jump
 * link to the winning declaration.
 */
export function isOverrideReasonCode(code: string | undefined): boolean {
  return (
    code === REASON_CODES.OVERRIDDEN_BY_LATER_DECLARATION ||
    code === REASON_CODES.OVERRIDDEN_BY_CROSS_RULE_DECLARATION
  );
}

/** The union of all standardized reason codes. */
export type ReasonCode = (typeof REASON_CODES)[keyof typeof REASON_CODES];
