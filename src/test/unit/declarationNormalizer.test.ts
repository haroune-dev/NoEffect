import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAndDeduplicate } from '../../engine/declarationNormalizer';
import { MatchedCssDeclaration } from '../../engine/inactivePropertyEngine';

const RANGE = { startLine: 2, startColumn: 2, endLine: 2, endColumn: 22 };

function decl(overrides: Partial<MatchedCssDeclaration>): MatchedCssDeclaration {
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

test('ranged + range-less equivalent declaration produces one candidate (ranged preferred)', () => {
  const result = normalizeAndDeduplicate([
    decl({ propertyRange: undefined }),
    decl({ propertyRange: RANGE }),
  ]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].propertyRange, RANGE);
});

test('two declarations in different selectors remain distinct', () => {
  const result = normalizeAndDeduplicate([
    decl({ selectorText: '.a' }),
    decl({ selectorText: '.b' }),
  ]);
  assert.equal(result.length, 2);
});

test('two declarations with different source ranges remain distinct', () => {
  const result = normalizeAndDeduplicate([
    decl({ propertyRange: { ...RANGE, startLine: 3 } }),
    decl({ propertyRange: RANGE }),
  ]);
  assert.equal(result.length, 2);
});

test('duplicate protocol representations never produce duplicate issues', () => {
  const ranged = decl({ propertyRange: RANGE });
  const result = normalizeAndDeduplicate([
    ranged,
    { ...ranged },
    decl({ propertyRange: undefined }), // range-less equivalent
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].propertyName, 'justify-content');
});

test('range-less declaration with no ranged equivalent is kept', () => {
  const result = normalizeAndDeduplicate([decl({ propertyRange: undefined })]);
  assert.equal(result.length, 1);
});

test('author origin is preferred when identical ranged keys collide', () => {
  const result = normalizeAndDeduplicate([
    decl({ origin: 'user-agent', propertyRange: RANGE }),
    decl({ origin: 'author', propertyRange: RANGE }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].origin, 'author');
});

test('duplicate range-less declarations collapse to one candidate', () => {
  const result = normalizeAndDeduplicate([
    decl({ propertyRange: undefined }),
    decl({ propertyRange: undefined }),
  ]);
  assert.equal(result.length, 1);
});

/**
 * Duplicate-declaration semantics: within ONE declaration block the last
 * declaration of a property wins, so markOverriddenDeclarations must tag
 * every earlier duplicate — and nothing else.
 */

import { markOverriddenDeclarations } from '../../engine/declarationNormalizer';

function ranged(
  name: string,
  value: string,
  blockId: string,
  line: number
): MatchedCssDeclaration {
  return decl({
    blockId,
    propertyName: name,
    propertyValue: value,
    propertyRange: { startLine: line, startColumn: 2, endLine: line, endColumn: 30 },
  });
}

test('markOverriddenDeclarations: earlier duplicates of a property are marked, the last is not', () => {
  const declarations = [
    ranged('justify-content', 'center', 'rule-0', 2),
    ranged('justify-content', 'center', 'rule-0', 3),
    ranged('justify-content', 'flex-end', 'rule-0', 4),
  ];
  markOverriddenDeclarations(declarations);

  assert.equal(declarations[0].isOverridden, true);
  assert.equal(declarations[1].isOverridden, true);
  assert.equal(declarations[2].isOverridden, undefined, 'the last duplicate keeps the effect');
});

test('markOverriddenDeclarations: overriddenBy points at the cascade winner of the block', () => {
  const declarations = [
    ranged('justify-content', 'center', 'rule-0', 2),
    ranged('justify-content', 'flex-end', 'rule-0', 3),
  ];
  markOverriddenDeclarations(declarations);

  assert.equal(declarations[0].overriddenBy, declarations[1], 'the overridden one points at the winner');
  assert.equal(declarations[1].overriddenBy, undefined, 'the winner never points anywhere');
});

test('markOverriddenDeclarations: a later cascade-order rule overrides an earlier one cross-rule', () => {
  const declarations = [
    ranged('justify-content', 'center', 'rule-0', 2),
    ranged('justify-content', 'flex-end', 'rule-1', 3),
  ];
  markOverriddenDeclarations(declarations);

  assert.equal(declarations[0].isOverridden, true, 'the earlier rule loses the cascade');
  assert.equal(declarations[0].isCrossRuleOverride, true);
  assert.equal(declarations[0].overriddenBy, declarations[1]);
  assert.equal(declarations[1].isOverridden, undefined, 'the later rule (higher cascade order) wins');
});

test('markOverriddenDeclarations: overriddenBy matches the property case-insensitively', () => {
  const declarations = [
    ranged('COLOR', 'red', 'rule-0', 2),
    ranged('color', 'blue', 'rule-0', 3),
  ];
  markOverriddenDeclarations(declarations);

  assert.equal(declarations[0].isOverridden, true);
  assert.equal(declarations[0].overriddenBy, declarations[1]);
  assert.equal(declarations[1].isOverridden, undefined);
});

test('markOverriddenDeclarations: same-block duplicates all lose to a later cross-rule winner', () => {
  const declarations = [
    ranged('justify-content', 'center', 'rule-0', 2),
    ranged('justify-content', 'center', 'rule-0', 3),
    ranged('justify-content', 'center', 'rule-1', 2),
  ];
  markOverriddenDeclarations(declarations);

  assert.equal(declarations[0].isOverridden, true);
  assert.equal(declarations[1].isOverridden, true, 'the block winner still loses the cascade');
  assert.equal(declarations[1].isCrossRuleOverride, true);
  assert.equal(declarations[1].overriddenBy, declarations[2], 'repointed at the global winner');
  assert.equal(declarations[2].isOverridden, undefined, 'a single declaration in the winning block is effective');
});

test('markOverriddenDeclarations: a single declaration per property is never marked', () => {
  const declarations = [
    ranged('justify-content', 'center', 'inline', 0),
    ranged('display', 'block', 'inline', 1),
  ];
  markOverriddenDeclarations(declarations);
  assert.deepEqual(
    declarations.map((d) => d.isOverridden),
    [undefined, undefined]
  );
});

test('markOverriddenDeclarations: inline duplicates on one line rank by source position', () => {
  const declarations = [
    ranged('justify-content', 'center', 'inline', 0),
    ranged('justify-content', 'center', 'inline', 1),
  ];
  markOverriddenDeclarations(declarations);
  assert.equal(declarations[0].isOverridden, true);
  assert.equal(declarations[1].isOverridden, undefined);
});

// ── Cross-rule cascade resolution ──
//
// CDP lists matched rules in cascade order (least → most priorous), the
// collector mirrors that order in `rule-<N>`, and the cross-rule pass
// competes the per-block winners per (pseudo scope, property).

test('cross-rule: base-class declaration loses to the compound-class rule (action-button case)', () => {
  const declarations = [
    decl({
      selectorText: '.action-button',
      blockId: 'rule-0',
      propertyName: 'color',
      propertyValue: '#ffffff',
      propertyRange: { startLine: 10, startColumn: 4, endLine: 10, endColumn: 20 },
    }),
    decl({
      selectorText: '.action-button.is-danger',
      blockId: 'rule-1',
      propertyName: 'color',
      propertyValue: '#ff4d4f',
      propertyRange: { startLine: 20, startColumn: 4, endLine: 20, endColumn: 20 },
    }),
  ];
  markOverriddenDeclarations(declarations);

  assert.equal(declarations[0].isOverridden, true, 'lower cascade order loses');
  assert.equal(declarations[0].isCrossRuleOverride, true);
  assert.equal(declarations[0].overriddenBy, declarations[1]);
  assert.equal(declarations[1].isOverridden, undefined);
  assert.equal(declarations[1].isCrossRuleOverride, undefined);
});

test('cross-rule: distinct properties in different blocks never interact', () => {
  const declarations = [
    ranged('justify-content', 'center', 'rule-0', 2),
    ranged('align-items', 'center', 'rule-1', 3),
  ];
  markOverriddenDeclarations(declarations);

  assert.equal(declarations[0].isOverridden, undefined);
  assert.equal(declarations[1].isOverridden, undefined);
});

test('cross-rule: the inline style attribute beats every normal rule', () => {
  const declarations = [
    ranged('color', 'white', 'rule-0', 2),
    ranged('color', 'red', 'inline', 3),
  ];
  markOverriddenDeclarations(declarations);

  assert.equal(declarations[0].isOverridden, true);
  assert.equal(declarations[0].overriddenBy, declarations[1]);
  assert.equal(declarations[1].isOverridden, undefined);
});

test('cross-rule: an !important rule beats the inline attribute and other rules', () => {
  const declarations = [
    ranged('color', 'white', 'rule-0', 2),
    ranged('color', 'red', 'rule-1', 3),
    { ...ranged('color', 'blue', 'inline', 4) },
  ];
  declarations[2].isInlineStyle = true;
  declarations[1].important = true;
  markOverriddenDeclarations(declarations);

  assert.equal(declarations[0].isOverridden, true);
  assert.equal(declarations[1].isOverridden, undefined, '!important rule wins the cascade');
  assert.equal(declarations[2].isOverridden, true, 'inline normal loses to !important');
  assert.equal(declarations[2].overriddenBy, declarations[1]);
});

test('cross-rule: user-agent rules never override authored declarations', () => {
  const declarations = [
    ranged('display', 'grid', 'rule-0', 2),
    { ...ranged('display', 'block', 'rule-1', 3), origin: 'user-agent' },
  ];
  markOverriddenDeclarations(declarations);

  assert.equal(declarations[0].isOverridden, undefined, 'a UA rule cannot beat an author rule');
  assert.equal(declarations[1].isOverridden, undefined, 'the UA declaration is not reported dead either');
});

test('cross-rule: pseudo-element declarations compete in their own scope only', () => {
  const declarations = [
    ranged('color', 'white', 'rule-0', 2),
    { ...ranged('color', 'black', 'rule-1', 3), pseudoElement: 'before' },
  ];
  markOverriddenDeclarations(declarations);

  assert.equal(declarations[0].isOverridden, undefined, "the element's rule is unaffected by ::before");
  assert.equal(declarations[1].isOverridden, undefined);
});
