# LEVEL11 — Multi-companion evidence merging (the semantic verdict lattice)

## The report

```html
<!-- project/index.html (distance 1) -->
<div class="non-flex">…</div>          <!-- plain block -->

<!-- project/pages/index.html (distance 2) -->
<div class="non-flex" style="display: flex">…</div>   <!-- real flex -->
```

```css
/* project/styles/x.css */
.non-flex { justify-content: center; }
```

Until this level `analyzeCssFile` analyzed a stylesheet against **ONE** companion
document (the closest linker, Level 9/10). A declaration that was inactive in the
closest page but **effective in another real page of the same project** was
dimmed anyway — the closest document was a single witness, and no other real
context could ever correct it. `crossdir-multi` even encoded that as a test:
"exactly one issue proves the closer companion won, not the farther ones."

## What changed

### 1. The verdict lattice — `src/engine/verdictMerge.ts` (new)
Per-pass engine verdicts form the chain **⊥ ≤ I ≤ A** (no evidence ≤ provably
inactive ≤ provably effective) and merge as the lattice JOIN (= component-wise
max). Because the order is total, commutativity, associativity and idempotence
hold by construction — locked by the exhaustive 3×3 table in
`verdictMerge.test.ts`.

- `mergeVerdicts` — the JOIN: `A ⊔ x = A` (effective anywhere ⇒ active),
  `I ⊔ I = I`, `I ⊔ ⊥ = I` (uncontradicted inactive evidence stands), `⊥` is
  the identity.
- `declarationKeyFor` — the companion-**independent** key of an authored
  declaration: stylesheet path + sheet identity (path|hash) + the **parsed
  local** declaration range + property name. Never CDP ranges, node ids or
  companion paths — two passes over different companions always key the same
  authored declaration identically, and the k-th duplicate inside one block
  keeps its own range → its own key.
- `mergePassOutcomes` — joins every **successful** pass. Execution failures
  are NOT lattice elements: a failed pass contributes no verdicts, no counts
  (recorded as pass failures in coverage instead). The issue of a merged `I`
  comes from the **highest-ranked** pass that issued it; `evaluatedCount` /
  `inactiveCount` count only `A`/`I`-emitting successful passes; `sourceRank`
  attributes the merged verdict to the **deciding** pass (first `A` for a
  merged `A`, the issue's pass for a merged `I`). Deterministic: the result
  depends only on the pass maps and their ranks, never on array order.
- Bottom-only declarations (no usable evidence in ANY pass) never
  materialize.

### 2. The multi-pass caches — `src/cache/multiPassCache.ts` (new)
- **Per-pass:** a pass result depends exactly on the CSS content hash and the
  companion content hash → cached under `cssHash|companionHash`. Verdicts are
  stored as an entries array and rebuilt into a FRESH `Map` on read
  (mutation-safe round trip, locked by tests); `locatedSelectors` is cloned.
  Failed passes are never cached by the caller — an execution failure is a
  runtime condition, not content.
- **Merged:** one run's joined result cached under
  `cssHash|K|ordered tuple of selected companion hashes`. A warm run is **one
  cache read + one pure merge + issue materialization** — no navigation, no
  rescan, no session touch (integration-proven: the warm run never consults
  the per-pass cache either).

### 3. The analyzer — `src/services/cdpAnalyzer.ts`
- `resolveCompanionsFor` now returns the **ranked list** of every matching
  companion (distance → `index.html` → alphabetical, exactly the Level 10
  order), cached through the hash-validated `companionCache`. An empty list is
  the wrapper fallback (the old single-companion flow is gone).
- `analyzeWithCompanions` (new): selects through the shared Level 11 rule
  (`selectCompanionsForAnalysis`) — the Top-K evidence budget
  (`companionSettings.maxCompanions`, default 3) PLUS the
  `COMPANION_EXPANSION_BUDGET` (3) tail of candidates beyond the budget whose
  documents contain the stylesheet's queryable-selector tokens (pure
  word-boundary containment superset, hash-gated scan cache) — and runs
  **one sequential pass per selected companion** — the persistent session
  owns ONE page, so passes never interleave; every pass checks the run token
  before navigating and before applying anything; one logical multi-pass run
  = one epoch. The expansion exists so budget truncation can never lose the
  ONLY document that gives a declaration effect; selection is deterministic
  and derived from the same validated snapshot the freshness probes use
  (see `companionSelection.ts`/`selectorScan.ts`).
- `runCompanionPass` (new): wraps each pass in the same session plumbing
  (prepare / recovery retry / cancellation) via the generic
  `withSessionPass<T>` (extracted from `withSession`). Every execution
  failure is caught into a failed `PassOutcome` — a failed pass contributes
  NO lattice element and is surfaced in companion coverage; cancellation is
  never swallowed. The page load is ALWAYS forced: the freshness validation
  re-reads every companion's hash before the pass, so a hit-flag-based
  change signal would be poisoned and the session (parked on the same URL)
  would judge the STALE DOM instead of the current document.
- `inspectSelectorsCore` (extracted; `inspectSelectors` and the new
  `inspectSelectorsForVerdicts` are thin wrappers): the SAME node loop and
  SAME mapping, but now also captures the per-declaration semantic verdict
  (`A` for every instance the engine found effective — the absorbing element
  — `I` + issue for confirmed inactive). Mapping tables moved to
  `buildMappingTables`. Companion passes set `deferSelectorBookkeeping`, so
  per-selector analyzed/skipped counts are **bookkept once after the merge**
  from the located-union: a selector is "analyzed" when ANY companion located
  it, "skipped" only when NO companion could judge it.
- `materializeMerged` (new): ONLY merged `I` results become issues (a merged
  `A` suppresses the declaration entirely), each carrying the bounded
  evidence metadata `evaluatedCount` / `inactiveCount` / `analyzedCompanions`
  (shallow-copied so warm runs never mutate cached issue objects).
- With companions, the synthetic wrapper is **NEVER mixed in** — including
  when every companion pass fails (synthetic evidence never mixes with real
  evidence).

### 4. Presentation — `src/status/derive.ts`, `src/diagnostics/decorations.ts`
- `companionCoverageLines` — the "Companions" section of Show Status
  (Level 11 view): counts from the coverage envelope's ranked bookkeeping
  (`analyzed · failed · not selected`), the evidence budget
  (`selected/total`), and the ranked lists — never a universal claim.
- `issueEvidenceNote` — the bounded-evidence note appended to a dimmed
  declaration's hover tooltip: "No effective use of this property was
  observed in any of the N pages that exercised it (of M analyzed)". Null for
  wrapper-flow issues (no multi-companion metadata).
- `failure/coverage.ts` gained `CompanionCoverage` (analyzed / failed /
  skipped / total / selected), plumbed through `RunMetrics` into the outcome
  envelope; `companionPassFailedFailure` classifies pass failures.

## Behavior guarantees
- **Lattice-correct:** a declaration is dimmed only when NO observed real
  context gives it effect; one real effective context anywhere absorbs the
  inactive verdicts of every other companion.
- **No synthetic mixing:** the wrapper page never contributes evidence to a
  run that has any companion.
- **Failed passes are visible, not poisonous:** they add no lattice elements
  and appear in companion coverage (`failed`), making the run partial.
- **One epoch per multi-pass run:** supersede drops the merged outcome with
  the run; cancellation is honoured per pass.
- **Deterministic:** the merge depends only on pass maps and ranks; selection
  order is the Level 10 order; every cache key is a pure function of content
  hashes.

## Verification
- New unit tests: `verdictMerge` (15 — exhaustive 3×3 JOIN, commutativity/
  associativity/idempotence, key purity + duplicate ranges, failed-pass
  neutrality, `I ⊔ A = A`, `I ⊔ ⊥ = I`, issue-from-highest-ranked-pass,
  array-order invariance, attribution), `multiPassCache` (9 — key
  composition, mutation-safe round trips, failure-flag round trip,
  hash-keyed misses, merged shared-reference contract, stats, reset),
  `derive` companion sections (6 — `companionCoverageLines` envelope
  surfaces, `issueEvidenceNote` bounded wording and wrapper-flow null).
- New integration test: **warm multi-companion run** — cold = 3 per-pass
  misses + 1 merged miss; warm = 1 merged hit, ZERO per-pass consults, ZERO
  new passes, identical merged result.
- Reworked `crossdir-multi`: the fixture now asserts the merged semantics —
  the distance-1 `I` is absorbed by the two distance-2 `A`s (0 issues, where
  a silently failed farther pass would leave 1), plus a direct resolution-
  order proof (`index.html` distance 1, then `pages/index.html` before
  `pages/a.html`).
- Full suites: **780 unit + 34 integration** green (up from 750/33), real
  Chromium; `tsc -p ./` clean.

## Post-Level-11 correction — the merged-cache poison (reported case)

**Symptom:** a declaration matched ONLY in the second-ranked companion
(`test-multipage`'s `.secondary-only` on `about.html`) never dimmed, while
primary-page declarations behaved — **and stayed broken across reruns.**

**Root cause:** the merged-cache key (`cssHash | K | companion-hash tuple`)
does not encode evidence completeness. A cold run where a companion pass
failed transiently (slow first navigation — `withSessionPass` → page-load/
browser-setup throw → `success:false`) merged ONLY the successful passes and
cached that partial result unconditionally. Every warm rerun then echoed the
partial evidence forever — the failed pass was never retried, and no cache
reset (the HTML watcher resets only the companion **resolution** cache, not
`multiPassCache`) could repair it short of a CSS content change.

**Fix:** `mergedResultIsCacheable(passOutcomes)` — the merged result is
cached ONLY when every selected pass succeeded. A partial run is never
cached (per-pass cache still holds the successes), so the next run re-attempts
exactly the failed companion(s) and only then caches a complete merge.
Locked by `mergedCachePolicy.test.ts` (4 — full/single/any-fail/empty) and
the new `test-multipage` integration regression (bottom-only companion merge
`⊥ ⊔ I = I`, plus warm-run intactness of the healthy path).

**Companion hardening (same report):** `runCompanionPass` now retries a
failed companion pass ONCE within the run (250ms backoff, forced refresh,
cancellation always rethrown) before declaring it failed — a flaky first
navigation (cold browser start-up racing a prior session teardown) no longer
leaves the run incomplete until the next user-triggered analysis.

## Files touched
- `src/engine/verdictMerge.ts` — NEW: the ⊥ ≤ I ≤ A lattice, companion-
  independent declaration keys, `mergePassOutcomes`.
- `src/cache/multiPassCache.ts` — NEW: per-pass + merged caches (fresh-map
  round trips, locatedSelectors clones).
- `src/services/cdpAnalyzer.ts` — ranked companion resolution,
  `analyzeWithCompanions` / `runCompanionPass` / `materializeMerged`,
  `inspectSelectorsCore` + verdict capture, `buildMappingTables`,
  `withSessionPass<T>`, deferred selector bookkeeping; single-companion flow
  removed.
- `src/failure/coverage.ts`, `src/failure/outcome.ts` — `CompanionCoverage`
  envelope; `companionPassFailedFailure` in `src/failure/classifier.ts`.
- `src/status/derive.ts` — `companionCoverageLines`, `issueEvidenceNote`.
- `src/diagnostics/decorations.ts` — bounded-evidence hover note.
- `src/cache/companionCache.ts` — ranked-list contract (array cache entries).
- `src/test/unit/verdictMerge.test.ts`, `src/test/unit/multiPassCache.test.ts`
  — NEW. `derive.test.ts`, `companionCache.test.ts`,
  `cdpAnalyzer.integration.test.ts` — extended/reworked.
