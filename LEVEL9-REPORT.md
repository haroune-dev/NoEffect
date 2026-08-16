# LEVEL9 — Embedded CSS: `<style>` blocks and `style=""` attributes analyzed

## The report

```html
<link rel="stylesheet" href="styles.css">   <!-- analyzed since Level 3 -->
<style>
  .block-inline {
    display: block;
    justify-content: center;   <!-- NOT analyzed — the gap -->
  }
</style>
<span style="display: block; justify-content: space-between;">  <!-- same -->
```

Until this level the analyzer only ever looked at CSS *files*. A
`justify-content` inside an HTML `<style>` block or a `style=""` attribute —
both equally provably inactive — was never evaluated, never mapped and never
dimmed.

## What changed

### 1. Discovery — `src/parser/htmlScanner.ts`
The 29-line legacy stub (`HtmlScanner` class, untested) is gone. `scanHtmlForCss(html)`
is a pure, position-exact tokenizer that returns `HtmlCssFragments`:
`styleBlocks` (raw text + document start position) and `styleAttributes`
(attribute value + document start position), both in document order.
It handles comments, raw-text `<style>`/`<script>` semantics (a `</style>` closes
the block even with weird attributes; a `</script>`-like sequence never does),
quoted values (`>` inside quotes does not close a tag), single-quoted/bare/
empty attributes, case-insensitive tag/attribute names, and never throws on
malformed HTML.

### 2. Parsing — `src/parser/cssAst.ts` + `src/cache/embeddedCssCache.ts`
- `parseDeclarationList(content)` parses a style-attribute value with the
  declaration-list grammar: the trailing declaration may omit its semicolon,
  `!important` stays inside the value (CDP reports it that way), comments are
  skipped, stray `{...}` blocks are skipped, malformed items are dropped.
- `embeddedParseCache` parses every fragment and **shifts** the fragment-relative
  ranges to document coordinates (line 0 adds the fragment column; other lines
  add only the line — a leading newline maps to the tag-end column). `<style>`
  rules flow through the existing `cssAst` parser, so blocks get the exact same
  declaration/name/value/anchor ranges as stylesheet rules.
- All three caches (`htmlFragmentCache`, `embeddedParseCache`,
  `embeddedMappingCache`) are content-addressed on the HTML content hash, so a
  byte-identical document never re-scans or re-parses. The single cache read
  also returns the content + hash, which drives the page-refresh decision —
  `fileHashCache` is no longer involved in the HTML flow.

### 3. Browser facts — CDP ground truth (experiments compiled in `src/scripts/`, then removed)
- Inline styles arrive in the `inlineStyle` section: **no selector**, a synthetic
  numeric `styleSheetId`, each property duplicated (ranged + range-less), ranges
  relative to the attribute VALUE TEXT.
- `<style>` blocks arrive as ordinary `matchedCSSRules` (origin `regular`,
  selector present), ranges relative to the block's textContent.
- `!important` is included in the CDP value (`"5px !important"`); the DOM tree's
  `attributes` is a flat name/value array.

The collector now surfaces the `inlineStyle` section as declarations tagged
`isInlineStyle` (`src/browser/matchedStylesCollector.ts`), and
`collectDeclaredDisplay` lets an inline `display` win the cascade — an inline
`display: block` overrides a rule's `display: flex`, exactly like the browser.

### 4. Mapping — `src/matcher/declarationMapper.ts` + `src/cache/mappingCache.ts`
- **`<style>` blocks are mapping targets just like stylesheets**: each block is
  one `LocalStylesheet` (path = the HTML file, hash = block content hash, rules
  with document-relative ranges), ordered BEFORE the linked sheets so block
  declarations map back into the HTML before an external sheet could claim them.
- **`matchInlineDeclaration`** maps selector-less inline declarations by content:
  normalized name/value against the owning attribute fragment's parsed
  declarations, and it returns `null` unless EXACTLY ONE candidate matches.
  Zero candidates (a shorthands expansion the browser made up) or two identical
  candidates (authored duplicates) both abstain — never a guess.
- **Inline targets** are found by walking the already-fetched DOM tree for
  `style` attributes and paired 1:1 with the source fragments (length AND
  trimmed content must agree); any disagreement aborts the whole inline flow
  (conservative abstain). The matching itself is cached per
  `(html path, html hash, fragment index, property name, property value)`.
- **`rulesFingerprint`** joined the mapping-cache entry key
  (`path|hash|fingerprint|batchSignature`): two identical `<style>` block texts
  at different document offsets can no longer share one mapping entry.

### 5. Dedupe — per local location
Dedupe switched from the declaration identity to `locationKey(declarationRange)`:
the same rule matching several nodes still collapses onto its source range,
while identical inline declarations on different nodes stay distinct issues
(each points at its own attribute text).

## Conservative abstention (by design)
The inline flow never fabricates a range. An inline declaration is reported
only when the DOM↔source pairing agrees 1:1 and the attribute text contains
exactly one matching declaration. Runtime-mutated attributes, entity-decoding
differences and template/svg quirks all degrade to "no verdict" rather than a
wrong dim.

## Follow-up fixes (same milestone)
- **Hover tooltips for embedded issues** — the hover provider was registered for
  `css` only, but embedded issues live in `html` documents; now `['css', 'html']`.
- **Duplicate declarations in one block** — every earlier duplicate of a property
  (rule or `style=""` attribute) provably has no effect: `blockId` tagging in the
  collector, `markOverriddenDeclarations` (per block, source order, last wins,
  range-less resolved copies filtered by name-with-ranged-in-block), and the
  fixed `OVERRIDDEN_BY_LATER_DECLARATION` engine verdict. Mapping is
  occurrence-based: `batchKeys` (selector|name|value + rank) and
  `matchInlineDeclaration(..., occurrenceIndex)` pair the k-th CDP report with
  the k-th parsed candidate; out-of-range ranks abstain (`null`).
- **Cross-sheet mapping steal** — declarations are now partitioned per sheet by
  source-range ownership (CDP ranges shifted by the sheet's `origin`; embedded
  blocks carry their document position), so same-selector/same-value rules in
  different sheets can never steal each other's candidates; mapping maps are
  keyed by sheet index (multiple `<style>` blocks share the HTML path).
- New tests: normalizer (block marking, per-block independence),
  `batchKeys`/mapper occurrence pairing (duplicates claim distinct slices,
  equal reports collapse, out-of-range abstain), engine override verdicts, and
  the `duplicates` fixture — external rule + `<style>` block + one-line inline
  attribute, all `justify-content` — asserting 7 issues, 7 distinct locations,
  per-source `rangeText` slices and the block issue mapping to its own line.

## Verification
- New unit tests: `htmlScanner` (18 — comments, raw-text, quoted `>`s, quotes
  in attributes, malformed HTML), `parseDeclarationList` (trailing semicolon,
  `!important`, comments, stray blocks, malformed items), `embeddedCssCache`
  (content-addressed hits, document-relative shifts for blocks AND attributes,
  identical texts at different positions, mapping-key determinism), collector
  inline section + inline-aware `collectDeclaredDisplay`, `matchInlineDeclaration`
  (unique/ambiguous/absent/`!important`), mapping-cache fingerprint.
- New integration test: the `embedded` fixture (external + `<style>` + `style=""`
  all declaring the same inactive property) yields exactly 3 issues, each mapped
  into its own source — the stylesheet, the style-block text and the attribute
  value slice (`rangeText` assertions on all three) — and the inline issue
  carries the empty selector.
- Full suites: **493 unit + 25 integration** green (up from 443/23), real
  Chromium; `tsc -p ./` clean.

## Files touched
- `src/parser/htmlScanner.ts` — stub replaced by `scanHtmlForCss`.
- `src/parser/cssAst.ts` — `parseDeclarationList` (style-attribute grammar).
- `src/cache/embeddedCssCache.ts` — NEW: fragment / parse (document-shifted) /
  inline-mapping caches + `inlineMappingKey`.
- `src/browser/matchedStylesCollector.ts` — `inlineStyle` section surfaced
  (`isInlineStyle`), `collectDeclaredDisplay` inline-aware.
- `src/engine/inactivePropertyEngine.ts` — `MatchedCssDeclaration.isInlineStyle`.
- `src/matcher/declarationMapper.ts` — `matchInlineDeclaration` (unique content
  match or null) + shared `toLocalMatch`.
- `src/cache/mappingCache.ts` — `rulesFingerprint` in the entry key.
- `src/services/cdpAnalyzer.ts` — `analyzeHtmlFile` rewrite (HTML cache read,
  block targets, refresh decision), `inspectSelectors` inline flow
  (`collectInlineTargets`, `gatherInlineFacts`, `mapInlineDeclaration`,
  location-based dedupe), `findLinkedStylesheets`/`collectStylesheetPaths`
  take the already-read HTML content.
- `src/test/fixtures/embedded/` + unit/integration tests listed above.
- Follow-up: `src/activation/activate.ts` (hover provider `['css','html']`),
  `src/engine/declarationNormalizer.ts` (`markOverriddenDeclarations` +
  resolved-copy filter), `src/browser/matchedStylesCollector.ts` (`blockId`),
  `src/inactive/reasonCode.ts` (`OVERRIDDEN_BY_LATER_DECLARATION`),
  `src/inactive/inactiveRuleEngine.ts` (override short-circuit),
  `src/cache/mappingCache.ts` (`batchKeys`), `src/matcher/declarationMapper.ts`
  (occurrence pairing), `src/cache/embeddedCssCache.ts` (`inlineMappingKey`
  occurrence), `src/services/cdpAnalyzer.ts` (per-sheet partition by source
  range + index-keyed mapping maps), `src/test/fixtures/duplicates/`.
