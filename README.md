# NoEffect

*Identifies CSS declarations that have no effect in the rendered page, powered by a real Chromium engine via the Chrome DevTools Protocol.*

[![Version](https://img.shields.io/visual-studio-marketplace/v/haroune-dev.no-effect.svg?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=haroune-dev.no-effect)
[![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-important?style=flat-square)](LICENSE)
[![VS Code](https://img.shields.io/badge/vscode-%5E1.85.0-blue?style=flat-square)](https://code.visualstudio.com/updates/v1_85)

> **Requires a Chromium-based browser** — Chrome, Edge, or Chromium. It's auto-detected, or set `noEffect.chromiumPath`. Everything runs locally: loopback-only server, isolated temp browser profile, nothing leaves your machine.

## Demo

![NoEffect demo](https://raw.githubusercontent.com/haroune-dev/NoEffect/master/assets/demo/demo.gif)

*Inactive declarations are dimmed and flagged inline, with a DevTools-style tooltip explaining why.*

## Key Features

- **Real Chromium ground truth.** A real browser computes every verdict — matched styles, formatting context, pseudo-elements. No static heuristics, no guessing about the cascade.
- **Covers everywhere CSS lives.** Stylesheets, embedded `<style>` blocks, and inline `style=""` attributes. No linking HTML beside the file? NoEffect finds companion pages across the project and analyzes up to `noEffect.maxCompanions` of them.
- **Only dims what's really dead.** A declaration is marked inactive only when no analyzed page gives it effect — one effective page anywhere keeps it alive.
- **DevTools-inspired UX.** Inactive properties are dimmed with an inline warning icon, hover tooltips explain the cause, and overridden duplicates jump straight to the cascade winner.
- **Fast and self-contained.** Content-addressed caches, a persistent browser session, and a skip gate keep warm re-analyses at ~10–40 ms. The single runtime dependency is bundled — nothing is downloaded at install.

## How It Works

```
CSS/HTML file → parse (exact ranges) → resolve companion pages → persistent Chromium over CDP
  → per-node LayoutContext (display, position, pseudo-boxes, replaced-ness)
  → per-declaration rule verdict → merge across pages → dim + icon + tooltip
```

Every declaration is judged against the layout context the browser actually built, through 9 rule families and 32 standardized reason codes — structural rules, not per-property hardcoding.

## Requirements & Quick Start

| Requirement | Notes |
|---|---|
| Browser | Chrome, Edge, or Chromium; auto-detected (override → PATH → platform defaults), or set `noEffect.chromiumPath` |
| VS Code | `^1.85.0` |
| Trusted workspace | Required — analysis launches a local browser |

1. Install **NoEffect** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=haroune-dev.no-effect).
2. Open and trust the workspace.
3. Analysis runs automatically on save (`noEffect.analyzeOnSave`). No setup wizard, no API keys.

## Commands

| Command | Description |
|---|---|
| `NoEffect: Analyze CSS Inactive Properties` | Run analysis on the current file |
| `NoEffect: Clear All Highlights` | Remove all visual indicators |
| `NoEffect: Jump To Overriding Declaration` | Jump to and flash the rule that wins the cascade |
| `NoEffect: Show Status` | Status bar state, coverage, and companion evidence |
| `NoEffect: Diagnose Setup` | Check browser, workspace, and configuration |
| `NoEffect: Restart Analysis Session` | Force a clean browser session |
| `NoEffect: Clear Cache` | Reset all analysis caches |
| `NoEffect: Show Output Logs` | Open the logging channel |

## Configuration

| Setting | Default | Description |
|---|---|---|
| `noEffect.enabled` | `true` | Master switch |
| `noEffect.analyzeOnSave` | `true` | Analyze on save of CSS/HTML files |
| `noEffect.analyzeOnType` | `false` | Analyze after a typing pause (experimental; saved files only) |
| `noEffect.debounceMs` | `1500` | Debounce delay for analyze-on-type |
| `noEffect.highlightStyle` | `"both"` | `"both"`, `"iconOnly"`, or `"dimOnly"` |
| `noEffect.chromiumPath` | `""` | Custom browser executable; empty = auto-detect |
| `noEffect.ignoredFiles` | `[]` | Glob patterns to skip (plus built-in ignores: `node_modules`, `dist`, minified CSS, …) |
| `noEffect.maxFileSizeKb` | `512` | Skip files larger than this |

**Companion search (advanced):**

| Setting | Default | Description |
|---|---|---|
| `noEffect.companionSearchDepth` | `6` | Max directory depth of the companion-HTML search |
| `noEffect.companionMaxCandidates` | `500` | Max scan operations per companion search |
| `noEffect.maxCompanions` | `3` | Max analyzed pages per CSS file |

## Known Limitations

- **Saved files only.** It only reads saved files. If the file is not saved, you see `FILE_UNSAVED`. Analyze-on-type is off by default and not stable yet.
- **Only some HTML files.** NoEffect checks up to 3 HTML files per CSS file (`noEffect.maxCompanions`), plus a few more on match. With no HTML file, it uses a fake page. Some checks for tags, parents, and overrides do not work there. On a real page, it checks only the first match. Other matches can be different.
- **Only some selectors.** It works with classes, IDs, tags, `A B` and `A > B`, and `::before`, `::after`, `::first-letter`. It skips `:hover`, `:focus`, `[type="..."]`, `+`, `~`, and `*` alone.
- **Only screen width in px.** It checks `@media` width rules in `px` with up to 7 screen sizes. Other rules do not work: `orientation`, `prefers-*`, height, `@container`, and other units like `em`. In these cases it hides warnings to avoid wrong warnings.
- **Only local CSS and HTML.** It works with `.css` and `.html` files, with `<style>` and `style=""`. No Sass/Less, no CSS-in-JS, no `.vue` / `.svelte` / `.jsx`. Remote `https:` files and `@import` are not read (but they still change the page). Shadow DOM and iframes are skipped. It also skips `.min.css` / `.bundle.css` files, files over 512 KB, and `node_modules` / `dist` folders.
- **Only known rules.** If there is no rule for a property (flex, grid, position, and others), NoEffect says nothing. `var()` names are shown as-is in tooltips.
- **Needs Chrome and a trusted folder.** You need Chrome, Edge, Brave, or Chromium (`noEffect.chromiumPath`). No browser inside (~290 KB). It does not work in untrusted folders or in the browser version of VS Code (`vscode.dev`).

If you find a problem, open an issue with a small example. Help is welcome!

## Contributing & License

Bugs, ideas, and discussion: [GitHub Issues](https://github.com/haroune-dev/NoEffect/issues) · [Repository](https://github.com/haroune-dev/NoEffect)

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE) — free for personal, educational, and non-commercial open-source use; commercial use requires a separate license.

**Development:**

```bash
npm install
npm run compile            # strict tsc — the type gate
npm run lint               # eslint
npm test                   # unit tests
npm run test:integration   # real-Chromium integration tests
npm run test:smoke:all     # packaged host smoke on VS Code 1.85.0 + stable
```
