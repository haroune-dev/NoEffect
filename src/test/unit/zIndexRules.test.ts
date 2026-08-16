import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zIndexRule } from '../../inactive/rules/position/zIndex';
import { REASON_CODES } from '../../inactive/reasonCode';
import { MatchedCssDeclaration } from '../../engine/inactivePropertyEngine';
import { LayoutContext, createLayoutContext } from '../../engine/layoutContext';

const declaration: MatchedCssDeclaration = {
  nodeId: 1,
  styleSheetId: 'sheet-1',
  selectorText: '.x',
  propertyName: '',
  propertyValue: '5',
  origin: 'author',
};

function layout(
  display: string,
  position: string,
  parentDisplay = 'none',
  parentIsSynthetic = false
): LayoutContext {
  const computedStyles = new Map<string, string>([
    ['display', display],
    ['position', position],
  ]);
  return createLayoutContext({ display, position, parentDisplay, parentIsSynthetic, computedStyles });
}

test('inactive when static, not an item, with a known parent', () => {
  const result = zIndexRule.inspect(layout('block', 'static', 'block'), declaration);
  assert.ok(result);
  assert.equal(result.inactive, true);
  assert.equal(result.propertyName, 'z-index');
  assert.equal(result.reasonCode, REASON_CODES.REQUIRES_POSITIONED_OR_FLEX_GRID_ITEM);
  assert.ok(result.reasonText.length > 0);

  // Inline static elements too.
  assert.ok(zIndexRule.inspect(layout('inline', 'static', 'block'), declaration));
});

test('active when positioned', () => {
  for (const position of ['relative', 'absolute', 'fixed', 'sticky']) {
    assert.equal(zIndexRule.inspect(layout('block', position, 'block'), declaration), undefined);
  }
});

test('active on flex/grid items even when static', () => {
  assert.equal(zIndexRule.inspect(layout('block', 'static', 'flex'), declaration), undefined);
  assert.equal(zIndexRule.inspect(layout('block', 'static', 'grid'), declaration), undefined);
});

test('no decision when the parent is unknown (none — may be the root)', () => {
  assert.equal(zIndexRule.inspect(layout('block', 'static', 'none'), declaration), undefined);
  assert.equal(zIndexRule.inspect(layout('block', 'static', ''), declaration), undefined);
});

test('synthetic wrapper parent: static z-index IS inactive (Level 5 regression)', () => {
  // The standalone CSS-file flow reports parent 'none' for a fabricated
  // wrapper parent. The wrapper provably places the element on a real
  // (non-root) node, so the root ambiguity does not exist — a static,
  // non-item element's z-index has no effect and must be dimmed.
  // (.static-box in the fixture.)
  const result = zIndexRule.inspect(layout('block', 'static', 'none', true), declaration);
  assert.ok(result, 'a synthetic-parent static element must be flagged');
  assert.equal(result.inactive, true);
  assert.equal(result.propertyName, 'z-index');
  assert.equal(result.reasonCode, REASON_CODES.REQUIRES_POSITIONED_OR_FLEX_GRID_ITEM);
  assert.ok(result.reasonText.length > 0);

  assert.ok(zIndexRule.inspect(layout('block', 'static', '', true), declaration));
});

test('synthetic wrapper parent: positioned or item z-index stays active', () => {
  for (const position of ['relative', 'absolute', 'fixed', 'sticky']) {
    assert.equal(zIndexRule.inspect(layout('block', position, 'none', true), declaration), undefined);
  }
});

test('no decision when position data is missing', () => {
  assert.equal(zIndexRule.inspect(layout('block', '', 'block'), declaration), undefined);
});

test('no decision when display data is missing', () => {
  assert.equal(zIndexRule.inspect(layout('', 'static', 'block'), declaration), undefined);
});

test('box suppressed (display: contents) uses the box-suppressed code', () => {
  const result = zIndexRule.inspect(layout('contents', 'static', 'block'), declaration);
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX);
});

test('normalization is handled by the context', () => {
  const upperStatic = zIndexRule.inspect(layout('block', 'STATIC', 'block'), declaration);
  assert.ok(upperStatic);
  assert.equal(upperStatic.reasonCode, REASON_CODES.REQUIRES_POSITIONED_OR_FLEX_GRID_ITEM);
  assert.equal(zIndexRule.inspect(layout('block', 'Relative', 'block'), declaration), undefined);
});

test('malformed values never crash', () => {
  const weird = { ...declaration, propertyValue: 'not-a-number !!!' };
  const result = zIndexRule.inspect(layout('block', 'static', 'block'), weird);
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.REQUIRES_POSITIONED_OR_FLEX_GRID_ITEM);
});
