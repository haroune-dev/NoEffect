# NoEffect — PR Level 3: Pseudo-Element & Scroll-Context Rules

Highlights CSS properties that can never take effect on `::before` / `::after` /
`::first-letter` pseudo-elements, and properties that only work inside scroll
containers. All behavior is grounded in empirical probes against real Chromium
(headless, via CDP) before any rule was written.

## 1. Scope

Three new inactivity categories:

1. **`::before` / `::after` missing content** — when the pseudo-element has no
   `content` (missing, `none`, or `normal`) it generates no box, so its other
   declarations (width, height, background, display, …) are dead. The
   `content` declaration itself is never flagged.
2. **`::first-letter` unsupported property** — a fixed, empirically-derived
   allow-list of properties the browser actually honors on the generated
   first-letter box; everything else is flagged.
3. **Scroll-container-dependent properties** — `scrollbar-gutter` and
   `overscroll-behavior` only take effect when the element is (or will be) a
   scroll container; they are flagged when the effective `overflow` is
   provably non-scrollable (`visible`/`visible` or any `clip`).

## 2. How pseudo-element declarations reach the engine

CDP's `getMatchedStylesForNode().pseudoElements[]` is the only structural
source for pseudo rules (pseudo elements are absent from the DOM tree and
`DOM.resolveNode` returns nothing for them). Probes confirmed the payload
shape and cascade order:

- `matches[]` is ordered least → most specific; the last declaration wins.
- Each rule's `cssProperties` appears twice (declared copy + resolved copy);
  both copies carry the same name/value for `content`, so "last `content`
  wins" is safe.
- `::first-letter` matches are reported even for empty origin elements, which
  keeps the wrapper-page analysis strategy safe.

### 2.1 Changes

- `src/engine/inactivePropertyEngine.ts` — `MatchedCssDeclaration` gains
  `pseudoElement?: string` (`'before'`, `'first-letter'`, …; `undefined` means
  the element itself). This is the engine's dispatch key.
- `src/browser/matchedStylesCollector.ts` —
  `collectMatchedDeclarations()` now also surfaces the `pseudoElements[]`
  section with the pseudo tag (the origin `nodeId` is kept on every
  declaration). New export `collectPseudoContent(matchedStyles)` returns the
  cascade-winning **declared** `content` per pseudo type as a
  `ReadonlyMap<string, string>`; a missing key means "no content declared".
- `src/engine/layoutContext.ts` — `LayoutContext` gains
  `pseudoContent?: ReadonlyMap<string, string>` (copied into the context).
  `undefined` means the facts were not collected, in which case pseudo rules
  make **no** decision. An empty map means "collected, nothing declared".
- `src/browser/layoutContextBuilder.ts` — `build(cdp, nodeId, pseudoContent?)`
  stores the pre-collected facts; zero extra protocol calls.

## 3. Rules

New file `src/inactive/rules/pseudo/pseudoRules.ts` (registered after the
scroll rules in `src/inactive/ruleRegistry.ts`):

| Registry key | Condition to flag | Reason code |
|---|---|---|
| `::before` | `hasGeneratedContent(layout, 'before') === false` | `GENERATED_PSEUDO_MISSING` |
| `::after` | `hasGeneratedContent(layout, 'after') === false` | `GENERATED_PSEUDO_MISSING` |
| `::first-letter` | `!supportsFirstLetterProperty(name)` | `FIRST_LETTER_UNSUPPORTED_PROPERTY` |

Shared helpers live in `src/inactive/rules/shared.ts`:

- `isGeneratedContentPseudo(pseudoType)` — normalized membership in
  `GENERATED_CONTENT_PSEUDOS` (`before`, `after`).
- `hasGeneratedContent(layout, pseudoType): boolean | undefined` —
  `undefined` when the context has no `pseudoContent` (no decision), `false`
  when the type is not generated-content or its declared content is absent /
  `none` / `normal`, `true` otherwise.
- `supportsFirstLetterProperty(name)` — custom properties (`--*`) are always
  eligible; everything else must be in `FIRST_LETTER_SUPPORTED_PROPERTIES`.

`src/inactive/reasonCode.ts` gains `GENERATED_PSEUDO_MISSING` and
`FIRST_LETTER_UNSUPPORTED_PROPERTY`.

Engine dispatch (`src/inactive/inactiveRuleEngine.ts`): a declaration tagged
`pseudoElement: 'before'` is looked up as `::before` in the registry, never as
its property name; unknown pseudo types (e.g. `::selection`) yield no rule.

## 4. First-letter eligibility — empirical evidence

Probe result (`pseudo-test3.mjs`, one property per styled pseudo against a
first-letter-containing paragraph; computed styles vs. authored):

**Honored (allow-listed):** `float`, `vertical-align`, `font-family`,
`font-size`, `font-weight`, `font-style`, `line-height`, `letter-spacing`,
`word-spacing`, `text-transform`, `color`, `opacity`, `background`,
`background-color`, `background-image`, `margin`, `padding`, `border`,
`border-radius`, `box-shadow`, `text-decoration` (+ `-color`, `-style`),
`text-shadow`. The full `font`/`background`/`text-decoration` shorthands and
their remaining longhands are included by construction. `visibility`,
`transform-origin`, and `text-justify` are kept because Chromium records them
on the first-letter box (conservative — avoids false positives).

**Ignored (excluded):** `display`, `position`, `top`, `z-index`, `clear`,
`text-align`, `white-space`, `text-emphasis`, `width`, `height`, `min/max`
sizing, `box-sizing`, `overflow`, the flex/grid families, `justify`/`align`
families, `gap`, `transform`, `transition`, `animation`, `content`, `cursor`,
`columns`, `outline`. Note: `clear` and `text-emphasis` are excluded even
though CSS Text Decoration Level 3 permits them — the probes proved Chromium
ignores them.

## 5. Scroll-container-dependent properties

`src/inactive/rules/overflow/scrollRules.ts` now has 7 rules; both additions
reuse `createRequiresScrollContainerRule` and the existing
`REQUIRES_SCROLL_CONTAINER` code:

- `scrollbar-gutter`
- `overscroll-behavior`

Critical correction found while probing (Pseudo Level 3): `scrollbar-gutter:
stable` and `overscroll-behavior: contain` are **preserved** in computed
styles even with `overflow: visible` — the computed values never reset, so
there is no computed-style signal to rely on. The rules therefore depend
entirely on the effective-overflow scroll-container check (both effective
axes `visible` or any axis `clip` ⇒ provably non-scrollable ⇒ inactive).

CDP reports only `overflow-x`/`overflow-y` and `overscroll-behavior-x`/`-y`
longhands in matched/computed styles (never the shorthands) and pre-resolves
mixed-axis combos (`visible`+`auto` ⇒ `auto`/`auto`, `clip`+`scroll` ⇒
`hidden`/`scroll`). The scroll rules were already written against those
longhands, so no rule changes were needed for correctness — only the header
comment now documents the finding.

## 6. Analyzer & selector extraction

- `src/services/cdpAnalyzer.ts` — `gatherNodeFacts` now returns
  `{ declarations, pseudoContent }`; `inspectSelectors` builds each node's
  LayoutContext with the pseudo facts before inspecting. INFO logs for matched
  declarations now include the pseudo tag.
- `src/services/analysisPage.ts` — `extractQueryableSelectors` emits the
  **origin** selector of a pseudo-element selector (`.a::before` ⇒ `.a`) so
  CDP returns its `pseudoElements` section. Selectors whose origin still
  contains a pseudo-class (`.a:hover::before` ⇒ `.a:hover`) remain unqueryable
  and are dropped.

## 7. Verification

- **Typecheck:** `tsc -p ./` — clean.
- **Unit tests:** 391/391 pass (`npm test`). New `pseudoRules.test.ts` covers
  the full guard/eligibility matrix (missing/`none`/`normal`/real content,
  `content`-declaration skip, missing facts ⇒ no decision, missing display,
  supported/unsupported/custom properties, unrelated pseudo types ignored).
  `scrollRules.test.ts` covers all 7 properties, visible/clip combos ⇒
  inactive, effective scroll combos (`auto`/`auto`, `hidden`/`auto`,
  `scroll`/`auto`, `hidden`/`scroll`, `auto`/`hidden`) ⇒ active, and missing
  longhands ⇒ no decision. `ruleRegistry`, `analysisPage`,
  `inactiveRuleEngine` (pseudo dispatch), and `layoutContextBuilder` tests
  updated.
- **Integration tests:** 16/16 pass against real headless Chromium
  (`npm run test:integration`). New `phase6` fixture produces **exactly 8
  issues** — 4 on `.no-content-pseudo::before` (`width`, `height`,
  `background-color`, `display`), 2 on `.article-text::first-letter`
  (`display:flex`, `position:absolute`), 2 on `.non-scroll-box`
  (`scrollbar-gutter`, `overscroll-behavior`) — with exact reason codes,
  declaration ranges, property-name ranges, and icon anchor ranges, plus
  negative assertions for all active controls (`.with-content-pseudo::before`,
  eligible `::first-letter` declarations, `.scroll-box`).
- **Benchmark** (`node out/test/benchmark/benchmark.js`, real Chromium,
  `inactive` fixture): cold **545ms**, warm **25ms/25ms**, **~21.8x**
  speedup; AST cache 2 hits/1 miss, mapping cache 2 hits/1 miss. Pseudo
  collection and the new rules add no measurable overhead (pure lookup work).
  (No pre-change baseline exists — the repo is not under version control.)

## 8. Files changed

New: `src/inactive/rules/pseudo/pseudoRules.ts`,
`src/test/unit/pseudoRules.test.ts`, `src/test/fixtures/phase6/`.

Modified: `src/engine/inactivePropertyEngine.ts`,
`src/browser/matchedStylesCollector.ts`, `src/engine/layoutContext.ts`,
`src/browser/layoutContextBuilder.ts`, `src/inactive/rules/shared.ts`,
`src/inactive/reasonCode.ts`, `src/inactive/rules/overflow/scrollRules.ts`,
`src/inactive/inactiveRuleEngine.ts`, `src/inactive/ruleRegistry.ts`,
`src/services/cdpAnalyzer.ts`, `src/services/analysisPage.ts`,
`src/test/unit/ruleRegistry.test.ts`, `src/test/unit/analysisPage.test.ts`,
`src/test/unit/scrollRules.test.ts`, `src/test/unit/inactiveRuleEngine.test.ts`,
`src/test/unit/layoutContextBuilder.test.ts`,
`src/test/integration/cdpAnalyzer.integration.test.ts`,
`src/test/fixtures/styles.css` (stale `margin-top` comment corrected — it is
empirically active on `::first-letter`).

## 9. Deferred edge cases

- `::first-line` and `::selection` — no rules yet; `::selection` is a valid
  engine key today but deliberately unregistered (no decision).
- Pseudo-class-conditional origins (`.a:hover::before`) — still dropped by the
  selector extractor; a future level could generate origin-specific pages.
- `content` dependents — `::marker`, `::placeholder`, `::file-selector-button`
  follow the same missing-content pattern and can reuse
  `hasGeneratedContent` when Level 4 demands them.
- Overflow shorthands (`overflow`, `overscroll-behavior`) never appear as
  computed longhands in matched styles — rules must keep using the longhand
  pair; a shorthand-only fix-up remains engine-level work.
