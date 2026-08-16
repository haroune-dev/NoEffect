import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Unit tests for the override-winner gutter badge icons
 * (assets/gutter/override-winner-{light,dark}.svg).
 *
 * DecorationManager resolves both SVGs from `extensionPath` at runtime
 * (`gutterIconPath` accepts no data URI), so a missing or malformed file
 * makes VS Code silently render NO badge. These tests pin the asset
 * contract: the files exist, share the fixed 16x16 gutter canvas, draw
 * the white `→|` glyph, and keep distinct light/dark accent fills so the
 * theme-aware selection always has two real variants to choose from.
 */

const ASSETS_GUTTER = path.resolve(__dirname, '..', '..', '..', 'assets', 'gutter');

const LIGHT_ICON = path.join(ASSETS_GUTTER, 'override-winner-light.svg');
const DARK_ICON = path.join(ASSETS_GUTTER, 'override-winner-dark.svg');

function readIcon(file: string): string {
  return fs.readFileSync(file, 'utf-8');
}

function fillOf(svg: string): string {
  const rectFill = /<rect\b[^>]*\bfill="([^"]*)"/.exec(svg)?.[1];
  assert.ok(rectFill, 'the badge rect must carry an explicit fill');
  return rectFill;
}

test('override-winner icons: both theme variants ship on disk', () => {
  assert.ok(fs.existsSync(LIGHT_ICON), `missing ${LIGHT_ICON}`);
  assert.ok(fs.existsSync(DARK_ICON), `missing ${DARK_ICON}`);
});

test('override-winner icons: the canvas is the fixed 16x16 gutter box', () => {
  for (const file of [LIGHT_ICON, DARK_ICON]) {
    const svg = readIcon(file);
    assert.ok(
      svg.includes('viewBox="0 0 16 16"'),
      `${path.basename(file)} must keep the 16x16 viewBox`
    );
    assert.ok(/width="16"/.test(svg), `${path.basename(file)} must be 16 wide`);
    assert.ok(/height="16"/.test(svg), `${path.basename(file)} must be 16 tall`);
  }
});

test('override-winner icons: the →| glyph is drawn in white strokes', () => {
  for (const file of [LIGHT_ICON, DARK_ICON]) {
    const svg = readIcon(file);
    const strokes = svg.match(/stroke="#ffffff"/g) ?? [];
    assert.ok(
      strokes.length >= 3,
      `${path.basename(file)} must draw shaft, arrowhead and bar (>= 3 strokes)`
    );
  }
});

test('override-winner icons: light and dark variants keep distinct accent fills', () => {
  const lightFill = fillOf(readIcon(LIGHT_ICON));
  const darkFill = fillOf(readIcon(DARK_ICON));

  assert.notEqual(lightFill, darkFill, 'the theme variants must not collapse into one file');
  // Blue accent tuned per theme: darker on light backgrounds, brighter on
  // dark ones (VS Code info-foreground palette).
  assert.equal(lightFill.toLowerCase(), '#0078d4');
  assert.equal(darkFill.toLowerCase(), '#3794ff');
});
