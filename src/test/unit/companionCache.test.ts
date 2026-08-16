import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { companionCache } from '../../cache/companionCache';
import { CompanionResolution } from '../../services/companionResolver';

/**
 * Companion-resolution cache (Level 11): the FULL ranked companion list of
 * a stylesheet is cached and validated on the warm path (no rescan), with
 * content-change, deletion and reset invalidation.
 */

let root: string;

function layout(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-cache-'));
  return root;
}

function resolution(htmlPath: string): CompanionResolution {
  return {
    htmlPath,
    href: 'styles.css',
    kind: 'relative-down',
    distance: 0,
    serverRoot: root,
  };
}

test('cached ranked list is validated against the companion content hashes', () => {
  layout();
  const htmlPath = path.join(root, 'index.html');
  fs.writeFileSync(htmlPath, '<link rel="stylesheet" href="styles.css">');
  const resolutions = [resolution(htmlPath)];

  companionCache.reset();
  companionCache.set('k1', resolutions);
  const hit = companionCache.getValidated('k1');
  assert.equal(hit, resolutions, 'unchanged companions hit without a rescan');
});

test('a changed companion invalidates the cached ranked list', () => {
  layout();
  const htmlPath = path.join(root, 'index.html');
  fs.writeFileSync(htmlPath, '<link rel="stylesheet" href="styles.css">');
  const resolutions = [resolution(htmlPath)];

  companionCache.reset();
  companionCache.set('k2', resolutions);
  assert.equal(companionCache.getValidated('k2'), resolutions);

  fs.writeFileSync(htmlPath, '<link rel="stylesheet" href="other.css">');
  assert.equal(companionCache.getValidated('k2'), undefined, 'content change → stale');
});

test('a deleted companion invalidates the cached ranked list', () => {
  layout();
  const htmlPath = path.join(root, 'index.html');
  fs.writeFileSync(htmlPath, 'x');
  const resolutions = [resolution(htmlPath)];

  companionCache.reset();
  companionCache.set('k3', resolutions);
  fs.rmSync(htmlPath);
  assert.equal(companionCache.getValidated('k3'), undefined);
});

test('a null resolution (no companion) is cached and reused', () => {
  layout();
  companionCache.reset();
  companionCache.set('k4', null);
  assert.equal(companionCache.getValidated('k4'), null);
  assert.equal(companionCache.getValidated('k4'), null);
});

test('reset clears entries and counters', () => {
  layout();
  companionCache.reset();
  companionCache.set('k5', null);
  assert.equal(companionCache.getValidated('k5'), null);
  companionCache.reset();
  assert.equal(companionCache.getValidated('k5'), undefined);
});