import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractQueryableSelectors,
  extractQueryableSelectorsDetailed,
  buildWrapperPage,
  isStandaloneSelector,
  unqueryableReason,
} from '../../services/analysisPage';
import { CssRule } from '../../parser/cssAst';

/**
 * Unit tests for the active-editor-file analysis page module:
 * selector filtering keeps only selectors a static wrapper can match, and
 * the wrapper HTML contains one element structure per selector.
 */

function rule(selector: string): CssRule {
  return {
    selector,
    declarations: [],
    range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
    line: 0,
    column: 0,
  };
}

test('keeps simple class, id and tag selectors in order', () => {
  const selectors = extractQueryableSelectors([rule('.a'), rule('#b'), rule('div')]);
  assert.deepEqual(selectors, ['.a', '#b', 'div']);
});

test('splits comma-separated selector lists and preserves order', () => {
  const selectors = extractQueryableSelectors([rule('.a, .b, .c')]);
  assert.deepEqual(selectors, ['.a', '.b', '.c']);
});

test('drops pseudo-classes but emits the origin of pseudo-element selectors', () => {
  const selectors = extractQueryableSelectors([
    rule('.a:hover'),
    rule('.b::before'),
    rule('.c:not(.d)'),
    rule('.e'),
  ]);
  assert.deepEqual(selectors, ['.b', '.e']);
});

test('pseudo-element origins: class, id and combinator forms are emitted', () => {
  const selectors = extractQueryableSelectors([
    rule('.article-text::first-letter'),
    rule('#box::after'),
    rule('.a > .b::before'),
  ]);
  assert.deepEqual(selectors, ['.article-text', '#box', '.a > .b']);
});

test('pseudo-element selectors keep pseudo-classes are still dropped', () => {
  const selectors = extractQueryableSelectors([rule('.a:hover::before'), rule('.b')]);
  assert.deepEqual(selectors, ['.b']);
});

test('origin of a pseudo-element selector is wrapped by the wrapper page', () => {
  const html = buildWrapperPage(['.no-content-pseudo', '.article-text'], '/styles.css');
  assert.match(html, /<div class="no-content-pseudo"><\/div>/);
  assert.match(html, /<div class="article-text"><\/div>/);
});

test('drops attribute selectors', () => {
  const selectors = extractQueryableSelectors([rule('input[type="text"]'), rule('.a')]);
  assert.deepEqual(selectors, ['.a']);
});

test('drops sibling combinators', () => {
  const selectors = extractQueryableSelectors([rule('.a + .b'), rule('.c ~ .d'), rule('.e')]);
  assert.deepEqual(selectors, ['.e']);
});

test('drops bare universal, leading-combinator and leading-universal selectors', () => {
  const selectors = extractQueryableSelectors([rule('*'), rule('* .a'), rule('> .c'), rule('.d')]);
  assert.deepEqual(selectors, ['.d']);
});

test('keeps universal parts anchored by an earlier selector part', () => {
  const selectors = extractQueryableSelectors([rule('.a > *'), rule('.b *')]);
  assert.deepEqual(selectors, ['.a > *', '.b *']);
});

test('wraps an anchored universal part as a plain div', () => {
  const html = buildWrapperPage(['.a > *'], '/styles.css');
  assert.match(html, /<div class="a"><div><\/div><\/div>/);
});

test('drops at-rule preludes', () => {
  const selectors = extractQueryableSelectors([rule('@media (max-width: 600px)'), rule('.a')]);
  assert.deepEqual(selectors, ['.a']);
});

test('keeps descendant and child combinators', () => {
  const selectors = extractQueryableSelectors([rule('.a .b'), rule('.c > .d')]);
  assert.deepEqual(selectors, ['.a .b', '.c > .d']);
});

test('keeps compound selectors', () => {
  const selectors = extractQueryableSelectors([rule('div.foo#bar'), rule('h1.title')]);
  assert.deepEqual(selectors, ['div.foo#bar', 'h1.title']);
});

test('removes duplicates across rules', () => {
  const selectors = extractQueryableSelectors([rule('.a'), rule('.b, .a')]);
  assert.deepEqual(selectors, ['.a', '.b']);
});

test('returns empty list when nothing is queryable', () => {
  assert.deepEqual(extractQueryableSelectors([rule(':hover')]), []);
  assert.deepEqual(extractQueryableSelectors([]), []);
});

test('links the analyzed stylesheet with the given href', () => {
  const html = buildWrapperPage(['.a'], '/styles.css');
  assert.match(html, /<link rel="stylesheet" href="\/styles\.css">/);
});

test('contains one element structure per selector', () => {
  const html = buildWrapperPage(['.a', '#b'], '/styles.css');
  assert.match(html, /<div class="a"><\/div>/);
  assert.match(html, /<div id="b"><\/div>/);
});

test('nests descendant selectors innermost-first', () => {
  const html = buildWrapperPage(['.a .b'], '/styles.css');
  assert.match(html, /<div class="a"><div class="b"><\/div><\/div>/);
});

test('nests multi-level descendant selectors', () => {
  const html = buildWrapperPage(['.a .b .c'], '/styles.css');
  assert.match(html, /<div class="a"><div class="b"><div class="c"><\/div><\/div><\/div>/);
});

test('nests child combinators too', () => {
  const html = buildWrapperPage(['.a > .b'], '/styles.css');
  assert.match(html, /<div class="a"><div class="b"><\/div><\/div>/);
});

test('emits the real tag for compound tag selectors', () => {
  const html = buildWrapperPage(['div.a', 'my-element.b'], '/styles.css');
  assert.match(html, /<div class="a"><\/div>/);
  assert.match(html, /<my-element class="b"><\/my-element>/);
});

test('keeps both id and class on one element', () => {
  const html = buildWrapperPage(['.a#b'], '/styles.css');
  assert.match(html, /<div id="b" class="a"><\/div>/);
});

test('isStandaloneSelector: single compound parts are standalone', () => {
  assert.equal(isStandaloneSelector('.flex-item'), true);
  assert.equal(isStandaloneSelector('#a'), true);
  assert.equal(isStandaloneSelector('div'), true);
  assert.equal(isStandaloneSelector('.a#b'), true, 'a single compound with id+class is one part');
  assert.equal(isStandaloneSelector('div.x'), true, 'a compound tag.class is one part');
});

test('isStandaloneSelector: combinators make the selector non-standalone', () => {
  assert.equal(isStandaloneSelector('.a .b'), false);
  assert.equal(isStandaloneSelector('.a > .b'), false);
  assert.equal(isStandaloneSelector('.a > *'), false);
  assert.equal(isStandaloneSelector('.a .b .c'), false);
  assert.equal(isStandaloneSelector('.a + .b'), false);
  assert.equal(isStandaloneSelector('.a ~ .b'), false);
});

test('isStandaloneSelector: whitespace does not confuse the split', () => {
  assert.equal(isStandaloneSelector('.a'), true);
  assert.equal(isStandaloneSelector('  .a  '), true);
});

test('unqueryableReason: a queryable selector has no reason', () => {
  assert.equal(unqueryableReason('.a'), null);
  assert.equal(unqueryableReason('div.x'), null);
  assert.equal(unqueryableReason('.a > *'), null);
  assert.equal(unqueryableReason('.a .b'), null);
});

test('unqueryableReason: deterministic reasons for each disqualifier', () => {
  const cases: Array<[string, RegExp]> = [
    ['.a:hover', /pseudo-class/],
    ['.a::before', /pseudo-element/],
    ['.a + .b', /sibling combinator/],
    ['input[type="text"]', /attribute selector/],
    ['*', /universal selector/],
    ['> .a', /leading combinator/],
    ['@media (x)', /at-rule/],
  ];
  for (const [selector, pattern] of cases) {
    const reason = unqueryableReason(selector);
    assert.ok(reason, `expected a reason for ${selector}`);
    assert.match(reason, pattern);
  }
  assert.equal(unqueryableReason(''), 'empty selector');
});

test('extractQueryableSelectorsDetailed: reports dropped parts with reasons', () => {
  const { queryable, dropped } = extractQueryableSelectorsDetailed([
    rule('.a'),
    rule('.b:hover'),
    rule('.c + .d'),
    rule('.e'),
  ]);

  assert.deepEqual(queryable, ['.a', '.e']);
  assert.deepEqual(
    dropped.map((d) => d.selector),
    ['.b:hover', '.c + .d']
  );
  assert.match(dropped[0].reason, /pseudo-class/);
  assert.match(dropped[1].reason, /sibling combinator/);
});

test('extractQueryableSelectorsDetailed: a pseudo-element origin stays queryable, not dropped', () => {
  const { queryable, dropped } = extractQueryableSelectorsDetailed([rule('.a::before'), rule('.b')]);
  assert.deepEqual(queryable, ['.a', '.b']);
  assert.deepEqual(dropped, []);
});

test('extractQueryableSelectorsDetailed: a pseudo with an unhittable origin is dropped', () => {
  const { queryable, dropped } = extractQueryableSelectorsDetailed([rule('.a:hover::before')]);
  assert.deepEqual(queryable, []);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].selector, '.a:hover::before');
  assert.match(dropped[0].reason, /pseudo/);
});

test('extractQueryableSelectorsDetailed: no selectors still reports zero drops', () => {
  const { queryable, dropped } = extractQueryableSelectorsDetailed([]);
  assert.deepEqual(queryable, []);
  assert.deepEqual(dropped, []);
});
