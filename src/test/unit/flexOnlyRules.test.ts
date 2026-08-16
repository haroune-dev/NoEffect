import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flexOnlyContainerRules } from '../../inactive/rules/flex/flexOnlyContainerRules';
import { REASON_CODES } from '../../inactive/reasonCode';
import { MatchedCssDeclaration } from '../../engine/inactivePropertyEngine';
import { LayoutContext, createLayoutContext } from '../../engine/layoutContext';

const declaration: MatchedCssDeclaration = {
  nodeId: 1,
  styleSheetId: 'sheet-1',
  selectorText: '.x',
  propertyName: '',
  propertyValue: 'row',
  origin: 'author',
};

function layout(display: string, parentDisplay = 'none'): LayoutContext {
  const computedStyles = new Map([['display', display]]);
  return createLayoutContext({ display, parentDisplay, computedStyles });
}

test('flex-only container rules: covers flex-direction/flex-flow/flex-wrap', () => {
  assert.deepEqual(
    flexOnlyContainerRules.map((r) => r.propertyName).sort(),
    ['flex-direction', 'flex-flow', 'flex-wrap']
  );
});

test('flex-only container rules: active on flex containers only', () => {
  for (const rule of flexOnlyContainerRules) {
    assert.equal(rule.inspect(layout('flex'), declaration), undefined);
    assert.equal(rule.inspect(layout('inline-flex'), declaration), undefined);

    // Grid containers are NOT flex containers for these properties.
    const asGrid = rule.inspect(layout('grid'), declaration);
    assert.ok(asGrid, `${rule.propertyName} should be inactive on a grid container`);
    assert.equal(asGrid.reasonCode, REASON_CODES.REQUIRES_FLEX_CONTAINER);

    for (const display of ['block', 'inline', 'inline-block', 'table', 'contents', 'none']) {
      const result = rule.inspect(layout(display), declaration);
      assert.ok(result, `${rule.propertyName} should be inactive on display=${display}`);
      assert.equal(result.inactive, true);
      assert.equal(result.propertyName, rule.propertyName);
      assert.equal(result.reasonCode, REASON_CODES.REQUIRES_FLEX_CONTAINER);
      assert.ok(result.reasonText.length > 0);
    }
  }
});

test('flex-only container rules: no decision when display data is missing', () => {
  for (const rule of flexOnlyContainerRules) {
    assert.equal(rule.inspect(layout(''), declaration), undefined);
  }
});

test('flex-only container rules: display normalization is handled by the context', () => {
  for (const rule of flexOnlyContainerRules) {
    assert.equal(rule.inspect(layout(' FLEX '), declaration), undefined);
    const blockUpper = rule.inspect(layout('BLOCK'), declaration);
    assert.ok(blockUpper);
    assert.equal(blockUpper.reasonCode, REASON_CODES.REQUIRES_FLEX_CONTAINER);
  }
});

test('flex-only container rules: multi-value shorthand values never crash', () => {
  const multiValue = { ...declaration, propertyValue: 'column-reverse  wrap' };
  for (const rule of flexOnlyContainerRules) {
    assert.ok(rule.inspect(layout('block'), multiValue));
  }
});
