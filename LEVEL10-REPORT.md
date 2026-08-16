# LEVEL10 — Cross-directory companion-document resolution

## The report

```html
<!-- project/index.html -->
<link rel="stylesheet" href="../styles/theme.css">
```

```css
/* project/styles/theme.css */
.object-fit-box { object-fit: cover; }   <!-- NOT analyzed — the gap -->
```

Until this level `analyzeCssFile` searched for a linking HTML document in the
stylesheet's **own directory only** (`findLinkingDocument`). A CSS file whose
companion lived one level up (or down, or was referenced root-relative, or
through a `<base href>`) fell back to the synthetic wrapper page — and the
wrapper's fabricated element types are marked `typeIsSynthetic`, so
type-dependent verdicts (like `object-fit` on a `<div>`) silently abstained.

## What changed

### 1. One shared URL model — `src/services/companionUrl.ts` (new)
Both the companion **matcher** and the **DevServer** must agree on what a
browser will request for a given stylesheet. There is exactly one resolution
implementation:

- `toServedPath(absPath)` — absolute file path → root-relative URL path
  (`/styles/theme.css`), the identity the DevServer routes on.
- `fromServedPath(root, urlPath)` — root-relative URL → in-bounds absolute
  path, with decode-then-containment: each decoded segment is rejected if it
  contains `..`, `/`, `\` or a null byte; malformed percent-escapes return
  `null` (400 on the server). In-bounds `..` segments are allowed and
  normalized exactly like a browser (the WHATWG URL parser collapses
  `%2e%2e` in the same way), so the matcher accepts precisely what a browser
  would request.
- `resolveLocalPath(baseDir, href)` — WHATWG `new URL(href, fileUrl)` math
  for the matcher: absolute (root-relative `/…`) and relative hrefs resolve
  against the **document's real directory or its `<base href>`**, and the
  result is same-origin-checked. `https:`, `data:`, `blob:`, `//host`,
  `javascript:` and undecodable hrefs return `null` (conservative skip —
  never a wrong verdict).

### 2. The resolver — `src/services/companionResolver.ts` (new)
`resolveCompanion(cssReal, settings)` is a pure, injectable function:

- **Phase A (find candidates):** a breadth-first scan from the stylesheet's
  directory upward, at each level visiting the directory's entries in
  deterministic order (directories first by name, files by name; `index.html`
  before other files), pruning eligibility-ignored names (`node_modules`,
  `dist`, `out`, …) before the read. Every HTML/HTM file is parsed with
  `extractLinkedHrefs` — a tokenizer-safe extractor that honors `<style>`
  raw-text semantics, quoted attribute values and a single `<base href>` —
  and a candidate matches if its resolved stylesheet paths contain the CSS
  file. The search stops as soon as any candidates exist at a level.
- **Phase B (precise match):** the winning document is the one whose
  `dirDistance` from the stylesheet is smallest; ties break
  `index.html`-first, then full-path lexicographic. Distance 0 is exactly
  the legacy same-directory policy — same-directory behavior is
  **bit-identical** (proven by every pre-existing fixture test).
- **Bounded by construction:** `maxCandidates` budgets BOTH directory
  visits AND candidate file reads (a root that climbs to `/` cannot hang);
  `maxDepth` caps the climb; `maxFileSizeBytes` skips oversized HTML;
  `ignoredPatterns` prunes `node_modules`-style trees before any I/O.
- **Search roots:** the stylesheet's workspace folder when one is known
  (the vscode layer injects `companionSettings.workspaceFolderProvider`);
  otherwise a bounded ancestor chain from the stylesheet upward (the plain
  `node` integration environment) — resolution is deterministic in both.

### 3. Serving — `src/browser/devServer.ts`
`resolveRequestPath` now delegates to `fromServedPath` from the shared model
instead of its private traversal rules. In-bounds `..` (e.g. a `pages/`
document requesting `../styles.css`) **serves** like a browser; raw/encoded
escapes, backslashes, null bytes and malformed percent-escapes are still
rejected with 400. The DevServer fixture tests gained in-bounds `..` cases.

### 4. Analysis wiring — `src/services/cdpAnalyzer.ts`
- `resolveCompanionFor(cssReal)` — cache-keyed lookup
  (`primaryRoot|cssReal`) through the hash-validated `companionCache`:
  the warm path reuses the previous resolution **without a single stat or
  read** unless the resolved HTML's content hash changed.
- `analyzeCssFile` companion branch: `withSession(serverRoot,
  toServedPath(serverRoot, htmlPath), companionChanged || !parsed.hit, …)`
  — the analysis page is served from the stylesheet's **root** with the
  real document's served path, and is re-served only when the companion
  changed or the session page was not the companion. Logs
  `[Companion] Resolved …` with the serving root.
- `analyzeHtmlFile` gains `serverRootFor` (workspace folder of the HTML,
  else its directory — legacy behavior unchanged) and serves
  `toServedPath(serverRoot, htmlPath)`; `collectStylesheetPaths` resolves
  linked-sheet paths through the shared `resolveLocalPath`, so a
  `pages/index.html` linking `../styles.css` loads its sheet over the
  DevServer exactly where the browser would request it.
- Legacy `findLinkingDocument` is gone; `vscode` stays a type-only import
  (the analyzer remains plain-node testable).

### 5. Configuration — `src/config/settings.ts` + `package.json`
- `noEffect.companionSearchDepth` (default **6**, 1–10) — max levels climbed
  above the stylesheet.
- `noEffect.companionMaxCandidates` (default **500**, 100–2000) — total
  directory visits + candidate reads budget.

### 6. Cache invalidation — `src/activation/activate.ts`
`applyCompanionSettings` wires the mutable settings bag; the vscode layer
pushes `workspaceFolderProvider` (from `vscode.workspace.getWorkspaceFolder`).
A `**/*.{html,htm,css}` file watcher, `onDidChangeWorkspaceFolders` and
settings changes all reset the companion cache, so an added/deleted/moved
companion document is picked up on the next run.

## Behavior guarantees
- **Deterministic:** every scan uses sorted directory entries; the winning
  document is a pure function of the filesystem state.
- **Bounded:** the search can never exceed `maxDepth` levels or
  `maxCandidates` units of work — even with a root at the filesystem root.
- **Safe:** the matcher and the server share one URL model; nothing the
  matcher accepts can be served outside the root, and nothing the server
  serves disagrees with the matcher's view.
- **Conservative:** unresolvable hrefs, external URLs, pruned `node_modules`
  linkers and multi-level ambiguity all degrade to the existing wrapper
  flow — never to a wrong dim.

## Verification
- New unit tests: `companionUrl` (17 — serving round-trips, traversal
  rejections, `%2e%2e` normalization, base hrefs, external URLs),
  `companionResolver` (23 — distance order, `index.html` tiebreak,
  root-relative/base resolution, depth/candidate budgets, `node_modules`
  pruning, ancestor-chain roots, deterministic order), `companionCache`
  (5 — hash-validated hits, invalidation on content change), extended
  `devServer` (in-bounds `..` serves, escapes 400).
- New integration fixtures (`src/test/fixtures/crossdir-*`), each with
  standing `❌`/`✅` controls, all green against real Chromium:
  - `crossdir-down` (stylesheet in `styles/`, companion one level **up**,
    `../styles/theme.css`) → 1 issue: `object-fit` on the **real** `<div>`
    dimmed, the `<img>` control active.
  - `crossdir-up` (stylesheet at root, companion in `pages/`, `../styles.css`)
    → 1 issue: `justify-content` on the block dimmed, flex control active.
  - `crossdir-root` (root-relative `/css/theme.css` from `pages/`) → 1 issue.
  - `crossdir-base` (`<base href="../assets/">` + relative href) → 1 issue.
  - `crossdir-multi` (three linking documents) → exactly 1 issue, proving the
    **distance-1 root page wins** over two distance-2 documents (which would
    have yielded zero issues — the discriminating control).
  - `crossdir-negative` (the only linker lives under `node_modules/`,
    pruned) → wrapper flow, 1 issue with the fabricated `.block` dimmed.
  - Plus `analyzeHtmlFile` cross-directory: a `pages/` document linking
    `../styles.css` serves through the workspace root (provider injected,
    restored after).
- Full suites: **750 unit + 33 integration** green (up from 709/26), real
  Chromium; `tsc -p ./` clean; smoke min + stable PASS.
- Benchmark: cold 550 ms → warm 25 ms/26 ms (~22×) with **page reuse on the
  warm runs** — the warm path re-serves nothing and re-scans nothing (the
  hash-validated companion cache held).

## Files touched
- `src/services/companionUrl.ts` — NEW: `toServedPath` / `fromServedPath` /
  `resolveLocalPath` (the one URL model).
- `src/services/companionResolver.ts` — NEW: `extractLinkedHrefs`,
  `dirDistance`, `compareCompanions`, `resolveCompanion`.
- `src/services/companionSettings.ts` — NEW: mutable settings bag with
  `workspaceFolderProvider`.
- `src/cache/companionCache.ts` — NEW: hash-validated companion cache.
- `src/browser/devServer.ts` — `resolveRequestPath` → `fromServedPath`
  (in-bounds `..` allowed, escapes rejected).
- `src/services/cdpAnalyzer.ts` — `resolveCompanionFor`, companion branch in
  `analyzeCssFile`, `serverRootFor` / `collectStylesheetPaths` via the
  shared model; legacy `findLinkingDocument` removed.
- `src/config/settings.ts` + `package.json` — `companionSearchDepth`,
  `companionMaxCandidates`.
- `src/activation/activate.ts` — provider wiring, `applyCompanionSettings`,
  cache-reset watchers (file watcher + workspace-folder changes).
- `src/test/fixtures/crossdir-{down,up,root,base,multi,negative}/` — NEW.
- `src/test/unit/companion{Url,Resolver,Cache}.test.ts` +
  `src/test/integration/cdpAnalyzer.integration.test.ts` — new tests.
