import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { astCache } from '../../cache/astCache';

/**
 * Unit tests for the performance-PR AST cache: identical content is never
 * parsed twice, and only a real content change invalidates an entry.
 */

function scratchCss(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-astcache-'));
  const file = path.join(dir, 'styles.css');
  fs.writeFileSync(file, content);
  return file;
}

const INACTIVE_CSS = `.non-flex {\n  display: block;\n  justify-content: center;\n}\n`;
const ACTIVE_CSS = `.non-flex {\n  display: flex;\n  justify-content: center;\n}\n`;

test('parses identical content only once (hit on second access)', () => {
  astCache.reset();
  const file = scratchCss(INACTIVE_CSS);

  const first = astCache.getOrParse(file);
  assert.equal(first.hit, false, 'first access must parse');

  const second = astCache.getOrParse(file);
  assert.equal(second.hit, true, 'identical content must hit the cache');
  assert.equal(second.rules.length, first.rules.length);
  assert.equal(second.rules[0].declarations.length, first.rules[0].declarations.length);

  const stats = astCache.stats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
});

test('a content change invalidates the entry (miss with new rules)', () => {
  astCache.reset();
  const file = scratchCss(INACTIVE_CSS);

  const first = astCache.getOrParse(file);
  assert.equal(first.hit, false);

  // Change display to flex — the same file now parses differently.
  fs.writeFileSync(file, ACTIVE_CSS);
  const second = astCache.getOrParse(file);
  assert.equal(second.hit, false, 'changed content must re-parse');
  assert.notEqual(second.hash, first.hash);
  assert.equal(second.rules[0].declarations[0].value, 'flex');

  const stats = astCache.stats();
  assert.equal(stats.hits, 0);
  assert.equal(stats.misses, 2);
});

test('rewriting identical bytes is a cache hit, not a re-parse', () => {
  astCache.reset();
  const file = scratchCss(INACTIVE_CSS);

  astCache.getOrParse(file);
  // Same bytes rewritten to disk — no semantic content change.
  fs.writeFileSync(file, INACTIVE_CSS);
  const third = astCache.getOrParse(file);
  assert.equal(third.hit, true, 'identical bytes must not re-parse');

  const stats = astCache.stats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
});

test('different files are cached independently', () => {
  astCache.reset();
  const fileA = scratchCss(INACTIVE_CSS);
  const fileB = scratchCss(ACTIVE_CSS);

  const a = astCache.getOrParse(fileA);
  const b = astCache.getOrParse(fileB);
  assert.equal(a.hit, false);
  assert.equal(b.hit, false);
  assert.notEqual(a.hash, b.hash);

  assert.equal(astCache.getOrParse(fileA).hit, true);
  assert.equal(astCache.getOrParse(fileB).hit, true);
});
