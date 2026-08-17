# NoEffect — Comprehensive Codebase Audit & Health Report

**Audit date:** 2026-08-17
**Audited surface:** 120 production TypeScript modules under `src/` (~18k LOC, excluding tests, fixtures, `reference/`), `package.json`, `scripts/build.mjs`, `.vscodeignore`, packaged VSIX payload
**Method:** full-file static analysis of every production module, export cross-referencing by grep across `src/`, verification re-reads of every critical finding, review of the packaged VSIX payload
**Scope note:** read-only audit — no source files were modified.

---

## 1. Executive Summary

NoEffect is a well-structured, defensive, extensively-tested VS Code extension (CSS inactive-property analysis over real Chromium/CDP). The architecture is genuinely strong: a single-writer result-identity model (content hash + analysis-context fingerprint + session epoch), a typed failure taxonomy with bounded retry policies, deterministic companion selection, and layered content-addressed caches. **No P0 (critical) issues were found.** There is one P1 correctness/robustness defect, a cluster of P2 issues (memory growth, blocking synchronous I/O in warm paths, a few security-hygiene gaps), and a large P3 dead-code / clean-code surface — roughly a third of the `session/`, `matcher/` and `utils/` modules are unused stubs or test-only exports.

### Key findings count

| Severity | Count |
|---|---|
| P0 — Critical | 0 |
| P1 — Major | 1 |
| P2 — Moderate | 12 |
| P3 — Low / Informational | 34 (grouped) |
| **Total** | **47** |

### Overall risk score: **Medium**

- **Positive:** strict TS (`"strict": true`); no shell execution (child processes spawned with argument arrays only); loopback-only DevServer with traversal protection; secret redaction present; cancellation honored in every long-running path; caches are content-addressed and cannot poison warm results.
- **Negative:** several caches grow unboundedly across edit history; the "warm" path still performs synchronous full-file reads + SHA-256 on the extension-host thread; one unguarded filesystem call can abort an analysis and throw inside editor event handlers; user-authored CSS text reaches hover Markdown; log redaction misses JSON-style secrets.

### Top 5 things to fix first

1. `[P1-BUG-01]` — guard `fileHashCache.getOrRead` (a deleted companion crashes the analysis and can throw inside editor event handlers).
2. `[P2-MEM-07/08]` — bound or evict all version-keyed caches; wire `multiPassCache.reset()` into the clear-cache command.
3. `[P2-PERF-09]` — stop unconditional re-reads on hash-probe warm paths (cheap size+mtime gate or off-thread hashing).
4. `[P2-BUG-02]` — re-validate the editor/document after an analysis `await`.
5. `[P2-SEC-04/05/06]` — complete the redaction contract, escape the injected filename in the wrapper page, backtick-quote authored CSS text entering Markdown.

---

## 2. Detailed Issue Breakdown

### P0 — Critical

None. The pipeline was specifically probed for: unhandled promise rejections (all async entry points resolve to classified outcomes), injection into `Runtime.evaluate` (all user data is `JSON.stringify`-escaped), DevServer path traversal (rejected by `fromServedPath` before any filesystem access), shell injection (argument-array spawn only), and stale-decoration poisoning (freshness fingerprint gate verified sound).

---

### P1 — Major

#### [P1-BUG-01] Unguarded `readFileSync` throw aborts analyses and throws inside editor event handlers

- **File Location:** `src/engine/companionSelection.ts:66-93` (unguarded call at line 73); root cause `src/cache/fileHashCache.ts:31-35`; propagation sites `src/engine/analysisContext.ts:117-123`, `src/services/cdpAnalyzer.ts:477`, `src/activation/commands.ts:129`, `src/activation/activate.ts:464,500`
- **Category:** Bug
- **Description & Impact:** `fileHashCache.getOrRead` performs `fs.readFileSync` **before** any try/catch (the file is read to compute a hash and compare it with the cached one). `cachedPageContainsAnySelector` calls it unguarded, so when a companion HTML file is deleted (or becomes unreadable) between resolution and selection — a routine event during development — an `ENOENT`/`EACCES` throws synchronously out of:
  - `selectCompanionsForAnalysis` → `analyzeWithCompanions` (`cdpAnalyzer.ts:477`) → **the entire stylesheet analysis fails** with a generic error instead of degrading to a conservative skip;
  - `companionContextFingerprintFor` (`analysisContext.ts:122`) → called from **editor event handlers** (`activate.ts:464,500` and `commands.ts:129`) → an exception bubbles to the VS Code event emitter and breaks the editor-switch/decorations refresh path.
  - The codebase's own defensive pattern — `companionHashOf` at `cdpAnalyzer.ts:612-618` returning `''` on failure — exists but is not applied here.
- **Recommended Fix:** (1) Wrap the hash read in try/catch inside `cachedPageContainsAnySelector` and treat a read failure as a conservative `false` (content unknown → never crash); (2) harden `companionContextFingerprintFor` with its own try/catch so event-handler paths can never throw; (3) optionally make `getOrRead` return a result type instead of throwing.
- **Before:**
```ts
// companionSelection.ts:66-73
export function cachedPageContainsAnySelector(htmlPath, selectors, cssHash) {
  const key = path.resolve(htmlPath);
  const cached = scanCache.get(key);
  const pageHash = fileHashCache.getOrRead(key).hash;   // throws on ENOENT/EACCES
  ...
}
```
- **After:**
```ts
export function cachedPageContainsAnySelector(htmlPath, selectors, cssHash) {
  const key = path.resolve(htmlPath);
  const cached = scanCache.get(key);
  let pageHash: string | null = null;
  try {
    pageHash = fileHashCache.getOrRead(key).hash;
  } catch {
    return false; // unreadable companion: conservative abstain, never crash
  }
  if (cached && cached.pageHash === pageHash && cached.cssHash === cssHash) {
    return cached.contains;
  }
  // ... unchanged containment scan
}
```

---

### P2 — Moderate

#### [P2-BUG-02] Analysis command uses a stale editor/document after `await`

- **File Location:** `src/activation/commands.ts:265-311` (capture), `:338` (hash of current text), `:432` (decoration apply), `:439` (clear)
- **Category:** Bug
- **Description & Impact:** `editor` is captured before a multi-second browser analysis. After `await promise` (line 311) the code hashes **whatever text the editor holds now** (`analyzedHash`, line 338) and records the namespace under that fingerprint — even though the run judged older content. If the user edited the file or switched editors during the run: (a) the recorded namespace identity matches content that was never analyzed, so freshness probes can treat a stale outcome as "fresh" and keep dimming outdated text; (b) `applyDecorationsToOwners` / `clearDecorationsForEditor` (lines 432/439) touch **the captured editor** — possibly a different file — with ranges computed for the analyzed file.
- **Recommended Fix:** Capture `document.version` and freeze the analyzed text at trigger time; after the `await`, re-validate that the active editor still shows the same document URI and the same version before hashing, recording the namespace, or applying decorations. When changed, skip application and let the next trigger re-analyze.
- **Before:**
```ts
const editor = vscode.window.activeTextEditor;               // line 265
...
const { outcome, issues } = await promise;                   // line 311
...
const analyzedHash = contentHash(editor.document.getText()); // line 338 — text may have changed
...
applyDecorationsToOwners(decorationManager, editor, issues); // line 432 — editor may be stale
```
- **After:**
```ts
const editor = vscode.window.activeTextEditor;
const document = editor.document;
const startVersion = document.version;
const analyzedText = document.getText();                     // freeze the judged content
...
const { outcome, issues } = await promise;
const current = vscode.window.activeTextEditor;
if (!current || current.document.uri.fsPath !== filePath) {
  return;                                                    // superseded by an editor switch
}
if (current.document.version !== startVersion) {
  return;                                                    // content changed mid-run — skip
}
const analyzedHash = contentHash(analyzedText);
...
applyDecorationsToOwners(decorationManager, current, issues);
```

#### [P2-BUG-03] `classifyFailure` crashes on `null`/`undefined` cause (catch-all boundary is not total)

- **File Location:** `src/failure/classifier.ts:193-302`
- **Category:** Bug
- **Description & Impact:** Every `catch` in the pipeline funnels its thrown value into `classifyFailure`, whose stated contract is "classify any thrown value" (lines 145-147). After all `instanceof` checks fail, `const errno = cause as ErrnoLike` is dereferenced unconditionally: `typeof errno.wsCloseCode` (196), `switch (errno.code)` (208), `errno.message` (302). `classifyFailure(null)` / `classifyFailure(undefined)` — e.g. from `throw undefined` or a bare `Promise.reject()` — throws `TypeError` instead of returning an `unknown` failure. Latent today (call sites pass `Error`s), but any future `throw` of a non-object value below the bound breaks classification itself.
- **Recommended Fix:** Guard the probe on `cause !== null && typeof cause === 'object'` before reading `.code`/`.message`; fall back to `messageOf(cause)`.
- **Before:**
```ts
const errno = cause as ErrnoLike;
if (typeof errno.wsCloseCode === 'number') { ... }   // TypeError when cause is null
switch (errno.code) { ... }                          // TypeError when cause is null
const message = errno.message ?? messageOf(cause);
```
- **After:**
```ts
const errno =
  cause !== null && (typeof cause === 'object' || typeof cause === 'function')
    ? (cause as ErrnoLike)
    : null;
if (errno && typeof errno.wsCloseCode === 'number') { ... }
if (errno) { switch (errno.code) { ... } }
const message = errno?.message ?? messageOf(cause);
```

#### [P2-SEC-04] Log redaction misses JSON keys and lowercase keys (contract violation)

- **File Location:** `src/session/redaction.ts:28-41`
- **Category:** Security
- **Description & Impact:** The redaction regex `(\b[A-Z_][A-Z0-9_.-]*)\s*[:=]...` only matches keys beginning with an uppercase letter or `_`. Verified: `{"apiKey": "secret123"}` and `key=...` in URLs pass through unchanged; quoted JSON keys break the match entirely. The module contract ("secrets ... never reach the user", line 12) is therefore violated for any structured/JSON content reaching the output channel or diagnostics — e.g. CDP error frames or settings echoes (`activate.ts:247` logs `JSON.stringify(settings)` wholesale).
- **Recommended Fix:** Add a JSON-aware pass that matches `"key"\s*:\s*"value"` and redacts the value; treat bare-key assignments case-insensitively.
- **Before:**
```ts
// redaction.ts:34-37
const ASSIGNMENT = /\b([A-Z_][A-Z0-9_.-]*)\s*[:=]\s*(["']?)([^"'\s,;]+)\2/g;
```
- **After:**
```ts
// JSON form: "apiKey": "..." -> redact group 2
const JSON_KV = /("(?:[^"\\]|\\.)*")\s*:\s*"((?:[^"\\]|\\.)*)"/g;
// Bare keys incl. lowercase: (\b[A-Za-z_][A-Z0-9a-z_.-]*)\s*[:=] ...
// keep any non-secret key whitelist (path-like values) as needed
```

#### [P2-SEC-05] Raw filename interpolation into wrapper-page HTML

- **File Location:** `src/services/analysisPage.ts:214-238` (line 231); caller `src/services/cdpAnalyzer.ts:379-380`
- **Category:** Security
- **Description & Impact:** `buildWrapperPage(selectors, \`/${fileName}\`)` interpolates the CSS file's **basename raw** into `<link rel="stylesheet" href="${cssHref}">`. A filename containing `"` injects attributes/elements into the served analysis page; `#`, `?`, or spaces break URL semantics so the browser requests a path different from what `toServedPath` computes (404 → degraded analysis). Self-inflicted (the user's own filename) but a genuine HTML-injection into a served page plus a correctness break; trivially fixable.
- **Recommended Fix:** URL-encode the href at the boundary and HTML-escape at the interpolation site; or construct the link in the page itself so no string interpolation is needed.
- **Before:**
```ts
// analysisPage.ts:231
`<link rel="stylesheet" href="${cssHref}">`,
```
- **After:**
```ts
// caller: cdpAnalyzer.ts:380
defaultLifecycle.setVirtualFile(wrapperName,
  buildWrapperPage(selectors, `/${encodeURI(fileName)}`));
// analysisPage.ts:231
`<link rel="stylesheet" href="${cssHref
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;')}">`,
```

#### [P2-SEC-06] Author-authored CSS text rendered as hover Markdown (content injection)

- **File Location:** `src/inactive/inactiveRuleEngine.ts:62-78` (raw `winnerSelector` in `reasonText`); `src/diagnostics/decorations.ts:451-501` (line 470 appends `issue.reason` verbatim); systemic via `src/inactive/rules/shared.ts:359-398` and rule files interpolating `propertyName`/`propertyValue`/selector fragments
- **Category:** Security
- **Description & Impact:** `reasonText` embeds the stylesheet's own selector text (e.g. `Overridden by '${winnerSelector}' ...`). `buildHoverMessage` appends it to a `MarkdownString` verbatim. Today `md.isTrusted = true` is set only when fixed-text command-link markdown is used (decorations.ts:496-498), so the raw text renders **untrusted** — but untrusted Markdown still renders clickable links, images, and format control (e.g. `[x](https://evil)`) with no escaping, and any future path that lifts trust (mixing the raw selector into a command-link message) becomes a `command:`-URI pivot. Low practical impact today; wrong-by-construction hardening.
- **Recommended Fix:** Escape backticks/backslashes and wrap selector fragments in backticks at the reason-text construction site (or escape in `buildHoverMessage` before `appendMarkdown`); never put raw content into messages that set `isTrusted`.
- **Before:**
```ts
// inactiveRuleEngine.ts:73-75
reasonText: winnerSelector
  ? `Overridden by '${winnerSelector}' — that rule wins the cascade for this element, ...`
```
- **After:**
```ts
const safeSelector = winnerSelector.replace(/[\\`]/g, '\\$&');
reasonText: winnerSelector
  ? `Overridden by \`${safeSelector}\` — that rule wins the cascade for this element, ...`
```

#### [P2-MEM-07] Version-keyed caches grow unboundedly across edit history

- **File Location:** `src/cache/embeddedCssCache.ts:155-183` (parse cache keyed `path|htmlHash`), `:242-249` (mapping cache keyed with `htmlHash`); `src/cache/mappingCache.ts:142-181` (key includes `cssHash` + batch signature); `src/cache/astCache.ts:31-56` and `src/cache/fileHashCache.ts:22-48` (stale entries retained for deleted files)
- **Category:** Performance / Memory
- **Description & Impact:** Every content version of a file creates a new permanent cache entry holding full parsed ASTs / mapping tables. Long sessions with many saves accumulate memory with no eviction; only the manual `Clear Cache` command resets them. `multiPassCache` has the same profile (see P2-MEM-08). Entries are content-addressed so they cannot poison correctness, but growth is unbounded. The intended pattern already exists at `companionSelection.ts:57` (`SCAN_CACHE_LIMIT = 256`) and `selectorScan.boundaryCache`.
- **Recommended Fix:** Add an LRU-style cap (e.g. 128-512 entries) with oldest-first eviction to every version-keyed cache; for path-keyed caches, lazily drop entries whose file no longer exists.
- **Before:**
```ts
// embeddedCssCache.ts — set() with no eviction
set(key: string, entry: EmbeddedCssParse): void {
  this.cache.set(key, entry);
}
```
- **After:**
```ts
private static readonly LIMIT = 256;
set(key: string, entry: EmbeddedCssParse): void {
  if (this.cache.size >= EmbeddedParseCache.LIMIT) {
    const oldest = this.cache.keys().next().value;
    if (oldest !== undefined) this.cache.delete(oldest);
  }
  this.cache.set(key, entry);
}
```

#### [P2-MEM-08] `multiPassCache` reset never wired into production (doc contract false)

- **File Location:** `src/cache/multiPassCache.ts:18-19` (doc claim), `src/activation/commands.ts:486-491` (clear-cache command)
- **Category:** Memory / Dead Code
- **Description & Impact:** The module doc claims `reset()` is "wired to the cache-reset watchers alongside the companion-resolution cache". Verified: only tests call `multiPassCache.reset()`; the `noEffect.clearCache` command resets `astCache/mappingCache/fileHashCache/htmlFragmentCache/embeddedParseCache/embeddedMappingCache` but **omits `multiPassCache`**, and activation watchers reset only `companionCache`. Per-pass and merged entries for every analyzed content version accumulate with no programmatic way to clear them.
- **Recommended Fix:** Add `multiPassCache.reset()` to the clear-cache command; correct the module doc.
- **Before:**
```ts
// commands.ts:486-491
astCache.reset();
mappingCache.reset();
fileHashCache.reset();
htmlFragmentCache.reset();
embeddedParseCache.reset();
embeddedMappingCache.reset();
```
- **After:**
```ts
astCache.reset();
mappingCache.reset();
fileHashCache.reset();
htmlFragmentCache.reset();
embeddedParseCache.reset();
embeddedMappingCache.reset();
multiPassCache.reset();   // was never wired — unbounded growth
```

#### [P2-PERF-09] Synchronous full-file read + SHA-256 on every hash probe (warm path is not warm)

- **File Location:** `src/engine/companionSelection.ts:71-76` (hash read before scan-cache check); `src/cache/fileHashCache.ts:31-35`; `src/cache/astCache.ts:40-42`; `src/cache/companionCache.ts:62-87`; consumers `src/engine/analysisContext.ts:101-123`, `src/activation/activate.ts:498-509`, `src/activation/commands.ts:128-136`
- **Category:** Performance
- **Description & Impact:** `getOrRead` must read the file to produce the hash, so a "cache hit" still costs a full `readFileSync` + SHA-256 — **on the extension-host main thread, synchronously**. `cachedPageContainsAnySelector` performs this **before** consulting its own scan cache, and every refresh path (editor switches, freshness probes, companion validation) re-reads and re-hashes every companion document. With K companions × several stylesheets, a single editor switch can run tens of full-file reads + hashes synchronously, freezing the UI — the exact hazard the codebase itself flags at `cdpAnalyzer.ts:1808-1811`.
- **Recommended Fix:** (1) Return early from the scan cache when the key matches (defer/cheaply gate the hash with a `stat` size+mtime comparison); (2) hash off-thread (`setImmediate` chunking or a worker); (3) in `companionCache.getValidatedEntry`, skip re-hash when nothing changed since validation.
- **Before:**
```ts
// companionSelection.ts:71-76
const cached = scanCache.get(key);
const pageHash = fileHashCache.getOrRead(key).hash;   // unconditional full read + SHA-256
if (cached && cached.pageHash === pageHash && cached.cssHash === cssHash) {
  return cached.contains;
}
```
- **After:**
```ts
const cached = scanCache.get(key);
if (cached && cached.cssHash === cssHash) {
  let stat;
  try { stat = fs.statSync(key); } catch { return false; }
  if (cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.contains;   // cheap freshness gate — no full re-read
  }
}
const pageHash = readHashSafely(key);   // wrapped, only when something changed
```

#### [P2-BUG-10] `ReadinessController.runWith` delivers `onSnapshot` twice per refresh

- **File Location:** `src/activation/readinessController.ts:142-174` (`apply` → `onSnapshot` at line 201, plus the `snapshot.then` chain at lines 168-173)
- **Category:** Bug
- **Description & Impact:** Every refresh fires the snapshot callback twice: once via `promise.then → this.apply(state)` (which itself calls `this.onSnapshot(state)` at line 201) and once via the returned `snapshot.then(...)` chain (line 170). With a bounded timeout the state is delivered a third time over (`null` + `state`). Currently masked because subscribers are debounced/guarded (first-run store, orchestration debouncer), but it doubles work on every refresh and is a latent contract violation for any future `onSnapshot` consumer (telemetry, focused triggers).
- **Recommended Fix:** Pick a single delivery path: make `apply` the sole notifier (drop the callback from the returned chain), or keep the submitted chain and remove `onSnapshot` from `apply`.
- **Before:**
```ts
promise.then((state) => { if (this.isCurrent(gen)) this.apply(state); }, ...); // apply → onSnapshot (L201)
...
return snapshot.then((state) => {
  if (this.isCurrent(gen)) this.onSnapshot(state);   // ← second delivery
  return state;
});
```
- **After:**
```ts
promise.then((state) => { if (this.isCurrent(gen)) this.apply(state); }, ...);
// apply() updates status bar + context keys; the returned promise chain
// only resolves the value — onSnapshot fires exactly once inside apply().
return snapshot.then((state) => state);
```

#### [P2-BUG-11] CDP WebSocket message handler: unguarded `JSON.parse` crashes the handler; in-flight requests can hang after a connection error

- **File Location:** `src/browser/cdpClient.ts:26-27` (parse), `:49-52` (error handler)
- **Category:** Bug
- **Description & Impact:** (a) `JSON.parse(data.toString())` on every frame runs without try/catch — a single malformed frame throws inside the EventEmitter handler (uncaught exception path in the extension host). (b) If the socket fires `'error'` after `'open'`, pending requests are neither rejected nor cleaned until a `'close'` arrives; a transport that errors without closing leaves requesters hanging until the session-level timeout. Both paths are robustness defects in the core protocol client.
- **Recommended Fix:** Wrap the parse in try/catch (log + ignore malformed frames); in the `'error'` handler, reject all pending requests (and mark the client disconnected) so no waiter hangs.
- **Before:**
```ts
socket.on('message', (data) => {
  const message = JSON.parse(data.toString());   // throws on malformed frame
  ...
});
socket.on('error', (err) => {
  logger.error(`[CDP] WebSocket error: ${err.message}`);
  if (!this.connected) reject(err);              // in-flight requests left pending
});
```
- **After:**
```ts
socket.on('message', (data) => {
  let message: unknown;
  try {
    message = JSON.parse(data.toString());
  } catch {
    logger.warn('[CDP] Ignoring malformed WebSocket frame');
    return;
  }
  ...
});
socket.on('error', (err) => {
  logger.error(`[CDP] WebSocket error: ${err.message}`);
  this.connected = false;
  this.pendingRequests.forEach((req) => req.reject(err));
  this.pendingRequests.clear();
  if (!this.connectedAtOpen) reject(err);
});
```

#### [P2-PERF-12] Companion resolution and freshness probes dominate the main thread on large workspaces

- **File Location:** `src/services/companionResolver.ts:207-328` (bounded BFS with `readdirSync`/`readFileSync` per candidate), called from `src/services/cdpAnalyzer.ts:2031` and from event handlers via `companionContextFingerprintFor`
- **Category:** Performance
- **Description & Impact:** Phase-A discovery walks the workspace synchronously (sorted `readdirSync` at each directory, full `readFileSync` per `.html` candidate, up to `maxCandidates` = 500 default operations) on the extension-host thread, from both the analysis path and the editor-switch freshness path. With large workspaces this is a multi-hundred-ms main-thread stall per trigger; combined with P2-PERF-09 it is the biggest UI-latency contributor. (Determinism, ignore-glob pruning and budget accounting are all correct — this is purely a threading issue.)
- **Recommended Fix:** Run resolution off the main thread (`vscode.workspace.fs` async APIs or a chunked `setImmediate` scan) and return a cached snapshot synchronously; the existing content+context fingerprints already allow an async refresh to be invisible to correctness.
- **Before:**
```ts
// companionResolver.ts:229,258 — synchronous scans on the caller's thread
entries = fs.readdirSync(dir, { withFileTypes: true }).sort(...);
...
content = fs.readFileSync(full, 'utf-8');
```
- **After:**
```ts
// Chunk the walk and yield to the event loop between directories:
for (const sub of subdirs) {
  queue.push({ dir: sub, depth: depth + 1 });
}
if (queue.length > 0 && batch % 16 === 0) {
  await new Promise((r) => setImmediate(r));   // cooperative scanning
}
// or move the whole scan into a Worker / vscode.workspace.fs
```

---

### P3 — Low / Informational

#### P3 group A — Dead modules (entire files, zero importers; grep-verified incl. tests)

| ID | File | Notes |
|---|---|---|
| [P3-DEAD-01] | `src/matcher/positionMapper.ts`, `src/matcher/propertyMatcher.ts`, `src/matcher/ruleMatcher.ts` | Phase-1 stubs; functionality replaced by `declarationMapper`; `async` methods never await; `dispose()` no-ops |
| [P3-DEAD-02] | `src/parser/sourceMapResolver.ts` | 29-line stub, zero importers, logs on every call |
| [P3-DEAD-03] | `src/browser/pageLoader.ts` | Entire `PageLoader` class unused; Phase-1 leftover |
| [P3-DEAD-04] | `src/utils/fs.ts`, `src/utils/paths.ts`, `src/utils/index.ts` | All exports zero importer; barrel also omits the actually-used `contentHash` |

**Recommended Fix:** delete these files and the barrel re-exports; run the test suite to confirm nothing regresses.

#### P3 group B — Dead exports & unreachable branches

| ID | File : lines | Item |
|---|---|---|
| [P3-DEAD-05] | `src/session/redaction.ts:54-65` | `redactLines` (zero usages); `shortenPath` test-only; `home === '/'` → `slice(1)` drops the leading slash |
| [P3-DEAD-06] | `src/session/notifications.ts:140` | `NotificationId` type unused; `:86-91` `DEV_SERVER_FAILED` entry unreachable (no `FAILURE_CODES` value equals it); `:117` `_FAILED`-strip fallback misses `DEVSERVER_START/DEVSERVER_PORT_BUSY/ANALYSIS_CANCELLED/COMPANION_FAILED` → generic message |
| [P3-DEAD-07] | `src/session/policy.ts:81-83,120-133` | `isRetriable`, `policyReason`, `isTransientKind`, `isPermanentKind`, `RETRY_BACKOFF_MS` — test-only/internal surface |
| [P3-DEAD-08] | `src/session/processTree.ts:22-29,67` | `GRACEFUL_KILL_DELAY_MS`, `KillPlan`, `runTaskkill` exported but internal/test-only |
| [P3-DEAD-09] | `src/session/report.ts:47-116` | `runCheck`, `buildReport`, `renderReport`, `overallStatus` — production assembles/renders the report inline; `commands.ts:43-65` re-implements a text renderer that "mirrors" `renderReport` (two sources of truth) |
| [P3-DEAD-10] | `src/session/tempProfile.ts:22-24,64-103` | `createTempDir`, `listStaleTempDirs`, `sweepStaleTempDirs`, `TEMP_PREFIX`, `STALE_TEMP_MAX_AGE_MS`, `TEMP_RETRY_DELAYS_MS` never invoked — the documented stale-profile sweep does not exist, orphaned `noeffect-*` temp dirs accumulate |
| [P3-DEAD-11] | `src/activation/diagnoseSetup.ts:230-292` | `collectDiagnostics` test-only (superseded by `collectDiagnoseReport`) |
| [P3-DEAD-12] | `src/inactive/rules/shared.ts:52-54` | `isOutOfFlow` helper — rules use `layout.isOutOfFlow` directly |
| [P3-DEAD-13] | `src/engine/verdictMerge.ts` | `locationDimensions` test-only export |
| [P3-DEAD-14] | `src/cache/companionCache.ts:63-66` | inert `resolutions.length !== companionHashes.length` guard (can never trigger); `:58,64,70,78,82` duplicated miss/return structure |
| [P3-DEAD-15] | `src/cache/embeddedCssCache.ts:181` | stored `hash` field never read (`getOrParse` keys on it already) |
| [P3-DEAD-16] | `src/status/derive.ts:48` | degenerate ternary `state: outcome?.stale ? 'idle' : 'idle'` |
| [P3-DEAD-17] | `src/activation/statusModel.ts:128-134` | `case 'disabled'` unreachable (early return at line 60 when `!enabled`) |
| [P3-DEAD-18] | `src/session/health.ts:126-129` | `reconnects` increments in the same branch as `recoveries` — always equal, cannot diverge; test codifies the coincidence |
| [P3-DEAD-19] | `src/environment/readiness.ts:153-160` | `allowOverride = workspace.isTrusted` always `true` (untrusted early-returns above) — dead guard |
| [P3-DEAD-20] | Repo root | Dev artifacts `repro-multipage.js/.map/.d.ts`, `testCdp.js/.map/.d.ts`, `.verify-companion.mjs` — excluded from VSIX but committed; consider moving under `scripts/` or deleting |

**Recommended Fix:** remove dead exports, collapse the `_FAILED`-strip + `DEV_SERVER_FAILED` message gap, and either wire or delete the temp-profile sweep; add a `publish-only` check for the root strays.

#### P3 group C — Logic edges & correctness nits

| ID | File : lines | Issue |
|---|---|---|
| [P3-LOG-21] | `src/parser/htmlScanner.ts:228-234` | Raw-text elements close on a **bare prefix match** (`</styles` closes `<style>`), diverging from browser "appropriate end tag" rules; CSS text containing `</stylesheet` is truncated. Also `html.slice(contentStart)` per element = O(R·n) copies |
| [P3-LOG-22] | `src/parser/htmlScanner.ts:168-177` | Quoted `style="  color:red"` (leading whitespace): `positions.at(valueTokenStart + 1)` points past the spaces while `value` retains them → shifted ranges land k columns right for oddly indented inline styles |
| [P3-LOG-23] | `src/failure/cancellation.ts:44-52` | TOCTOU: token can cancel between `isCancellationRequested` check and `onCancellationRequested` registration; new listeners don't replay past cancellations → a cancelled run may wait on the underlying promise instead of rejecting |
| [P3-LOG-24] | `src/activation/overrideJump.ts:69,96` | `void this.jumpToDeclaration(target)`; `showTextDocument` can reject (document closed mid-await) → unhandled rejection in a command handler |
| [P3-LOG-25] | `src/activation/firstRun.ts:186-191` | On messenger failure `completed` stays false → re-shows again in the same activation, contradicting the comment "stay quiet"; `activate.ts:125` `void context.globalState.update(...)` rejection unhandled |
| [P3-LOG-26] | `src/services/watchService.ts:20-32` | No URI-scheme filter — `git:`/virtual-scheme documents fire `onChange`/`onSave` → spurious re-analysis |
| [P3-LOG-27] | `src/browser/layoutContextBuilder.ts:157-160` | `contextCache` keyed by nodeId only: a second `build()` for the same node with different options silently returns the first context (no live bug today; latent) |
| [P3-LOG-28] | `src/cache/mappingCache.ts:39-45` | `mappingKeyFor` joins `selectorText\|name\|value` unescaped; `|` is legal inside CSS (attribute selectors `[x\|y]`) → theoretical key collision merging occurrence ranks |
| [P3-LOG-29] | `src/failure/coverage.ts:199,206` | `collectCoverage` stores the caller's `signals.counts` object **by reference** (no defensive copy) — later mutations retroactively change published snapshots |
| [P3-LOG-30] | `src/failure/outcome.ts:178` | `mode` without `modeReason` yields reason `'full analysis'` even for `mode: 'failed'/'limited'` — misleading status text |
| [P3-LOG-31] | `src/environment/browserDetection.ts:286` | `token?.onCancellationRequested(() => finish(false))` — subscription never disposed; listeners accumulate per probe |
| [P3-LOG-32] | `src/engine/verdictMerge.ts:160-162,196-198` | Doc claims outcome "depends only on ranks, not pass order in the input array", but `issueSource` picks the first array-ordered pass with an issue — latent if a caller passes unsorted outcomes; `:205` broken indentation |
| [P3-LOG-33] | `src/services/companionUrl.ts:82` | `serverRoot === '/'` (filesystem root): containment check becomes `startsWith('//')` → every request rejected (workspace roots never `/`; latent) |
| [P3-LOG-34] | `src/browser/devServer.ts:98-99` | Virtual-file name looked up un-decoded while disk paths are decoded — a browser-normalized wrapper URL containing `#`/`?` 404s |

**Recommended Fix:** apply the cheap guards described per row (delimiter check in the raw-text scanner, re-check cancellation inside the listener, `.catch` on jump, scheme filter in the watcher, defensive copies, subscription disposal, URL-decode the virtual name, backtick/escape the appended reason text).

#### P3 group D — Performance & resource nits

| ID | File : lines | Issue |
|---|---|---|
| [P3-PERF-35] | `src/browser/devServer.ts:192-207` | `closeServer` fallback `setTimeout` never cleared when `server.close()` finishes first — fires later (no-op) and keeps the event loop referenced for `timeoutMs` |
| [P3-PERF-36] | `src/session/tempProfile.ts:33-35` | `fs.rmSync(recursive: true)` inside `async removeTempDir` — blocking recursive delete of the browser profile on the extension-host thread; exported `removeTempDir` is an unguarded rm-rf primitive on an arbitrary caller-supplied path (containment check recommended) |
| [P3-PERF-37] | `src/cache/astCache.ts:41-47` + `fileHashCache.ts:40,45` | `logger.info` on **every** cache access (hit and miss) — hot-path output-channel churn |
| [P3-PERF-38] | `src/matcher/declarationMapper.ts:120-141,163-168` | `match()` rebuilds `exact`/`contained` arrays + `matchesSelector` Set per call, plus three `logger.info` lines per successful match |
| [P3-PERF-39] | `src/engine/declarationNormalizer.ts:67-83` | `findIndex`-based dedup is O(n²) per node batch (n small — acceptable, but replaceable with a Map keyed by range) |
| [P3-PERF-40] | `src/session/processTree.ts:89-93` | Windows path confirms death only once, 250 ms after `taskkill`, with no bounded re-poll (POSIX path polls) |
| [P3-PERF-41] | `src/inactive/inactiveRuleEngine.ts` + `src/browser/cdpAnalyzer.ts` pass loops | Per-declaration/per-selector `logger.info` lines inside the node loop — high volume on multi-node passes |

#### P3 group E — Code quality & DRY

| ID | File : lines | Issue |
|---|---|---|
| [P3-CLEAN-42] | `src/activation/activate.ts:304,335` | `disposables.push(...readinessUi.disposables)` executed **twice** for the same array → double-dispose of `ReadinessController`/status bar on deactivation (benign today; remove one) |
| [P3-CLEAN-43] | `src/inactive/rules/overflow/overflow.ts`, `overflowX.ts`, `overflowY.ts` | Three byte-identical 10-12 line modules (`createBoxSuppressedRule` one-liners) — merge into one module exporting three rules |
| [P3-CLEAN-44] | `src/parser/cssAst.ts:118-307` | `findBlockEnd` / `scanToStructuralChar` / `findFirstColon` are near-verbatim triplicates (~3 × 55 lines of scanner state machine); `:634-643` at-rule kind split on `/\s+/` only — `@media/*x*/ screen` misclassified; `:467-468` rule preludes keep comments verbatim, diverging from CDP `selectorText` |
| [P3-CLEAN-45] | `src/activation/statusViewModel.ts:119-121` | mis-indented `lines.push` (cosmetic) |
| [P3-CLEAN-46] | `src/config/settings.ts` + `package.json` | `ws` is a runtime import listed only under `devDependencies` — correct only because the VSIX ships fully bundled (`scripts/build.mjs`); add a comment or move to dependencies to make the contract explicit |
| [P3-CLEAN-47] | `src/engine/layoutContext.ts:464-471` | `pseudoBoxFacts` values are shared references (map copied only) — latent mutation leak into a "frozen" context |

---

## 3. Actionable Remediation Checklist

### Phase 1 — Correctness & robustness (do first; ~1-2 days)

- [ ] **P1-BUG-01** Guard `fileHashCache.getOrRead` in `cachedPageContainsAnySelector` + `companionContextFingerprintFor`; add a unit test deleting a companion between resolution and selection.
- [ ] **P2-BUG-02** Document-version re-validation in `commands.ts` before hashing/recording/applying.
- [ ] **P2-BUG-03** Null-safe probing in `classifyFailure`; add `classifyFailure(null)` / `classifyFailure(undefined)` unit tests.
- [ ] **P2-BUG-10** Single-delivery fix in `ReadinessController.runWith`; assert one `onSnapshot` per refresh in tests.
- [ ] **P2-BUG-11** Try/catch around `JSON.parse` in `CdpClient`; reject pending requests on socket `'error'`.
- [ ] **P3-LOG-23/24/25** Re-check cancellation inside the listener; catch `jumpToDeclaration` rejections; fix first-run failure semantics + awaited `globalState.update`.

### Phase 2 — Memory & performance (next; ~2-3 days)

- [ ] **P2-MEM-07 / P2-MEM-08** LRU caps on `embeddedParseCache`, `embeddedMappingCache`, `mappingCache`, `multiPassCache`; wire `multiPassCache.reset()` into `noEffect.clearCache`.
- [ ] **P2-PERF-09 / P2-PERF-12** Cheap size+mtime gate before hashing; cooperative/yielded companion scanning or `vscode.workspace.fs`; reduce hot-path `logger.info` calls.
- [ ] **P3-PERF-35/36/37/38/40** Clear the `closeServer` timer; async profile removal with path containment; log at `debug` on cache hits; trim mapper logging.

### Phase 3 — Security hardening (~1-2 days)

- [ ] **P2-SEC-04** JSON-aware secret redaction + regression tests for `{"apiKey": ...}` and lowercase keys.
- [ ] **P2-SEC-05** Encode + escape `cssHref` in `buildWrapperPage`.
- [ ] **P2-SEC-06** Backtick-wrap/escape authored selector text entering hover Markdown.

### Phase 4 — Dead code removal (~0.5-1 day, verify with `npm test`)

- [ ] Delete: `matcher/positionMapper.ts`, `matcher/propertyMatcher.ts`, `matcher/ruleMatcher.ts`, `parser/sourceMapResolver.ts`, `browser/pageLoader.ts`, `utils/fs.ts`, `utils/paths.ts`, `utils/index.ts`.
- [ ] Remove dead exports: `redactLines`, `NotificationId`, policy helpers, `KillPlan`/`runTaskkill` surface, `report.ts` production exports, temp-profile sweep (or wire it into activation), `collectDiagnostics`, `isOutOfFlow`, `locationDimensions`, `entry.hash`.
- [ ] Fix the `notifications.ts` message-map gap (`DEVSERVER_START_FAILED` etc.) and delete the unreachable `DEV_SERVER_FAILED` entry.
- [ ] Remove the duplicate `disposables.push` in `activate.ts:335`; move or delete root-level `repro-*`/`testCdp*`/`.verify-companion.mjs` artifacts.

### Phase 5 — Clean code (ongoing)

- [ ] **P3-CLEAN-43** Merge the three overflow rule files. **P3-CLEAN-44** extract one shared scanner for `cssAst`. **P3-CLEAN-45/47** fix indentation and copy `pseudoBoxFacts`. **P3-CLEAN-46** document/move the `ws` dependency.
- [ ] Re-run `npm run lint` and `npm test` after every phase; add targeted unit tests for each behavioral fix (the existing test suite covers the affected modules).

---

*Report generated from a read-only audit pass. Line numbers refer to the current working tree (`git status`: `src/activation/activate.ts` and `src/activation/commands.ts` have uncommitted modifications — findings in those files were verified against the working-tree content).*