# LEVEL 4 — Context Resolution Hardening and Regression Fixes

PR scope: fix three structural defects of the inactive-CSS engine without
adding new features, families or fixture-specific logic.

---

## 1. Root causes (from the pre-fix audit)

| # | Symptom | Root cause |
|---|---------|------------|
| 1 | `vertical-align: middle` on `.table-cell` (table wrapper overridden to `display: block`) NOT flagged | The `vertical-align` rule treated computed `table-cell` as unconditionally active. Computed `display: table-cell` is produced by the UA `td, th` rule **even when no table box exists** in the ancestor chain — the cell's table formatting context is destroyed the moment its `<table>` wrapper is overridden to `display: block`. Computed styles alone cannot detect the break. |
| 2 | `place-self: center` on a flex item with an explicit `display: block` override NOT flagged | `hasPlaceSelfEffect` classified the element purely from the computed parent display (flex/grid ⇒ item). The explicit authored `display: block` (the `.bad` case) removes the element from the Box Alignment placement context even though it remains a flex/grid item. Firefox flags this (`place-self` has no effect); the vendored Chrome `CSSRuleValidator.js` contains no `place-self` rule, so the Firefox `inactive-property-helper.js` is the reference. |
| 3 | `.flex-item { flex: 1 }` falsely flagged when analyzing a bare CSS file (wrapper flow) | The CSS-file flow builds one wrapper element per standalone selector as a **top-level child of `<body>`**. The wrapper parent's computed `display: block` is an artifact of the analysis page — the real document parent is unknowable. The `flex` rule then saw a real (fabricated) parent and dimmed the property with confidence. |

Additional facts confirmed during the audit:

- UA rules **do** leak into `CSS.getMatchedStylesForNode.matchedCSSRules`:
  every `div` reports a `user-agent` `display: block` rule. Any
  declared-display signal must filter non-author origins.
- CDP duplicates each rule's `cssProperties` (declared + resolved copies),
  so a "last `display` wins" walk over `matchedCSSRules` recovers the
  cascade winner exactly (rules are listed least → most specific).
- `place-self` is absent from the vendored Chrome reference validator;
  Firefox's helper flags it on non-flex/grid items and on items whose
  display is explicitly overridden away from the item context.

---

## 2. Fixes (all at the context-builder / rule-evaluation boundary)

### 2.1 Context: two new immutable fields
`src/engine/layoutContext.ts`

- `hasTableBoxAncestor?: boolean` — `true` when some ancestor's computed
  display is `table`/`inline-table`; `undefined` = chain unresolved ⇒
  rules must make no decision.
- `declaredDisplay?: string` — the cascade-winning **authored** `display`
  declaration (UA/injected/inspector origins excluded); `undefined` =
  nothing authored.

`createLayoutContext` copies fields only when defined, so existing callers
and tests are unaffected.

### 2.2 Declared-display collection
`src/browser/matchedStylesCollector.ts` — `collectDeclaredDisplay()`

Walks `matchedCSSRules` in order, skips `user-agent`/`injected`/`inspector`
origins, and keeps the last `display` value (CDP's declared+resolved
duplicates cancel out; last = cascade winner). This is the SAME protocol
pass the analyzer already performs — zero extra round trips.

### 2.3 Table-box ancestor walk
`src/browser/layoutContextBuilder.ts`

- `resolveTableBoxAncestor(cdp, nodeId)` — memoized walk up the parent
  chain; each distinct ancestor's styles are fetched at most once via the
  existing `stylesCache`. Parent detection reuses the DOM tree
  (`DOM.getDocument` once per run) + `DOM.getParentNode` fallback.
- Conservative termination: an unreadable ancestor that is a dead-end
  (the root) resolves to `false`; an unreadable interior ancestor yields
  `undefined` (no decision).

### 2.4 Rules
- `src/inactive/rules/misc/verticalAlign.ts` — `display: table-cell` is
  active only when `hasTableBoxAncestor === true`. `false` ⇒ new reason
  code `BROKEN_TABLE_CONTEXT` (extended message explains the broken
  wrapper). `undefined` ⇒ no decision. Inline-level boxes ignore the
  check entirely.
- `src/inactive/rules/shared.ts` — `hasPlaceSelfEffect` now consults
  `layout.declaredDisplay`: a flex/grid item that **explicitly** declares
  a plain-block display (`block`, `flow-root`, `list-item`) loses its
  placement context ⇒ inactive. `undefined` declared display falls back to
  the computed-parent classification (the `.good` case stays active).
  `alignSelf`/`justifySelf` rules inherit the fix automatically.
- `src/inactive/reasonCode.ts` — `BROKEN_TABLE_CONTEXT`.

### 2.5 CSS-file flow (wrapper page)
- `src/services/analysisPage.ts` — exported `isStandaloneSelector()`
  (single compound part, no combinators).
- `src/services/cdpAnalyzer.ts` — `inspectSelectors` gained an options bag;
  `analyzeCssFile` passes `syntheticParents: true`. For standalone
  selectors the builder receives `parentIsSynthetic`, which reports
  `parentDisplay = 'none'` — item-dependent rules (`flex`, `place-self`,
  …) then take the conservative no-decision path instead of flagging
  against the fabricated `<body>` parent. Descendant selectors
  (`.a .b`, `.a > .b`) keep their real wrapper element as parent, so
  nested structures stay fully analyzable.
- `gatherNodeFacts` now also returns `collectDeclaredDisplay(...)`, handed
  to the builder as `options.declaredDisplay`.

There is **no per-class-name or per-fixture detection anywhere** — every
signal is a CDP fact (computed styles, matched styles, DOM hierarchy).

---

## 3. Tests

Unit (415 total, all pass):
- `layoutContextBuilder.test.ts` — table-ancestor resolution (none /
  parent / grandparent / unreadable interior ⇒ undefined / unreadable
  root ⇒ false / parentless ⇒ false / reset), synthetic-parent ⇒
  `NO_PARENT_DISPLAY` + no item flags, `declaredDisplay` passthrough.
- `miscRules.test.ts` — vertical-align: intact table ⇒ active; broken ⇒
  `BROKEN_TABLE_CONTEXT`; unresolved chain ⇒ no decision; inline boxes
  ignore the check.
- `sharedHelpers.test.ts` — `hasPlaceSelfEffect` with authored
  `block`/`flow-root`/`list-item` overrides (flex and grid), case /
  whitespace normalization, non-override declared displays stay active,
  no-declared-display fallback.
- `placeSelfRule.test.ts` — end-to-end rule: override ⇒
  `REQUIRES_FLEX_OR_GRID_ITEM`, no override ⇒ active.
- `analysisPage.test.ts` — `isStandaloneSelector` (compounds vs
  combinators vs whitespace).

Integration (18 total, real Chromium, all pass):
- `phase7` fixture — broken-table `vertical-align` ⇒ `BROKEN_TABLE_CONTEXT`,
  `.place-bad` `place-self` ⇒ `REQUIRES_FLEX_OR_GRID_ITEM`, exactly 2
  issues; intact-table / implicit-item / flex-child controls produce none.
- CSS-file flow — a standalone `.flex-item { flex: 1 }` produces **0**
  issues (synthetic-parent hardening).
- Existing phase3/4/5/6 and pipeline tests unchanged and green (no
  regressions; the 8 phase6 issues and all level-1/2/3 counts intact).

Verified with throwaway CDP probes before removal: probe3 (HTML flow) now
flags `.table-cell` and `.place-item.bad` while keeping `.flex-item`
active; probe4 (CSS-file flow) no longer flags `.flex-item`.

---

## 4. Deferred edges (known, documented, conservative)

- **Standalone selectors in the CSS-file flow** lose all item-dependent
  analysis (`flex`, `place-self`, `align-self`, …) by design — the real
  parent is unknowable. Flagging them would be guessing. If a future PR
  wants a heuristic, it must be opt-in and clearly labeled as such.
- **`display: inline-table` in the chain** counts as a table box for
  `hasTableBoxAncestor` (inline-table still establishes the table
  formatting context).
- **Ruby context**: `vertical-align` on ruby-family boxes is treated as
  active (pre-existing behavior, untouched by this PR).
- **`list-item` inside `display: block` flex/grid containers**: `place-self`
  is judged via `declaredDisplay` only; a computed-only `list-item` (e.g.
  UA-default on `<li>` inside a flex container) still counts as active —
  the UA rule is filtered by design, so only authored overrides trigger
  the removal.
- **Chrome `CSSRuleValidator.js` has no `place-self` / `vertical-align`
  rules**; Firefox `inactive-property-helper.js` remains the reference for
  both. If the vendored Chrome validator is ever updated, reconcile.

---

## 5. Acceptance criteria

- `npm run compile` — clean.  ✔
- `npm test` — 415/415 pass.  ✔
- `npm run test:integration` — 18/18 pass (real Chromium).  ✔
- Benchmark — 1 issue cold/warm, healthy cache ratios.  ✔
- No new false positives: phase7 active controls, phase6 controls,
  main fixture `.flex-item` and `.place-item.good` stay silent in both
  flows.  ✔
- Fix is general: driven by CDP facts (computed styles, matched styles,
  DOM hierarchy), no fixture/class-name detection.  ✔
