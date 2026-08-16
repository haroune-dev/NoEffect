# PHASE6 Report — Multi-File Orchestration (F1–F5, no forced CSS save)

**Status: complete.**
**Verify:** `npm run compile` + `npm test` (807 passing) +
`npm run test:integration` (49 tests, all passing) +
`npm run test:smoke:all` (PASS on 1.85.0 and stable, settled analysis) +
`node out/test/benchmark/benchmark.js` (cold 706 ms → warm 35/39 ms).

## Goal

Make multi-file coordination sound. A CSS file is analyzed against every
linking companion document (Level 10/11); with more than one file in play, the
extension previously forced a CSS save to surface inactive declarations from
companion-only evidence (`⊥ ⊔ I = I`), half-merged outcomes could leak between
the CSS-file and HTML-file flows, and the skip cache could absorb stale
companion snapshots. Phase 6 removes all five coordination flaws (F1–F5) and
locks the behavior with 11 mandated tests (T1–T11) on a dedicated
`multipage-orchestration` fixture.

## What landed

### F1 — Pure analysis-context fingerprint (`src/engine/analysisContext.ts`)
- `ANALYSIS_CONTEXT_VERSION = 1` (`:28`); `analysisContextFingerprint({resolutions,
  companionHashes, maxCompanions})` (`:57`) hashes the Top-K **selected**
  resolutions (path + content hash) + the evidence budget — a deterministic,
  versioned identity of the context a CSS outcome was judged against.
- Consumed in `src/services/cdpAnalyzer.ts:436` for the merged-cache key; the
  store-facing fingerprint comes from `companionContextFingerprintFor`
  (`cdpAnalyzer.ts:871-878`), which reads the **validated companion cache
  only** — never a fresh workspace walk. A reset/empty cache returns the
  `STALE_CONTEXT_FINGERPRINT` sentinel, which is never recorded and never
  satisfies the skip gate (`commands.ts:369-377`).

### F2 — Explicit trigger matrix (`src/activation/activate.ts`)
Every trigger now funnels through ONE 300 ms-coalesced re-evaluation
(`ORCHESTRATION_DEBOUNCE_MS = 300`, `:489`):

| Trigger | Wiring | Evidence |
|---|---|---|
| Companion HTML create / change / delete | `companionWatcher.onDidCreate/Delete/Change` → `companionCache.reset()` + `triggerReanalysis()` (HTML docs only) | `activate.ts:263-289` |
| CSS content change | same watcher, CSS path → re-analysis | `activate.ts` (watcher block) |
| Workspace-folder change | `onDidChangeWorkspaceFolders` → reset + re-trigger | `activate.ts:290-292` |
| Settings / resolver change | `onDidChangeConfiguration` → `triggerReanalysis()` | `activate.ts:392` |
| Readiness blocked → ready | `createReadinessUi(context, () => triggerReanalysis())` retry hook | `activate.ts:294`; unit test `T9` |
| HTML document open / editor switch | `evaluateActiveEditor` (`:441`) via `onDidChangeActiveTextEditor` (`:501`) + immediate post-activation evaluation: re-applies known per-file issues, then debounced re-analysis gated by the F3 skip check (`canSkipReanalysis`); `onAnalysisComplete` re-evaluates only when the run was recorded | `activate.ts:441-497,500-518` |
| Document close | decorations for the closed file are cleared (no re-analysis) | `activate.ts:527` |

`triggerReanalysis` is a hoisted `let` initialized to a no-op and assigned once
subscriptions exist (`activate.ts:252,492`) — a subscription firing before
activation completes can never hit a TDZ or an unassigned handler.

### F3 — Two-keyed skip gate (`src/activation/commands.ts:359-378`)
A run is skipped only when a **successful or partial** run was recorded
(`recordSuccessfulAnalysis`, `sessionManager.ts:158`) against the SAME content
fingerprint AND the SAME context fingerprint. Failed, cancelled and blocked
runs are never marked handled, so the next trigger genuinely re-attempts them
(a readiness transition re-triggers environment-blocked runs; file events
re-trigger content changes). A companion create/change/delete with byte-
identical CSS bytes still re-analyzes because the context FP changed — the
no-forced-save requirement.

### F4 — Single-writer namespaces (`src/models/analysisResult.ts:12`)
`AnalysisNamespace` = `cssGlobal | htmlEmbedded`. Each run writes exactly ONE
namespace (`sessionManager.ts:224-260`): CSS-file runs write only the
`cssGlobal` entry — the one multi-companion outcome — and never `htmlEmbedded`;
HTML runs write only page-local embedded issues. Linked-sheet issues in the
HTML flow surface through `ensureCssGlobalOutcome` (`cdpAnalyzer.ts:870-899`:
fresh-read via `getFresh(sheet.path, hash, contextFP, epoch)` else a full
multi-companion pass recorded under `(path, hash, contextFP, epoch)`). The
stale half-merge case is structurally impossible.

### F5 — Epoch-scoped session store (`src/services/sessionManager.ts`)
- `cssGlobal[cssPath]` keyed `(contentFP, contextFP, epoch)` (`:96`);
  `htmlEmbedded[htmlPath]` keyed `(contentFP, epoch)` (`:99`) — the epoch in
  the key means a result from a superseded session (crash + recovery bumped the
  epoch mid-run) is never read back (`commands.ts:302-308` drops it before any
  UI surface).
- `beginAnalysis` (`:210`) is the single gate (a foreign in-flight run drops
  the trigger); `getIssuesForFile` (`:136-141`) routes CSS files to cssGlobal,
  everything else to htmlEmbedded; `getFresh` (`:331`) enforces content+context
  freshness, not just presence.

## Release criteria — confirmed

| Criterion | Confirmed by |
|---|---|
| **RC1 (F1):** context fingerprint deterministic, derived from the validated cache only; stale snapshots never record nor satisfy the skip gate | `analysisContext.ts:28,57`; `cdpAnalyzer.ts:871-878`; `commands.ts:369-377`; unit `analysisContext.test.ts` (8 tests: determinism, order-dependence, budget/version changes, Top-K truncation, STALE on empty/deleted/changed companions) |
| **RC2 (F2+F3):** every trigger in the matrix re-analyzes; skip ⟺ recorded ∧ content FP ∧ context FP unchanged | `activate.ts:252-294,392,489,527`; `commands.ts:359-378`; integration T1/T6/T7 (companion change, HTML-only flip, maxCompanions change) |
| **RC3 (F4):** exactly one namespace per run; embedded issues stay page-local; linked-sheet issues flow only through cssGlobal | `analysisResult.ts:12`; `sessionManager.ts:224-260`; `cdpAnalyzer.ts:791-795,870-899`; unit T8; integration T5/T11 |
| **RC4 (F5):** store is epoch-correct; `getFresh` matches (content, context, epoch); superseded sessions never decorate | `sessionManager.ts:58,96-99,210,331`; `commands.ts:302-308`; integration T10 (epoch supersede after rapid open/close) |

## Mandated tests T1–T11 (fixture `src/test/fixtures/multipage-orchestration/`)

Fixture `styles.css` defines the ❌/✅ controls: `.all-inactive`
(`I ⊔ I = ❌`), `.active-somewhere` (`A ⊔ I = ✅`), `.secondary-only`
(`⊥ ⊔ I = ❌`); `index.html` + `about.html` link the sheet.

| Test | Location | Proves |
|---|---|---|
| T1 [F1+F2] companion HTML change re-analyzes with unchanged CSS hash | integration `cdpAnalyzer.integration.test.ts:2033` | no-save-required re-analysis; passMisses+1, mergedMisses+1 |
| T2 [F3] failed attempt never records a skip identity | integration `:2081` | cancelled run (`CancellationTokenLike` → `AnalysisCancelledError`) leaves the gate open; pre-seeded companion cache lets the context FP be knowable |
| T3 [A⊔I=A] `.active-somewhere` stays active, incl. while about.html is open | integration `:2136` | lattice correctness over two companions + store reads |
| T4 [⊥⊔I=I] `.secondary-only` dims right after CSS analysis | integration `:2169` | `REQUIRES_FLEX_OR_GRID_CONTAINER`, no HTML open needed |
| T5 [F4] HTML flow never overrides the global CSS outcome | integration `:2189` | warm open reuses the fresh cssGlobal outcome (no new passMisses) |
| T6 [F1+F2] HTML-only change flips the verdict | integration `:2224` | `.active-somewhere` → dimmed `REQUIRES_FLEX_OR_GRID_ITEM` without a CSS edit |
| T7 [F1+F2] maxCompanions change alone re-analyzes (K in the context) | integration `:2266` | `maxCompanions=1` vs `3` change the context FP |
| T8 [F4+F5] single-writer unit proof | unit `sessionManager.test.ts:245` | an HTML-flow run can never write a cssGlobal entry and vice versa; `getFresh` stays undefined |
| T9 [F2] blocked → ready transition fires the retry hook exactly once | unit `readinessController.test.ts:275` | transition dedupe (controller reports the snapshot twice: apply + awaited race) |
| T10 [F5] rapid open/close cycles; superseded epochs dropped | integration `:2300` | `getFresh(fp,'ctx',7)` undefined after epoch 8 recorded |
| T11 [F4] embedded issues stay in about.html, never leak to styles.css | integration `:2350` | one `<style>`-block issue mapped into about.html; external outcomes stay settled |

Test-authoring notes (recorded for future maintainers): T2 pre-seeds
`companionCache` with the resolved companion list so the context FP is
knowable before the first failed run; T11 uses a `<style>` rule + a real
`.embedded-block` element rather than `style=""` on a selector also covered by
an external rule — the inline attribute collides with the shared dedup
identity (`[Dedup] Skipped range-less copy … 179324.5||justify-content|center`)
and only one issue would survive, masking half the mandate.

## Acceptance evidence

- **A1 — unit suite:** 807/807 passing (`npm test`), including the new
  `analysisContext.test.ts` (8), the rewritten `sessionManager.test.ts` (F3/F5
  semantics + T8), T9 in `readinessController.test.ts`, the updated
  `multiPassCache.test.ts` (2-arg `mergedKeyFor`), the post-phase fixes
  (`getFreshCssIssues` freshness-gate semantics +1,
  `getLastContextFingerprint` runner passthrough +2), and the
  `session_build`-budget invariants (+1: rebuild budget ≥ launch + connect
  while `restart_cleanup` stays a cleanup cap).
- **A2 — integration suite:** 49/49 passing (`npm run test:integration`),
  incl. T1–T7, T10, T11 browser tests plus the freshness-gate regression
  (pre-drift snapshot retired, post-drift snapshot applied, transactional
  recording identity); 14 legacy `analyzeHtmlFile` tests
  reworked to the F4 semantics (external-sheet assertions via
  `store.getIssuesForFile(cssFilePath)`), 3 obsolete merge tests replaced by
  F4 orchestration versions.
- **A3 — benchmark:** cold 706 ms → warm 35/39 ms (~20×); 1 Chromium launch,
  1 DevServer, 1 CDP connection, 2 page reuses, 2 AST/mapping hits.
- **A4 — build:** `npm run build` → `dist/extension.js` 466.1 kb (111 input
  files) — the shipped bundle is current, not stale.
- **A5 — smoke:** `npm run test:smoke:all` → **PASS on 1.85.0 and stable**
  with a settled end-to-end analysis on both (see below). The suite now leads
  with the multipage first-open regression: the process's FIRST analysis on
  `multipage-orchestration` (cold browser + DevServer, no page visits) must
  dim exactly `.all-inactive` + `.secondary-only` — never `.active-somewhere`.

## Post-fix: the first-open dimming root cause

The freshness gate stopped STALE results from applying, but the first-open
symptom persisted because the first run itself produced a poisoned outcome
and still applied it. Root cause, in two stacked layers:

1. **Raw CDP payload logging froze the first pass.** `cdpAnalyzer` logged the
   full `CSS.getMatchedStylesForNode` / `Runtime.evaluate` response objects
   (`logger.debug('[CDP] Raw matched styles response', rawMatched)`). On a
   cold run the first companion pass (index.html — the A-evidence page) wrote
   hundreds of KB of raw selector/specificity JSON into the output channel
   and the extension host stalled mid-write (captured in the smoke log as
   `Unable to log remote console arguments…` followed by 100+ s of silence);
   the pass failed, the merged ⊥ dimmed `.active-somewhere`, and the
   freshness gate could not tell that poisoned outcome from a truthful one.
   Fixed: the raw dumps are removed; a one-line bounded summary (rule and
   declaration counts) replaces them.
2. **Partial runs were recorded and applied as successes.** `succeeded` in
   the command layer included `partial`, so a run with failed companion
   pass(es) was both recorded (skip identity, closing the retry gate) and
   decorated. Now the analyzer returns NO issues for an incomplete-evidence
   merge (failed passes → `coverage.companions.failed`), and the command
   layer applies/records nothing for such runs — the gate stays open and the
   next trigger genuinely re-attempts the failed companion(s).

Both layers are asserted end to end by the smoke multipage scenario on the
first analysis of the process; unit 807, integration 49 unchanged.

## Side work — the smoke suite is now a real gate

The in-host suite previously passed spuriously: it compared `process.exitCode`
that the extension-host test runner swallows (host exits 0 → launcher prints
PASS even on assertion failure), and it spied on the DEV logger while the
loaded extension runs the BUNDLE — a different module instance, so the suite
could never observe a settled analysis. Three defects fixed in
`src/test/smoke/`:

1. `EXTENSION_ID` was hardcoded `noeffect.no-effect` (never matched the real
   `haroune-dev.no-effect` from the manifest) → now derived from
   `package.json` (`publisher.name`).
2. The log spy patches `vscode.window.createOutputChannel` BEFORE activation
   so the bundle's logger binds the spy channel (works for any entry-point
   layout; no production change).
3. The launcher gates on a verdict file (`NOEFFECT_SMOKE_RESULT`): a missing
   or `FAIL` verdict fails the run even when `runTests` resolves.
   Negative-tested (deliberate bogus command → exit 1 with the real
   AssertionError).

## Test suite deltas

| Suite | Before | After |
|---|---|---|
| Unit | 784 | **807** |
| Integration | 35 | **49** |
| Smoke | PASS spuriously | **PASS genuinely (min + stable)** |
| Benchmark | cold 550 ms / warm 25-26 ms | cold 706 ms / warm 35-39 ms (same session-reuse profile) |

## Files touched (primary)

- `src/engine/analysisContext.ts` (new — F1 fingerprint)
- `src/services/sessionManager.ts` (F3/F5 store + gate)
- `src/services/cdpAnalyzer.ts` (F1 keys, F4 `ensureCssGlobalOutcome`)
- `src/activation/commands.ts` (F3/F4/F5 wiring, epoch supersede)
- `src/activation/activate.ts` (F2 trigger matrix, hoisted `triggerReanalysis`)
- `src/models/analysisResult.ts` (`AnalysisNamespace`)
- `src/models/index.ts` (export `AnalysisNamespace`)
- `src/test/fixtures/multipage-orchestration/` (new fixture)
- `src/test/integration/cdpAnalyzer.integration.test.ts`, `src/test/unit/{
  sessionManager,analysisContext,readinessController,multiPassCache}.test.ts`
- `src/test/smoke/smokeMain.ts`, `src/test/smoke/runSmoke.ts` (gate fixes)
