# PHASE5 Report — Recovery, Retry & Diagnose Setup (failure-UX Phase 5)

**Status: complete.**
**Verify:** `npm run compile` + `npm test` (707 passing, ~6 s) +
`npm run test:integration` (26 tests, all passing).

## Goal

Turn the persistent browser/CDP/DevServer/page session into a **self-healing,
typed** subsystem: every failure that previously crashed or thorn a hung
analysis is now (a) classified against a typed retry/timeout policy, (b)
recovered through a bounded, single-flight restart, and (c) surfaced to the
user only when it actually blocks explicit work — never as noise from
routine self-healing. Add the two missing diagnostics commands and upgrade
Diagnose Setup into a structured, actionable report.

## What landed

### Session health state machine (`src/session/health.ts`)
- `SessionHealth` with a fixed state set: `idle`, `preparing`, `ready`,
  `degraded`, `dead`, `restarting`, `disposing`.
- Transitions travel only allowed arcs (`state.guard` rejects illegal jumps);
  both crash (`ready` → `dead`, browser exited unexpectedly) and CDP drop
  (`ready` → `degraded`) are captured, and both are repaired on the next
  `prepare()`.
- Counters (`crashes`, `restarts`, `cdpReconnects`), `epoch`, snapshot for the
  status bar, and an `EventLog` ring for the last N transitions.

### Typed retry/timeout policy (`src/session/policy.ts`)
- One `RETRY_POLICY` table (op → `maxRetries` + `timeoutMs`): `browser_launch`,
  `cdp_connect`, `cdp_reattach`, `cdp_command`, `page_load`, `dev_server_start`,
  `graceful_close`, `full_analysis`, `restart_cleanup`, `temp_dir_cleanup`
  — no scattered magic numbers anywhere else.
- `backoffFor(op, attempt)` → bounded `[250, 500, 1000]` steps; `isTransientKind` /
  `isPermanentKind` split retries (transient) from hard failures (permanent).

### Bounded waits (`src/session/timing.ts`)
- `withTimeout(promise, ms, reason, token?)` — typed `AnalysisTimeoutError` on
  deadline. **When the caller's cancellation token fires, the internal timer is
  disarmed** (the underlying promise is tamed, never an unhandled rejection).
  This is what keeps a cancelled hung analysis from pinning the event loop: the
  unit suite went from ~30 s back to ~6 s once the `full_analysis` bound was
  token-aware.
- `sleep` is the single backoff/poll gatekeeper.

### Session owner rewrite (`src/browser/lifecycleManager.ts`)
- `prepare()` → DevServer start-once, browser reboot when dead, CDP connect and
  page navigate/reload with per-policy retry loops, `page_load` bounded; returns
  `{ cdp, port, pageLoadTimedOut, epoch }`.
- On unexpected browser exit / CDP connection close the manager classifies the
  failure, notifies (see policy below), and lets the state machine park until
  the next `prepare()` — recovery is implicit and cheap.
- `restartAnalysisSession()` is **single-flight atomic** (a `restarting`
  promise that supersedes concurrent callers) and bumps the epoch.
- `dispose()` idempotent, bounded by `restart_cleanup`; browser process tree
  killed via `processTree.buildKillPlan` (POSIX `SIGTERM`→wait→`SIGKILL`,
  Windows `taskkill /T /F`); temp profiles removed (retries + stale-24h sweep);
  DevServer close drains sockets; ports released.

### Epoch-stamped outcomes (`src/failure/model.ts`, `outcome.ts`)
- `AnalysisOutcome.epoch?: number` — every `buildOutcome` call stamps the
  producing session epoch, including environment-blocked, cancelled and failed
  outcomes. `AnalysisRunner` prefers `analyzer.getLastSessionEpoch?.()` then
  falls back to its injected `epochSource` (default = lifecycle epoch).
- The command layer drops decor/mark results whose epoch no longer matches the
  live session — stale outcomes can't paint the editor.

### Failure notifications (`src/session/notifications.ts`)
- A manual run (a run actually in flight, or any run an explicit request) can
  notify once per failure code per epoch (`NotificationDedupe` keyed by
  `(code, epoch)`); a crash under an ongoing explicit run notifies, a crash
  while idle/healing silently recovers.
- `CDP_DISCONNECTED` is never notifyable (session loss is always an internal
  recovery event). Actions offered: open settings, diagnose setup, restart
  session, show output. `reset()` on user-initiated restart reopens a muted
  code.

### New commands (`activation/commands.ts`, `constants.ts`, `package.json`)
- `noEffect.restartAnalysisSession` — single-flight restart (typed outcome:
  `restarted` / `already_restarting` / `cannot_restart`), resets dedupe,
  `notificationDedupe.reset()`.
- `noEffect.clearCache` — beans AST/mapping/file-hash/embedded-parser/embedded
  mapping appended + `decorationManager.clearAllDecorations()`.
- `activationEvents` + `contributes.commands` updated.

### Diagnose Setup upgrade (`src/activation/diagnoseSetup.ts`)
- `collectDiagnoseReport(facts, session?, probe?)` → `{ hint, groups }` with
  stable per-check `ids` (environment / browser / session / file + optional
  live `probe` group). Rendered in output channel; commands.ts Quick Pick adds
  a `▶ Run Live Browser Probe` item that calls `restartAnalysisSession()` —
  plain Diagnose stays passive (no browser launch).

### Status view & UI (`src/activation/statusViewModel.ts`)
- Show Status gained a "Session" section (`state`, `epoch`, counters).

## Tests added (+22 unit, +4 runner)

- `unit/sessionPhase5.test.ts` (+22): policy invariants/backoff/transient–
  permanent, `buildKillPlan`, health arcs/counters/epoch/snapshot, event log,
  temp-profile create/remove/stale sweep, redaction rules, `shouldNotify`
  (crash notifyable only while blocking; `CDP_DISCONNECTED` never), dedupe +
  `reset()`, `runCheck`/`buildReport`/`renderReport`/`overallStatus`,
  epoch stamping + backward compatibility.
- `analysisRunner.test.js` reached 26 tests (+4): epoch prefers
  `getLastSessionEpoch()` then falls back, blocked outcome epoch stamped,
  `full_analysis` timeout via a temporarily-shrunk policy → `ANALYSIS_TIMEOUT`
  (mutated in the test, restored in `finally`).

## Notes / limitations
- The `embedded` integration fixture, whose 4-vs-3 discrepancy was long logged
  as a known failure, is **fixed**: the fixture had drifted from its documented
  contract (one inactive declaration per source) — `display: flex` and duplicate
  `justify-content` lines had been introduced, which turned the effective
  declarations active and inflated the count to four overridden duplicates.
  Restored to one inactive `justify-content` per source (external rule, `<style>`
  block, inline attribute); the dedicated `duplicates` fixture keeps covering
  override semantics. Integration is now 26/26.
- Epoch stamping relies on the analyzer reporting its own last session epoch
  when the provider doesn't (fallback keeps old tests/uses valid).
- Notifications deliberately follow the allow-list: encode, message, actions
  are the only surface, and only for explicit/blocking failures — silent
  self-healing stays silent.

## Next (backlog candidates)
- Feed live synthetic-injection/decoration-stage counts into `CoverageSignals`
  (completes Phase 4's feed axes with real numbers).
- Re-notify (auto-analyze-on-save) paths so they reuse `buildOutcome`/`derive`
  instead of ad-hoc strings.
- Audit the standing `RETRY_POLICY` numbers against real-platform crash
  distributions (the values are structural, not yet empirically tuned).