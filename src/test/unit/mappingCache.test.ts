import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import { mappingCache, mappingKeyFor, batchKeys } from '../../cache/mappingCache';
import { CssAstParser } from '../../parser/cssAst';
import { MatchedCssDeclaration } from '../../engine/inactivePropertyEngine';

/**
 * Unit tests for the performance-PR mapping cache: mapping outcomes are
 * deterministic per (CSS content + CDP declaration batch) and identical
 * inputs never re-run the mapper.
 */

const CSS_PATH = '/fake/fixture/styles.css';
const CSS_CONTENT = `.non-flex {\n  display: block;\n  justify-content: center;\n}\n`;

function cssHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

function cdpDeclaration(
  overrides: Partial<MatchedCssDeclaration>
): MatchedCssDeclaration {
  return {
    nodeId: 1,
    selectorText: '.non-flex',
    propertyName: 'justify-content',
    propertyValue: 'center',
    ...overrides,
  };
}

const INACTIVE_BATCH: MatchedCssDeclaration[] = [
  cdpDeclaration({}),
  cdpDeclaration({ propertyName: 'display', propertyValue: 'block' }),
];

function runBatch(css: string, batch: MatchedCssDeclaration[]) {
  const rules = new CssAstParser().parse(css, CSS_PATH);
  return mappingCache.matchAll(cssHash(css), CSS_PATH, rules, batch);
}

test('identical CSS + CDP batch hits the cache with identical results', () => {
  mappingCache.reset();

  const first = runBatch(CSS_CONTENT, INACTIVE_BATCH);
  const statsAfterFirst = mappingCache.stats();
  assert.equal(statsAfterFirst.misses, 1);
  assert.equal(statsAfterFirst.hits, 0);

  const second = runBatch(CSS_CONTENT, INACTIVE_BATCH);
  const statsAfterSecond = mappingCache.stats();
  assert.equal(statsAfterSecond.hits, 1);
  assert.equal(statsAfterSecond.misses, 1);

  // Both runs resolve the same mapping (same ranges, same local declaration).
  const key = batchKeys(INACTIVE_BATCH).get(INACTIVE_BATCH[0])!;
  assert.deepEqual(second.get(key), first.get(key));
  assert.equal(first.get(key)?.declarationRange.startLine, 2);
  assert.equal(first.get(key)?.iconAnchorRange.endColumn, 26);
});

test('a CSS content change invalidates the mapping entry', () => {
  mappingCache.reset();

  runBatch(CSS_CONTENT, INACTIVE_BATCH);
  assert.equal(mappingCache.stats().misses, 1);

  const activeCss = CSS_CONTENT.replace('block', 'flex');
  runBatch(activeCss, INACTIVE_BATCH);
  const stats = mappingCache.stats();
  assert.equal(stats.misses, 2, 'changed CSS must re-map');
  assert.equal(stats.hits, 0);
});

test('a different CDP declaration batch invalidates the mapping entry', () => {
  mappingCache.reset();

  runBatch(CSS_CONTENT, INACTIVE_BATCH);
  assert.equal(mappingCache.stats().misses, 1);

  // Same CSS but a batch missing the display declaration.
  runBatch(CSS_CONTENT, [cdpDeclaration({})]);
  const stats = mappingCache.stats();
  assert.equal(stats.misses, 2, 'a different CDP batch must re-map');
});

test('unmappable declarations resolve to null deterministically', () => {
  mappingCache.reset();

  const batch = [cdpDeclaration({ propertyName: 'never-exists', propertyValue: '42' })];
  const first = runBatch(CSS_CONTENT, batch);
  const second = runBatch(CSS_CONTENT, batch);

  assert.equal(first.get(batchKeys(batch).get(batch[0])!), null);
  assert.deepEqual(second, first);
});

test('batch ordering is part of the cache key (claims are order-sensitive)', () => {
  mappingCache.reset();

  // Two declarations with the same name/value but different selectors:
  // the claim order depends on the batch order.
  const batchA = [
    cdpDeclaration({ selectorText: '.b' }),
    cdpDeclaration({ selectorText: '.a' }),
  ];
  const batchB = [...batchA].reverse();

  const css = `.a { justify-content: center; }\n.b { justify-content: center; }\n`;
  const resultA = runBatch(css, batchA);
  const resultB = runBatch(css, batchB);

  const stats = mappingCache.stats();
  assert.equal(stats.misses, 2, 'reordered batches must re-map');
  // The first declaration of each batch claims the matching local rule.
  assert.equal(resultA.get(batchKeys(batchA).get(batchA[0])!)?.selector, '.b');
  assert.equal(resultB.get(batchKeys(batchB).get(batchB[0])!)?.selector, '.a');
});

/**
 * Rules fingerprint: identical rule text at DIFFERENT source offsets (two
 * identical <style> blocks in one HTML document) must not share a mapping
 * entry, or the second block's ranges would be claimed by the first.
 */

test('identical rules at different offsets produce distinct mapping entries', () => {
  mappingCache.reset();

  const contentA = `.x { justify-content: center; }\n`;
  const contentB = `.x { justify-content: center; }\n`;

  // Same content, same hash — but parsed at two different document
  // positions (as two <style> blocks would be).
  const blockA = new CssAstParser().parse(contentA, CSS_PATH);
  const blockB = new CssAstParser().parse(contentB, CSS_PATH);
  blockB.forEach((r) => {
    r.range = { startLine: 10, startColumn: 0, endLine: 11, endColumn: 30 };
    r.declarations[0].range = { startLine: 10, startColumn: 0, endLine: 10, endColumn: 28 };
  });

  const hash = cssHash(contentA);
  const batch = [cdpDeclaration({ selectorText: '.x' })];

  const resultA = mappingCache.matchAll(hash, CSS_PATH, blockA, batch);
  const first = resultA.get(batchKeys(batch).get(batch[0])!);
  assert.equal(first?.declarationRange?.startLine, 0, 'first block maps to its own offset');

  // A second call for the second block must MISS (different fingerprint)
  // and map to the second block's offsets.
  const statsBefore = mappingCache.stats();
  const resultB = mappingCache.matchAll(hash, CSS_PATH, blockB, batch);
  const second = resultB.get(batchKeys(batch).get(batch[0])!);
  assert.equal(second?.declarationRange?.startLine, 10, 'identical text at another offset maps there');

  const statsAfter = mappingCache.stats();
  assert.equal(statsAfter.misses, statsBefore.misses + 1, 'a different fingerprint must re-map');
});

/**
 * Authored duplicates: the same property written twice in ONE rule. CDP
 * reports both (distinct ranges, source order), and the occurrence-scoped
 * keys must make the k-th report claim the k-th LOCAL declaration — two
 * issues with two distinct source ranges, never one merged.
 */

const DUP_CSS = `.dup {\n  display: block;\n  justify-content: center;\n  justify-content: center;\n  justify-content: flex-end;\n}\n`;

function dupDeclaration(value: string): MatchedCssDeclaration {
  return cdpDeclaration({ selectorText: '.dup', propertyValue: value });
}

test('authored duplicates map to distinct local declarations by occurrence', () => {
  mappingCache.reset();

  const batch = [
    dupDeclaration('center'),
    dupDeclaration('center'),
    dupDeclaration('flex-end'),
  ];
  const results = runBatch(DUP_CSS, batch);
  const keys = batchKeys(batch);

  // Three distinct local declarations, each at its own source line.
  const lines = [...results.values()].map((m) => m?.declarationRange.startLine);
  assert.deepEqual(lines, [2, 3, 4], 'each authored duplicate claims its own source line');
  assert.equal(results.get(keys.get(batch[0])!)?.declarationRange.startLine, 2);
  assert.equal(results.get(keys.get(batch[1])!)?.declarationRange.startLine, 3);
  assert.equal(results.get(keys.get(batch[2])!)?.declarationRange.startLine, 4);
});

test('equal reports of ONE authored declaration collapse onto the same local declaration', () => {
  mappingCache.reset();

  // The same rule matching two nodes reports the identical declaration
  // twice; the first claim wins and the second resolves to null, so the
  // analyzer's location dedupe collapses them.
  const batch = [
    dupDeclaration('flex-end'),
    dupDeclaration('flex-end'),
  ];
  const results = runBatch(DUP_CSS, batch);
  const keys = batchKeys(batch);

  assert.ok(results.get(keys.get(batch[0])!), 'the first report claims the declaration');
  assert.equal(results.get(keys.get(batch[1])!), null, 'the equal second report must not claim it again');
});
