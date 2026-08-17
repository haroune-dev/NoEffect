import { test } from 'node:test';
import assert from 'node:assert/strict';
import { multiPassCache } from '../../cache/multiPassCache';
import { PassOutcome, PassVerdict } from '../../engine/verdictMerge';

/**
 * Multi-pass cache (Level 11): the per-pass and merged-result caches of the
 * multi-companion flow. Pass entries are rebuilt as FRESH Maps on read
 * (mutation-safe round trip); merged entries are shared references (read
 * only). Keys are pure compositions of content hashes — a changed css or
 * companion document produces a different hash and therefore a different
 * key, so nothing else can invalidate an entry.
 */

function fresh(): typeof multiPassCache {
  multiPassCache.reset();
  return multiPassCache;
}

function verdict(key: string, verdict: PassVerdict['verdict']): PassVerdict {
  return { key, verdict };
}

function outcome(rank: number, keys: string[]): PassOutcome {
  return {
    companionPath: `/p/${rank}.html`,
    companionRank: rank,
    verdicts: new Map(keys.map((key) => [key, verdict(key, 'I')])),
    success: true,
  };
}

test('passKeyFor combined key: css and companion content hashes, order matters', () => {
  const cache = fresh();
  assert.equal(cache.passKeyFor('css1', 'html1'), 'css1|html1');
  assert.notEqual(cache.passKeyFor('css1', 'html1'), cache.passKeyFor('html1', 'css1'));
  assert.notEqual(cache.passKeyFor('css1', 'html1'), cache.passKeyFor('css1', 'html2'));
});

test('mergedKeyFor: content fingerprint + canonical context fingerprint (Phase 6)', () => {
  const cache = fresh();
  assert.equal(
    cache.mergedKeyFor('content-fp', 'context-fp'),
    'content-fp|context-fp',
    'the key is the (content, context) fingerprint pair'
  );
  assert.notEqual(
    cache.mergedKeyFor('content-fp', 'context-fp'),
    cache.mergedKeyFor('content-fp', 'context-fp-2'),
    'a context fingerprint change is a different key'
  );
  assert.notEqual(
    cache.mergedKeyFor('content-fp', 'context-fp'),
    cache.mergedKeyFor('content-fp-2', 'context-fp'),
    'a content fingerprint change is a different key'
  );
});

test('pass round-trip: getPass returns a FRESH Map (mutation-safe)', () => {
  const cache = fresh();
  const entry = { outcome: outcome(0, ['k1', 'k2']), locatedSelectors: ['.a'] };
  cache.setPass('p', entry);

  const first = cache.getPass('p');
  assert.ok(first, 'cold read hits');
  assert.deepEqual([...first!.outcome.verdicts.keys()].sort(), ['k1', 'k2']);
  assert.deepEqual(first!.locatedSelectors, ['.a']);

  first!.outcome.verdicts.delete('k1');
  first!.locatedSelectors.push('.b');

  const second = cache.getPass('p');
  assert.deepEqual(
    [...second!.outcome.verdicts.keys()].sort(),
    ['k1', 'k2'],
    'mutating a returned entry never corrupts the cache'
  );
  assert.equal(second!.locatedSelectors.includes('.b'), false);
});

test('pass entry: locatedSelectors round-trip intact, failure flag preserved', () => {
  const cache = fresh();
  const failed = {
    outcome: { ...outcome(0, []), success: false, error: 'boom' },
    locatedSelectors: [],
  };
  cache.setPass('p', failed);
  const read = cache.getPass('p')!;
  assert.equal(read.outcome.success, false);
  assert.equal(read.outcome.error, 'boom');
});

test('pass miss: a different css or companion hash is a different key → miss', () => {
  const cache = fresh();
  cache.setPass('css1|html1', { outcome: outcome(0, ['k1']), locatedSelectors: [] });
  assert.equal(cache.getPass('css1|html2'), undefined, 'companion hash change → miss');
  assert.equal(cache.getPass('css2|html1'), undefined, 'css hash change → miss');
});

test('merged round-trip: shared reference contract (read-only by consumers)', () => {
  const cache = fresh();
  const merged = new Map<string, import('../../engine/verdictMerge').MergedResult>();
  merged.set('k1', { key: 'k1', verdict: 'I', evaluatedCount: 1, inactiveCount: 1, sourceRank: 0 });
  cache.setMerged('m', merged);

  const read = cache.getMerged('m');
  assert.equal(read, merged, 'the merged result is returned as the stored reference');
  assert.equal(read?.get('k1')?.verdict, 'I');
});

test('merged miss: any component change misses', () => {
  const cache = fresh();
  cache.setMerged('content-fp|context-fp', new Map());
  assert.equal(cache.getMerged('content-fp|context-fp-2'), undefined);
  assert.equal(cache.getMerged('content-fp-2|context-fp'), undefined);
});

test('stats: hits and misses counted per cache', () => {
  const cache = fresh();
  cache.getPass('x|y');
  cache.getMerged('m');
  cache.setPass('x|y', { outcome: outcome(0, ['k']), locatedSelectors: [] });
  cache.getPass('x|y');
  cache.setMerged('m', new Map());
  cache.getMerged('m');
  const stats = cache.stats();
  assert.equal(stats.passHits, 1);
  assert.equal(stats.passMisses, 1);
  assert.equal(stats.mergedHits, 1);
  assert.equal(stats.mergedMisses, 1);
});

test('reset clears entries and counters', () => {
  const cache = fresh();
  cache.setPass('x|y', { outcome: outcome(0, ['k']), locatedSelectors: [] });
  cache.setMerged('m', new Map());
  cache.reset();
  assert.equal(cache.getPass('x|y'), undefined);
  assert.equal(cache.getMerged('m'), undefined);
  assert.deepEqual(cache.stats(), { passHits: 0, passMisses: 1, mergedHits: 0, mergedMisses: 1 });
});

test('pass store is bounded: the oldest entry evicts at the cap', () => {
  const cache = fresh();
  const entry = { outcome: outcome(0, []), locatedSelectors: [] };
  for (let i = 0; i < 513; i++) {
    cache.setPass(`css|html${i}`, entry);
  }
  assert.equal(cache.getPass('css|html0'), undefined, 'the oldest pass entry was evicted');
  assert.ok(cache.getPass('css|html512'), 'the most recent entry survives');
});

test('pass store evicts least-recently-USED entries (a hit refreshes recency)', () => {
  const cache = fresh();
  const entry = { outcome: outcome(0, []), locatedSelectors: [] };
  for (let i = 0; i < 512; i++) {
    cache.setPass(`p${i}`, entry);
  }
  assert.ok(cache.getPass('p0'), 'refreshing the oldest entry hits');
  cache.setPass('p512', entry);
  assert.ok(cache.getPass('p0'), 'the refreshed entry survived the eviction');
  assert.equal(cache.getPass('p1'), undefined, 'the least-recently-used entry was evicted');
});

test('merged store is bounded: the oldest key evicts at the cap', () => {
  const cache = fresh();
  for (let i = 0; i < 129; i++) {
    cache.setMerged(`fp|ctx${i}`, new Map());
  }
  assert.equal(cache.getMerged('fp|ctx0'), undefined, 'the oldest merged entry was evicted');
  assert.ok(cache.getMerged('fp|ctx128'), 'the most recent entry survives');
});