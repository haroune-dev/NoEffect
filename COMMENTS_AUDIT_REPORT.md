# COMMENTS_AUDIT_REPORT — NoEffect (Inactive CSS Inspector)

**Scope:** every TypeScript file under `src/` (110 extension-source files, 20,234 lines; 77 test files, 16,738 lines) plus `scripts/` tooling.
**Method:** full sequential read of every `src/` file, plus targeted pattern scans:

- `TODO|FIXME|HACK|XXX` (case-insensitive) across `src/`, `src/test/`, `scripts/`
- commented-out code heuristics (`//` + statement prefixes, `console.` inside comments)
- per-file comment-line counts (both `//` lines and JSDoc/`/* */` lines)
- cross-referencing of every comment that claims a field is "optional", "legacy", or references external docs

**Five audit dimensions:** (1) stale/orphaned, (2) commented-out code, (3) missing JSDoc on public APIs, (4) redundant/noise, (5) formatting consistency.

---

## 1. Executive summary

| Metric | Value |
|---|---|
| Extension-source files audited | 110 |
| Total extension-source lines | 20,234 |
| Comment lines (incl. JSDoc block lines) | 5,759 (≈ 28.5 % density) |
| Files with any comment content | 105 / 110 (95 %) |
| `//` inline-comment lines | 2,662 |
| TODO / FIXME / HACK / XXX | **0** |
| Commented-out code blocks | **0** |
| `console.*` calls in production `src/` | 0 (only the intentional, documented fallback at `src/utils/logger.ts:77-78`) |
| Stale/orphaned comments | 3 (all minor; 2 are the same file) |
| Formatting deviations | 2 (trivial) |

**Verdict:** the documentation discipline in this codebase is excellent — well above the norm for a VS Code extension of this size. Headers explain *why* (not merely *what*), invariants and cross-phase contracts (F1-F6, PR4/PR5, P2/P3 remediation IDs) are recorded at the point of truth, and there is a single-sentence JSDoc on essentially every public member. No dead comments, no orphaned scaffolding, no placeholder stubs. The findings below are cosmetic and low-risk; there is **no `[HIGH]` item** in this audit.

---

## 2. Category findings

### 2.1 Stale / orphaned comments — 3 findings (all `[LOW]`/`[MED]`)

| ID | Status | Location | Issue |
|---|---|---|---|
| `[STALE-01]` | MED | `src/services/sessionManager.ts:75-89` | Class header still describes the manager as *"In Phase 1, this is a simple placeholder that stores the last analysis result … In later phases, it will manage the actual Chromium CDP session lifecycle."* The class (per the same file's later paragraphs and its implementation) now implements the full Phase 6 namespaced outcome store (`cssGlobal` / `htmlEmbedded`), the F3 skip gate, and the F4 single-writer contract. The "placeholder / later phases" framing describes a past state. |
| `[STALE-02]` | LOW | `src/services/sessionManager.ts:390-392` | `dispose()` doc says *"Clean up any resources (browser sessions in later phases)."* — browser sessions are owned by the lifecycle layer, not this class; `dispose()` clears the outcome maps, gate identities and listeners. The forward-looking clause is misleading. |
| `[STALE-03]` | LOW | `src/models/cssIssue.ts:51` | `reasonCode` is documented *"Optional reason code explaining why the property is inactive."* In practice the field is set by **every** producer (`cdpAnalyzer.createIssue`, all engine paths — 271 reference sites) and is asserted by `decorations.ts` and unit tests. The "Optional" label overstates the contract. |

Minor wording (not stale, but misleading) — `[WORDING-01]`: `src/activation/diagnoseSetup.ts:5` labels `collectDiagnostics` as *"legacy flat lines"* while the function (`:230`) is live and covered by `src/test/unit/diagnoseSetup.test.ts`.

**Recommendation:** rewrite the `SessionManager` header to describe the actual responsibilities (namespaced outcome store, freshness gate, single-writer role, skip gate); drop "Optional" from `cssIssue.ts:51` and note the always-set contract; reword "legacy" in `diagnoseSetup.ts:5`; remove the "in later phases" note from `dispose()`.

### 2.2 Commented-out code — none found

Exhaustive scan (statement-prefix patterns, `console.`-inside-comment patterns, block-comment heuristics) found **zero** commented-out production code. The only console-related comments are:

- `src/utils/logger.ts:77` — *"Fallback to console if init() wasn't called yet"* — accurate description of live behavior.
- `src/test/smoke/runSmokeVsix.ts:133` — describes how the smoke harness relays output — accurate.

All `console.log` calls in `src/test/` (smoke runners, benchmark) are intentional CLI output, not leftovers.

### 2.3 Missing JSDoc on public APIs — 2 findings (both `[LOW]`)

| ID | Location | Issue |
|---|---|---|
| `[MISS-01]` | `src/browser/browserRunner.ts:259` | Public `dispose()` is the **only** public member of `BrowserRunner` without a one-line doc comment (every sibling — `launch`, `shutdown`, `kill`, `isAlive`, `pid`, `stderrTail`, `isAvailable` — has one). |
| `[MISS-02]` | `src/failure/outcome.ts:36-56` | `RunMetrics` public mutators (`markAnalyzed`, `markSkipped`, `markSkippedAll`, `addWarning`, `setCompanionCoverage`) lack one-liners although every field on the same class has one. Purely a consistency nit. |

No *essential* public API is undocumented; `[MISS-02]` is optional polish.

### 2.4 Redundant / noise comments — none of consequence

No pure restatement comments, no "# region" noise, no echoed code-as-comment. The densest files (e.g. `cdpAnalyzer.ts`, `verdictMerge.ts`) use comments to record *decisions and invariants*, e.g.:

- the bounded-debug rationale at `src/services/cdpAnalyzer.ts:1829-1832` (why the raw CDP payload must never be logged),
- the retry-budget rationale at `src/session/policy.ts:41-50` (why `session_build` is the sum of its phases),
- the rm-rf safety guard at `src/session/tempProfile.ts:26-34`,
- the active-wins lattice invariant at `src/status/derive.ts:206-220`.

### 2.5 Formatting consistency — 2 findings (both `[LOW]`, 10-minute total fix)

| ID | Location | Issue |
|---|---|---|
| `[FMT-01]` | `src/services/cdpAnalyzer.ts:197` | JSDoc continuation line starts with a bare `*` instead of ` * ` (missing single leading space) — the only malformed JSDoc line found in 5,759 comment lines. |
| `[FMT-02]` | `src/session/notifications.ts:6` | *"v.s. status + output channel"* — typo for "vs.". |

Plus one minor cross-cutting nit: the British spelling *"analyser"* appears in `src/diagnostics/decorations.ts:467`, `src/diagnostics/inactivePropertyExplanation.ts:4-5`, `src/diagnostics/decorationPlanner.ts:56`, while "analyzer" is used everywhere else (code, comments, output strings). Pick one spelling.

---

## 3. Per-file comment coverage (highlights)

Full table: 187 rows computed from `src/` (extension + tests). Notable extremes:

| File | Lines | `//` lines | JSDoc/block lines | Notes |
|---|---|---|---|---|
| `services/cdpAnalyzer.ts` | 2,104 | 38 | 500+ | Highest-quality inline rationale in the repo |
| `engine/verdictMerge.ts`, `engine/inactivePropertyEngine.ts` | — | — | 40-50 % density | Lattices/invariants documented at point of use |
| `activation/activate.ts` | 610 | 125 | 156 | Activation docstrings; entry flow fully narrated |
| `sessionManager.ts` | 403 | 13 | 90 | Except for `[STALE-01]/[STALE-02]` |
| `browser/browserRunner.ts` | 261 | 3 | 28 | Sparse inline, but every public member dotted (except `dispose()`) |
| `matcher/declarationMapper.ts` | 250 | 0 | 47 | Header-only; intentional (pure mapping, self-describing code) |
| `models/cssLocation.ts`, `cdpSourceRange.ts` | — | — | — | Immaculate |

Directory densities (comment lines / total lines): engine 45 %, inactive rules 34 %, services 31 %, cache 28 %, session 26 %, environment 20 %, failure 20 %, parser 19 %, matcher 19 %, diagnostics 32 %, activation 22 %, browser 25 %, models 54 %.

Tests: 48 of 72 unit-test files carry JSDoc headers; average test density 7 % — appropriate for test code.

---

## 4. Priority cleanup plan

| Priority | Items | Effort |
|---|---|---|
| P1 (do now) | `[FMT-01]`, `[FMT-02]`, `[STALE-03]` | ≈ 10 min |
| P2 (next pass) | `[STALE-01]` + `[STALE-02]` (SessionManager header/dispose rewrite) | ≈ 20 min |
| P3 (style sweep) | `[WORDING-01]`, `[MISS-01]`, `[MISS-02]`, analyser/analyzer unification | ≈ 30 min |

No item requires behavioral change; all are documentation-only edits.