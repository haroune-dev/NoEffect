import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeSelfRule } from '../../inactive/rules/flex/placeSelfRule';
import { REASON_CODES } from '../../inactive/reasonCode';
import { MatchedCssDeclaration } from '../../engine/inactivePropertyEngine';
import { LayoutContext, createLayoutContext } from '../../engine/layoutContext';

const declaration: MatchedCssDeclaration = {
  nodeId: 1,
  styleSheetId: 'sheet-1',
  selectorText: '.plain-block',
  propertyName: 'place-self',
  propertyValue: 'center',
  origin: 'author',
};

function layout(display: string, parentDisplay: string, declaredDisplay?: string): LayoutContext {
  return createLayoutContext({
    display,
    parentDisplay,
    declaredDisplay,
    computedStyles: new Map([['display', display]]),
  });
}

test('place-self: inactive on a standard display: block element (block parent)', () => {
  const result = placeSelfRule.inspect(layout('block', 'block'), declaration);
  assert.ok(result);
  assert.equal(result!.inactive, true);
  assert.equal(result!.propertyName, 'place-self');
  assert.equal(result!.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_ITEM);
  assert.ok(result!.reasonText.length > 0);
});

test('place-self: inactive on inline-block and inline boxes outside a flex/grid context', () => {
  for (const display of ['inline-block', 'inline', 'flow-root']) {
    const result = placeSelfRule.inspect(layout(display, 'block'), declaration);
    assert.ok(result, `expected inactive for display: ${display}`);
    assert.equal(result!.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_ITEM);
  }
});

test('place-self: active on flex and grid items', () => {
  assert.equal(placeSelfRule.inspect(layout('block', 'flex'), declaration), undefined);
  assert.equal(placeSelfRule.inspect(layout('block', 'inline-flex'), declaration), undefined);
  assert.equal(placeSelfRule.inspect(layout('block', 'grid'), declaration), undefined);
  assert.equal(placeSelfRule.inspect(layout('block', 'inline-grid'), declaration), undefined);
});

test('place-self: no decision when the parent is unknown (none)', () => {
  assert.equal(placeSelfRule.inspect(layout('block', 'none'), declaration), undefined);
  assert.equal(placeSelfRule.inspect(layout('block', ''), declaration), undefined);
});

test('place-self: no decision when display data is missing', () => {
  const ctx = createLayoutContext({
    display: '',
    parentDisplay: 'block',
    computedStyles: new Map([['display', '']]),
  });
  assert.equal(placeSelfRule.inspect(ctx, declaration), undefined);
});

test('place-self: inactive when an explicit display: block override drops the item context', () => {
  const result = placeSelfRule.inspect(layout('block', 'flex', 'block'), declaration);
  assert.ok(result);
  assert.equal(result!.inactive, true);
  assert.equal(result!.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_ITEM);
});

test('place-self: active when the flex-item parent has no display override', () => {
  assert.equal(placeSelfRule.inspect(layout('block', 'flex'), declaration), undefined);
  assert.equal(
    placeSelfRule.inspect(layout('block', 'flex', 'flex'), declaration),
    undefined,
    'declaring the real display keeps the placement context'
  );
});

test('place-self: still inactive on a grid item whose display is overridden to block', () => {
  const result = placeSelfRule.inspect(layout('block', 'grid', 'block'), declaration);
  assert.ok(result);
  assert.equal(result!.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_ITEM);
});

test('place-self: explicit display: block override dims even with an unknown parent (Level 5)', () => {
  // Level-5 regression: the standalone CSS-file flow reports no parent, but
  // `display: block` + `place-self` (.place-item.bad) must still flag.
  for (const parentDisplay of ['none', '']) {
    const result = placeSelfRule.inspect(layout('block', parentDisplay, 'block'), declaration);
    assert.ok(result, `expected inactive with parent=${JSON.stringify(parentDisplay)}`);
    assert.equal(result!.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_ITEM);
  }
  assert.equal(placeSelfRule.inspect(layout('block', 'none'), declaration), undefined);
});
