# LEVEL8 — `::first-letter` formatting-context verdicts (`margin-top` dimmed)

## The report

```css
.first-letter-case::first-letter {
  display: flex;              /* already dimmed */
  position: absolute;         /* already dimmed */
  transform: translateY(8px); /* already dimmed */
  margin-top: 8px;            /* NOT dimmed — the bug */
  font-size: 40px;            /* must stay active */
  color: #b00;                /* must stay active */
  font-weight: 700;           /* must stay active */
}
```

`margin-top` on a `::first-letter` box is provably inactive (the box is a
non-replaced inline box, so its vertical margins are ignored by the line
box), yet it stayed active in both the CSS-file and HTML flows.

## Root cause

The engine dispatched pseudo-element declarations to the `::<type>` rule
(`::before`, `::after`, `::first-letter`) and to NOTHING else. The
`::first-letter` rule only enforces the whitelist
(`FIRST_LETTER_SUPPORTED_PROPERTIES` in `src/inactive/rules/shared.ts`).
`margin-top` is whitelisted — the margin family does apply to the
first-letter box — so the pseudo rule abstained, and the general
`margin-top` rule (inline-box suppression) was never consulted. Whitelist
membership answers "is the property in the first-letter family"; the
formatting context answers "does it have an effect". The engine only
answered the first question.

## The fix (structural, no `::first-letter` special cases)

1. **Pseudo-box LayoutContexts** — `src/engine/layoutContext.ts`
   (`derivePseudoBoxLayout`, `PseudoBoxFacts`, `pseudoBoxContexts`):
   each pseudo element of a node now gets its OWN derived LayoutContext:
   display = the box's COMPUTED display (inline by default, blockified by
   a non-none float), position = computed position, parent display = the
   origin element's display, nodeName = the origin's (a pseudo box is
   never itself replaced). The map is normalized and frozen with the
   context.

2. **Two-stage engine dispatch** — `src/inactive/inactiveRuleEngine.ts`:
   stage 1 routes the pseudo declaration to the `::<type>` rule as
   before. When that rule abstains, stage 2 consults the declaration's
   own property rule against the pseudo BOX context (falling back to the
   origin context — and to silence — when the pseudo-box facts could not
   be fetched). A `::first-letter` verdict is final; unknown pseudo types
   without a registered `::<type>` rule stay silent.

3. **Computed pseudo-box facts** — `src/services/cdpAnalyzer.ts`
   (`fetchPseudoBoxStyles`): the pseudo box's display/float/position come
   from `getComputedStyle(el, pseudo)` inside the page, one batched
   `Runtime.evaluate` per node. The browser is the only truthful source:
   it ignores authored `display: flex`/`position: absolute` on the
   `::first-letter` box (computed display stays `inline`, or `block` when
   floated), while it honors them on `::before`/`::after`. `collectPseudoTypes`
   (`src/browser/matchedStylesCollector.ts`) lists the pseudo types to
   query. `CSS.getComputedStyleForNode` with `forPseudo` was tested and
   rejected — Chromium answers it with the ORIGIN element's styles.

## Why this is not a `::first-letter` special case

The derivation contains zero pseudo-type knowledge: whatever the browser
computes for any pseudo box (first-letter, before, after, ...) shapes its
context. The whitelisted text properties stay active; `display: flex` on
the box does not leak into the context (it is ignored by the browser, not
by us); a floated first-letter computes to `display: block` and keeps its
margins active.

## Verification

- New unit tests: engine two-stage dispatch (abstention, pseudo-box
  context routing, verdict precedence, unregistered types stay silent),
  `derivePseudoBoxLayout` (defaults, computed display, float
  blockification incl. inline-flex→flex / inline-grid→grid / table,
  position, frozen surface), `collectPseudoTypes`.
- New integration tests: phase6 fixture extended (`.article-text::first-letter`
  `margin-top` → `NOT_APPLICABLE_TO_INLINE_BOX`, 8→9 issues; a floated
  `::first-letter` control stays active; `.with-content-pseudo::before`
  now `display: block` — its width is judged against the box it really
  has), plus a dedicated regression test reproducing the exact report
  case in the CSS-file flow.
- Full suites: 440 unit + 21 integration green; benchmark cold ~667ms /
  warm ~31ms (the extra evaluate costs nothing measurable).

## Files touched

- `src/engine/layoutContext.ts` — `PseudoBoxFacts`, `BLOCKIFY_DISPLAYS`,
  `derivePseudoBoxLayout`, `pseudoBoxContexts`, frozen map.
- `src/inactive/inactiveRuleEngine.ts` — two-stage pseudo dispatch.
- `src/services/cdpAnalyzer.ts` — `fetchPseudoBoxStyles` (computed
  pseudo-box facts).
- `src/browser/matchedStylesCollector.ts` — `collectPseudoTypes`.
- `src/browser/layoutContextBuilder.ts` — `BuildOptions.pseudoBoxFacts`
  passthrough.
- `src/inactive/rules/pseudo/pseudoRules.ts` — docs (fall-through).
- `src/test/fixtures/phase6/{styles.css,index.html}` + integration tests;
  unit tests for the engine, layout context and collector.
