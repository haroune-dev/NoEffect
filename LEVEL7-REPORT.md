# LEVEL7 — Inline Layout Vertical Box Suppression

## Bug Report

`.inline-target { display: inline; ... }` (root fixture) was only partially
dimmed: `margin-top`, `margin-bottom` and `transform` showed the ⚠️ warning,
but `padding-top: 8px` and `padding-bottom: 8px` stayed active — violating the
fixture's `/* ❌ should be faded */` contract on both of them.

## Root Cause

Vertical box geometry on a non-replaced inline box is ignored by the browser:
the box's contribution to the line box height comes from `line-height` alone, so
vertical margins, paddings and borders never move the line. The engine already
modeled this for the margin/transform half through
`inlineSuppressionRules`, which reuses the shared context matcher
`isInlineNonReplacedElement(layout)`:

```ts
export const inlineSuppressionRules = [
  createInlineSuppressionRule('margin-top'),
  createInlineSuppressionRule('margin-bottom'),
  createInlineSuppressionRule('transform'),
  createInlineSuppressionRule('perspective'),
];
```

`padding-top`/`padding-bottom` were simply absent — but they could not be added
to that list, because the rule registry enforces exactly ONE rule per property
and the whole padding family (all five paddings, needed for the table-internal
suppression) is already owned by `paddingRules`. Adding the paddings to
`inlineSuppressionRules` produced a `Duplicate rule for property "padding-top"`
registration error.

So the gap was structural: the padding family's applicability rule had no inline
context at all — `paddingRules` only knew about table-internal boxes.

## Fix

Give the padding family its full applicability matrix in one place,
`src/inactive/rules/table/paddingRules.ts` (the rule that owns the padding
properties). Each padding rule now checks, in order:

1. no display data → no decision (unchanged);
2. `display: contents` → `NOT_APPLICABLE_WITHOUT_BOX` (unchanged);
3. table-internal display → `NOT_APPLICABLE_TO_TABLE_INTERNAL_BOX` (unchanged);
4. **vertical longhands** (`padding-top`/`padding-bottom`) on a provably
   **non-replaced inline** element → `NOT_APPLICABLE_TO_INLINE_BOX`.

Only the two vertical longhands are suppressed. `padding-left`/`padding-right`
widen the inline box and push the line — they take effect — and the `padding`
shorthand is partially effective (it also sets the horizontal paddings), so it
stays active too. This mirrors the margin family exactly, where only the
`margin-top`/`margin-bottom` longhands are suppressed. Replaced inline elements
(`<img>`, `<video>`, ...) honor vertical padding, so the node name is
consulted through the shared `isInlineNonReplacedElement` predicate
(`true` → flag, `false`/`undefined` → no decision), reusing the same context
matcher the margin rule uses — no new matching logic.

`inlineSuppressionRules.ts` remains the owner of the margin/transform half and
its doc now points out that the vertical padding half lives in `paddingRules`.

## Verification

- Unit tests (`npm test`): 426/426 pass, including new `paddingRules.test.ts`
  cases (vertical longhands flagged on inline `<span/div/a/em/strong/p>`,
  replaced `<img>` active, inline-block/block/flex active, `padding`/
  `padding-left`/`padding-right` active on inline, unknown node-name → no
  decision).
- Integration (`npm run test:integration`): 20/20 pass against real Chromium.
  The phase5 fixture now carries the vertical-padding case: `.inline-geometry`
  contributes 15 → 17 provably-inactive declarations and a new active control
  `.inline-horizontal-padding` verifies `padding-left`/`padding-right` stay
  bright. All issues map with the exact `NOT_APPLICABLE_TO_INLINE_BOX` reason.
- Real-fixture probe, `.inline-target` (both the HTML and CSS-file flows):
  `margin-top`, `margin-bottom`, `padding-top`, `padding-bottom` and
  `transform` all flagged `NOT_APPLICABLE_TO_INLINE_BOX` — matches the expected
  faded state of the bug report.
- Benchmark: cold 671ms / warm ~46ms, healthy (no regression in the rule path).

## Deferred edges

- Borders: `border-top-width`/`border-bottom-width` share the same line-box
  behavior, but were left untouched — out of scope for this report (the
  reference's border handling is a longhand-width family of its own).
- The `padding` shorthand is intentionally NOT flagged (partially effective on
  inline). A future refinement could split shorthand values, but that requires
  a value-parser — beyond the predicate's gift.