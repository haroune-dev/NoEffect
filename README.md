# NoEffect — CSS Inactive Property Highlighter

A VS Code extension that highlights CSS properties with **no actual effect** on the rendered page, using the same visual language as Chrome DevTools.

## How It Works

NoEffect analyzes your CSS using the **Chrome DevTools Protocol (CDP)** against a real browser engine. Instead of relying on static text analysis, it sees what the browser actually computes — then shows you the result right inside your editor.

### Visual Indicators

- **Dimmed text** — The inactive  line becomes faded (opacity 0.45)
- **Yellow triangle** — A ⚠ icon appears immpropertyediately after the inactive CSS declaration; hover it for a DevTools-style explanation and suggested fix

No squiggly lines. No error messages. No noise.

## Commands

| Command | Description |
|---|---|
| `NoEffect: Analyze CSS Inactive Properties` | Run analysis on the current file |
| `NoEffect: Clear All Highlights` | Remove all visual indicators |
| `NoEffect: Show Extension Status` | Show current extension state in the Output panel |

## Settings

| Setting | Default | Description |
|---|---|---|
| `noEffect.enabled` | `true` | Enable/disable the extension |
| `noEffect.analyzeOnSave` | `true` | Auto-analyze when saving CSS/HTML files |
| `noEffect.analyzeOnType` | `false` | Auto-analyze after a typing pause |
| `noEffect.debounceMs` | `1500` | Debounce delay for analyze-on-type |
| `noEffect.highlightStyle` | `"both"` | `"both"`, `"iconOnly"`, or `"dimOnly"` |
| `noEffect.chromiumPath` | `""` | Path to Chromium (auto-detect if empty) |
| `noEffect.ignoredFiles` | `[]` | Glob patterns for files to skip |

## Development

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Watch mode
npm run watch

# Launch Extension Host (press F5 in VS Code)
```

## Architecture

```
Extension Layer → Browser/CDP Layer → Matching Layer → Decorations
```

1. **Extension Layer** — Monitors files, runs commands, displays decorations
2. **Browser Layer** — Launches Chromium, loads the page, queries CDP
3. **Parser Layer** — Parses local CSS into AST with exact positions
4. **Matcher Layer** — Links CDP results to local file positions

## Current Status

**Phase 1** — Basic structure, mock analysis, decoration pipeline verification.

## License

MIT
