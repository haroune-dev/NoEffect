# LEVEL 5 — Inactive Rules Engine Regressions (three CSS-flow context fixes)

PR scope: fix three reported regressions of the inactive-CSS engine without
adding new features, families or fixture-specific logic. The fixes live at
the context-evaluation boundary, exactly where the Level-4 hardening PR
worked.

---

## 1. Root causes (from the pre-fix audit)

The three symptoms were first reproduced against the CURRENT code with
throwaway CDP probes in both analysis flows (`analyzeHtmlFile` on the main
fixture, `analyzeCssFile` on scratch CSS):

| # | Symptom | Root cause |
|---|---------|------------|
| 1 | `flex-basis` (and `order`, `align-self`, `flex-grow`) on a `position: absolute` rule NOT flagged in the standalone CSS-file flow | `createOutOfFlowAwareItemRule` only flagged an out-of-flow box when its parent was KNOWN to be a flex/grid item (`isItem`), and its parent-unknown guard ran FIRST. The wrapper page reports no parent for a standalone selector (`parentDisplay = 'none'`), so the guard returned no decision BEFORE the out-of-flow condition could ever fire — the property stayed active. The HTML flow already passed: probe output showed `.abs-flex-item\|flex-basis` → `[NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX]`. |
| 2 | `place-self` under an explicit `display: block` override (`.place-item.bad`) NOT flagged in the standalone CSS-file flow | `hasPlaceSelfEffect` ran its parent-unknown guard BEFORE the authored plain-block-display override. With a synthetic (unknown) parent, the guard returned `undefined` and the override was never consulted. The `.good` case (no authored display) must stay active — only the explicit override is authoritative. |
| 3 | `object-fit` / `object-position` on an image selector (`.object-fit-img`) falsely flagged `REQUIRES_REPLACED_ELEMENT` in the CSS-file flow | The wrapper page builds one element per selector part and defaults every part that does not name a tag to `<div>`. `.object-fit-img` became a synthetic `<div>` (nodeName `div`), so the replaced-element rule dimmed it with confidence. A real `<img>` in the page must never be dimmed. The HTML flow already passed (the real `<img>` element stays active). |

Additional facts confirmed during the audit:

- The HTML flow was already correct for all three — the regressions live
  exclusively in the CSS-file (wrapper) flow, where the wrapper fabricates
  both the parent context and the element type.
- `elementForPart` already emits a real tag when the selector names one
  (`img.object-fit-img` → `<img class="object-fit-img">`); only class/id
  parts fall back to `<div>`.
- The task's exact symptom for #1 (flex-basis missed while the other three
  were flagged) does not reproduce against current code: all four flex-item
  properties are flagged in the HTML flow and all four were silently
  conservative in the CSS flow. The structural fixes below make all four
  flag in BOTH flows.

---

## 2. Fixes (all at the context-builder / rule-evaluation boundary)

### 2.1 Out-of-flow item properties are provably inactive — no parent needed
`src/inactive/rules/shared.ts` — `createOutOfFlowAwareItemRule`

The out-of-flow condition now runs BEFORE the parent-unknown guard. An
absolutely/fixed positioned box is NEVER a flex/grid item — whether its
parent is a flex/grid container (removed from the formatting context) or
not (never an item) — so flagging it can never be a false positive, even
when the parent is unknowable. The new condition order:

1. out-of-flow ⇒ `NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX` (no parent
   knowledge required);
2. in-flow item ⇒ active;
3. everything else ⇒ plain item-required reason code.

The parent-unknown guard now applies only to IN-FLOW boxes. Flex and grid
item families both use this factory, so `flex`, `flex-grow`, `flex-shrink`,
`flex-basis`, `align-self`, `order`, `justify-self`, `grid-column`,
`grid-row`, `grid-area` and the line-placement longhands inherit the fix
uniformly.

### 2.2 Explicit plain-block display overrides the placement context
`src/inactive/rules/shared.ts` — `hasPlaceSelfEffect`

The authored plain-block-display override is now checked BEFORE the
parent-unknown guard. `display: block` / `flow-root` / `list-item` removes
the box from the Box Alignment placement context regardless of how much of
the parent is known. The parent-unknown guard applies only when no override
exists — so `.place-item.good` (no authored display, unknown parent) stays
active and `.place-item.bad` (explicit `display: block`) is flagged.

### 2.3 Element-type rules stay conservative on a fabricated element
- `src/engine/layoutContext.ts` — new immutable field `elementTypeKnown:
  boolean` (default `true`; `false` when the wrapper fabricated the tag).
- `src/browser/layoutContextBuilder.ts` — `BuildOptions.elementTypeKnown`,
  passed straight through.
- `src/inactive/rules/misc/objectFit.ts` — when `elementTypeKnown ===
  false` the rule returns no decision (the node name is not authoritative,
  so a real `<img>` must never be dimmed). Box-suppressed and missing-node
  checks are unchanged; selectors that name their tag keep the real type.
- `src/services/analysisPage.ts` — new helpers `partNamesElementTag(part)`
  and `selectorNamesElementTag(selector)` (the target is the innermost
  compound part), mirroring the wrapper's own default-tag decision.
- `src/services/cdpAnalyzer.ts` — the CSS-file flow passes
  `elementTypeKnown: selectorNamesElementTag(selector)`; the HTML flow
  keeps it `true` (real DOM tags).

The wrapper was NOT changed to fabricate `img` tags: a bare class selector
has no tag to name, so the honest answer is "type unknown ⇒ no decision",
not a guess. Selectors that DO name their tag (`img.x`) still emit the real
element and get the real verdict.

There is **no per-class-name or per-fixture detection anywhere** — every
signal is a CDP fact (computed styles, matched styles, selector structure
as data).

---

## 3. Tests

Unit (423 total, all pass — 8 new):
- `outOfFlowItemRules.test.ts` — out-of-flow now wins over any known
  parent; the new "unknown parent ('none') + out-of-flow ⇒ flagged" cases
  pin the CSS-flow regression; in-flow keeps the parent-unknown guard.
- `sharedHelpers.test.ts` — `hasPlaceSelfEffect` override-first semantics;
  explicit `block`/`flow-root`/`list-item` + unknown parent ⇒ inactive.
- `placeSelfRule.test.ts` — `display: block` override dims `place-self`
  with an unknown parent; no-override unknown parent stays undecided.
- `miscRules.test.ts` — `elementTypeKnown: false` ⇒ no decision for
  `object-fit`/`object-position`; a real `<img>` (known type) stays active.
- `layoutContextBuilder.test.ts` — `elementTypeKnown` passthrough and
  default.
- `analysisPage.test.ts` — `partNamesElementTag` / `selectorNamesElementTag`
  (class/id-only false, tag-naming true, innermost-part semantics).

Integration (19 total, real Chromium, all pass — 1 new):
- New CSS-file-flow test with the three regression selectors: `.abs-flex-item`
  `order`+`flex-basis` ⇒ `NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX`,
  `.place-item.bad` `place-self` ⇒ `REQUIRES_FLEX_OR_GRID_ITEM`, exactly 3
  issues, all mapped to the analyzed file; `.place-item.good`, `.object-fit-img`
  and `.object-fit-box` produce nothing.
- Existing phase3/4/5/6/7 and pipeline tests unchanged and green (no
  regressions; all per-fixture counts intact, including the standalone
  `.flex-item { flex: 1 }` hardening test).

Verified with throwaway CDP probes before removal: HTML flow flags
`.abs-flex-item`/`.out-of-flow-flex-item` flex-basis and `.place-item.bad`
place-self while keeping `.place-item.good` and `.object-fit-img` active
(TOTAL 82, unchanged); CSS-file flow flags flex-basis/order/place-self while
keeping all four active controls silent.

---

## 4. Deferred edges (known, documented, conservative)

- **`object-fit`/`object-position` on a bare class selector in the CSS-file
  flow stays ACTIVE (undecided)** — the wrapper cannot know the element's
  tag. A real `.object-fit-box` (a div) in the analyzed page is no longer
  dimmed in that flow; only the HTML flow, where the real tag is visible,
  dims it. This is the conservative trade-off that eliminates the false
  positive on `.object-fit-img`.
- **Out-of-flow flags the item property family even with a fully unknown
  parent** — this is correct (no abspos box can be an item), but the reason
  code is now the out-of-flow one rather than the item-required one on
  non-flex/grid parents. The reason is strictly more diagnostic.
- **Ruby / list-item UA-default display** behavior is unchanged (Level-4
  note) — only authored `display` overrides trigger the placement removal.
- **Chrome `CSSRuleValidator.js` still has no `place-self` rule**; Firefox
  `inactive-property-helper.js` remains the reference (unchanged from
  Level 4).

---

## 5. Acceptance criteria

- `npm run compile` — clean.  ✔
- `npm test` — 423/423 pass.  ✔
- `npm run test:integration` — 19/19 pass (real Chromium).  ✔
- Benchmark — 1 issue cold/warm, healthy cache ratios.  ✔
- No new false positives: `.object-fit-img`, `.object-fit-box`,
  `.place-item.good`, the standalone `.flex-item` and all phase fixtures
  stay silent where they should.  ✔
- Fix is general: driven by CDP facts (computed styles, matched styles,
  DOM hierarchy, selector structure as data), no fixture/class-name
  detection.  ✔

---

## 6. Follow-up fix — `z-index` on a static rule in the CSS-file flow

Reported after the PR: `.static-box { position: static; top: 20px; …
z-index: 5 }` — top/right/bottom/left faded but `z-index` stayed active in
the extension (CSS-file flow).

Root cause: the `z-index` rule held back whenever `parentDisplay === 'none'`
("the element may be the document root, where z-index is meaningful"). In
the CSS-file flow every standalone selector reports `'none'` (synthetic
parent), so the rule never decided — while the positioned-offset rules
(`top`/`right`/…) only need the element's own `position` and worked. The
HTML flow already flagged it (probe: `[REQUIRES_POSITIONED_OR_FLEX_GRID_ITEM]`).

Fix:
- `src/engine/layoutContext.ts` — new field `parentIsSynthetic` (default
  `false`), passed through `BuildOptions` by the builder.
- `src/inactive/rules/position/zIndex.ts` — the root-ambiguity guard now
  applies only when the parent is genuinely unknown
  (`!layout.parentIsSynthetic`). A synthetic wrapper parent provably sits
  on a real, non-root node, so the root ambiguity cannot exist and the rule
  decides: static + non-item ⇒ inactive.
- No change to item-required rules (`flex`, `place-self`, …): they keep the
  conservative no-decision path on synthetic parents (the Level-4
  `.flex-item { flex: 1 }` hardening is untouched).

Verification:
- `npm run compile` — clean. ✔
- `npm test` — 426/426 (3 new: synthetic-parent z-index inactive, synthetic
  positioned stays active, builder `parentIsSynthetic` passthrough). ✔
- `npm run test:integration` — 19/19; the Level-5 CSS-flow test now also
  asserts `.static-box|z-index` ⇒ `REQUIRES_POSITIONED_OR_FLEX_GRID_ITEM`
  (4 issues). ✔
- Probe (both flows, main fixture): `.static-box` now yields the same 5
  issues in HTML and CSS-file flows. ✔
- Benchmark healthy. ✔
