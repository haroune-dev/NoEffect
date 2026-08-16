import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Unit tests for the inline warning icon (assets/inline/warning-icon.svg).
 *
 * The icon is rendered as an `after` decoration attachment: VS Code places
 * the 14x14 canvas as an inline-block whose BOTTOM edge sits on the editor's
 * monospace text baseline (inline-block with no in-flow content aligns its
 * bottom margin edge to the parent baseline). The triangle must therefore
 * rest its base on the bottom strip of the canvas; keeping it higher (e.g.
 * centered like the old y=11.2) makes the icon float visibly above the text
 * baseline.
 */

const INLINE_ICON_SVG = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'assets',
  'inline',
  'warning-icon.svg'
);

interface IconGeometry {
  canvas: number;
  apexY: number;
  baseY: number;
  strokeWidth: number;
  markBaseline: number;
  fontSize: number;
}

function readIcon(): string {
  return fs.readFileSync(INLINE_ICON_SVG, 'utf-8');
}

/**
 * Parse the geometry invariants out of the static SVG: the canvas size, the
 * triangle's apex/base coordinates and the exclamation mark's font metrics.
 * The base is the target y of the path's final (absolute) corner arc — the
 * deepest point of the triangle.
 */
function parseIconGeometry(svg: string): IconGeometry {
  const d = /<path\b[^>]*\bd="([^"]*)"/.exec(svg)?.[1] ?? '';
  const canvas = Number(/<svg\b[^>]*\bwidth="(\d+)"/.exec(svg)?.[1]);
  const apexY = Number(/\bM\s*[\d.]+\s+([\d.]+)/.exec(d)?.[1]);
  const baseY = Number(/A[\d.]+(?:\s+[\d.]+){2}\s+1\s+[\d.]+\s+([\d.]+)/.exec(d)?.[1]);
  const strokeWidth = Number(/stroke-width="([\d.]+)"/.exec(svg)?.[1]);
  const markBaseline = Number(/<text\b[^>]*\by="([\d.]+)"/.exec(svg)?.[1]);
  const fontSize = Number(/font-size="([\d.]+)"/.exec(svg)?.[1]);
  return { canvas, apexY, baseY, strokeWidth, markBaseline, fontSize };
}

test('inline warning icon: the canvas is the fixed 14x14 box of the decoration', () => {
  const svg = readIcon();
  assert.ok(svg.includes('viewBox="0 0 14 14"'), 'the viewBox must match the rendered 14x14 box');
  const g = parseIconGeometry(svg);
  assert.equal(g.canvas, 14, 'the canvas width attribute must stay 14');
  assert.equal(g.strokeWidth, 0.4);
  assert.ok(g.strokeWidth > 0, 'the triangle must keep its outline');
});

test('inline warning icon: the triangle base rests on the text-baseline strip of the canvas', () => {
  const g = parseIconGeometry(readIcon());

  // The decoration canvas sits with its bottom edge on the editor's text
  // baseline, so the triangle's deepest point must reach the bottom strip
  // (>= 13.0). The old geometry ended at y=11.2 and floated ~2.8px above
  // the baseline — the reported upward offset.
  assert.ok(g.baseY >= 13.0, `base at y=${g.baseY} must reach the baseline strip (>= 13.0)`);
  assert.ok(
    g.baseY + g.strokeWidth / 2 < 14.0,
    'base plus stroke must stay inside the canvas so the edge is never clipped'
  );

  // The triangle keeps its glyph proportions: apex well above the middle
  // with a full-height body.
  assert.ok(g.apexY < 5, `apex at y=${g.apexY} must stay in the upper band (< 5)`);
  assert.ok(g.baseY - g.apexY >= 8, 'the triangle must keep a full-height body');
});

test('inline warning icon: the exclamation mark stays centred inside the triangle', () => {
  const g = parseIconGeometry(readIcon());
  const triangleCenterY = (g.apexY + g.baseY) / 2;
  const markCenterY = g.markBaseline - (g.fontSize * 0.71) / 2;

  assert.ok(g.markBaseline > g.apexY, 'the mark baseline must be below the triangle apex');
  assert.ok(g.markBaseline < g.baseY, 'the mark baseline must be above the triangle base');
  assert.ok(
    Math.abs(markCenterY - triangleCenterY) < 2,
    `the mark centre (${markCenterY.toFixed(1)}) must sit centred in the triangle (${triangleCenterY.toFixed(1)})`
  );
});
