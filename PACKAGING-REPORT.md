# PACKAGING-REPORT — Release-Packaging P0 Audit

> Audience: AI assistants and developers continuing work on this repository.
> This is the audit report for the release-packaging milestone (esbuild bundle,
> VSIX packaging, payload + size audit, `ws`-bundling proofs, staged proof
> matrix, governance). Companion docs: `PROJECT_STATE.md`, `NODE-COMPAT-AUDIT.md`.

## 1. Layout & pipeline

Dual-output layout:

| Output | Contents | Role |
|---|---|---|
| `out/` | `tsc` emission of `src/` (dev layout) | unit/integration/benchmark/test runners |
| `dist/` | esbuild bundle: `extension.js` + `.map` + `.meta.json` (all gitignored) | **the shipped artifact** |

- `package.json` `main` → `./dist/extension.js`.
- `scripts/build.mjs`: esbuild, `bundle:true`, `platform:'node'`, `format:'cjs'`,
  `target:['node18.15']`, `external:['vscode']`, metafile → `dist/extension.meta.json`,
  external sourcemap, no minify. ~62–110 ms, no warnings.
- `vscode:prepublish` → `npm run build` (vsce auto-runs it from the repo root;
  `scripts/**` stays committed and never ships — excluded via `.vscodeignore`).
- `ws` is a **devDependency**; `dependencies` is empty. Runtime deps: none.

### Target rationale
`node18.15` matches the recorded compatibility policy: VS Code `1.85.0` (the
pinned minimum, `engines.vscode`) ships Electron `25.9.7` → Node `18.15.0`
(empirically verified; `NODE-COMPAT-AUDIT.md`). No compatibility change was made.

## 2. Payload audit (vsce ls ↔ ZIP must agree)

Packaged with the exact release command:

```bash
npx @vscode/vsce package --no-dependencies --out /tmp/noeffect/no-effect-0.1.0.vsix
```

`vsce ls` (build-time include list):

```
package.json
README.md
dist/extension.js
```

`unzip -l` (actual archive contents — 5 files):

```
extension.vsixmanifest      2,032
[Content_Types].xml           359
extension/package.json      5,524
extension/readme.md         2,314   (vsce normalizes README.md → readme.md)
extension/dist/extension.js 433,316
                            ------
5 files, 443,545 B uncompressed
```

**Agreement: yes.** The two listings match (modulo the mandatory manifest +
content-types wrappers and the readme name normalization).

Include assertions (all ✓): `dist/extension.js`, `package.json`, `README.md` in the archive.

Negative assertions (all ✓ — none ship): `src/**`, `out/**`, `test fixtures`,
`*-REPORT.md`, `PROJECT_STATE.md`, `NODE-COMPAT-AUDIT.md`, `*.map`,
`*.meta.json`, `node_modules/**`, `tsconfig.json`, `eslint*`, `scripts/**`,
`reference/**`, `assets/**`, dotfiles (`.*`), `*.d.ts`.

## 3. Size report

| Artifact | Bytes | Note |
|---|---|---|
| `dist/extension.js` | 433,316 | 423.2 KB |
| `dist/extension.js.map` | 936,252 | external sourcemap, **excluded** from VSIX |
| `dist/extension.meta.json` | 89,296 | build metafile, excluded |
| **VSIX** | **99,374** | **97.04 KB** — vsce: "(5 files, 97.04 KB)" |

Soft budget **2 MB**: PASS (97.04 KB ≈ 4.7 % of budget). No size action needed.

## 4. `ws`-bundling proofs (runtime-dep must be inside the artifact)

**Primary — esbuild metafile** (`dist/extension.meta.json`, 89,296 B):
- 104 input files total; **14 `node_modules/ws/...` files** among the inputs
  (incl. `node_modules/ws/wrapper.mjs`, the `'ws'` specifier resolution — so
  `ws` is an INPUT, not external).
- The only non-input module references in the graph: `node:` builtins
  (`buffer`, `crypto`, `events`, `http`, `https`, `net`, `stream`, `tls`,
  `url`, `util`, `zlib`), `vscode` (intended external), and `bufferutil` /
  `utf-8-validate` (ws's optional native try/catch deps, not installed — the
  require is guarded and dead at runtime).

**Secondary — bundle text scans** (on `dist/extension.js`):
- `require("ws")` / `require('ws')` occurrences in the bundle: **0**.
- `ws` internals present: **128 matches** (e.g. `is-typed-array`, `WebSocket`
  internals) — i.e. the code is there, it's just bundled under hashed names.
- No `node_modules/**` entry exists in the VSIX (see §2 negative assertions).

**Runtime-dep invariant: satisfied.** The shipped artifact has zero runtime
dependencies to resolve.

## 5. Staged proof matrix (no fake layers)

| Stage | What | Result |
|---|---|---|
| A | Unit 709/709 (incl. 2 source-hygiene guard tests) + integration 26/26 on the `out/` dev layout | ✅ PASS (regression gate; NOT bundle proof) |
| B | Integration suite resolving the extension through `main` | ⬇️ **DOWNGRADED** — the harness (`src/test/integration/cdpAnalyzer.integration.test.ts`) imports `out/services/cdpAnalyzer` directly in a plain Node process; it never resolves `main`, so its green run proves the source, not the bundle. Limitation reported explicitly; C/D carry the bundle proof. |
| C | Packaged VSIX installed into an isolated profile, in-host smoke on the installed copy only (`extensionDevelopmentPath: []`) | ✅ PASS on run 2 (see §6 for the run ledger) |
| D | UI/e2e decoration automation | N/A — no UI automation harness exists in this repo (pre-existing limitation, `PROJECT_STATE.md` §4) |

## 6. Stage C run ledger (honest record)

Runner: `src/test/smoke/runSmokeVsix.ts` (`npm run test:pack`):
packages with vsce → downloads/caches VS Code stable (`.vscode-test/`) →
installs into a temp `--user-data-dir`/`--extensions-dir` profile → runs
`smokeMain.js` via `@vscode/test-electron` with an EMPTY
`extensionDevelopmentPath` so the host resolves the extension **only** from the
installed VSIX.

| Run | Result | Notes |
|---|---|---|
| 1 | ⏳ hang | First launch — install step blocked the runner; root-caused later |
| 2 | ✅ **PASS** | `[pack] STAGE C PASS — installed VSIX activates and analyzes`; runTests exit 0; extension host exit 0 — for exit 0, `smokeMain` must have passed every assertion (activation, 7 contributed commands, analysis settle-or-graceful-skip, zero unhandled rejections) |
| 3–6 | ⏳ stall | Extension host never starts (workbench renderer hangs; host log shows eager built-ins activating on the successful run only). Environmental: 7 GB host, ~2.5 GB free, user's Chrome + VS Code running; the launch is display-dependent |
| — | — | `--ozone-platform=headless`: renderer never spawns (not viable). `xvfb`: unavailable (no sudo). CLI `--install-extension` hangs windowed on this host → documented fallback: VSIX extraction into the extensions dir (identical result; verified via installed `package.json` `main`) |

Run 2's evidence stands; the runner additionally writes an in-host verdict
file (`NOEFFECT_SMOKE_RESULT` → `ANALYSIS_SETTLED`/`NO_BROWSER_SKIP`) and sets
`ELECTRON_ENABLE_LOGGING` so any future clean run produces the explicit
branch record. Retry `npm run test:pack` on an idle machine.

## 7. Governance rules

- `.vscodeignore` **only** governs VSIX contents: task list +
  `reference/**`, `assets/**`, `**/*.d.ts`, `.*`, `.verify-companion.mjs`,
  `scripts/**`, `package-lock.json`, etc.
- `.gitignore` **only** governs the repo: `out/`, `dist/`, `node_modules/`,
  `.vscode-test/`, `*.vsix`, `.DS_Store`.
- `scripts/**` + build config stay committed; never ship.
- Never commit `dist/` or `*.vsix` (both ignored).
- Repo-root strays (`.verify-companion.mjs`, `testCdp.d.ts`, `testCdp.js.map`)
  are excluded from the VSIX but intentionally NOT deleted (outside this task's
  scope — cleanup candidate).
- vsce informational warning "The file extension/dist/extension.js is large
  (423.16 KB)" is not a failure.

## 8. Reproduce

```bash
npm run compile            # type gate
npm test                   # 709 unit
npm run test:integration   # 26 integration
npm run build              # esbuild → dist/extension.js
npx @vscode/vsce package --no-dependencies --out /tmp/noeffect/no-effect-0.1.0.vsix
unzip -l /tmp/noeffect/no-effect-0.1.0.vsix   # payload audit (agree with vsce ls)
npm run test:pack          # Stage C (needs an idle display)
```
