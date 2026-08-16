# METADATA-REPORT — Marketplace Metadata P0 (storefront)

> Audience: AI assistants and developers continuing work on this repository.
> Audit report for the Marketplace metadata milestone: license file + license
> field format decision (evidence-based), icon wiring, full manifest
> completion, payload re-audit. Companion docs: `PROJECT_STATE.md`,
> `PACKAGING-REPORT.md`.

## 1. License — decision with evidence

### Starting state
`package.json` had **no `license` field** and the repo had **no `LICENSE`
file** (verified by inspection). The license protocol therefore required
creating the file and choosing the field format from evidence.

### Evidence collected

| Question | Source | Finding |
|---|---|---|
| Is `PolyForm-Noncommercial-1.0.0` on the CURRENT SPDX list? | `https://spdx.org/licenses/PolyForm-Noncommercial-1.0.0.html` (fetched live) | **YES.** Short identifier `PolyForm-Noncommercial-1.0.0`, full name "PolyForm Noncommercial License 1.0.0", released July 9, 2019. The SPDX reference text matches the PolyForm site text verbatim. |
| How does vsce handle the `license` field / LICENSE file? | `node_modules/@vscode/vsce/out/package.js` (v3.9.2, `LicenseProcessor`) | vsce does **NOT validate SPDX identifiers**. It only (a) matches a `SEE LICENSE IN <path>` manifest value, or (b) looks for `extension/licen[cs]e(.md|.txt)`; the found file is registered as the `Microsoft.VisualStudio.Services.Content.License` VSIX asset and normalized to `LICENSE.txt` in the archive. Missing license ⇒ warning + interactive prompt (`--skip-license` to bypass). The `license` string is otherwise passed through. |
| Official full text | `https://polyformproject.org/licenses/noncommercial/1.0.0` (canonical, fetched live; also the site's official plain-text download at `/licenses/noncommercial/1.0.0.txt`) | Full text obtained verbatim (13 sections: Acceptance, Copyright, Distribution, Notices, Changes and New Works, Patent, Noncommercial Purposes, Personal Uses, Noncommercial Organizations, Fair Use, No Other Rights, Patent Defense, Violations, No Liability, Definitions). GitHub mirror unreachable from this host (network), not needed — canonical source sufficed. |

### Decision
- `LICENSE` at repo root: **official verbatim text** as published on the
  canonical PolyForm page (SPDX-identical content).
- `"license": "PolyForm-Noncommercial-1.0.0"` — **exact SPDX identifier
  exists**, so it is used verbatim (no fallback needed, no guessing).
- vsce emitted **no license-related warning** (the file is found and shipped
  as `extension/LICENSE.txt` inside the VSIX).
- Factual note (no editorializing): this license permits noncommercial use
  only (personal, research, educational, charitable, governmental purposes);
  it restricts downstream COMMERCIAL use. README wording is a separate task.

## 2. Icon — wired and verified

| Check | Result |
|---|---|
| Asset exists at `./images/icon.png` | ✅ |
| Valid PNG | ✅ `PNG image data, 499 x 499, 8-bit/color RGBA, non-interlaced` (`file`) |
| Palette (programmatic sampling, PIL) | Corners transparent (alpha 0); dominant plate `#F4F5F7`; glyphs near-black `#131313`–`#1A1A1A` |
| `"icon": "./images/icon.png"` in `package.json` | ✅ set |
| In VSIX payload | ✅ `extension/images/icon.png` in both `vsce ls` and `unzip -l`; registered as `Microsoft.VisualStudio.Services.Icons.Default` in the VSIX manifest |
| Gallery banner | `{"color": "#1E1E1E", "theme": "dark"}` — the icon's own dark glyph tone family (matches VS Code dark theme background) |

## 3. Manifest completion audit

- **Fixed values**: `name no-effect`, `displayName "NoEffect — Inactive CSS
  Inspector"`, `version 0.9.0`, `publisher haroune-dev`, `preview: true` — all
  applied exactly.
- **description**: two sentences, keyword-aware (rendering-aware detection of
  declarations with no effect; real Chromium over CDP as ground truth; CSS
  files + `<style>`/`style=""` embedded CSS; DevTools-style dimming + tooltip).
- **categories**: `["Linters", "Programming Languages"]`.
- **keywords**: css, inactive, no-effect, devtools, chromium, cdp, layout,
  rendering, html.
- **capabilities**: `untrustedWorkspaces: { supported: false, description }
  ` and `virtualWorkspaces: false` — matches the Phase 2 trust gating
  (browser/DevServer launch requires a trusted local workspace).
- **Commands**: all 7 registered commands are contributed
  (`analyzeCurrentFile`, `clearDecorations`, `showStatus`, `diagnoseSetup`,
  `showOutputLogs`, `restartAnalysisSession`, `clearCache`) with the
  consistent "NoEffect: " category prefix; `debugShowFirstRun` is registered
  in `src/activation/activate.ts:190` and retained in `keybindings` +
  `activationEvents`. Nothing references removed commands.
- **activationEvents**: added the three missing `onCommand` entries
  (`analyzeCurrentFile`, `clearDecorations`, `showOutputLogs`) so every
  contributed command has explicit activation (metadata-only; runtime
  behavior unchanged).
- **configuration**: all 8 settings from `src/config/settings.ts` are
  contributed — types + defaults ✓; `highlightStyle` enum +
  `enumDescriptions` ✓; `debounceMs` (500–10000) and `maxFileSizeKb`
  (16–65536) bounds ✓; `ignoredFiles` array `items` ✓;
  `chromiumPath` keeps `"scope": "machine-overridable"` (Settings Sync never
  ships a machine-specific path) ✓; `analyzeOnType` now has a
  `markdownDescription` documenting its experimental status and the
  saved-files-only behavior ✓.
- **repository / bugs / homepage**: `git remote get-url origin` fails (no
  remote configured) → **all three omitted** as instructed. vsce emits:
  `WARNING  A 'repository' field is missing from the 'package.json' manifest file.`
  (recorded verbatim; informational — no remote exists to reference).
- **Untouched**: `engines.vscode`, `main`, `dependencies` (stays empty),
  packaging fields, scripts, devDependencies.

## 4. Verification (all run for real)

- `npm run compile` ✅; `npm test` ✅ **709/709** (metadata-only — unaffected).
- `npx @vscode/vsce package --no-dependencies` ✅
  `DONE  Packaged: ... (7 files, 292.07 KB)` — the only warning is the
  repository-field one quoted above.
- `npx @vscode/vsce ls`:
  ```
  package.json
  README.md
  LICENSE
  images/icon.png
  dist/extension.js
  ```
  ZIP listing agrees (7 entries incl. `extension.vsixmanifest` +
  `[Content_Types].xml`; `LICENSE` normalized to `extension/LICENSE.txt`,
  `README.md` to `extension/readme.md` by vsce).
- Size re-audit: **292.07 KB** (299,075 B) — was 97.04 KB; the +195 KB is the
  icon (197.5 KB). Soft budget **2 MB**: PASS (~14 % of budget).
- Manifest parses cleanly (`node -e` JSON.parse ✅, both repo and in-archive
  copies); no placeholder text remains (scan for TODO/REPLACE/lorem/etc:
  clean — only the intended `haroune-dev` publisher).

## 5. Definition of Done — checklist

- ✅ Fixed values applied exactly; `preview: true` set.
- ✅ `LICENSE` = official full PolyForm Noncommercial 1.0.0 text, verbatim,
  at repo root; ships in the VSIX; `license` field format evidence-based
  (SPDX identifier confirmed on the current list).
- ✅ `icon` wired to `./images/icon.png`; visible in the VSIX payload and
  registered as the default icon asset.
- ✅ description/categories/keywords/banner/capabilities/commands/
  configuration complete and consistent with the code.
- ✅ repository/bugs/homepage omitted (no git remote — reported).
- ✅ No runtime/packaging/engines changes; tests unaffected (709/709);
  VSIX audit green (payload, assets, size).
- ✅ PROJECT_STATE.md updated.
