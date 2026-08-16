# PHASE3-REPORT — Phase 3: First-Run Experience & Status Visibility

## Scope
Phase 3 of the failure-UX effort (Phase 1 = failure taxonomy, Phase 2 =
environment readiness). Turn the readiness state into visible, calm,
non-spammy UI: a persistent status bar item, a one-time first-run welcome,
a Show Status overview, a Diagnose Setup summary and an output-channel
entry point — plus context keys for future `when` clauses. Non-goals kept
explicit: no setup wizard, no full diagnostics/repair, no browser crash
recovery UI, no coverage UX, no webview, no telemetry, no browser
download/install, no auto-analysis on first run, no Problems-panel changes,
no new CSS rules or engine changes.

## What was built

### Status model & bar (`src/activation/statusModel.ts`, `statusBarController.ts`)
- `deriveStatus(enabled, readiness, known)` is a pure mapping from the Phase 2
  `ReadinessState` to a presentation contract (`state` / `text` / `tooltip` /
  `visible`). Persistent states map 1:1 to short, non-technical labels
  ("NoEffect: Ready", "NoEffect: Browser not found", "NoEffect: Untrusted
  workspace", …); file-level reasons never surface as status-bar states;
  `readiness === null` renders "Initializing..." before the first snapshot and
  a neutral "Status unknown" after a failed refresh — never a misleading
  success/failure.
- `StatusBarController` owns the single item for the extension lifetime. The
  vscode adapter creates it once (`StatusBarAlignment.Right`, priority 100)
  and sets the command to `noEffect.showStatus` permanently. Updates are
  deduped on a presentation key (`state|text` or `hidden`), so rapid readiness
  changes never mutate the item needlessly; `visible: false` states
  (e.g. disabled) hide the item quietly. Disposal releases the host item.

### Readiness controller (`src/activation/readinessController.ts`)
- The single consumer of the Phase 2 readiness model for UI purposes
  (`ReadinessSource`/`ReadinessHost`/`StatusBarController` injected). On
  `start()` it initializes all context keys to safe false, then kicks off the
  first environment check on a microtask (activation stays fast).
- **Freshness:** a generation counter means a stale async result can never
  overwrite a newer one; a failed evaluation applies a neutral `null` state.
- **Coalescing:** settings/trust-triggered refreshes pass through a
  `Debouncer` (300 ms); `forceRefresh()` (Diagnose Setup) invalidates pending
  debounced refreshes and re-checks the environment now.
- **Bounded first snapshot:** the first-run decision races the snapshot with a
  short bounded timeout (3 s); the eventual result still applies afterwards,
  so the UI never stays stuck on "Initializing".
- **Context keys:** `noEffect:ready`, `noEffect:enabled`,
  `noEffect:setupNeeded`, `noEffect:workspaceBlocked` — updated only on
  change, failures swallowed, never the sole feedback mechanism.
- **Logging:** change-only `[Readiness] <reason>` info lines (plus debug lines
  for context updates) via the existing logger.

### First-run welcome (`src/activation/firstRun.ts`)
- Pure `decideFirstRun(enabled, readiness)` → `'none' | 'ready' | 'setup' |
  'workspace'`; disabled and unknown snapshots are quiet, file-level reasons
  are quiet, browser problems get the setup message, workspace problems the
  workspace message.
- Shown **at most once per user**: completion persisted in global state
  (`noEffect:firstRunShown.v2`). Guards: in-flight flag against concurrent
  snapshots, plus a session guard so an unreadable/broken store can never
  cause a re-show loop. The run is marked complete even when the environment
  is unready — persistent problems stay visible through the status bar, Show
  Status and Diagnose Setup, never through repeated notifications.
- Messenger actions are wired to real commands (Analyze, Show Status, Open
  Settings, Diagnose Setup). Messenger or store failures stay quiet.

### Show Status (`src/activation/statusViewModel.ts` + `commands.ts`)
- Pure `buildStatusView(facts)` → heading + lines + declarative actions
  (`command` + `args`, never closures). No raw browser paths, no raw error
  messages: detection source is described as "auto-detected" / "configured
  browser path", warnings are summarized by code.
- The command renders the view as a Quick Pick whose action items execute
  their declarative command (Analyze, Diagnose Setup, Open Settings, Show
  Output).

### Diagnose Setup (`src/activation/diagnoseSetup.ts` + `commands.ts`)
- Pure `collectDiagnostics(facts)`: versioned header, enabled/trust/support,
  browser detection with checked timestamp (stale marked explicitly), usable
  configured-path validity, current-file eligibility, settings summary,
  readiness + warnings, first-run state, and an actionable `Hint:` line.
- The command writes the lines to the output channel and shows them in a
  Quick Pick; it never launches a browser.

### Show Output Logs
- New `noEffect.showOutputLogs` command reveals the NoEffect output channel —
  the only auto-reveal in the extension.

## Testing
- 61 new unit tests (595 → **656**), all passing; `npm run compile` clean.
  Suites: `statusModel` (state mapping incl. initializing/unknown/disabled),
  `statusBarController` (dedup, single item, hide/show transitions),
  `readinessController` (safe-false context init, generation-counter stale
  rejection, debounce coalescing, forceRefresh cancel, bounded snapshot with
  eventual apply, change-only logging, swallowed setContext failures,
  dispose semantics), `firstRun` (once-only, quiet-when-disabled, mark-complete
  even when unready, session guard on broken stores, action pass-through,
  quiet failures), `statusViewModel` (safe lines, no raw paths, declarative
  actions, warning summaries), `diagnoseSetup` (path validity, hints, stale
  marker, no secrets).

## Persistence & state
- `noEffect:firstRunShown.v2` (global state, boolean; unreadable → treated as not
  completed, session guard prevents loops).

## Known limitations
- Status bar text is static per state (no browser path shown, by design).
- VS Code notifications render a **single line only** (`\n` is stripped and
  `MessageOptions.detail` is ignored for non-modal toasts). The welcome is
  therefore composed into one compact sentence via `composeFirstRunMessage`
  — no long command names, no full extension name. The `Source` line in
  notifications comes from `displayName`, kept short (`NoEffect`); the rich
  marketplace description lives in `package.json#description`.
- The first-run welcome depends on the first readiness snapshot; in exotic
  environments this may arrive after the initial bounded wait (message still
  shows once the snapshot lands).
- Context keys are exposed for `when` clauses but no `when` clauses use them
  yet (commands remain always registered).

## Dev tooling
- Hidden command `noEffect.debugShowFirstRun` (not in the command palette)
  re-shows the welcome message on demand for previewing; it bypasses the
  one-time guards and never marks completion. Bound to `Ctrl+Alt+Shift+N`
  (`Cmd+Alt+Shift+N` on macOS) via `contributes.keybindings`; rebindable in
  the Keyboard Shortcuts editor.
