# PHASE2-REPORT — Phase 2: Environment Detection & Safe Defaults

## Scope
Phase 2 of the failure-UX effort (Phase 1 = the central failure taxonomy and
`AnalysisOutcome` contracts). Turn "run the analysis" into a safe, conservative
pipeline that only ever touches a real local browser against real local files,
and that records its readiness state through the existing Phase 1 failure
taxonomy — no new parallel model, no notifications, no modal spam, no remote
connections, no browser downloads.

## What was built

### Browser discovery & validation (`src/environment/browserDetection.ts`)
- `BrowserDetector`: deterministic, cached, injectable (platform / fs / spawn /
  env). Checks the user-configured `noEffect.chromiumPath` first (exists +
  executable via a lightweight `--version` probe), then auto-detects common
  installs (Linux/macOS PATH names, macOS app bundles, Windows env-derived
  paths) in a fixed order. Every probe is a shell-free `spawn` with an argument
  array, bounded by a 5 s timeout, killed on settle. Results are cached until
  `invalidate()` (settings change) or a successful real launch
  (`recordFound()`).
- Overrides are **never executed in untrusted workspaces** (callers drop
  `allowOverride`); workspace-provided strings never become browser paths there.

### Workspace classification (`src/environment/workspace.ts`)
- `classifyWorkspace`: `local` (all `file:` folders), `unsupported` (any
  virtual/remote/SSH scheme — analysis cannot run), `none` (single-file mode is
  still safe).

### File eligibility (`src/environment/fileEligibility.ts`)
- Deterministic primary-reason order: **scheme → language → generated bundle →
  ignore glob → size**, evaluated once per request (no repeated re-evaluation
  of unchanged files).
- Generated/minified bundles (`.min.css`, `.bundle.css`) skipped by default;
  dependency/build/VCS/IDE directories (`node_modules`, `bower_components`,
  `vendor`, `dist`, `build`, `coverage`, `out`, `.git`, `.hg`, `.svn`,
  `.idea`, `.vscode`) ignored by default; user patterns merged on top.
- Conservative **512 KB** default threshold (`noEffect.maxFileSizeKb`, default
  512, range 16–65536) — down from the previous 1 MB constant.
- Ships its own tiny dependency-free glob matcher (`**`, `*`, `?`; POSIX
  normalization; bare-name patterns match the basename).

### Readiness model (`src/environment/readiness.ts`)
- `EnvironmentReadiness.evaluate()` with deterministic precedence
  **disabled → unsupported workspace → untrusted workspace → browser
  detection**; `fileReadiness()` with **unsaved → eligibility**. Every unready
  state carries the matching Phase 1 `AnalysisFailure` (kind / code /
  severity / recoverable), and `analyzeOnType` on a ready state emits a
  `LIVE_ANALYSIS_UNAVAILABLE` warning (degraded-not-fatal). Consumed on demand
  by `noEffect.showStatus`; the same contracts drive the runner gate so the two
  can never disagree.

### Runner integration (`src/services/analysisRunner.ts`)
- `run()` gates: untrusted/unsupported workspace → known-bad cached browser
  state (`not_found` / `path_invalid` / `launch_failed` block; `not_attempted`
  proceeds to the typed-error path) → dirty file (`FILE_UNSAVED`, no prompts)
  → eligibility. `RunRequest` gained `workspaceUnsupported`, `scheme`,
  `ignoredPatterns`, `maxFileSizeBytes`; the runner accepts an injectable
  `BrowserDetector`.

### Safe local infrastructure
- `DevServer`: binds **loopback-only** (`127.0.0.1`), ephemeral port; path
  traversal (raw and percent-encoded), backslash and null-byte escapes are
  rejected with 400 before any filesystem access; all responses carry
  `Cache-Control: no-store`; virtual pages never touch disk.
- `BrowserRunner`: launches with an **isolated temp profile**
  (`--user-data-dir` from a temp provider — never the user's real profile),
  removed on shutdown/crash; extra feature-disabling flags
  (`--no-default-browser-check`, `--disable-notifications`, etc.); `spawn`
  injectable for unit tests.
- `LifecycleManager`: uses the detector's found executable when no override is
  set, records a real launch into the detector (`recordFound`), and page URLs
  now use `127.0.0.1` to match the loopback-bound server (avoiding a
  `localhost` → `::1` mismatch).
- Activation re-detects in the background (cancellable, non-blocking) on
  settings changes.

### Failure behavior
- Environment not ready → analysis skipped (`skipped` outcome) → state recorded
  in the outcome's warnings/skipped-reasons; never a notification, never a
  crash, no rapid retry loops (detector caching + session-manager
  hash-based skip).

## Tests
New unit suites (all injectable — no real browser):
- `browserDetection.test.ts` (9): not_attempted default, not_found,
  path_invalid (missing/not-executable override), configured-override found,
  allowOverride suppression, caching + `invalidate`, `recordFound`, mid-flight
  cancellation without caching.
- `fileEligibility.test.ts` (14): scheme/type/generated/ignore/size gates,
  512 KB boundary, deterministic precedence, user pattern merging, glob
  matcher semantics (segments, basenames, Windows paths, anchoring).
- `readiness.test.ts` (14): disabled/unsupported/untrusted precedence, browser
  states, ready + `LIVE_ANALYSIS_UNAVAILABLE` warning, untrusted never reaches
  detection, file dimension (requires save / too large / ignored / eligible).
- `devServer.test.ts` (6): loopback bind, file serving + no-store, raw and
  encoded traversal rejection, virtual pages, 404.
- `browserRunner.test.ts` (3): injected spawn, isolated temp profile flag,
  feature-disabling flags, running-state transitions.
- `analysisRunner.test.ts` (+8): workspaceUnsupported, maxFileSizeBytes
  override, ignored/generated files, cached browser states block the run, a
  usable browser does not.

**Totals: 595 unit tests passing, 0 failing** (was 541); `npm run compile`
clean. Integration suite still compiles; the existing integration tests
(24) are unchanged and remain optional/graceful when Chromium is absent.

## Deliberate behaviors (safe defaults)
- Dirty files: skip with `FILE_UNSAVED` — no repeated save prompts; saved-file
  analysis is the documented policy.
- `analyzeOnType` disabled by default; live in-memory analysis not supported
  and explicitly surfaced as a warning if enabled.
- 512 KB default max file size; generated/minified/large/vendored skipped by
  default; patterns configurable.
- No browser download/install, no remote browser connections.
- Chromium missing → analysis disabled via `CHROMIUM_NOT_FOUND` (actionable
  message), no crash loops.

## Known limitations (documented in PROJECT_STATE.md §4)
- Saved-file-only analysis (no live typing analysis).
- Detection covers common installs only; no auto-install.
- Companion-document search and README staleness remain pre-existing debt
  (README "Phase 1" claim noted there).
