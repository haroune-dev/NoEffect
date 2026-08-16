# LEVEL6 — Replaced Elements Context Detection

## Bug Report

`.object-fit-box` in the fixture (`src/test/fixtures/styles.css`) declares
`object-fit` and `object-position` with `/* ❌ should be faded */`. The HTML
flow dimmed both correctly, but in the CSS-file (extension) flow both stayed
fully active — the reported regression.

## Root Cause

Two compounding issues:

### 1. Level-5's `elementTypeKnown` abstention gate (the visible regression)

The previous PR introduced `elementTypeKnown` to stop a false positive on
`.object-fit-img` (a bare class selector) in the CSS-file flow. The gate made
`object-fit`/`object-position` abstain whenever the element's node name could
not be "proven real" — which fired for EVERY fabricated wrapper element. The
side effect: `.object-fit-box` (fabricated `<div>`) was never dimmed either.
The gate sat at the wrong boundary: the wrapper's node name IS the operative
element type. Tag-naming selectors already produce their real element
(`img.x` → a real `<img>`), and a fabricated `<div>` verdict for a bare
class selector is the correct verdict — object-fit on a div really has no
effect. The whole mechanism was dead code after the gate was removed.

### 2. A latent tree-map ordering race in `LayoutContextBuilder.build()`

While removing the gate, a deeper bug surfaced: `build()` evaluated
`nodeName: this.nodeNameMap.get(nodeId)` (an object-literal property) BEFORE
the `resolveSnapAncestor` call that triggers the `getParentMap` tree walk
filling `nodeNameMap`. On the FIRST analyzed node of a run the map was still
empty, so the first selector always got `nodeName=''` — silently disabling
every nodeName-dependent rule (object-fit, sizing, transforms, ...) for that
one selector. The HTML flow never hit it because its parent-display lookup
populated the map first; the synthetic-parent (CSS-file) flow skipped that
lookup. Fixed by eagerly awaiting `getParentMap(cdp)` at the top of `build()`
(the walk is memoized — zero extra protocol round trips after the first node).

## Changes

- `src/inactive/rules/misc/objectFit.ts` — removed the `elementTypeKnown`
  abstention gate; the rule again decides purely on node name
  (display-gate → box-suppression gate → replaced-element check).
- `src/engine/layoutContext.ts` — `elementTypeKnown` field, init wiring and
  build line removed.
- `src/browser/layoutContextBuilder.ts` — `BuildOptions.elementTypeKnown` and
  its passthrough removed; `build()` now populates the tree map eagerly so
  every context (including the first) sees its node name.
- `src/services/cdpAnalyzer.ts` — analyzer wiring for `elementTypeKnown`
  removed.
- `src/services/analysisPage.ts` — `partNamesElementTag` /
  `selectorNamesElementTag` helpers removed; the wrapper docstring documents
  the operative element type.
- Unit tests: the `elementTypeKnown` tests were removed from
  `miscRules.test.ts`, `layoutContextBuilder.test.ts` and `analysisPage.test.ts`
  (421 unit tests pass).
- Integration tests (`cdpAnalyzer.integration.test.ts`):
  - Level-5 test: the `.object-fit-*` scratch blocks and active-key
    assertions removed (its former "case 3" is superseded by Level 6); the
    header now lists the three Level-5 regression cases (out-of-flow
    flex-basis, place-self display override, z-index synthetic parent).
  - NEW Level-6 test: bare class `.object-fit-box` and `.object-fit-img`
    (fabricated `<div>`) ⇒ dimmed; tag-naming `img.object-fit-img` and
    `video.hero` (real replaced elements) ⇒ active; mapped locations and
    reason codes verified (20 integration tests pass, real Chromium).

## Verdicts after the fix

| Selector | Operative element | Verdict |
| --- | --- | --- |
| `.object-fit-box` | `<div>` (wrapper) / `<div>` (HTML flow) | `REQUIRES_REPLACED_ELEMENT` for both properties |
| `.object-fit-img` | `<div>` (wrapper) / `<img>` (HTML flow) | dimmed in CSS flow, active in HTML flow — each flow reflects its own operative element |
| `img.object-fit-img` | `<img>` | active |
| `video.hero` | `<video>` | active |

Both flows were verified against the real fixture: identical
`[REQUIRES_REPLACED_ELEMENT]` output for `.object-fit-box`, silence for
`.object-fit-img` in the HTML flow and the same operative-type semantics in
the CSS-file flow.

## Verification

- `npm run compile` clean.
- `npm test`: 421/421 pass.
- `npm run test:integration`: 20/20 pass (real Chromium).
- Benchmark: cold 776ms / warm ~32ms (~23.5x speedup), healthy.

## Deferred edges

- A `<div>` with `display: inline-block` etc. is still a non-replaced box —
  object-fit remains correctly inactive there (computed display is a
  separate axis from replaced-ness).
- Pseudo-element/attribute selectors stay out of the wrapper (pre-existing
  boundary, unchanged).
