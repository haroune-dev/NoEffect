import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
  ICON_HOVER_TOLERANCE_CHARS,
  isIconHoverTarget,
} from '../../diagnostics/decorationPlanner';

/**
 * Regression tests for the cross-platform hover/cursor contract:
 *
 *   - the NoEffect tooltip fires ONLY over the yellow warning triangle
 *     (the virtual icon space at/past the anchor's end);
 *   - hovering the property name, the value, the semicolon, or any other
 *     real source character never triggers it, so VS Code's native CSS
 *     hover behavior there is left completely untouched;
 *   - the decoration source sets no `cursor` override (the `cursor` option
 *     styles the anchor text, never the `after` attachment, and smuggling
 *     one through `textDecoration` breaks decoration creation on Windows).
 */

// `  height: 200px;` — anchor is the one-character `;` at [6, 16..17).
const ANCHOR = { startLine: 6, startColumn: 16, endLine: 6, endColumn: 17 };

test('icon hover: fires at the anchor end (icon hit zone start)', () => {
  assert.equal(isIconHoverTarget(ANCHOR, { line: 6, character: 17 }), true);
});

test('icon hover: fires across the icon tolerance window', () => {
  for (let c = 17; c <= 17 + ICON_HOVER_TOLERANCE_CHARS; c++) {
    assert.equal(isIconHoverTarget(ANCHOR, { line: 6, character: c }), true, `char ${c}`);
  }
});

test('icon hover: ignores everything past the icon space', () => {
  assert.equal(
    isIconHoverTarget(ANCHOR, { line: 6, character: 17 + ICON_HOVER_TOLERANCE_CHARS + 1 }),
    false
  );
});

test('icon hover: never fires over the semicolon itself', () => {
  assert.equal(isIconHoverTarget(ANCHOR, { line: 6, character: 16 }), false);
});

test('icon hover: never fires over the property name or value', () => {
  for (const c of [2, 5, 8, 11, 14, 15]) {
    assert.equal(isIconHoverTarget(ANCHOR, { line: 6, character: c }), false, `char ${c}`);
  }
});

test('icon hover: never fires on another line', () => {
  assert.equal(isIconHoverTarget(ANCHOR, { line: 5, character: 17 }), false);
  assert.equal(isIconHoverTarget(ANCHOR, { line: 7, character: 17 }), false);
});

test('icon hover: tolerance window stays bounded', () => {
  assert.ok(
    ICON_HOVER_TOLERANCE_CHARS > 0 && ICON_HOVER_TOLERANCE_CHARS <= 6,
    'the window must cover renderer offset variance without reaching real text'
  );
});

test('icon hover: neighboring anchors do not steal each other', () => {
  const first = { startLine: 6, startColumn: 16, endLine: 6, endColumn: 17 };
  const second = { startLine: 8, startColumn: 13, endLine: 8, endColumn: 14 };
  assert.equal(isIconHoverTarget(second, { line: 6, character: 17 }), false);
  assert.equal(isIconHoverTarget(first, { line: 8, character: 14 }), false);
});

test('decoration contract: no cursor override on the icon decoration type', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'src', 'diagnostics', 'decorations.ts'),
    'utf-8'
  );
  assert.ok(!/cursor:\s*'pointer'/.test(source), 'no cursor:pointer override may remain');
  assert.ok(
    !/textDecoration:\s*'none;\s*cursor/.test(source),
    'the invalid textDecoration cursor smuggling must not return (breaks Windows)'
  );
});

test('icon asset: no inert cursor styling on the triangle', () => {
  const svg = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'assets', 'inline', 'warning-icon.svg'),
    'utf-8'
  );
  assert.ok(!/cursor/.test(svg), 'contentIconPath rendering ignores it; keep the asset cursor-free');
});
