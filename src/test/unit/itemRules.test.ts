import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridItemRules } from '../../inactive/rules/grid/gridItemRules';
import { REASON_CODES } from '../../inactive/reasonCode';
import { MatchedCssDeclaration } from '../../engine/inactivePropertyEngine';
import { LayoutContext, createLayoutContext } from '../../engine/layoutContext';

const declaration: MatchedCssDeclaration = {
  nodeId: 1,
  styleSheetId: 'sheet-1',
  selectorText: '.x',
  propertyName: '',
  propertyValue: '1 / 3',
  origin: 'author',
};

function layout(display: string, parentDisplay: string): LayoutContext {
  const computedStyles = new Map([['display', display]]);
  return createLayoutContext({ display, parentDisplay, computedStyles });
}

test('grid item rules: active on grid items only', () => {
  assert.deepEqual(
    gridItemRules.map((r) => r.propertyName).sort(),
    [
      'grid-area',
      'grid-column',
      'grid-column-end',
      'grid-column-start',
      'grid-row',
      'grid-row-end',
      'grid-row-start',
      'justify-self',
    ]
  );

  for (const rule of gridItemRules) {
    // Active as a grid item.
    assert.equal(
      rule.inspect(layout('block', 'grid'), declaration),
      undefined,
      `${rule.propertyName} should be active as a grid item`
    );
    assert.equal(rule.inspect(layout('block', 'inline-grid'), declaration), undefined);

    // Inactive as a flex item (grid-only property).
    const asFlexItem = rule.inspect(layout('block', 'flex'), declaration);
    assert.ok(asFlexItem, `${rule.propertyName} should be inactive as a flex item`);
    assert.equal(asFlexItem.reasonCode, REASON_CODES.REQUIRES_GRID_ITEM);

    // Inactive as a plain block child.
    const asBlockChild = rule.inspect(layout('block', 'block'), declaration);
    assert.ok(asBlockChild);
    assert.equal(asBlockChild.reasonCode, REASON_CODES.REQUIRES_GRID_ITEM);

    assert.ok(rule.inspect(layout('flex', 'block'), declaration));
  }
});

test('grid item rules: grid-lanes parents count as grid containers', () => {
  // PR7: grid-column/grid-row/grid-area/grid-row-start/grid-row-end honor
  // experimental grid-lanes parents; justify-self keeps the classic set.
  const lanesAware = gridItemRules.filter((r) => r.propertyName !== 'justify-self');
  const justifySelf = gridItemRules.find((r) => r.propertyName === 'justify-self');
  assert.ok(justifySelf);

  for (const rule of lanesAware) {
    assert.equal(rule.inspect(layout('block', 'grid-lanes'), declaration), undefined);
    assert.equal(rule.inspect(layout('block', 'inline-grid-lanes'), declaration), undefined);
  }
  assert.ok(justifySelf.inspect(layout('block', 'grid-lanes'), declaration));
});

test('grid item rules: no decision when the parent is unknown (none)', () => {
  for (const rule of gridItemRules) {
    assert.equal(rule.inspect(layout('block', 'none'), declaration), undefined);
    assert.equal(rule.inspect(layout('block', ''), declaration), undefined);
  }
});

test('grid item rules: parent display normalization is handled by the context', () => {
  for (const rule of gridItemRules) {
    assert.equal(rule.inspect(layout('block', ' GRID '), declaration), undefined);
    assert.equal(rule.inspect(layout('block', 'Grid'), declaration), undefined);
    const asBlockChild = rule.inspect(layout('block', 'BLOCK'), declaration);
    assert.ok(asBlockChild);
    assert.equal(asBlockChild.reasonCode, REASON_CODES.REQUIRES_GRID_ITEM);
  }
});
