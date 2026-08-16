# PLAN — Cross-Directory Companion-Document Resolution (Level 10)

## Goal

A CSS file must be analyzable against a real HTML document that links it even
when the two live in different workspace directories (the current
`findLinkingDocument` only scans the CSS file's own directory). One **shared
URL-resolution model** is used by both the companion matcher and the DevServer:
*what resolves is what serves* — never two independent resolution logics.

Same-directory behavior must stay bit-identical (distance-0 candidates keep
`index.html`-first, then alphabetical order; existing fixtures are the
precedence proof). No rule-engine changes, no new UI surfaces, no new runtime
dependencies, no hardcoded selectors/project paths.

## The shared URL model (single source of truth)

A document is served at the root-relative page path

```
pagePath(S) = '/' + posixRelative(S, htmlPath)      // S = serverRoot
```

and the browser resolves an authored `href` against that URL. The matcher
must reproduce the browser exactly:

```
resolveLocalPath(S, pageFsPath, baseHref, href):
  pageUrl      = new URL('http://noeffect.local' + pagePath(S))      // pageFsPath ≡ pagePath(S)
  base         = baseHref ? new URL(baseHref, pageUrl) : pageUrl
  url          = new URL(href, base)
  if url.origin !== pageUrl.origin → null                            // external: same as today's skip
  decode each pathname segment (try/catch → null; '/' '\' '..' in a
    decoded segment → null)                                          // conservative skip
  return path.normalize(S + decodedSegments)                         // fs-normalize compare
```

- `../css/x.css`, `./x.css`, `css/x.css` and root-relative `/css/x.css` all
  land on the same answer in the matcher **and** the server, because both
  derive from the same URL math.
- `<base href>` (new support) only affects the matcher — the server serves by
  URL path; a base escaping to another origin makes the href external (skip).
- `toServedPath(S, absPath)` (inverse) yields the page URL for a companion.

This model lives in a pure module (no `vscode`, no fs) so it is unit-testable
and is imported by BOTH the resolver and the DevServer.

## Module: `src/services/companionResolver.ts` (new, pure)

Inputs (injected, no `vscode`): `readFile(fsPath)`, `listDir(fsPath)`,
`isIgnored(fsPath)` (from `fileEligibility` globs + user `ignoredFiles`),
bounds `{ maxDepth, maxCandidates }`, `searchRoot`, `cssFilePath`.

- `resolveCompanion(input): CompanionResolution | null`
  - `CompanionResolution = { htmlPath, href, distance, kind, serverRoot }`
  - `kind ∈ relative-down | relative-up | root-relative | base`
- **Phase A (bounded discovery)**: from `searchRoot`, BFS up to `maxDepth`
  (default 6) with `maxCandidates` (default 500); prune ignored dirs
  (`DEFAULT_IGNORED_PATTERNS` + user patterns — reuse eligibility globs);
  prefilter `/<link\b[^>]*/gi` on candidate `.html`/`.htm` content before full
  processing; candidates ineligible by size/type are skipped, never crash.
- **Phase B (precise matching)**: extract `href`/`rel` + `<base href>` from
  each candidate (same tokenizer-safe regex as today's
  `collectStylesheetPaths`), resolve via the shared URL model, compare
  fs-normalized path against the CSS file; undecodable candidates skipped
  conservatively.
- **Comparator (deterministic, pure)**: 1) directory distance asc
  (segments in `path.relative(cssDir, htmlDir)`), 2) `index.html` first within
  equal distance, 3) full-path lexicographic asc. Distance 0 ⇒ identical to
  today's legacy order.
- `serverRoot` fallback chain: workspace-folder root containing the CSS file
  → else `LCA(cssDir, htmlDir)` → else same-directory root (== LCA, so legacy
  flows are byte-identical).

## Serving: `src/browser/devServer.ts`

- `resolveRequestPath` delegates to the shared model's
  `fromServedPath(this.root, url)`.
- The current blanket `raw.includes('..')` reject is relaxed to
  **post-decode containment** (in-bounds `..` like `../css/x.css` becomes
  servable; escaping candidates keep returning 400). Kept: `\0`, backslashes,
  encoded-separator/`..` escapes, `?`/query stripping, `index.html` default,
  loopback-only, `no-store`.
- `setRoot` unchanged; `VIRTUAL_PREFIX` flow unchanged.

## Wiring: `src/services/cdpAnalyzer.ts`

- `analyzeCssFile`: `findLinkingDocument` is replaced by
  `resolveCompanion` (search root = workspace folder of the CSS file via
  `vscode.workspace.getWorkspaceFolder(uri)`; no folder ⇒ LCA fallback).
  Companion flow: `withSession(resolution.serverRoot,
  toServedPath(serverRoot, htmlPath), refresh, …)`. Wrapper flow unchanged
  (same-directory root, virtual page, `noCompanionHtmlFailure` warning).
- `analyzeHtmlFile`: serve root = workspace folder of the HTML file (else
  legacy `dirname(htmlPath)`). Page URL stays root-relative, so existing
  relative hrefs behave identically; root-relative and in-bounds `../` links
  now work too (browser-truthful — if the browser cannot load a sheet, CDP
  simply reports nothing for it).
- `collectStylesheetPaths` becomes a thin wrapper over the shared model so the
  HTML flow and the companion matcher never disagree.

## Caching + invalidation

- `src/cache/companionCache.ts` (new): key `(searchRoot, cssReal)` → resolution
  record; entry records the content hashes of the contributing HTML docs
  (via `fileHashCache` reads, try/catch). Warm path: hash-checked reuse —
  **no rescan, no browser work**.
- Invalidation: watchService save/change of any `.html`/`.htm`/`.css`
  (add `onHtmlEvent` callback), `onDidChangeWorkspaceFolders`, and
  `onSettingsChanged` (ignoredFiles + new companion settings) — each clears
  the cache (`companionCache.reset()`), tiny and bounded. Wired in
  `src/activation/activate.ts` next to the existing watchers.

## Settings (optional, consistent with the existing surface)

- `noEffect.companionSearchDepth` — default 6, bounds 1–10, markdownDescription.
- `noEffect.companionMaxCandidates` — default 500, bounds 100–2000.

## Tests

- Unit `src/test/unit/companionResolver.test.ts`: comparator matrix
  (distance 0 index-first = legacy proof), URL matrix (relative down/up,
  root-relative, `./`, `<base>`, `%20`/encoded, undecodable → skipped,
  external `https:`/`data:`/`//`), ignore-dir pruning, depth/candidate bounds,
  no-workspace-folder LCA fallback, `serverRoot` chain.
- Unit `src/test/unit/companionCache.test.ts`: hit/miss, content-hash change,
  reset.
- Unit `devServer.test.ts` (extend): in-bounds `..` serves 200; escape via
  `../..` / `%2e%2e` / `%2f` still 400; existing traversal tests stay green.
- Integration (extend `cdpAnalyzer.integration.test.ts`):
  - fixtures `crossdir-down` (css in `styles/`, html one level up),
    `crossdir-up` (css at root, html in `pages/`),
    `crossdir-root` (root-relative href `/css/x.css`), `crossdir-base`
    (`<base href>`), `crossdir-multi` (two linking HTMLs, distance ordering +
    index.html rule), `crossdir-negative` (node_modules-only link → wrapper
    flow, `❌`/`✅` standing controls).
  - assert exact issue counts/ranges + standing controls per fixture.
  - HTML-flow test: `analyzeHtmlFile` with cross-dir linked sheet.
  - Same-directory companion fixtures (phase3–phase7, active/inactive) must
    pass **unchanged** (bit-identical precedent).
- Benchmark: warm path must not rescan (same warm ms); cold delta reported.

## Verification

```
npm run compile && npm test && npm run test:integration && npm run test:smoke:all
node out/test/benchmark/benchmark.js
```

## Docs

- `LEVEL10-REPORT.md` with the milestone evidence; `PROJECT_STATE.md` §2 data
  flow, §4 companion limitation, §5 counts, §6 backlog item 2 updated.
