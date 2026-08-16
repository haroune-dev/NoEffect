import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileHashCache } from '../../cache/fileHashCache';

/**
 * Unit tests for the file content-hash cache: identical content is never
 * re-read as a change, and only a real content change invalidates an entry.
 */

function scratchFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-filehash-'));
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, content);
  return file;
}

const HTML_A = '<html><head><link rel="stylesheet" href="styles.css"></head><body></body></html>\n';
const HTML_B = '<html><head><link rel="stylesheet" href="other.css"></head><body></body></html>\n';

test('first read of a file is a miss', () => {
  fileHashCache.reset();
  const file = scratchFile(HTML_A);

  const entry = fileHashCache.getOrRead(file);
  assert.equal(entry.hit, false, 'first read must be a miss');
  assert.equal(typeof entry.hash, 'string');
  assert.ok(entry.hash.length > 0);

  const stats = fileHashCache.stats();
  assert.equal(stats.hits, 0);
  assert.equal(stats.misses, 1);
});

test('identical content is a hit on the second read', () => {
  fileHashCache.reset();
  const file = scratchFile(HTML_A);

  const first = fileHashCache.getOrRead(file);
  const second = fileHashCache.getOrRead(file);
  assert.equal(second.hit, true, 'identical content must hit the cache');
  assert.equal(second.hash, first.hash);

  const stats = fileHashCache.stats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
});

test('a content change is a miss with a new hash', () => {
  fileHashCache.reset();
  const file = scratchFile(HTML_A);

  const first = fileHashCache.getOrRead(file);
  fs.writeFileSync(file, HTML_B);
  const second = fileHashCache.getOrRead(file);
  assert.equal(second.hit, false, 'changed content must be a miss');
  assert.notEqual(second.hash, first.hash);

  const third = fileHashCache.getOrRead(file);
  assert.equal(third.hit, true, 'unchanged content after a change hits again');

  const stats = fileHashCache.stats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 2);
});

test('rewriting identical bytes is a hit, not a miss', () => {
  fileHashCache.reset();
  const file = scratchFile(HTML_A);

  fileHashCache.getOrRead(file);
  fs.writeFileSync(file, HTML_A);
  const entry = fileHashCache.getOrRead(file);
  assert.equal(entry.hit, true, 'identical bytes must not count as a change');

  const stats = fileHashCache.stats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
});

test('different files are tracked independently', () => {
  fileHashCache.reset();
  const fileA = scratchFile(HTML_A);
  const fileB = scratchFile(HTML_B);

  assert.equal(fileHashCache.getOrRead(fileA).hit, false);
  assert.equal(fileHashCache.getOrRead(fileB).hit, false);
  assert.equal(fileHashCache.getOrRead(fileA).hit, true);
  assert.equal(fileHashCache.getOrRead(fileB).hit, true);

  const stats = fileHashCache.stats();
  assert.equal(stats.hits, 2);
  assert.equal(stats.misses, 2);
});

test('reset clears entries and counters', () => {
  fileHashCache.reset();
  const file = scratchFile(HTML_A);

  fileHashCache.getOrRead(file);
  assert.equal(fileHashCache.getOrRead(file).hit, true);

  fileHashCache.reset();
  assert.equal(fileHashCache.getOrRead(file).hit, false, 'a fresh cache must miss again');

  const stats = fileHashCache.stats();
  assert.equal(stats.hits, 0);
  assert.equal(stats.misses, 1);
});
