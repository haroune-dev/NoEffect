import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectPseudoTypes } from '../../browser/matchedStylesCollector';
import { normalizeAndDeduplicate } from '../../engine/declarationNormalizer';

/**
 * Unit tests for the pseudo-type collector: it must surface the pseudo
 * elements CDP reports for a node so the analyzer can fetch the COMPUTED
 * styles of each pseudo box. Types are normalized (trimmed, lowercased)
 * and returned in response order; the `::` prefix of the CDP value is
 * preserved so the keys line up with the pseudo tags on declarations.
 */

test('collects the pseudo types present in the response, in order', () => {
  const types = collectPseudoTypes({
    pseudoElements: [
      { pseudoType: '::first-letter', matches: [] },
      { pseudoType: 'before', matches: [] },
      { pseudoType: '::after', matches: [] },
    ],
  });

  assert.deepEqual(types, ['::first-letter', 'before', '::after']);
});

test('normalizes case and whitespace of the pseudo type', () => {
  const types = collectPseudoTypes({
    pseudoElements: [
      { pseudoType: '  First-Letter ', matches: [] },
      { pseudoType: ' BEFORE ', matches: [] },
    ],
  });

  assert.deepEqual(types, ['first-letter', 'before']);
});

test('handles empty and malformed payloads safely', () => {
  assert.deepEqual(collectPseudoTypes(undefined), []);
  assert.deepEqual(collectPseudoTypes(null), []);
  assert.deepEqual(collectPseudoTypes({}), []);
  assert.deepEqual(collectPseudoTypes({ pseudoElements: [] }), []);
  assert.deepEqual(collectPseudoTypes({ pseudoElements: [{ pseudoType: '' }] }), []);
  assert.deepEqual(collectPseudoTypes({ pseudoElements: [null, 'x', 42] }), []);
});

/**
 * Embedded CSS: the `inlineStyle` (style="...") section of a matched-styles
 * response is surfaced as inline declarations with no selector.
 */

import { collectMatchedDeclarations, collectDeclaredDisplay } from '../../browser/matchedStylesCollector';

test('collectMatchedDeclarations: surfaces inline styles tagged with no selector', () => {
  const payload = {
    inlineStyle: {
      styleSheetId: '1234.0',
      range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 29 },
      cssProperties: [
        { name: 'color', value: 'red', range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 11 } },
        { name: 'margin-top', value: '5px' },
      ],
    },
    matchedCSSRules: [],
  };

  const declarations = collectMatchedDeclarations(7, payload);
  assert.equal(declarations.length, 2);
  const [color, margin] = declarations;
  assert.equal(color.isInlineStyle, true);
  assert.equal(color.selectorText, '');
  assert.equal(color.propertyName, 'color');
  assert.equal(color.propertyValue, 'red');
  assert.deepEqual(color.propertyRange, { startLine: 0, startColumn: 0, endLine: 0, endColumn: 11 });
  assert.equal(margin.isInlineStyle, true);
  assert.equal(margin.propertyRange, undefined, 'a range-less inline property stays range-less');
  assert.deepEqual(margin.ruleRange, { startLine: 0, startColumn: 0, endLine: 0, endColumn: 29 }, 'the attribute range travels as the rule range');
});

test('collectMatchedDeclarations: no inline style section produces no inline declarations', () => {
  const declarations = collectMatchedDeclarations(1, {});
  assert.equal(declarations.some((d) => d.isInlineStyle), false);
});

test('collectMatchedDeclarations: normalizes duplicated inline copies (declared + resolved)', () => {
  const payload = {
    inlineStyle: {
      styleSheetId: '5.0',
      cssProperties: [
        { name: 'color', value: 'red', range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 11 } },
        { name: 'color', value: 'red' },
      ],
    },
  };

  const normalized = normalizeAndDeduplicate(collectMatchedDeclarations(9, payload));
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].propertyName, 'color');
  assert.ok(normalized[0].propertyRange, 'the ranged representation is kept');
});

test('collectDeclaredDisplay: an inline display overrides the cascade-winning rule display', () => {
  const payload = {
    inlineStyle: {
      cssProperties: [{ name: 'display', value: 'flex' }],
    },
    matchedCSSRules: [
      {
        rule: {
          origin: 'author',
          selectorList: { text: '.x' },
          style: { cssProperties: [{ name: 'display', value: 'block' }] },
        },
      },
    ],
  };

  assert.equal(collectDeclaredDisplay(payload), 'flex');
});

test('collectDeclaredDisplay: without an inline display the rule display wins', () => {
  const payload = {
    inlineStyle: { cssProperties: [{ name: 'color', value: 'red' }] },
    matchedCSSRules: [
      {
        rule: {
          origin: 'author',
          selectorList: { text: '.x' },
          style: { cssProperties: [{ name: 'display', value: 'block' }] },
        },
      },
    ],
  };

  assert.equal(collectDeclaredDisplay(payload), 'block');
});
