# Node / VS Code Runtime-Compatibility Audit (P0)

**Status: complete — decision: Path A (keep `engines.vscode ^1.85.0`, no runtime code changes).**
**Verify:** `npm run compile` (types pinned to the declared minimum) + `npm test` (707)
+ `npm run test:integration` (26) + `npm run test:smoke:all` (1.85.0 + stable).

## 1. Version ground truth — VS Code → Electron → Node (verified)

Sources: `microsoft/vscode` release commits (e.g. `chore: update electron v25.9.7`,
`#202679`), Electron 30.0.0 release notes (electronjs.org), and the maintained
version-tracking table `ewanharris/vscode-versions` (cross-checked against the
empirical `process.versions` output of the downloaded builds, §6).

| VS Code | Electron | Node (shipped) | Chromium | Empirical (smoke) |
|---|---|---|---|---|
| **1.85.0** (Nov 2023, our declared minimum) | **25.9.7** | **18.15.0** | 114.0.5735.289 | ✅ `node=18.15.0 electron=25.9.7` |
| 1.93.0 (Aug 2024, fallback candidate) | 30.4.0 | 20.15.1 | 124.0.6367.243 | — (not used) |
| stable (1.132.0, at audit time) | 42.7.1 | 24.18.0 | 148.0.7778.280 | ✅ `node=24.18.0 electron=42.7.1` |

**Two distinct Node contracts (now stated explicitly in PROJECT_STATE):**

- **Development / build / tests:** Node ≥ 20 (`@types/node` 18 line is used for
  *type* guarding; the toolchain itself runs on the developer's Node). Unchanged.
- **Runtime extension host:** the Node **shipped inside VS Code** — Node 18.15.0
  on the declared minimum 1.85.0. This is the contract the audit verifies.

## 2. Static audit of the runtime graph (`src/` excluding `src/test/`)

TypeScript transpiles syntax (target `ES2022`, fully native on Node 18) but does
**not** polyfill runtime built-ins — the audit therefore targets globals and
prototype methods. Findings:

| Location | Suspect | Verified minimum | Classification |
|---|---|---|---|
| `src/browser/cdpClient.ts:17` | `new WebSocket(wsUrl)` | Node 18.0+ (package) | **node18-ok** — this is the `ws` dependency (`import WebSocket from 'ws'`), not the Node global `WebSocket` (which is Node 21+). The `ws` package supports Node 18. |
| — (absent) | `Array.prototype.toSorted/toReversed/toSpliced/with` | Node 20 | no hits |
| — (absent) | `Array.fromAsync` | Node 22 | no hits |
| — (absent) | `Promise.withResolvers` | Node 22 | no hits |
| — (absent) | `AbortSignal.timeout/any`, `AbortController` | 17.3 / 20.3 | no hits (no `AbortSignal.*` anywhere) |
| — (absent) | `URL.canParse` | 18.17 | no hits |
| — (absent) | globals `navigator.`, `File`, global `fetch(` | 21 / 18 (experimental) | no hits |
| — (absent) | `String.isWellFormed/toWellFormed` | 20 | no hits |
| — (absent) | RegExp `v` flag | 20 | no hits |
| — (absent) | Set/Map `union/intersection/getOrInsert/…` | 22 | no hits |
| — (absent) | `Array.prototype.findLast/findLastIndex` (18.0 — fine anyway), `structuredClone` (17.0), `Object.groupBy` (21) | — | no hits |
| `src/utils/logger.ts`, `src/activation/readinessController.ts:90` | `queueMicrotask` | 11.0 | node18-ok |
| `src/parser/cssAst.ts`, `htmlScanner.ts` | `Array.prototype.at` (`positions.at(...)`) | 16.6 | node18-ok |
| `src/browser/devServer.ts` | `http` server (`writeHead`, `server.close`) | ancient | node18-ok |
| `src/session/processTree.ts`, `browserRunner.ts` | `process.kill(pid/signals)`, `process.platform`, `process.env` | ancient | node18-ok |
| `src/session/tempProfile.ts`, `utils/fs.ts` | `fs.rmSync`, `readdir({withFileTypes})`, `mkdtempSync` | 14.14+ (no `recursive readdirSync` — that is 20.1) | node18-ok |
| caches / `utils/contentHash.ts` | `crypto.createHash('sha256')` | ancient | node18-ok |
| built-ins imported | `fs, os, path, http, net, child_process(spawn), events, crypto` | ancient | node18-ok |

**Verdict: zero Node-20-only (or newer) built-ins on the runtime graph.**

## 3. VS Code API audit

All `vscode.*` symbols used, with the version they have existed since (all ≤ 1.62,
well inside 1.85): `commands`, `window`, `workspace`, `languages`, `Disposable`,
`Uri`, `TextEditor`, `ExtensionContext`, `Range`, `Position`,
`TextEditorDecorationType`, `MarkdownString`, `Hover`, `TextDocument`,
`StatusBarAlignment`, `RelativePattern`, `OutputChannel`, `DecorationRangeBehavior`,
`DecorationOptions`, `CancellationTokenSource`, `CancellationToken`, `version`.

**Permanent compile-time guard:** `@types/vscode` was `^1.85.0` — a caret, which
installed **1.125.0** and silently admitted 40 releases of newer API. It is now
pinned to the exact string `"1.85.0"`, so `tsc` rejects any API newer than the
declared minimum at build time. (Additionally `@types/node` moved to the `^18.19.0`
line so Node-20-only built-ins are also compile-blocked.)

## 4. Decision — Path A (keep `^1.85.0`), by evidence

- Distinct Node-20-only built-ins on the runtime graph: **0** (the only suspect,
  `new WebSocket`, is the `ws` package and works on Node 18).
- Raising to `^1.93.0` would lose ~9 months of supported VS Code for zero
  compatibility benefit — there is nothing in the runtime that needs Node 20.
- No polyfills introduced; runtime dependency set unchanged (`ws` only).

## 5. Changes in this task

- `package.json`: `"@types/vscode": "1.85.0"` (exact pin), `"@types/node": "^18.19.0"`,
  devDep `@vscode/test-electron ^2.4.1`, scripts `test:smoke` (stable),
  `test:smoke:min` (1.85.0), `test:smoke:all`.
- `src/test/smoke/runSmoke.ts` — launcher (dev Node).
- `src/test/smoke/smokeMain.ts` — in-host suite: logs `process.versions.*`,
  asserts the Node-18 mapping on the min build, asserts activation + all 7
  contributed commands, runs one full analysis through the shipped command and
  expects the deterministic `Coverage` record (graceful skip without Chromium),
  fails on unhandled rejections.
- No shipped (`src/` non-test) code changed — the audit proved no replacement
  was needed.

## 6. Oldest-version proof (automated results)

```
$ npm run test:smoke:min      # VS Code 1.85.0 (downloaded by @vscode/test-electron)
host: vscode=1.85.0 node=18.15.0 electron=25.9.7 chrome=114.0.5735.289
noeffect.no-effect activated / 7 contributed commands registered
full analysis settled (Coverage record found) / no unhandled rejections
Exit code: 0  → PASS

$ npm run test:smoke          # stable (1.132.0 at audit time)
host: vscode=1.132.0 node=24.18.0 electron=42.7.1 chrome=148.0.7778.280
noeffect.no-effect activated / 7 contributed commands registered
full analysis settled (Coverage record found) / no unhandled rejections
Exit code: 0  → PASS
```

The static audit found suspects; the oldest-host run proves reality: activation
**and a full real-Chromium analysis** work on VS Code 1.85.0 / Node 18.15.0.

## 7. Verification summary

- `npm run compile` — clean, with types pinned to the declared minimum.
- `npm test` — 707/707 (unchanged baseline).
- `npm run test:integration` — 26/26 (baseline, real Chromium).
- Smoke on min (1.85.0) and stable — PASS (above).
