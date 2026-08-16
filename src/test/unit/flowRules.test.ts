import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floatRule } from '../../inactive/rules/flow/float';
import { clearRule } from '../../inactive/rules/flow/clear';
import { REASON_CODES } from '../../inactive/reasonCode';
import { MatchedCssDeclaration } from '../../engine/inactivePropertyEngine';
import { LayoutContext, createLayoutContext } from '../../engine/layoutContext';

const declaration: MatchedCssDeclaration = {
  nodeId: 1,
  styleSheetId: 'sheet-1',
  selectorText: '.x',
  propertyName: '',
  propertyValue: 'left',
  origin: 'author',
};

function layout(
  display: string,
  position: string,
  parentDisplay = 'none',
  floatValue?: string
): LayoutContext {
  const computedStyles = new Map<string, string>([
    ['display', display],
    ['position', position],
  ]);
  if (floatValue !== undefined) {
    computedStyles.set('float', floatValue);
  }
  return createLayoutContext({ display, position, parentDisplay, computedStyles });
}

test('float: inactive on flex and grid items', () => {
  for (const parent of ['flex', 'inline-flex', 'grid', 'inline-grid']) {
    const result = floatRule.inspect(layout('block', 'static', parent), declaration);
    assert.ok(result, `float should be inactive as a ${parent} item`);
    assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_FLEX_GRID_ITEM);
  }
});

test('float: inactive when absolutely/fixedly positioned', () => {
  for (const position of ['absolute', 'fixed']) {
    const result = floatRule.inspect(layout('block', position), declaration);
    assert.ok(result, `float should be inactive at position: ${position}`);
    assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX);
  }
});

test('float: abspos wins over item-ness (most specific condition first)', () => {
  // An absolutely positioned child of a flex container is NOT a flex item —
  // the reason code must stay honest.
  const result = floatRule.inspect(layout('block', 'absolute', 'flex'), declaration);
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX);
});

test('float: inactive on box-suppressed elements', () => {
  const result = floatRule.inspect(layout('contents', 'static'), declaration);
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX);
});

test('float: active in normal flow', () => {
  for (const display of ['block', 'inline', 'inline-block', 'flow-root', 'table']) {
    assert.equal(
      floatRule.inspect(layout(display, 'static'), declaration),
      undefined,
      `float should be active on display: ${display}`
    );
    assert.equal(floatRule.inspect(layout(display, 'relative'), declaration), undefined);
  }
});

test('float: no decision when display data is missing', () => {
  assert.equal(floatRule.inspect(layout('', 'static'), declaration), undefined);
});

test('float: malformed values never crash', () => {
  const weird = { ...declaration, propertyValue: 'left right center' };
  assert.ok(floatRule.inspect(layout('block', 'static', 'flex'), weird));
});

test('clear: inactive on flex and grid items', () => {
  for (const parent of ['flex', 'grid']) {
    const result = clearRule.inspect(layout('block', 'static', parent), declaration);
    assert.ok(result, `clear should be inactive as a ${parent} item`);
    assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_FLEX_GRID_ITEM);
  }
});

test('clear: inactive when absolutely/fixedly positioned', () => {
  for (const position of ['absolute', 'fixed']) {
    const result = clearRule.inspect(layout('block', position), declaration);
    assert.ok(result);
    assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX);
  }
});

test('clear: inactive on non-floated inline boxes', () => {
  const result = clearRule.inspect(layout('inline', 'static', 'block', 'none'), declaration);
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_INLINE_BOX);
});

test('clear: active on floated inline boxes (blockified)', () => {
  assert.equal(clearRule.inspect(layout('inline', 'static', 'block', 'left'), declaration), undefined);
  assert.equal(clearRule.inspect(layout('inline', 'static', 'block', 'right'), declaration), undefined);
});

test('clear: no decision for inline boxes with unknown float data', () => {
  assert.equal(clearRule.inspect(layout('inline', 'static', 'block'), declaration), undefined);
});

test('clear: active on block-level and inline-block boxes', () => {
  for (const display of ['block', 'inline-block', 'flow-root', 'table']) {
    assert.equal(
      clearRule.inspect(layout(display, 'static', 'block', 'none'), declaration),
      undefined,
      `clear should be active on display: ${display}`
    );
  }
});

test('clear: inactive on box-suppressed elements', () => {
  const result = clearRule.inspect(layout('contents', 'static'), declaration);
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX);
});

test('clear: no decision when display data is missing', () => {
  assert.equal(clearRule.inspect(layout('', 'static'), declaration), undefined);
});

test('clear: malformed values never crash', () => {
  const weird = { ...declaration, propertyValue: 'both both' };
  assert.ok(clearRule.inspect(layout('block', 'static', 'flex'), weird));
});
