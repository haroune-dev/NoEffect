import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textOverflowRule } from '../../inactive/rules/overflow/textOverflow';
import { REASON_CODES } from '../../inactive/reasonCode';
import { MatchedCssDeclaration } from '../../engine/inactivePropertyEngine';
import { LayoutContext, createLayoutContext } from '../../engine/layoutContext';

const declaration: MatchedCssDeclaration = {
  nodeId: 1,
  styleSheetId: 'sheet-1',
  selectorText: '.x',
  propertyName: 'text-overflow',
  propertyValue: 'ellipsis',
  origin: 'author',
};

function layout(display: string, extraStyles: Array<[string, string]> = []): LayoutContext {
  const computedStyles = new Map([['display', display], ...extraStyles]);
  return createLayoutContext({ display, parentDisplay: 'none', computedStyles });
}

function inspect(extraStyles: Array<[string, string]> = [], value = 'ellipsis'): ReturnType<typeof textOverflowRule.inspect> {
  return textOverflowRule.inspect(layout('block', extraStyles), { ...declaration, propertyValue: value });
}

test('text-overflow: valid/active when BOTH overflow hidden AND white-space nowrap are present', () => {
  assert.equal(
    inspect([['overflow', 'hidden'], ['white-space', 'nowrap']]),
    undefined,
    'overflow: hidden + white-space: nowrap must be active'
  );
  assert.equal(
    inspect([['overflow', 'scroll'], ['white-space', 'nowrap']]),
    undefined,
    'overflow: scroll + white-space: nowrap must be active'
  );
  assert.equal(
    inspect([['overflow-x', 'hidden'], ['white-space', 'nowrap']]),
    undefined,
    'overflow-x: hidden + white-space: nowrap must be active'
  );
});

test('text-overflow: inactive when overflow is visible', () => {
  const result = inspect([['white-space', 'nowrap'], ['overflow', 'visible']]);
  assert.ok(result, 'expected inactive when overflow is visible');
  assert.equal(result!.reasonCode, REASON_CODES.REQUIRES_TRUNCATION_PRECONDITIONS);
});

test('text-overflow: inactive when overflow-x is visible', () => {
  const result = inspect([['white-space', 'nowrap'], ['overflow-x', 'visible']]);
  assert.ok(result, 'expected inactive when overflow-x is visible');
  assert.equal(result!.reasonCode, REASON_CODES.REQUIRES_TRUNCATION_PRECONDITIONS);
});

test('text-overflow: inactive when white-space allows wrapping', () => {
  for (const ws of ['normal', 'pre-wrap', 'break-spaces', 'pre-line']) {
    const result = inspect([['overflow', 'hidden'], ['white-space', ws]]);
    assert.ok(result, `expected inactive with white-space: ${ws}`);
    assert.equal(result!.reasonCode, REASON_CODES.REQUIRES_TRUNCATION_PRECONDITIONS);
  }
});

test('text-overflow: non-ellipsis values are outside the composite rule scope', () => {
  assert.equal(inspect([['overflow', 'visible']], 'clip'), undefined);
  assert.equal(inspect([['overflow', 'visible']], ' initial '), undefined);
  assert.equal(inspect([['overflow', 'visible']], 'ellipsis 5px'), undefined);
});

test('text-overflow: conservative when computed prerequisites are missing', () => {
  // No overflow/white-space data at all.
  assert.equal(inspect(), undefined);
  // Only white-space: nowrap (overflow unknown).
  assert.equal(inspect([['white-space', 'nowrap']]), undefined);
  // Only overflow: hidden (white-space unknown).
  assert.equal(inspect([['overflow', 'hidden']]), undefined);
});

test('text-overflow: no decision when display data is missing', () => {
  const ctx = layout('', [['overflow', 'visible']]);
  assert.equal(textOverflowRule.inspect(ctx, declaration), undefined);
});

test('text-overflow: white-space normalization is handled', () => {
  const result = inspect([['overflow', 'hidden'], ['white-space', ' PRE-WRAP ']]);
  assert.ok(result);
  assert.equal(result!.reasonCode, REASON_CODES.REQUIRES_TRUNCATION_PRECONDITIONS);
});

test('text-overflow: inactive when computed white-space wraps via text-wrap-mode longhand', () => {
  // Chromium reports the CSS Text 4 longhand instead of the shorthand; the
  // default white-space: normal becomes text-wrap-mode: wrap.
  const result = inspect([['overflow', 'hidden'], ['text-wrap-mode', 'wrap']]);
  assert.ok(result, 'expected inactive when text-wrap-mode: wrap');
  assert.equal(result!.reasonCode, REASON_CODES.REQUIRES_TRUNCATION_PRECONDITIONS);
});

test('text-overflow: active when both prerequisites hold via longhand', () => {
  assert.equal(
    inspect([['overflow-x', 'hidden'], ['text-wrap-mode', 'nowrap']]),
    undefined,
    'overflow hidden + text-wrap-mode: nowrap must be active'
  );
});
