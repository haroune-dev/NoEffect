# PROJECT_STATE — Internal Context & Progress Snapshot

> **Audience:** AI assistants and developers continuing work on this repository.
> This is NOT the user-facing README. It is a live technical snapshot of the
> project's architecture, progress, known regressions and test/validation state.
> Keep it updated whenever a milestone or architectural decision lands.

- **Repo root:** `/home/haroune-dev/Desktop/NoEffect`
- **Package:** `no-effect` v`0.9.0` — "NoEffect — CSS Inactive Property Highlighter"
- **Runtime:** VS Code `^1.85.0` — extension host runs on the Node SHIPPED INSIDE
  VS Code: **Node 18.15.0 on the minimum 1.85.0** (Electron 25.9.7; see
  `NODE-COMPAT-AUDIT.md` for the verified VS Code → Electron → Node matrix and
  the per-API audit). **Development/build/tests require Node ≥ 20** (unchanged).
  TypeScript `^5.3.0` (strict), only runtime dep: `ws`. Types pinned as permanent
  compile-time guards: `@types/vscode` EXACTLY `1.85.0`, `@types/node` `^18.19.0`.
- **Packaging (release pipeline):** the shipped artifact is an esbuild bundle
  `dist/extension.js` (target `node18.15`, matches the recorded compat policy;
  `ws` is BUNDLED in, so `dependencies` is empty — `ws` is a devDependency).
  `out/` is the dev/tests/benchmark layout, `dist/` is what ships
  (`main` → `./dist/extension.js`). Build: `npm run build` (or
  `npm run vscode:prepublish`). Package: `npm run test:pack` (full packaged
  VSIX smoke) or `npx @vscode/vsce package --no-dependencies` (VSIX ≈ 292 KB,
  well inside the 2 MB soft budget; see `PACKAGING-REPORT.md` for the full
  audit: payload, size, `ws`-bundling proofs, staged proof matrix).
- **Marketplace metadata (P0 storefront):** applied — `displayName`
  "NoEffect — Inactive CSS Inspector", v`0.9.0`, publisher `haroune-dev`,
  `preview: true`, `license: "PolyForm-Noncommercial-1.0.0"`, wired icon
  `./images/icon.png`, dark gallery banner `#1E1E1E`, categories/keywords,
`capabilities` (virtual workspaces disabled; `untrustedWorkspaces.supported`
  is now `true` so the extension ACTIVATES in untrusted workspaces and can
  surface its "NoEffect needs a trusted workspace" notification with
  Trust Workspace / Diagnose Setup actions — analysis itself stays safely
  blocked by the Phase 2 trust gating), explicit `onCommand` activation for
  every contributed command, and the configuration audit completed
  (markdownDescription for the experimental `analyzeOnType`;
  `chromiumPath` stays `machine-overridable`). No git remote exists →
  `repository`/`bugs`/`homepage` intentionally omitted (vsce warning
  recorded in `METADATA-REPORT.md`). License evidence + full audit:
  `METADATA-REPORT.md`.

---

## 1. Project Vision & Core Purpose

### Problem it solves
Developers write CSS properties that **have no effect** in the rendered browser
(the classic `justify-content` on a `display: block` box, `margin-top` on an
inline `::first-letter` box, `object-fit` on a `<div>`, `gap` on a non-flex
container, …). Static linters misjudge these because "has no effect" is a
**rendering** question, not a text question.

### How the engine answers it
NoEffect analyzes stylesheets with a **real Chromium engine over CDP** and reads
what the browser *actually computes*, then re-reports the inactive declaration
directly in the editor — dimmed with a DevTools-style warning tooltip. It ships
zero borrowed CSS-parsing of its own for evaluation: the **browser is the only
truthful source** of formatting-context facts.

### Architectural principles (invariants — do not violate)
1. **Context-driven rules.** Every declaration is judged against one immutable
   `LayoutContext` (display, position, floats, parent context, replaced-ness,
   pseudo-box contexts) built per DOM node in a single protocol pass. Rules
   never reason from raw property names alone.
2. **Zero hardcoding of selectors / class names.** Fixes are structural. A bug
   must never be patched by special-casing a literal selector or class (this
   was the explicit rule for the `object-fit`/`object-fit-img` regression).
3. **Strict W3C / rendering-semantics compliance.** Where the reference
   Chromium `CSSRuleValidator` is ported, implementations mirror rendering
   semantics. Computed browser values shape verdicts (`::first-letter` ignores
   authored `display`, `getComputedStyle(el, pseudo)` is ground truth, etc.).
4. **Determinism + caching.** AST, mapping and lifecycle caches make identical
   inputs near-free and never re-run the browser needlessly.
5. **One Markdown report per milestone PR** at repo root (`LEVEL3-REPORT.md` →
   `LEVEL11-REPORT.md`); add the next one when the next milestone lands.
6. **No-noise UX.** Decorations + one hover tooltip source; no squiggly lines,
   no Problems-panel spam; per-file decoration cache suppresses `setDecorations`
   when the state is unchanged.

---

## 2. Architecture & Key Components

### Module map (`src/`)

| Layer | Modules | Responsibility |
|---|---|---|
| **Activation / command** | `activation/activate.ts`, `activation/commands.ts`, `extension.ts` | Register commands (`noEffect.analyzeCurrentFile`, `clearDecorations`, `showStatus`, `diagnoseSetup`, `showOutputLogs`), wiring, deactivation → `defaultLifecycle.dispose()` |
| **Phase 3 UI (first-run & visibility)** | `activation/constants.ts`, `statusModel.ts`, `statusBarController.ts`, `readinessController.ts`, `firstRun.ts`, `statusViewModel.ts`, `diagnoseSetup.ts` | Status bar item (Right/100, one per lifetime), readiness controller (generation-counter freshness, 300 ms coalescing, bounded first snapshot), one-time global-state first-run welcome, Show Status Quick Pick, Diagnose Setup summary, context keys `noEffect:ready`/`enabled`/`setupNeeded`/`workspaceBlocked` |
| **Analysis orchestration** | `services/cdpAnalyzer.ts`, `services/sessionManager.ts`, `services/debounceService.ts`, `services/watchService.ts`, `services/analysisPage.ts`, `services/companionResolver.ts`, `services/companionUrl.ts`, `services/companionSettings.ts` | Entry points `analyzeCssFile` / `analyzeHtmlFile` / `analyzeFixture`; editor-file analysis; analysis `<link>`-driven page building; wrapper-page generation; cross-directory companion-document resolution over one shared URL model (matcher + DevServer agree on what a browser requests) |
| **Parser** | `parser/cssAst.ts`, `parser/htmlScanner.ts`, `parser/sourceMapResolver.ts` | Position-exact CSS AST (rules, selectors, declarations, ranges); HTML embedded-CSS scanner (`<style>` blocks + `style=""` fragments); sourceline/column resolution |
| **Caches** | `cache/astCache.ts`, `cache/mappingCache.ts`, `cache/fileHashCache.ts`, `cache/embeddedCssCache.ts`, `cache/decorationStateCache.ts`, `cache/companionCache.ts`, `cache/multiPassCache.ts` | Content-addressed AST, mapping (rules fingerprint), file-hash, HTML fragment / embedded parse / inline-mapping, decoration-state, hash-validated companion-resolution caches; per-pass + merged multi-companion caches (Level 11) |
| **Browser / CDP** | `browser/browserRunner.ts`, `browser/cdpClient.ts`, `browser/devServer.ts`, `browser/pageLoader.ts`, `browser/lifecycleManager.ts`, `browser/matchedStylesCollector.ts`, `browser/layoutContextBuilder.ts` | Chromium launch, WS CDP client, static+virtual DevServer, persistent page session with transparent recovery, DOM/matched-style collection, layout-context build |
| **Engine** | `engine/layoutContext.ts`, `engine/declarationNormalizer.ts`, `engine/inactivePropertyEngine.ts`, `engine/verdictMerge.ts` | Immutable `LayoutContext` + `PseudoBoxFacts` + pseudo-box contexts; declaration normalize/dedupe; declarative engine surface; multi-companion verdict lattice (⊥ ≤ I ≤ A, JOIN = max, companion-independent keys, `mergePassOutcomes`) |
| **Rules** | `inactive/inactiveRuleEngine.ts`, `inactive/ruleRegistry.ts`, `inactive/inactiveRule.ts`, `inactive/reasonCode.ts`, `inactive/rules/…` (29 modules, 8 families) | Two-stage dispatch; single owner per property; standardized reason codes |
| **Matcher / mapping** | `matcher/declarationMapper.ts`, `matcher/propertyMatcher.ts`, `matcher/ruleMatcher.ts`, `matcher/positionMapper.ts` | Link CDP declaration/model back to exact local ranges (`declarationRange`, `propertyNameRange`, `iconAnchorRange`); `matchInlineDeclaration` for `style=""` content |
| **Diagnostics / UI** | `diagnostics/decorationPlanner.ts`, `diagnostics/decorations.ts`, `diagnostics/inactivePropertyExplanation.ts`, `diagnostics/overrideWinnerPlanner.ts` | Plan ranges, render dim + inline-`after`-icon decorations, single hover provider, fallback tooltips; override-winner `→|` gutter badges (theme-aware light/dark SVG, hover listing the overridden lines + jump link, `onDidChangeActiveColorTheme` recreate-and-reapply) |
| **Config** | `config/settings.ts` | `enabled`, `analyzeOnSave`, `analyzeOnType`, `debounceMs`, `highlightStyle` (`both|iconOnly|dimOnly`), `chromiumPath`, `ignoredFiles`, `maxFileSizeKb` |
| **Environment readiness** | `environment/browserDetection.ts`, `environment/workspace.ts`, `environment/fileEligibility.ts`, `environment/readiness.ts` | Browser discovery/validation (`BrowserDetector`, cached, injectable), workspace scheme classification, deterministic file eligibility (scheme→language→generated→ignore→size), `EnvironmentReadiness` state feeding the Phase 1 failure contracts |
| **Failure taxonomy (Phase 1)** | `failure/model.ts`, `failure/classifier.ts`, `failure/errors.ts`, `failure/cancellation.ts`, `failure/outcome.ts`, `services/analysisRunner.ts` | `FailureKind`/`FailureCode`/`FailureSeverity` taxonomy, `AnalysisOutcome` contract (success/partial/skipped/cancelled/failed), typed errors, central classification, cleanup, supersede/cancel |
| **Outcome axes & coverage (Phase 4/11)** | `failure/coverage.ts`, `status/derive.ts`, `failure/outcome.ts` | Three-axis outcome (`AnalysisLifecycle` idle/running/settled, `AnalysisMode` active/limited/failed, `CoverageData` envelope with companion evidence bookkeeping), deterministic `collectCoverage()` with provenance (`SkipSource`), single derivation `deriveOutcome`/`coverageLines`/`coverageSummaryLine`/`companionCoverageLines`/`issueEvidenceNote` feeding status bar, Show Status Coverage/Companions sections and output channel |
| **Models** | `models/cssIssue.ts`, `models/cssLocation.ts`, `models/cdpSourceRange.ts`, `models/analysisResult.ts` | Issue/Location/range value types; `AnalysisNamespace` (`cssGlobal`/`htmlEmbedded` — the Phase 6 single-writer namespaces), `AnalysisResult` carries `namespace` + `epoch` |
| **Phase 6 orchestration (multi-file, no forced save)** | `services/sessionManager.ts`, `services/cdpAnalyzer.ts` (F1/F4), `activation/commands.ts` (F3/F5 wiring), `activation/readinessController.ts` | F1 pure analysis-context fingerprint (`analysisContextFingerprint`, `ANALYSIS_CONTEXT_VERSION=1`, Top-K resolutions + companion hashes + budget; `STALE_CONTEXT_FINGERPRINT` sentinel never records/skips); F4 single-writer namespace per run (CSS-file runs write only `cssGlobal`, HTML runs only `htmlEmbedded`; linked-sheet issues flow through the cssGlobal namespace); F3 skip gate (skip ⟺ recorded success/partial ∧ content FP ∧ context FP unchanged); F5 `SessionManager` store with epoch-scoped entries, `beginAnalysis`/`completeAnalysis`/`recordSuccessfulAnalysis` gate; F2 trigger matrix in `activate.ts` (CSS/companion file events, settings/resolver change, readiness blocked→ready retry, HTML open → ensure fresh global outcome, 300 ms burst coalescing) |

### Data flow (CSS file input to decoration output)
```
CSS file on disk
  → astCache.getOrParse()           (content-addressed CSS AST, exact ranges)
  → extractQueryableSelectors()      (drops @-rules, pseudo-classes, attrs, siblings;
                                      pseudo-ELEMENT selectors reduce to their origin)
  → analyzeCssFile():
        resolveCompanionsFor(css) → ranked REAL linking HTML list (cross-directory:
            distance-first, index.html-then-alphabetical tiebreak, bounded,
            workspace-root served, hash-validated-cache warm list)
            K up to maxCompanions → analyzeWithCompanions(): one sequential
                pass per companion (withSessionPass), semantic verdicts merged
                as ⊥ ≤ I ≤ A (lattice JOIN), per-pass + merged caches
          : no companions → in-memory wrapper page (one element/selector)
  → defaultLifecycle.prepare()       (persistent browser+CDP+DevServer+page; smart refresh)
  → inspectSelectorsCore(): per selector:
        locateNode (Runtime.evaluate querySelector + DOM.requestNode)
        gatherNodeFacts (CSS.getMatchedStylesForNode → normalized declarations,
                         pseudoContent, pseudoTypes, fetchPseudoBoxStyles,
                         declaredDisplay)
        layoutContextBuilder.build() → immutable LayoutContext
                                      (+ pseudoBoxContexts, + typeIsSynthetic)
  → engine.inspect() per declaration  (2-stage dispatch; returns inactive result+reason)
                                  — verdicts captured per pass (A / I+issue)
  → mergePassOutcomes()              (multi-companion evidence merge; I ⊔ A = A)
  → materializeMerged() → CssIssue[] (ONLY merged-I issues, bounded evidence
                                      metadata, deduped, only real local ranges)
  → DecorationManager.applyDecorations()
        dimDecorationType opacity 0.45 + italic
        iconDecorationType after-attachment SVG anchored at the final ';'
        provideInlineIconHover()     (single tooltip source; bounded-evidence
                                      note on multi-companion dims)
```

*HTML-file flow*: `analyzeHtmlFile` serves the real document, derives selectors
from its linked stylesheets, and inspects against the real DOM (no wrapper).
*Fixture flow*: `analyzeFixture` serves a fixture directory for tests/benchmark.

### Rule families (all registered centrally in `ruleRegistry.ts`)

| Family | Modules | Notable properties / contexts |
|---|---|---|
| Flex | `flexContainerRules`, `flexItemRules`, `flexOnlyContainerRules`, `placeSelfRule` | `justify-content`, `align-items`, `gap`, `flex*`; `place-self`; flex-only container wording |
| Grid | `gridContainerRules`, `gridItemRules`, `gridTemplateRules` | `grid-template-*`, `grid-*` item placement; grid-lane-aware |
| Position | `topRightBottomLeft`, `inset`, `zIndex`, `positionAnchorRules` | requires positioned / flex-grid-item; anchor-positioning |
| Flow | `float`, `clear`, `listRules` | float/clear applicable-to checks; `list-style` on list items |
| Overflow | `overflow`, `overflowX`, `overflowY`, `scrollRules`, `textOverflow` | clip/scroll contexts; `scrollbar-gutter`, `overscroll-behavior`, scroll-snap; `text-overflow` truncation preconditions |
| Box | `sizingRules`, `boxSuppressionRules`, `inlineSuppressionRules`, `transformRules`(+`backdropFilterRule`) | `min/max-width/height` (box generation), `display: contents`, inline-box margin suppression, transforms/transformable |
| Misc | `objectFit`, `pointerEvents`, `verticalAlign` | replaced-element (`object-fit`/`object-position`), inline `vertical-align`, pointer-events applicability |
| Table | `paddingRules`, `tableRules` | table-internal box padding; broken table chain (`BROKEN_TABLE_CONTEXT`) |
| Pseudo | `pseudoRules` | `::before`/`::after` generated-content rules (registered under `::<type>` keys), `::first-letter` whitelist + formatting-context verdicts |

~35 standardized `REASON_CODES` (see `src/inactive/reasonCode.ts`) — stable,
machine-readable, consumed by tests/reports.

---

## 3. Current Progress & Milestone Tracker

**Status: Milestone Level 11 complete (multi-companion evidence merging) +
failure-UX Phases 1–6 done (Phase 6 = multi-file orchestration: no forced CSS
save, context-fingerprint skips, single-writer outcome namespaces) + the
interactive override-navigation milestone (jump-and-flash hovers).**
The planned roadmap (Levels 1–8) is implemented and stable plus the
embedded-CSS milestone (Level 9), the cross-directory companion milestone
(Level 10), the multi-companion evidence-merge milestone (Level 11), the
interactive overridden-declaration navigation milestone (Level 12) and the
failure-UX phases (Phase 1 = failure
taxonomy, Phase 2 = environment detection / safe defaults, Phase 3 = status bar,
first-run welcome, Show Status / Diagnose Setup, Phase 4 = three-axis outcome
model + coverage collector + single status derivation, Phase 5 = recovery,
retry & diagnose setup, Phase 6 = multi-file orchestration F1–F5); the project is in
an **expansion/hardening phase** (real-world rule coverage, robustness,
hygiene) rather than core construction.

| Level | Scope | Status |
|---|---|---|
| 1–2 | Extension skeleton, parse, mock analyzer, decoration pipeline, source-range mapping | ✅ (bootstrap) |
| 3 | Real CDP analyzer, matched-styles collection, pseudo content, fixture tests | ✅ `LEVEL3-REPORT.md` |
| 4 | CDP→local mapping, caches, real ranges | ✅ `LEVEL4-REPORT.md` |
| 5 | Persistent session, recovery, benchmark, regression hardening | ✅ `LEVEL5-REPORT.md` |
| 6 | `LayoutContext` + registry/engine (Phase 1–3), reason codes, replaced-element semantics | ✅ `LEVEL6-REPORT.md` |
| 7 | Extended applicability families (grid-lane, gap, table, anchor, flex-wrap), context hardening | ✅ `LEVEL7-REPORT.md` |
| 8 | `::first-letter` formatting-context verdicts (`margin-top` dimmed), computed pseudo-box facts | ✅ `LEVEL8-REPORT.md` |
| 8.x (extra) | `object-fit` fabricated-type abstention + companion-document resolution; inline-icon baseline alignment | ✅ (see §3 Recent fixes) |
| 9 | Embedded CSS: `<style>` blocks + `style=""` attributes scanned, parsed (document-shifted), evaluated and mapped into the HTML source | ✅ `LEVEL9-REPORT.md` |
| 10 | Cross-directory companion-document resolution: linking HTML found across directories (relative-up/down, root-relative, `<base href>`) over one shared URL model with the DevServer; deterministic distance-first selection; bounded + hash-validated-cache warm path | ✅ `LEVEL10-REPORT.md` |
| 11 | Multi-companion evidence merging: every ranked linking document up to the Top-K budget analyzed in its own sequential pass (plus the evidence-expansion tail — candidates beyond the budget whose documents contain the stylesheet's selector tokens, so budget truncation can never lose the only document that gives a declaration effect); semantic verdicts merge as the lattice ⊥ ≤ I ≤ A (`I ⊔ A = A` — a declaration is dimmed only when NO real context gives it effect); companion-independent merge keys (parsed local ranges); per-pass + merged caches (warm run = one cache read + pure merge); companion coverage envelope + bounded-evidence tooltips | ✅ `LEVEL11-REPORT.md` |
| 9.x (failure UX) | Phase 1: central failure taxonomy (`FailureKind`/`AnalysisOutcome`, typed errors, classification, cleanup, supersede/cancel) | ✅ (Phase 1 contracts; see §2 `failure/`) |
| 9.x (failure UX) | Phase 2: environment detection & safe defaults: browser discovery/validation, workspace trust/unsupported handling, file eligibility, dirty-file/live-analysis policy, safe local infra, readiness state feeding the Phase 1 contracts | ✅ `PHASE2-REPORT.md` |
| 9.x (failure UX) | Phase 3: first-run & visibility: status bar item, readiness controller (context keys, change-only logs, stale-safe), one-time first-run welcome, Show Status / Diagnose Setup / Show Output Logs commands | ✅ `PHASE3-REPORT.md` |
| 9.x (failure UX) | Phase 4: outcome axes & coverage: lifecycle×mode×coverage outcome model (`AnalysisLifecycle`/`AnalysisMode`/`CoverageData`), deterministic coverage collector, single status/text derivation feeding status bar + Show Status + output channel | ✅ `PHASE4-REPORT.md` |
| 9.x (failure UX) | Phase 5: recovery, retry & diagnose setup: session-health state machine (`SessionHealth`) with epochs, typed `RETRY_POLICY` backoff/retries, single-flight atomic restart, bounded awaits (`withTimeout`/`sleep` with token disarm), epoch-stamped outcomes, crash/CDP-reconnect notification policy (dedupe), `restartAnalysisSession` + `clearCache` commands, upgraded Diagnose Setup report + opt-in live browser probe | ✅ `PHASE5-REPORT.md` |
| 9.x (failure UX) | Phase 6: multi-file orchestration (F1–F5): pure context fingerprint from the validated companion cache; skip gate keyed by content+context fingerprints; single-writer outcome namespaces (`cssGlobal` per CSS file keyed (contentFP, contextFP, epoch), `htmlEmbedded` per HTML file keyed (contentFP, epoch)) so linked-sheet issues flow through one fresh multi-companion outcome and `<style>`/`style=""` issues stay page-local; no forced CSS save; trigger matrix (file events, settings/resolver change, readiness retry, HTML open, 300 ms coalescing); 11 mandated tests (T1–T11) on the `multipage-orchestration` fixture; smoke suite made a real gate (bundle-channel spy + verdict handshake) | ✅ `PHASE6-REPORT.md` |
| 12 | Interactive overridden-declaration navigation: hover tooltip of an `OVERRIDDEN_BY_LATER_DECLARATION` duplicate gets `Overridden by a later declaration of the same property.` + a TRUSTED `[Go to overriding declaration (Line N)]` command link (no arrow adornment); the analyzer records the cascade winner's local property-name range (`issue.overrideTarget`, via the `overriddenBy` pointer materialized through the owner-sheet mapping for rule declarations and the occurrence-ranked fragment mapping for inline attributes); `noeffect.jumpAndHighlight` (hidden from the palette via `menus.commandPalette` `"when": "false"`) focuses the document, moves the cursor to `(line-1, character-1)`, reveals centered and flashes the winner with the theme-native `editor.wordHighlightStrongBackground` color (adaptive in Dark/Light/HC); stale-guard: the range is only flashed when the live text still reads the expected property name, otherwise the line is revealed without flashing; single-flash invariant (one timer + one decoration, cancelled on repeat clicks / editor-document change-close / dispose) | ✅ (this milestone; pure module `src/diagnostics/overrideJumpTarget.ts` + controller `src/activation/overrideJump.ts`) |

### Fully implemented & stable today
- Full CDP pipeline (CSS + HTML + fixture flows + **embedded CSS**), position-exact
  mapping, dedupe.
- Persistent session with **transparent recovery** (browser crash / WS loss).
- AST + mapping + file-hash + embedded (fragment/parse/inline) caches;
  decoration-state cache (skip unchanged).
- All rule families in §2, all reason codes, two-stage pseudo dispatch.
- Standing controls in fixtures: every `❌ should be faded` / `✅ should stay active`
  comment is asserted by integration tests (styles.css + companion index.html).
- **Interactive override navigation (Level 12):** overridden duplicates carry
  the cascade winner's local range and their hover tooltip links to
  `noeffect.jumpAndHighlight` — a trusted command link that jumps the cursor
  and flashes the winning declaration with the theme-native highlight for 1 s.
  Verified live on the `duplicates` fixture (external rule + `<style>` block +
  `style=""` attribute) and through the packaged smoke on both VS Code builds.

### Recently resolved regressions / edge cases
- **Multi-page stress suite (5 failures) fixed.** The engine now dims
  exactly what a page chain proves inert and nothing else. Root causes
  were split between the fixture and the engine:
  - *Fixture:* `.active-somewhere` was made a flex CONTAINER (not the
    intended flex ITEM — `align-self` applies to items, so no page ever
    proved it effective), and `.flex-item-only` / `.grid-item-only` were
    direct children of `body` with no flex/grid parent anywhere. The pages
    now provide the real item contexts (about.html wraps the element in a
    flex container; deep/b wraps the two items in flex/grid containers).
  - *Engine (replaced-element evidence):* the `<img>` page (home.html)
    linked the stylesheet with `<base href="/">` + an absolute `/test/…`
    href — a deployed-URL style the on-disk layout cannot serve, so the
    page was never resolved, never selected, and its `object-fit` evidence
    (A) never reached the merge. Two fixes: the companion resolver now
    pairs deployment-kind links (root-relative/base) whose URL model
    output does not exist on disk with the analyzed file BY BASENAME (a
    link that resolves to an existing file keeps exact URL matching; plain
    relative broken links never pair), and `COMPANION_EXPANSION_BUDGET`
    grew 3 → 4 so a 7-page project (K=3) is judged in full — a unique
    evidence page can no longer rank itself out of the run.
  - *Engine (pseudo-elements):* generated `::before`/`::after` boxes are
    evaluated through their Chromium-derived pseudo-box LayoutContext.
    Computed pseudo `content` is the source of truth for box generation;
    when it produces a box, `display: flex|grid` and all other supported
    layout properties continue into their normal property rules rather
    than being suppressed merely for belonging to a pseudo-element.
- **Level 11 evidence expansion: evidence beyond the Top-K budget is never
  lost.** The Top-K budget (`maxCompanions`) used to truncate the companion
  selection BEFORE any judgment — a declaration whose ONLY judging document
  ranked outside the budget was silently skipped (never dimmed, no matter
  how inactive it really was), and worse: the saved state depended on which
  pages happened to fit in K. The selection is now the shared Level 11 rule
  (`src/engine/companionSelection.ts` + `selectorScan.ts`): the Top-K ranks
  PLUS a small deterministic expansion tail (`COMPANION_EXPANSION_BUDGET =
  4`) of candidates beyond the budget whose documents contain the
  stylesheet's queryable-selector tokens (a pure word-boundary containment
  superset — over-expansion only, never under-expansion; hash-gated
  scan-result cache so probes cost one read per page). The record site
  (`analyzeWithCompanions`) and the post-run freshness probes
  (`companionContextFingerprintFor`) select through the SAME function from
  the SAME validated snapshot, and `analysisContextFingerprint` no longer
  truncates internally (the caller passes the final selection) — the
  recorded and re-derived fingerprints agree by construction, so the
  skip gate and the decoration freshness probes keep holding and nothing
  re-blurs on save. Proven by a new integration test (rank-4 document
  judged through the expansion; verdict flips when THAT document's evidence
  changes; flips back on revert) and T7 updated to the new semantics
  (K=1 still judges the rank-2 evidence via the expansion).
- **Stale-DOM companion pass fixed (pre-existing, found by the expansion
  test).** `runCompanionPass` detected "companion changed" via
  `fileHashCache.getOrRead(...).hit` — but the freshness validation
  (`companionCache.getValidatedEntry`) and the re-resolution `set()` read
  EVERY companion's hash BEFORE the pass runs, so the flag was always false
  by the time the pass checked it. With the persistent session parked on
  that page's previous load and no forced refresh, an edited companion page
  was judged against its STALE DOM (computed display of the OLD markup)
  until the session died — evidence flips froze permanently. The pass now
  ALWAYS forces the page refresh; the DevServer reads every request from
  disk, so the price is at most one same-URL reload per cold run.
- **Phase 6 (multi-file orchestration, F1–F5) landed** — see `PHASE6-REPORT.md`:
  five fixes make multi-file coordination sound. **(F1)** a pure analysis-context
  fingerprint replaces the ad-hoc companion count: `analysisContextFingerprint`
  (`ANALYSIS_CONTEXT_VERSION=1`) hashes the Top-K companion resolutions (path +
  content hash) + budget from the **validated companion cache only** — never a
  fresh workspace walk; a stale cache yields the `STALE_CONTEXT_FINGERPRINT`
  sentinel, which is never recorded and never treated as the run's identity.
  **(F2)** the trigger matrix is explicit and test-locked (CSS change, companion
  HTML create/change/delete, settings/resolver change, readiness blocked→ready
  retry, HTML open → ensure linked-CSS global fresh, 300 ms burst coalescing).
  **(F3)** the skip gate is two-keyed: a run is skipped only when a SUCCESSFUL
  or PARTIAL run was recorded against the same content FP AND the same context
  FP — failed/cancelled/blocked runs are never marked handled, and a companion
  create/change/delete with byte-identical CSS still re-analyzes. **(F4)** single
  writer per namespace: CSS-file runs write ONLY the `cssGlobal` entry (the one
  multi-companion outcome; HTML runs may ensure/reuse it) and never `htmlEmbedded`;
  HTML runs write only page-local embedded issues — the stale half-merge case is
  gone. **(F5)** `SessionManager` (`beginAnalysis`/`completeAnalysis`/
  `recordSuccessfulAnalysis`/`getIssuesForFile`) stores
  `cssGlobal[cssPath]` keyed (contentFP, contextFP, epoch) and
  `htmlEmbedded[htmlPath]` keyed (contentFP, epoch); the epoch in the key means
  a superseded-session result is never read back. 11 mandated tests (T1–T11)
  drive the `multipage-orchestration` fixture (❌/✅ controls): companion-change
  re-analysis, cancellation pre-seed + skip-gate, `.active-somewhere` staying
  active, `.secondary-only` dimming, fresh-global reuse on HTML open, flex-item
  re-evaluation, K-in-context-FP (maxCompanions), F4/F5 single-writer unit proof,
  readiness retry-hook dedupe, epoch supersede + rapid open/close, embedded
  `<style>` block isolation, and the freshness-gate regression (see the
  freshness-fix note). Unit: **806**; integration: **49**.
- **Freshness-aware CSS decorations** — the editor path used to apply the last
  stored issues to a visible CSS file BEFORE validating them: a stale or
  single-page result could dim `.active-somewhere` until some later trigger
  rebuilt the global outcome. Fixed end to end: `applyCssGlobalDecorations`
  and `evaluateActiveEditor` now probe `SessionManager.getFreshCssIssues`
  (content FP + analysis-context FP + session epoch) FIRST — fresh → apply,
  anything else → clear — before deciding whether (re)analysis is needed;
  the raw `getIssuesForFile` read remains only for HTML embedded outcomes.
  Results are recorded under the EXACT context fingerprint the run judged
  against (`cdpAnalyzer.getLastContextFingerprint`, stamped in
  `analyzeWithCompanions` at run time, never recomputed post-run): a mid-run
  companion change can never register a result under a foreign context.
  Proven by a multipage-fixture integration test (pre-drift snapshot retired,
  post-drift snapshot applied) + `getFreshCssIssues`/runner passthrough unit
  tests. Unit: **806**; integration: **49**.
- **First-run multi-companion root cause fixed** — "nothing dims on first
  open (not even `.all-inactive`), dimming appears only after a save" had
  THREE stacked causes, all now fixed and smoke-asserted:
  1. **THE root cause — the cold session rebuild ran under a 4 s cap.**
     `restart_cleanup` (`{ maxRetries: 0, timeoutMs: 4_000 }`) was used as
     the budget for the ENTIRE cold rebuild (`withTimeout(this.restore(), …
     'Session rebuild timed out')` in `lifecycleManager.restartNow`) — but
     the rebuild legitimately spans launch (15 s) + CDP connect (3 × 5 s) +
     domain setup. On machines where the browser takes > 4 s to expose its
     DevTools port (captured in the user's real-editor log: **11 s** with a
     system google-chrome, then `WebSocket was closed before the connection
     was established` / `ECONNREFUSED` after the cap killed the rebuild
     mid-launch), EVERY companion pass of the first analysis failed with
     `Session rebuild timed out (4000ms)` → `0 issue(s)` → nothing dimmed;
     the save-triggered rerun hit an eventually-warm session and dimmed.
     Fixed: a dedicated `session_build` budget (30 s = launch + connect +
     slack) now caps the rebuild; `restart_cleanup` stays a short local
     cap for the process-tree SIGKILL escalation. Policy-invariant unit
     test added (`session_build ≥ launch + connect`, `restart_cleanup` stays
     a cleanup cap).
  2. `cdpAnalyzer` logged the ENTIRE raw CDP payload of every
     `CSS.getMatchedStylesForNode` / `Runtime.evaluate` response
     (`logger.debug('[CDP] Raw matched styles response', rawMatched)`): a
     multi-hundred-KB object per selector, appendLine-d into the output
     channel mid-first-pass on a cold run — the extension host stalled writing
     it (the observed `Unable to log remote console arguments…` + 100s hang).
     The raw dumps are gone; a bounded one-line summary (rule/declaration
     counts) replaced them.
  3. A partial run (any failed companion pass) was still treated as a
     success: recorded as the skip identity and applied to decorations —
     so the poisoned ⊥ merge stuck until a content change. Now the analyzer
     returns NO issues for an incomplete-evidence merge (a failed pass leaves
     its declarations ⊥, indistinguishable from absence — an I could be
     masking an A), the failed companion(s) land in coverage
     (`companions.failed`), and the command layer refuses to record the skip
     identity or the cssGlobal namespace for such runs — the next trigger
genuinely re-attempts them. All three symptoms are covered by the smoke
      multipage scenario (first analysis of the process on
      `multipage-orchestration`; asserts the `[Result]` record lists
      `.all-inactive` + `.secondary-only` and NEVER `.active-somewhere`).
      Unit: **807**; integration: **49**; smoke: PASS on 1.85.0 + stable.
- **Warm-run epoch poisoning fixed** — the apply-then-CLEAR decoration
   flicker ("dimming never sticks after the first run"): the command layer
   builds a FRESH `AnalysisRunner` (and thus a fresh `CdpAnalyzer`) per
   trigger, while a WARM run (every pass resolved from the content-addressed
   multi-pass cache) prepares NO session — the fresh analyzer's
   `lastSessionEpoch` stayed `0`. The runner stamped `outcome.epoch = 0`; the
   command layer read `0 !== live epoch` as "superseded session" (drop the
   result, `[Lifecycle] Analysis result dropped: epoch 0 superseded by N`)
   and recorded the cssGlobal namespace under epoch 0 — so every later
   `getFreshCssIssues` probe (live epoch, `defaultLifecycle.epoch`) missed
   the entry and CLEARED the valid decorations. Fix
   (`cdpAnalyzer.getLastSessionEpoch`): a run that prepared no session this
   trigger reports the LIVE epoch — a warm hit derives from the same resolved
   content + context fingerprint as any current-world determination, so it is
never a superseded-session artifact. Locked by the integration warm-path
    regression (fresh-instance warm run: `getLastSessionEpoch() === live >= 1`).
    Unit: **807**; integration: **49**; smoke: PASS on 1.85.0 + stable.
- **CSS-save STALE-context flicker fixed** — after the epoch fix, dimming
   still blinked off/on briefly around every CSS save: the fs watcher
   (`activate.ts` companionWatcher, `**/*.{html,htm,css}`) reset
   `companionCache` on CSS-file events too, even though it only re-triggers
   analysis for HTML documents. The analyzer computes its context fingerprint
   DURING the run (from the then-valid snapshot) and records the cssGlobal
   outcome under it; the watcher reset lands mid-run, so the post-run
   freshness probes (`evaluateActiveEditor`, `applyCssGlobalDecorations`)
   recompute `companionContextFingerprintFor` → no validated entry →
   `STALE_CONTEXT_FINGERPRINT` → the fresh (content, context, epoch) outcome
   looks unknown → CLEAR → the next trigger re-applies. A CSS event can NEVER
   change the companion selection (companions are HTML documents linking the
   sheet) and a stylesheet edit is already captured by the cssGlobal CONTENT
   fingerprint — the reset added no correctness, only the artificial STALE.
   Fix: `companionCache.reset()` now happens ONLY on HTML-document events
   (create/delete/change); CSS events leave the resolution cache untouched,
   so the probes hit the just-recorded identity and dimming persists
   continuously until the evidence genuinely changes. HTML/settings/
   workspace events keep their reset + re-analysis (correct: the world
   changed). Unit: **807**; integration: **49**; smoke: PASS on 1.85.0 +
   stable.
- **Smoke suite made a real gate** — the in-host suite previously compared
  `process.exitCode` that the extension-host test runner swallows (host exits 0
  → PASS even on assertion failure), and it spied on the DEV logger while the
  loaded extension runs the BUNDLE (a different logger instance — the suite
  could never observe a settled analysis). Fixed in `src/test/smoke/`:
  `EXTENSION_ID` is derived from the manifest (`publisher.name`, i.e.
  `haroune-dev.no-effect` — the hardcoded `noeffect.no-effect` never matched),
  the log spy patches `vscode.window.createOutputChannel` BEFORE activation so
  the bundle's logger binds the spy channel, and the launcher gates on a
  verdict file (`NOEFFECT_SMOKE_RESULT`) written by the host — a missing or
  `FAIL` verdict fails the run even when `runTests` resolves. Negative-tested
  (deliberate failure → exit 1 with the real assertion). PASS on 1.85.0 and
  stable with a settled end-to-end analysis.
- **Level 11 post-fix: the merged-cache poison (reported `test-multipage`
  case)** — a declaration matched only in a secondary-ranked companion
  (`⊥ ⊔ I = I`) never dimmed and stayed broken across reruns: the merged-
  cache key does not encode evidence completeness, and a cold run whose
  companion pass failed transiently cached the PARTIAL merge; warm reruns
  then echoed it forever (failed passes are never cached per-pass, so the
  failure was unrecoverable until a CSS change). Fix: the merged result is
  cached only when EVERY selected pass succeeded
  (`mergedResultIsCacheable` in `cdpAnalyzer.ts`); partial runs re-attempt
  the failed companion next run. Companion passes additionally retry once
  in-run (250ms backoff) so a flaky first navigation cannot leave the run
  incomplete. Locked by `mergedCachePolicy.test.ts` (4)
  and the `test-multipage` integration regression (cold `⊥ ⊔ I = I` merge,
  warm intactness). Unit: **784**; integration: **35**.
- **Level 11 (multi-companion evidence merging) landed** — see `LEVEL11-REPORT.md`:
  `analyzeCssFile` now resolves the RANKED list of every linking document
  (Level 10 order) and analyzes up to the Top-K evidence budget
  (`noEffect.maxCompanions`, default 3, K = evidence budget — never a
  correctness guarantee) in sequential per-companion
  passes over the persistent session. Per-pass verdicts form the lattice
  ⊥ ≤ I ≤ A and merge as the JOIN: a declaration is dimmed only when NO
  observed real context gives it effect — `I ⊔ A = A` (one real effective
  page anywhere absorbs the inactive verdicts of the rest), `I ⊔ ⊥ = I`
  (uncontradicted inactive evidence stands), failed passes contribute NO
  lattice elements and surface in companion coverage. Merge keys are
  companion-independent (parsed LOCAL declaration ranges — never CDP
  ranges), issues carry bounded evidence metadata (`evaluatedCount`,
  `inactiveCount`, `analyzedCompanions`), the Show Status view gained a
  Companions section and dimmed tooltips a bounded-evidence note; selector
  counts are bookkept once post-merge (located union). Warm runs are ONE
  merged-cache read (css hash + K + companion-hash tuple) + a pure merge —
  zero navigation, zero per-pass consults (integration-proven). The wrapper
  page never mixes with real evidence. Unit: **780** (+30 verdictMerge/
  multiPassCache/derive); integration: **34** (+1 warm-path, `crossdir-multi`
  reworked to the merged semantics).
- **Level 10 (cross-directory companion-document resolution) landed** — see
  `LEVEL10-REPORT.md`: `analyzeCssFile` now finds its linking HTML across
  directories (relative-up/down, root-relative, `<base href>`) through one
  shared URL model (`companionUrl.ts`) that the DevServer also serves by —
  "what resolves is what serves". Selection is deterministic (closest
  document, `index.html` first, then alphabetical; distance 0 = the legacy
  same-directory policy, bit-identical), strictly bounded (`maxDepth` +
  `maxCandidates` budgets, `node_modules`-style pruning), and the warm path
  reuses the resolution via a content-hash-validated cache (no re-scan;
  benchmark page-reuse proof). New settings `companionSearchDepth` (6) and
  `companionMaxCandidates` (500). Unit: **750** (+41: companionUrl/Resolver/
  Cache + devServer); integration: **33** (+7 fixtures
  `crossdir-{down,up,root,base,multi,negative}` + HTML cross-dir flow).
- **Failure-UX Phase 5 (recovery, retry & diagnose setup) landed** — see `PHASE5-REPORT.md`:
  the persistent session is now owned by a typed state machine (`SessionHealth`:
  `idle` → `preparing` → `ready` → `degraded`/`dead` → `restarting` → …; every
  transition is an allowed arc, crash → `dead`, CDP drop → `degraded`, both
  recovered on the next `prepare()`). A typed `RETRY_POLICY` table (op →
  `maxRetries`/`timeoutMs`) backs every wait: `withTimeout`/`sleep` are the only
  await gatekeepers and now **disarm their internal timer when the run's
  cancellation token fires** (a cancelled hung analysis no longer keeps the
  event loop alive up to the full budget — the unit suite dropped from ~30 s
  back to ~6 s). Outcomes carry the producing session `epoch`; results from a
  superseded epoch are dropped before decorations. Manual runs (or an
  in-flight explicit run) that hit a crash/`CDP_DISCONNECTED` failure notify
  once per code per epoch (`NotificationDedupe`, `openSettings` /
  `diagnoseSetup` / `restartSession` / `showOutput`
  actions); routine
  self-healing stays silent. New commands `noEffect.restartAnalysisSession`
  (single-flight atomic) and `noEffect.clearCache` (AST/mapping/file-hash/
  embedded/decoration caches). Diagnose Setup upgraded to a per-check report
  with a one-time opt-in "Run Live Browser Probe" Quick Pick item
  (`collectDiagnoseReport`; no browser is launched by plain diagnose). Unit:
  707 passing (+22 sessionPhase5 +4 runner epoch/timeout tests; analysisRunner
  suite ~0.3 s; 709 today with the source-hygiene guard); integration 26/26
  (recovery tests green against the rewritten
  lifecycle, and the `embedded` fixture was restored to its documented
  one-inactive-declaration-per-source shape — its earlier 4-vs-3 discrepancy
  was fixture drift, not pipeline behavior).
- **Failure-UX Phase 4 (outcome axes & coverage) landed** — see `PHASE4-REPORT.md`:
  the outcome contract is now three axes in one object (`status` + `lifecycle`
  + `mode` + `coverage`). A pure coverage collector (`failure/coverage.ts`)
  derives the envelope from classified failures + run metrics with provenance
  for every skip (input / selector / stage / analyzer), the status bar finally
  reflects analysis runs (Analyzing… → result row; stale/superseded outcomes
  map to a neutral Idle, never a misleading failure), the Show Status view
  gained a Coverage section, and the output channel logs one deterministic
  coverage line. All text (status bar, tooltip, view lines, log line) comes
  from one derivation module (`status/derive.ts`) — no surface formats
  statuses on its own. Unit tests: 681 passing; integration: the real CDP
  pipeline produces a coverage envelope end-to-end.
- **Failure-UX Phase 3 (first-run & visibility) landed** — see `PHASE3-REPORT.md`: a
  single right-aligned status bar item (created once, updated in place, deduped
  by presented state), a readiness controller that owns all UI-state derivation
  (generation counter against stale async results, 300 ms coalescing for
  settings/trust triggers, bounded first-snapshot wait with eventual apply,
  context keys initialized to safe false, change-only `[Readiness]` log lines),
  a one-time first-run welcome persisted in global state (`noEffect:firstRunShown.v2`,
  session + persistence guards prevent any re-show loop), Show Status rendered
  as a Quick Pick from the pure status view model (no raw paths, no raw
  errors, declarative actions), and Diagnose Setup producing a sanitized,
  stale-aware environment summary. All logic is vscode-free and unit-tested.
- **Failure-UX Phase 2 (environment readiness) landed** — see `PHASE2-REPORT.md`: browser
  detection (configured override first, then platform auto-detect; lightweight
  `--version` probe; cached until `invalidate()`), conservative file
  eligibility (512 KB default max; generated bundles + dependency/build/VCS
  dirs ignored by default; user `ignoredFiles` merged), workspace
  trust/type gating (untrusted → skip; non-`file` workspace schemes →
  skip), saved-file-only policy (dirty files skip with `FILE_UNSAVED`; live
  typing analysis not supported → `analyzeOnType` warns `LIVE_ANALYSIS_UNAVAILABLE`),
  and safe infrastructure (DevServer binds `127.0.0.1`, rejects path
  traversal, `no-store` responses; browser runs with an isolated temp
  profile and feature-disabling flags).
- **Duplicate declarations of the same property not detected** — the first two
  copies of `justify-content: center; justify-content: center; ...` in ONE
  declaration block (rule or `style=""` attribute) have no effect by CSS
  semantics. The collector tags every block (`blockId`), the normalizer marks
  the earlier duplicates (`markOverriddenDeclarations`, source order, last
  wins), and the engine answers them with the fixed
  `OVERRIDDEN_BY_LATER_DECLARATION` verdict — no context rule runs. CDP's
  range-less "resolved" copies (`center` → `center center`, `#b00` →
  `rgb(176,0,0)`, shorthand expansion) are dropped from the override marking by
  a name-with-ranged-in-block filter. Mapping is occurrence-based: the k-th CDP
  report of a (name,value) pairs with the k-th parsed candidate
  (`batchKeys`/`matchInlineDeclaration(..., occurrenceIndex)`); per-location
  dedupe collapses equal reports of one authored declaration.
- **Cross-sheet mapping steal** — two sheets defining the same selector with the
  same property text (an external rule + a `<style>` block) collided in the
  occurrence ranks, shifting every duplicate one line and mis-locating
  overridden issues. Each declaration is now partitioned to the ONE sheet whose
  parsed declarations contain its source range (CDP ranges shifted by the
  sheet's origin; embedded blocks carry their document position), and the
  mapping-cache maps are keyed by sheet index instead of path (multiple blocks
  share the HTML path). Covered by the `duplicates` fixture (external rule +
  `<style>` block + inline attribute, same tuple).
- **No hover tooltip for issues in HTML files** — embedded-CSS issues live in
  `html` documents; the hover provider is now registered for `['css', 'html']`.
- **Embedded CSS not analyzed** — `<style>` blocks and `style=""` attributes are
  now scanned (`htmlScanner.scanHtmlForCss`), parsed with document-relative
  ranges (`embeddedParseCache` shift), evaluated via the same engine, and mapped
  back into the HTML: blocks like stylesheets (content-hash targets, ordered
  first), inline declarations content-matched with unique-candidate abstention
  (`matchInlineDeclaration`), DOM↔source 1:1 pairing aborting on any
  disagreement. Identical block texts at different offsets stay distinct via
  `rulesFingerprint`; dedupe is per local location (`LEVEL9-REPORT.md`).
- **`::first-letter` `margin-top` not dimmed** → pseudo box gets its own computed
  facts (`getComputedStyle(el, pseudo)`); engine stage-2 dispatch falls back to
  the property rule against the pseudo box context (`LEVEL8-REPORT.md`).
- **`object-fit` false positive** on `.object-fit-img` in the CSS-file flow:
  wrapper-fabricated types are marked `typeIsSynthetic` and `object-fit`/`object-position`
  abstain; also **false negative** on `.object-fit-box` fixed by **companion-document
  resolution** — `analyzeCssFile` now analyzes against a same-directory HTML that
  links the stylesheet (real DOM types), falling back to the synthetic wrapper.
- **Float `none` blockify edge** — only a *non-`none`* float blockifies an inline
  pseudo box (unit-caught); `pseudoBoxContexts` map is frozen.
- **Synthetic-parent hardening** — standalone `.flex-item` (no combinators) keeps
  flex active instead of being judged against a fabricated `<body>` parent.
- **Level-5 regressions** (three cases) and **table-context hardening**
  (`.non-flex`/`display: table-cell` under overridden table wrapper) all green.
- **Inline warning-icon vertical alignment** — SVG canvas now places the triangle
  base on the editor text-baseline edge (browser = baseline-aligned inline-block);
  verified DPI-independent at 1× and 2× device scale factors.

---

## 4. Active Issues, Regressions & Technical Debt

### False positives (fixed; keep guarded)
- None open. Guards: `typeIsSynthetic` abstention (fabricated types), companion
  document for real types, computed pseudo-box facts, frozen contexts.

### False-negative zones (by design — known and documented)
- **`analyzeCssFile` without a companion document:** bare class/id selectors get
  an unknown (fabricated) type → type-dependent rules **abstain** (e.g.
  `object-fit` on `.hero` stays active even if a `<div>` is likely). Conservative
  by design; correct-by-construction on the real document.
- **Companion flow skips unmatched selectors:** selectors absent from the
  companion HTML produce no issue at all (no element to judge).
- **Embedded-CSS abstentions (by design):** an inline `style=""` declaration is
  reported only when the DOM↔source pairing agrees 1:1 (length + trimmed
  content) and the attribute text contains exactly one matching declaration.
  Runtime-mutated attributes, entity-decoding differences, template/svg quirks
  and authored duplicate declarations all degrade to no verdict.
- **Unqueryable selector classes:** pseudo-classes (`:hover`, `:not`), attribute
  selectors, sibling combinators (`+`,`~`), `@media`/`@keyframes` preludes and
  bare/leading `*` selectors are **dropped** from analysis (wrapper cannot match
  them). These declarations simply never get a verdict.
- Pseudo-CLASS selectors are dropped even after pseudo-ELEMENT origin reduction
  (`.a:hover::before` stays unanalyzable).

### Context failures / coverage gaps
- No `place-content`, `row/column-gap`-vs-`gap` nuance handling beyond what is
  registered; no multicol-property family beyond `gap` multi-col applier.
- `@media`-scoped declarations are evaluated at the page's current viewport;
  there is no per-`@media` context re-evaluation.
- No CSS custom-property (`var()`) value resolution — values are matched by the
  browser, but replacement of `var()` tokens in explanations is not resolved.

### Architectural limitations / deferred improvements
- **Runtime Node/VS Code compatibility: resolved.** The extension host runs on
  the Node shipped inside VS Code (Node 18.15.0 on the minimum 1.85.0). A full
  audit (`NODE-COMPAT-AUDIT.md`) found **zero** Node-20-only built-ins on the
  runtime graph, and the permanent guards are in place: `@types/vscode` pinned
  exactly to `1.85.0` and `@types/node` to the `^18.19.0` line, so newer APIs
  are compile-blocked. Activation + a full real-Chromium analysis are proven on
  the oldest host by the smoke suite (see §5) — the min-version story is
  truthful and verified, no runtime code changes were needed.
- **Live analysis while typing is not supported.** `noEffect.analyzeOnType`
  stays disabled by default; any enablement surfaces `LIVE_ANALYSIS_UNAVAILABLE`
  via readiness. Analysis reads saved files from disk only (dirty files skip
  with `FILE_UNSAVED` — no save prompts by design).
- **No browser download/install and no remote connections.** Detection covers
  common installs (override → PATH → platform defaults); a missing browser
  disables analysis (`CHROMIUM_NOT_FOUND`) until one is installed. Override is
  never executed in untrusted workspaces.
- **Companion-document search is cross-directory and multi-document**
  (`LEVEL10-REPORT.md`/`LEVEL11-REPORT.md`): the linking HTML is found by a
  bounded, deterministic BFS upward from the stylesheet (workspace-root served
  when known, ancestor-chain otherwise) and RANKED (closest first, `index.html`
  first, then alphabetical). Every ranked companion up to the Top-K evidence
  budget (`noEffect.maxCompanions`, default 3) is analyzed in its own pass and
  the verdicts merge as ⊥ ≤ I ≤ A — a declaration is dimmed only when no real
  context gives it effect, so a farther effective page corrects a closer
  inactive one. Documents beyond the budget are recorded in companion coverage
  (`skipped`). `node_modules`/`dist`/`out` trees are pruned before any I/O;
  unresolvable or external hrefs and a companionless stylesheet fall back to
  the wrapper flow.
- **`vertical-align` not exposed by VS Code's decoration API** → icon alignment
  is baked into the SVG canvas height (14×14 box). Any future resize must
  re-derive geometry and re-verify at 1× AND 2× DPI; `line-height` must stay
  untouched.
- **README "Current Status" is resolved** — rewritten to v0.9.0: real Chromium/CDP
  pipeline, exact mapping for all three CSS sources, multi-companion
  orchestration, interactive override-jump hovers, readiness gating and the
  verification suites. The Marketplace metadata (displayName, description,
  categories, keywords, banner) is complete in `package.json`; `LEVEL3-9-REPORT.md`
  and this document remain authoritative for internal detail.
- **License:** `PolyForm-Noncommercial-1.0.0` — the `LICENSE` file at repo
  root is the official verbatim text fetched from
  `https://polyformproject.org/licenses/noncommercial/1.0.0` (verified against
  the SPDX listing: `spdx.org/licenses/PolyForm-Noncommercial-1.0.0.html`
  confirms the identifier is on the current SPDX list, released 2019-07-09;
  vsce does not validate the SPDX string — it ships the file as the
  `Microsoft.VisualStudio.Services.Content.License` asset). The license
  restricts downstream COMMERCIAL use (noncommercial purposes only) — a
  deliberate choice, stated factually; README wording is a separate task.
- **ESLint is not configured** (`npm run lint` fails; no `eslint.config`/`.eslintrc`);
  type-checking = `tsc -p ./` is the real gate.
- **Vestigial/duplicated artifacts: resolved.** All stale `.js` twins under
  `src/` (`browserRunner.js`, `cdpClient.js`, `devServer.js`, `cdpAnalyzer.js`,
  `analyzer.js`, `logger.js`, `models/{index,cssIssue,cssLocation,analysisResult}.js`)
  and the legacy `mockAnalyzer.ts` were deleted (release-hygiene task); the dead
  `export * from './mockAnalyzer'` line was removed from `src/services/index.ts`.
  `src/` is TypeScript-only, enforced by the `sourceHygiene.test.ts` guard
  (fails on any `.js/.mjs/.cjs` under `src/`; whitelist `ALLOWED_NON_TS_FILES`
  is empty; also asserts `outDir: out`, `rootDir: src`, `allowJs` off — see §5).
  `.gitignore` covers `out/` and `dist/`.
- **Release packaging: landed.** The extension now ships as a single esbuild
  bundle (`dist/extension.js`, `main` → it) with `ws` bundled in — the VSIX
  contains exactly `package.json`, `README.md` and `dist/extension.js`
  (≈ 97 KB). Full audit in `PACKAGING-REPORT.md` (payload tables, size vs. the
  2 MB soft budget, metafile `ws`-bundling proofs, staged proof matrix, `.vsix`
  vs `.gitignore` governance). Known environmental limitation: the packaged
  VSIX smoke (`npm run test:pack`, Stage C) launches a real VS Code window on
  the host display — on busy/memory-constrained machines the extension host
  can fail to start (2 of 4 reruns stalled; the run-2 pass is recorded in the
  report); the runner prefers VS Code's own `--install-extension` and falls
  back to VSIX extraction (identical result) because the CLI installer hangs
  windowed on this host.
- **Integration suite requires real Chromium** (skipped gracefully when absent);
  no VS Code UI/e2e automation for the decoration layer.
- **Phase 6 namespace semantics (by design):** `cssGlobal` entries exist only
  for CSS-file runs (or HTML runs that ensured them); linked-sheet issues in an
  HTML run therefore surface via the cssGlobal namespace, not the HTML run's own
  return. `htmlEmbedded` covers only page-local `<style>`/`style=""` issues.
  A companion change with identical CSS content re-analyzes by design (context
  FP changed) — warm skips require both fingerprints unchanged.
- **Smoke verdict handshake:** the launcher gates on the in-host verdict file
  (accepted: `HOST_OK`). A host that crashes without writing a verdict fails the
  launcher — correct, but means the suite has no "informational only" mode.

---

## 5. Test Suite Status & Validation

| Suite | Count | Status |
|---|---|---|
| Unit (`src/test/unit/*.test.ts`) | **844** | ✅ all passing (`npm test`) |
| Integration (`src/test/integration/*.test.ts`) | **51** | ✅ all passing (real Chromium; the advanced-multipage probe now asserts all five stress scenarios) |
| Smoke (`src/test/smoke/`) | min + stable | ✅ activation + full analysis on the oldest VS Code (see below) |
| Benchmark (`src/test/benchmark/benchmark.ts`) | — | ✅ |

### Verification commands (run all four before merging work)
```bash
npm run compile            # tsc strict — the type gate
npm test                   # unit suite (844)
npm run test:integration   # real-Chromium integration (51, all passing)
npm run test:smoke:all     # host smoke on VS Code 1.85.0 (min) + stable
node out/test/benchmark/benchmark.js   # cold/warm perf
```

### Release packaging (see `PACKAGING-REPORT.md` for the full audit)
```bash
npm run build                              # esbuild → dist/extension.js (ws bundled)
npx @vscode/vsce package --no-dependencies # VSIX (vsce runs vscode:prepublish = build)
npx @vscode/vsce ls                        # assert payload: package.json, README.md, LICENSE, images/icon.png, dist/extension.js
npm run test:pack                          # full packaged-VSIX smoke (Stage C) — needs an idle display
```

### Smoke suite (oldest-version proof — `@vscode/test-electron`)
Downloads real VS Code builds (cached under `.vscode-test/`, gitignored) and
runs `out/test/smoke/smokeMain.js` inside the extension host:
`npm run test:smoke` (stable), `npm run test:smoke:min` (1.85.0),
`npm run test:smoke:all` (both). The in-host suite logs `process.versions.*`
(empirical proof of the shipped-Node mapping), asserts the Node-18 line on the
min build, activates the extension, checks all 8 contributed commands, runs one
full analysis through the shipped command (expects the deterministic `Coverage`
log record; graceful skip without Chromium), and fails on unhandled rejections.
The log spy patches `vscode.window.createOutputChannel` BEFORE activation so
the shipped BUNDLE's logger is observed; `EXTENSION_ID` is derived from the
manifest (`haroune-dev.no-effect`); the launcher gates on the host's verdict
file (in-host failures are not reliably propagated through `runTests`).
Last measured: **PASS on 1.85.0 (`node=18.15.0 electron=25.9.7`) and on stable
(`node=24.18.0 electron=42.7.1`)** with a settled full analysis on both —
see `NODE-COMPAT-AUDIT.md`.

### Source-hygiene guard
`src/test/unit/sourceHygiene.test.ts` (2 tests, part of the 709) walks the whole
`src/` tree and fails if any `.js`/`.mjs`/`.cjs` file appears (whitelist
`ALLOWED_NON_TS_FILES`, empty by design — static assets need a written
justification), and asserts `tsconfig.json` keeps `outDir: out`, `rootDir: src`
and `allowJs` off so emission can never land next to sources. Post-compile
check: zero `.js` under `src/`.

### Coverage highlights
- Fixture-driven integration tests (`phase3`–`phase7` + `embedded` +
  `active`/`inactive` dirs, each with `styles.css` + `index.html`) assert
  **exact issue counts, mapped ranges, reason codes AND active controls** (no
  false positives). The `embedded` fixture covers the three sources of one
  inactive property (linked sheet, `<style>` block, `style=""` attribute) with
  per-source `rangeText` assertions; the `duplicates` fixture covers
  override-semantics duplicates across the same three sources AND now asserts
  that every override verdict carries `overrideTarget` at the cascade-winning
  declaration (the winner's property-name slice, strictly after the dead
  duplicate in source order — the data behind the Level 12 jump link).
- Level 12 navigation contract is unit-locked: `overrideJumpTarget.test.ts`
  (11 tests) pins the exact link encoding
  (`encodeURIComponent(JSON.stringify([{ line, character, length, propertyName }]))`),
  the exact two-line hover markdown, the 1-based→0-based payload conversion,
  the payload parser (rejects malformed/multi-arg shapes) and the stale-guard
  predicate (match, stale text, out-of-bounds, CRLF, case-insensitivity);
  `declarationNormalizer.test.ts` pins the `overriddenBy` winner pointer
  (per-block, case-insensitive name matching).
- Cross-directory companion fixtures (`crossdir-down`/`up`/`root`/`base`/
  `multi`/`negative`, Level 10 + 11) prove the resolver against real documents
  reached across directories (relative `../`, root-relative, `<base href>`),
  that selection is distance-first (`crossdir-multi` asserts the resolution
  order directly), that the merged verdict lattice absorbs a closer inactive
  verdict under farther effective ones (`I ⊔ A = A` → 0 issues), that the
  multi-companion warm path is one merged-cache read with zero per-pass
  consults, and that `node_modules`-pruned linkers degrade to the wrapper
  flow (`crossdir-negative`).
- Regression tests: Level-5 three cases, Level-6 object-fit (synthetic abstain,
  companion, real-DOM), Level-8 `::first-letter` `margin-top`, synthetic-parent
  `.flex-item`, HTML-change refresh, Level-9 embedded CSS.
- Infrastructure tests: AST/mapping caches hit taxonomy, single browser/server/CDP
  session reuse, CDP **disconnect recovery** and **browser-crash recovery**.
- UI alignment is guarded statically: `inlineWarningIcon.test.ts` asserts the
  SVG triangle base sits on the canvas baseline strip, stroke is not clipped,
  and the `!` stays centered (regression vs. the pre-fix floating `y=11.2`).

### Benchmark (last measured)
```
run 1 (COLD: browser + CDP + DevServer + page + caches)   706 ms   (issues: 1)
run 2 (WARM: everything reused, caches hit)                35 ms   (issues: 1)
run 3 (WARM again)                                         39 ms
Cold: 706ms | Warm: 35ms/39ms  (speedup ≈ 20×)
```
Session persistence + caches keep warm analyses ~10–40 ms; the warm path also
reuses the companion resolution without re-scanning (page reuses: 2 — the
hash-validated companion cache held; single Chromium launch, single DevServer,
single CDP connection).

---

## 6. Roadmap & Immediate Next Steps

### Prioritized backlog
1. **Real-world hardening** — audit the registered rule families against a wide
   corpus of authored CSS; grow the fixture per-phase and the `❌/✅` controls;
   extend the *synthetic* flow's selector coverage where a static wrapper CAN be
   extended (descendant combinators already work; attribute selectors remain
   hard). Also audit the embedded flows against real HTML (entity decoding,
   template literals, `@import` inside `<style>`, runtime-mutated attributes —
   today any mismatch aborts inline analysis for the whole document).
2. **Companion-document policy breadth** — the multi-document evidence merge
   (Level 11) analyzes every ranked companion up to the Top-K budget
   (`noEffect.maxCompanions`); remaining ideas: per-`<link>`/per-folder
   override config, a user-facing companion override, and surfacing the
   budget trade-off in settings UI.
3. **@media-awareness** — evaluate inactive verdicts per-`@media` viewport where
   feasible, or at least document the single-viewport limitation in settings UI.
4. **Hygiene** — remove stale `.js`/mock duplicates from `src/` (mostly done,
   guard-held); add an ESLint config (`npm run lint` currently fails; `tsc`
   stays the real gate).
5. **Coverage** — consider a `place-content`/multicol family audit and
   `var()`-token awareness for tooltip explanations.

### Guidelines for future AI prompts (workbook)
- **Read first:** `PROJECT_STATE.md`, then the newest `LEVEL*-REPORT.md`, then the
  specific subsystem under `src/` you will touch.
- **Respect the invariants** in §1 — especially *no hardcoded selector/class
  names* and *browser-computed styles as ground truth*. Prefer a structural fix
  (new fact → new context field → conservative abstention) over a per-case patch.
- **Rule ownership:** the engine dispatches each property to exactly one rule;
  register new rules centrally in `ruleRegistry.registerDefaultRules()` and give
  every verdict a stable `REASON_CODES` entry.
- **Pseudo-element work:** verdicts flow through the two-stage dispatch
  (`::<type>` rule first, then the general property rule against
  `pseudoBoxContexts.get(pseudoElement) ?? layout`); facts come from
  `getComputedStyle(el, pseudo)` — never authored declarations.
- **Type/replaced-element work:** real tags come from the document (companion /
  HTML flow); fabricated wrapper types must set `typeIsSynthetic` so
  type-dependent rules abstain instead of guessing.
- **Failure/coverage surfaces (Phase 4):** never format status or skip text in a
  UI layer — derive it (status bar text/tooltip, Show Status lines, output
  channel line) through `status/derive.ts` from the outcome axes
  (`status`/`lifecycle`/`mode`/`coverage`). Keep collectors pure
  (`failure/coverage.ts`) and deterministic; `buildOutcome` is the single place
  that resolves the three axes from runner inputs.
- **Phase 6 orchestration (F1–F5):** the context fingerprint comes ONLY from the
  validated companion cache (`companionContextFingerprintFor`); never re-walk the
  workspace for it. A run records its identity (`recordSuccessfulAnalysis`)
  only on success/partial AND only with a non-stale context FP. `completeAnalysis`
  writes exactly ONE namespace (`AnalysisNamespace`) per run. Skip ⟺ recorded ∧
  content FP ∧ context FP all unchanged — a companion create/change/delete must
  re-analyze even with identical CSS bytes. HTML runs emit only page-local
  embedded issues; linked-sheet issues always flow through `cssGlobal`.
- **Always verify:** `npm run compile` + `npm test` + `npm run test:integration`
  + `npm run test:smoke:all` (host smoke on the minimum VS Code and stable; see
  §5 and `NODE-COMPAT-AUDIT.md`)
  (+ benchmark for perf work). Add or update a fixture control and a regression
  test with your fix. Write one `LEVELN-REPORT.md`/`PHASEN-REPORT.md` when a
  milestone lands, and keep this `PROJECT_STATE.md` in sync.
