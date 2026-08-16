import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionAnchorRule } from '../../inactive/rules/position/positionAnchorRules';
import { REASON_CODES } from '../../inactive/reasonCode';
import { MatchedCssDeclaration } from '../../engine/inactivePropertyEngine';
import { LayoutContext, createLayoutContext } from '../../engine/layoutContext';

const declaration: MatchedCssDeclaration = {
  nodeId: 1,
  styleSheetId: 'sheet-1',
  selectorText: '.x',
  propertyName: 'position-anchor',
  propertyValue: 'auto',
  origin: 'author',
};

function layout(position: string, display = 'block'): LayoutContext {
  const computedStyles = new Map([['display', display], ['position', position]]);
  return createLayoutContext({ display, parentDisplay: 'none', position, computedStyles });
}

test('position-anchor: requires absolute or fixed positioning', () => {
  for (const position of ['static', 'relative', 'sticky']) {
    const result = positionAnchorRule.inspect(layout(position), declaration);
    assert.ok(result, `expected inactive for position=${position}`);
    assert.equal(result.inactive, true);
    assert.equal(result.propertyName, 'position-anchor');
    assert.equal(result.reasonCode, REASON_CODES.REQUIRES_ABSOLUTE_OR_FIXED_POSITION);
    assert.ok(result.reasonText.length > 0);
  }
});

test('position-anchor: active on absolute and fixed elements', () => {
  assert.equal(positionAnchorRule.inspect(layout('absolute'), declaration), undefined);
  assert.equal(positionAnchorRule.inspect(layout('fixed'), declaration), undefined);
});

test('position-anchor: inactive on hidden elements (display: none)', () => {
  const result = positionAnchorRule.inspect(layout('absolute', 'none'), declaration);
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX);
});

test('position-anchor: no decision when data is missing', () => {
  const missingPosition = createLayoutContext({
    display: 'block',
    parentDisplay: 'none',
    computedStyles: new Map([['display', 'block']]),
  });
  assert.equal(positionAnchorRule.inspect(missingPosition, declaration), undefined);

  const missingDisplay = createLayoutContext({
    display: '',
    parentDisplay: 'none',
    position: 'static',
    computedStyles: new Map([['position', 'static']]),
  });
  assert.equal(positionAnchorRule.inspect(missingDisplay, declaration), undefined);
});

test('position-anchor: normalization is handled by the context', () => {
  const result = positionAnchorRule.inspect(layout('STATIC'), declaration);
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.REQUIRES_ABSOLUTE_OR_FIXED_POSITION);
});
