import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  COMPANION_EXPANSION_BUDGET,
  cachedPageContainsAnySelector,
  resetSelectionScans,
  selectCompanionsForAnalysis,
} from '../../engine/companionSelection';
import { htmlContainsAnySelector, selectorTokensFor } from '../../engine/selectorScan';
import { fileHashCache } from '../../cache/fileHashCache';
import { contentHash } from '../../utils/contentHash';
import { CompanionResolution } from '../../services/companionResolver';

/**
 * Unit tests for the Level 11 companion selection (F6): the deterministic
 * Top-K + evidence-expansion rule, its token-level containment scan, and
 * the hash-gated scan cache — the shared identity both the analysis run
 * and the freshness probes derive the selection from.
 */

function resolution(htmlPath: string, rank: number): CompanionResolution {
  return {
    htmlPath,
    href: 'styles.css',
    kind: 'relative-down',
    distance: 0,
    serverRoot: path.dirname(htmlPath),
  };
}

test('F6: selectorTokensFor extracts the class/id/tag tokens of every compound part', () => {
  assert.deepEqual(selectorTokensFor('.hero'), ['hero']);
  assert.deepEqual(selectorTokensFor('#search'), ['search']);
  assert.deepEqual(selectorTokensFor('section'), ['section']);
  assert.deepEqual(selectorTokensFor('.menu .item > *'), ['menu', 'item']);
  assert.deepEqual(selectorTokensFor('a.nav-link'), ['nav-link', 'a']);
  assert.deepEqual(selectorTokensFor('my-element'), ['my-element']);
  assert.deepEqual(selectorTokensFor('*'), []);
});

test('F6: the containment scan is a conservative superset — every element match implies a hit', () => {
  const html = [
    '<body>',
    '<section class="hero" id="top">',
    '  <ul class="menu"><li class="item active"></li></ul>',
    '  <my-element></my-element>',
    '</section>',
    '</body>',
  ].join('');

  assert.equal(htmlContainsAnySelector(html, ['.hero']), true, 'class token present');
  assert.equal(htmlContainsAnySelector(html, ['#top']), true, 'id token present');
  assert.equal(htmlContainsAnySelector(html, ['section']), true, 'tag token present');
  assert.equal(htmlContainsAnySelector(html, ['my-element']), true, 'custom-element token present');
  assert.equal(htmlContainsAnySelector(html, ['.menu .item']), true, 'both descendant tokens present');
  assert.equal(htmlContainsAnySelector(html, ['.hero .item']), true, 'tokens present elsewhere — still a superset hit');
  assert.equal(htmlContainsAnySelector(html, ['.missing']), false, 'absent class misses');
  assert.equal(htmlContainsAnySelector(html, ['.item .missing']), false, 'one absent token misses the whole selector');
});

test('F6: the scan never under-reports — token boundaries and separators are respected', () => {
  assert.equal(htmlContainsAnySelector('<div class="xbox"></div>', ['.x']), false, 'class tokens are whole words');
  assert.equal(htmlContainsAnySelector('<div id="search2"></div>', ['#search']), false, 'id tokens are whole words');
  assert.equal(htmlContainsAnySelector('<area></area>', ['a']), false, 'tag tokens are whole words');
  assert.equal(htmlContainsAnySelector('<div id="search-box"></div>', ['#search']), true, 'a compound id still over-reports — over-expansion is safe, under-expansion never is');
  assert.equal(htmlContainsAnySelector('<div id="search"></div>', ['#search']), true, 'exact id hits');
  assert.equal(htmlContainsAnySelector('<div class="x-1"></div>', ['.x_1']), false, 'hyphen vs underscore are distinct tokens');
  assert.equal(htmlContainsAnySelector('<div class="x_1"></div>', ['.x_1']), true, 'underscore is a word character');
});

test('F6: selectCompanionsForAnalysis expands the Top-K with matched candidates, bounded and deterministic', () => {
  const ranked = [1, 2, 3, 4, 5, 6].map((i) => resolution(path.join('/proj', `p${i}.html`), i));
  const contains = new Set(['p4.html', 'p5.html']);

  const selected = selectCompanionsForAnalysis(ranked, ['.a'], 3, COMPANION_EXPANSION_BUDGET, (c) =>
    contains.has(path.basename(c.htmlPath))
  );
  assert.deepEqual(
    selected.map((c) => path.basename(c.htmlPath)),
    ['p1.html', 'p2.html', 'p3.html', 'p4.html', 'p5.html'],
    'the Top-K plus the ranked-order matched tail'
  );

  const allMatched = selectCompanionsForAnalysis(ranked, ['.a'], 3, 2, () => true);
  assert.equal(allMatched.length, 5, 'the expansion tail is budget-bounded');

  const noSelectors = selectCompanionsForAnalysis(ranked, [], 3, COMPANION_EXPANSION_BUDGET, () => true);
  assert.equal(noSelectors.length, 3, 'no expansion without selectors');

  const noBudget = selectCompanionsForAnalysis(ranked, ['.a'], 3, 0, () => true);
  assert.equal(noBudget.length, 3, 'no expansion without a budget');

  const again = selectCompanionsForAnalysis(ranked, ['.a'], 3, COMPANION_EXPANSION_BUDGET, (c) =>
    contains.has(path.basename(c.htmlPath))
  );
  assert.deepEqual(again.map((c) => c.htmlPath), selected.map((c) => c.htmlPath), 'deterministic selection');
});

test('F6: cachedPageContainsAnySelector is gated by the page AND the stylesheet content hash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-scan-'));
  const html = path.join(dir, 'index.html');
  fs.writeFileSync(html, '<div class="hero"></div>');
  fileHashCache.reset();
  resetSelectionScans();

  // In production the cssHash IS the stylesheet content hash, so it
  // uniquely identifies the selector list the scan ran with — a different
  // selector list always carries a different hash (same content → same
  // parse → same queryable selectors).
  const hashA = contentHash('h1 { color: red }');
  const hashB = contentHash('.ghost { color: red }');

  assert.equal(cachedPageContainsAnySelector(html, ['.hero'], hashA), true, 'cold scan');
  assert.equal(cachedPageContainsAnySelector(html, ['.hero'], hashA), true, 'cached scan');
  assert.equal(
    cachedPageContainsAnySelector(html, ['.ghost'], hashB),
    false,
    'a different stylesheet (new hash) re-scans with its own selectors'
  );

  fs.writeFileSync(html, '<div class="hero extra"></div>');
  assert.equal(cachedPageContainsAnySelector(html, ['.extra'], hashA), true, 'a page edit invalidates the cache');
  assert.equal(cachedPageContainsAnySelector(html, ['.hero'], hashA), true, 'the re-scan covers the new content');
});