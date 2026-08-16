# PHASE4 Report — Outcome Axes & Coverage (failure-UX Phase 4)

**Status: complete.**
**Verify:** `npm run compile` + `npm test` (681 passing) + `npm run test:integration`
(25 tests; 24 pass, 1 pre-existing `embedded` fixture failure unrelated to this phase
— later resolved as fixture drift, see below).

## Goal

Give every downstream UI surface — status bar, Show Status view, output
channel — a *single, deterministic* source of truth about what an analysis
actually did: how much of the input fed into the browser, what was skipped,
and why, plus where the run sits in its lifecycle.

The previous model had only `status` + raw counts. The new model is **three
axes in one outcome**:

| Axis | Type | Meaning |
|---|---|---|
| Lifecycle | `AnalysisLifecycle` | `idle` / `running` / `settled` — where the run sits in its own lifetime |
| Mode | `AnalysisMode` | `active` / `limited` / `failed` — how much of the input fed into the browser, independent of per-selector outcome |
| Coverage | `CoverageData` | per-stage counts (`totalSelectors`/`targets`/`queryable`/`feedable`/`feedSynthetic`/`feedFailures`) with provenance (`SkipSource`) for every skip |

## What landed

### Pure model (`src/failure/model.ts`)
- `AnalysisLifecycle`, `AnalysisMode`, `AnalysisRunStatus`.
- `AnalysisOutcome` extended with `lifecycle`, `mode`, `modeReason`, `coverage`
  (all documented as the three axes; existing fields untouched, so no caller
  broke).

### Coverage collector (`src/failure/coverage.ts`)
- `SkipSource` provenance: `mode` (input-level feed limitation), `selector`
  (a single uninspectable selector), `stage`, `input` (gating), `analyzer`.
- `classifyMode(failures)` → deterministic `active|limited|failed` from
  classified failures only (no message guessing).
- `collectCoverage(signals)` → the envelope, always the same output for the
  same signals. `emptyCoverage()` for no-run states.

### Single derivation (`src/status/derive.ts`)
- `deriveOutcome(outcome, opts)` — the one function for **status bar text &
  tooltip** (includes `Analyzing…` during a run; stale/superseded results map
  to a neutral Idle, never a misleading failure; failure rows carry the code,
  never raw messages).
- `coverageLines(outcome)` → the Show Status "Coverage" section lines.
- `coverageSummaryLine(outcome)` → the one-line output-channel record.
- `countsCaption`, `collectSkipReasons`, `rowKey` (dedup key for the item).

### Wiring
- `failure/outcome.ts`: `buildOutcome` resolves all three axes from runner
  inputs (explicit override wins; otherwise classify + metric-only skips lower
  `active` → `limited`; no-op runs carry no envelope).
- `services/analysisRunner.ts`: logs one deterministic `Coverage <mode>: …`
  line for settled runs.
- `activation/commands.ts` + `activate.ts`: the run lifecycle now drives the
  status bar through `reportOutcome` (Analyzing… → result row); the last
  outcome feeds the Show Status facts.
- `activation/statusViewModel.ts`: Show Status shows the "Coverage (last
  analysis)" section.
- `activation/statusModel.ts`: new `StatusState` members (`analyzing`,
  `partial`, `limited`, `idle`, `failed`).
- `activation/statusBarController.ts`: dedup now uses the shared `rowKey`.

## Tests added (+22 unit, +1 integration)

- `unit/coverage.test.ts` — mode classification + collector determinism/provenance.
- `unit/derive.test.ts` — single-derivation contract: text/tooltip/row/stale/
  counts/view lines/summary, plus limited-mode from metric skips.
- `unit/statusViewModel.test.ts` — the Coverage section renders from an outcome.
- `integration/cdpAnalyzer.integration.test.ts` — a real Chromium run through
  `AnalysisRunner` produces a settled outcome with `mode: active` and a
  coverage envelope (`stage: decoration`, `queryable >= 1`).

## Notes / limitations (documented in PROJECT_STATE §5)

- The `embedded` integration fixture failure (4 vs 3 inline issues) was the one
  red mark at the time of writing; it was later traced to fixture drift (the
  fixture had gained `display: flex` + duplicate `justify-content` lines that
  contradicted its documented one-inactive-declaration-per-source contract),
  not to pipeline behavior. Resolved by restoring the fixture; integration is
  26/26 passing.
- `feedSynthetic` is currently 0 (the CDP analyzer does not yet report
  synthetic-injection counts); the surface renders it when nonzero.
- `derive` is intentionally conservative: the status bar shows readiness until
  a run starts, the run row while running, the outcome row after it settles.

## Next (backlog candidates)
- Surface synthetic-injection/decoration-stage counts from the analyzer into
  `CoverageSignals` (completes the feed axes with real numbers).
- Re-notify (auto-analyze-on-save) paths to reuse `buildOutcome`/`derive`
  instead of ad-hoc strings.