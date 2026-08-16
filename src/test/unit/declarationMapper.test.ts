import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CssAstParser } from '../../parser/cssAst';
import { DeclarationMapper } from '../../matcher/declarationMapper';
import { MatchedCssDeclaration } from '../../engine/inactivePropertyEngine';

/**
 * Unit tests for PR4: the CDP → local declaration mapper.
 *
 * The mapper must prefer authored declarations, never claim the same local
 * declaration twice, tolerate range-less protocol entries and produce no
 * false positives from malformed or incomplete CDP data.
 */

const FILE = '/fake/styles.css';

interface RangeLike {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

function sliceAt(text: string, r: RangeLike): string {
  return text.split('\n')[r.startLine].slice(r.startColumn, r.endColumn);
}

function makeMapper(css: string): DeclarationMapper {
  return new DeclarationMapper(new CssAstParser().parse(css, FILE), FILE);
}

function cdp(overrides: Partial<MatchedCssDeclaration>): MatchedCssDeclaration {
  return {
    nodeId: 1,
    styleSheetId: 'sheet-1',
    selectorText: '.non-flex',
    propertyName: 'justify-content',
    propertyValue: 'center',
    origin: 'author',
    ...overrides,
  };
}

test('matches exact selector + property + value and returns real local ranges', () => {
  const css = '.non-flex {\n  justify-content: center;\n}\n';
  const mapper = makeMapper(css);

  const m = mapper.match(cdp({}));
  assert.ok(m);
  assert.equal(m.filePath, FILE);
  assert.equal(m.selector, '.non-flex');
  assert.equal(m.declaration.name, 'justify-content');
  assert.equal(m.declaration.value, 'center');

  assert.equal(sliceAt(css, m.declarationRange), 'justify-content: center;');
  assert.equal(sliceAt(css, m.propertyNameRange), 'justify-content');
  assert.equal(sliceAt(css, m.valueRange), 'center');
  assert.equal(sliceAt(css, m.iconAnchorRange), ';');
  // The icon anchor is exactly one character.
  assert.equal(
    m.iconAnchorRange.startColumn + 1,
    m.iconAnchorRange.endColumn,
    'icon anchor must be a single character'
  );
  assert.equal(m.iconAnchorRange.startLine, m.iconAnchorRange.endLine);
});

test('tolerates a range-less protocol entry', () => {
  const css = '.non-flex { justify-content: center; }';
  const mapper = makeMapper(css);

  const m = mapper.match(cdp({ propertyRange: undefined, ruleRange: undefined }));
  assert.ok(m);
  assert.equal(m.declaration.name, 'justify-content');
  assert.equal(sliceAt(css, m.propertyNameRange), 'justify-content');
});

test('duplicate CDP entries map to a single local declaration', () => {
  const css = '.non-flex { justify-content: center; }';
  const mapper = makeMapper(css);

  const first = mapper.match(cdp({}));
  const second = mapper.match(cdp({}));
  assert.ok(first);
  assert.equal(second, null, 'second duplicate CDP entry must not produce a second local match');
});

test('same property in different selectors stays distinct', () => {
  const css = '.a { justify-content: center; }\n.b { justify-content: center; }\n';
  const mapper = makeMapper(css);

  const a = mapper.match(cdp({ selectorText: '.a' }));
  const b = mapper.match(cdp({ selectorText: '.b' }));
  assert.ok(a && b);
  assert.equal(a.selector, '.a');
  assert.equal(b.selector, '.b');
  assert.notDeepEqual(a.declarationRange, b.declarationRange);
});

test('same property/value in different files stays distinct', () => {
  const fileA = '/fake/a.css';
  const fileB = '/fake/b.css';
  const cssA = '.a { justify-content: center; }';
  const cssB = '.b { justify-content: center; }';

  const mapperA = new DeclarationMapper(new CssAstParser().parse(cssA, fileA), fileA);
  const mapperB = new DeclarationMapper(new CssAstParser().parse(cssB, fileB), fileB);

  // A CDP declaration owned by file B does not match mapper A.
  assert.equal(mapperA.match(cdp({ selectorText: '.b' })), null);
  const b = mapperB.match(cdp({ selectorText: '.b' }));
  assert.ok(b);
  assert.equal(b.filePath, fileB);
});

test('malformed or incomplete CDP entries produce no false positives', () => {
  const css = '.non-flex { justify-content: center; }';
  const mapper = makeMapper(css);

  assert.equal(mapper.match(cdp({ propertyName: '' })), null);
  assert.equal(mapper.match(cdp({ propertyName: '   ' })), null);
  assert.equal(mapper.match(cdp({ propertyValue: '' })), null);
});

test('an ambiguous match without selector information is rejected', () => {
  const css = '.a { justify-content: center; }\n.b { justify-content: center; }\n';
  const mapper = makeMapper(css);

  assert.equal(mapper.match(cdp({ selectorText: '' })), null);
});

test('a single candidate without selector information is still matched', () => {
  const css = '.non-flex { justify-content: center; }';
  const mapper = makeMapper(css);

  const m = mapper.match(cdp({ selectorText: '' }));
  assert.ok(m);
  assert.equal(m.declaration.name, 'justify-content');
});

test('a selector that is not present locally is rejected', () => {
  const css = '.other { justify-content: center; }';
  const mapper = makeMapper(css);

  assert.equal(mapper.match(cdp({ selectorText: '.non-flex' })), null);
});

test('matching is case- and whitespace-insensitive for name and value', () => {
  const css = '.non-flex { justify-content: center; }';
  const mapper = makeMapper(css);

  const m = mapper.match(
    cdp({ propertyName: '  Justify-Content  ', propertyValue: '  CENTER ' })
  );
  assert.ok(m);
  assert.equal(m.declaration.name, 'justify-content');
});

/**
 * Embedded CSS: inline `style=""` declarations are matched against one
 * parsed attribute fragment purely by content (they carry no selector).
 */

import { matchInlineDeclaration } from '../../matcher/declarationMapper';

const parser = new CssAstParser();

function attrDeclarations(value: string) {
  return parser.parseDeclarationList(value);
}

test('matchInlineDeclaration: unique content match maps to the attribute declaration', () => {
  const decls = attrDeclarations('color: red; margin-top: 5px');
  const match = matchInlineDeclaration(
    cdp({ selectorText: '', propertyName: 'margin-top', propertyValue: '5px' }),
    '/x/index.html',
    decls
  );

  assert.ok(match);
  assert.equal(match.filePath, '/x/index.html');
  assert.equal(match.declaration.name, 'margin-top');
  assert.deepEqual(match.declarationRange, { filePath: '/x/index.html', startLine: 0, startColumn: 12, endLine: 0, endColumn: 27 });
  assert.deepEqual(match.propertyNameRange, { filePath: '/x/index.html', startLine: 0, startColumn: 12, endLine: 0, endColumn: 22 });
  assert.deepEqual(match.iconAnchorRange, { filePath: '/x/index.html', startLine: 0, startColumn: 26, endLine: 0, endColumn: 27 });
});

test('matchInlineDeclaration: is case- and whitespace-insensitive', () => {
  const decls = attrDeclarations('COLOR : RED');
  const match = matchInlineDeclaration(
    cdp({ propertyName: '  color ', propertyValue: '  red ' }),
    '/x/index.html',
    decls
  );
  assert.ok(match);
});

test('matchInlineDeclaration: authored duplicates pair by occurrence index', () => {
  const decls = attrDeclarations('color: red; color: red');
  const first = matchInlineDeclaration(
    cdp({ propertyName: 'color', propertyValue: 'red' }),
    '/x/index.html',
    decls,
    0
  );
  const second = matchInlineDeclaration(
    cdp({ propertyName: 'color', propertyValue: 'red' }),
    '/x/index.html',
    decls,
    1
  );

  // CDP reports duplicates in source order, so occurrence 0 is the first
  // authored duplicate and occurrence 1 the second — two distinct slices.
  assert.ok(first);
  assert.ok(second);
  assert.deepEqual(first.declarationRange, { filePath: '/x/index.html', startLine: 0, startColumn: 0, endLine: 0, endColumn: 11 });
  assert.deepEqual(second.declarationRange, { filePath: '/x/index.html', startLine: 0, startColumn: 12, endLine: 0, endColumn: 22 });
  assert.notDeepEqual(first.declarationRange, second.declarationRange);
});

test('matchInlineDeclaration: an occurrence beyond the fragment abstains', () => {
  const decls = attrDeclarations('color: red');
  const match = matchInlineDeclaration(
    cdp({ propertyName: 'color', propertyValue: 'red' }),
    '/x/index.html',
    decls,
    1
  );
  assert.equal(match, null, 'a rank beyond the authored candidates cannot be attributed');
});

test('matchInlineDeclaration: absent or incomplete declarations never match', () => {
  const decls = attrDeclarations('color: red');
  assert.equal(
    matchInlineDeclaration(cdp({ propertyName: 'gap', propertyValue: '8px' }), '/x/index.html', decls),
    null
  );
  assert.equal(
    matchInlineDeclaration(cdp({ propertyName: 'color', propertyValue: '' }), '/x/index.html', decls),
    null
  );
  assert.equal(matchInlineDeclaration(cdp({ propertyName: '', propertyValue: 'red' }), '/x/index.html', decls), null);
});

test('matchInlineDeclaration: !important values match (CDP keeps the token)', () => {
  const decls = attrDeclarations('margin-top: 5px !important');
  const match = matchInlineDeclaration(
    cdp({ propertyName: 'margin-top', propertyValue: '5px !important' }),
    '/x/index.html',
    decls
  );
  assert.ok(match);
});
