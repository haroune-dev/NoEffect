import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridContainerRules } from '../../inactive/rules/grid/gridContainerRules';
import { gridTemplateRules } from '../../inactive/rules/grid/gridTemplateRules';
import { REASON_CODES } from '../../inactive/reasonCode';
import { MatchedCssDeclaration } from '../../engine/inactivePropertyEngine';
import { LayoutContext, createLayoutContext } from '../../engine/layoutContext';

const declaration: MatchedCssDeclaration = {
  nodeId: 1,
  styleSheetId: 'sheet-1',
  selectorText: '.x',
  propertyName: '',
  propertyValue: 'center',
  origin: 'author',
};

function layout(display: string, extraStyles: Array<[string, string]> = []): LayoutContext {
  const computedStyles = new Map([['display', display], ...extraStyles]);
  return createLayoutContext({ display, parentDisplay: 'none', computedStyles });
}

test('justify-items is grid-container-only', () => {
  const rule = gridContainerRules.find((r) => r.propertyName === 'justify-items');
  assert.ok(rule);

  // Active only on grid containers.
  assert.equal(rule.inspect(layout('grid'), declaration), undefined);
  assert.equal(rule.inspect(layout('inline-grid'), declaration), undefined);

  // A flex container is NOT enough — justify-items is grid-only.
  const asFlex = rule.inspect(layout('flex'), declaration);
  assert.ok(asFlex, 'justify-items should be inactive on a flex container');
  assert.equal(asFlex.reasonCode, REASON_CODES.REQUIRES_GRID_CONTAINER);

  const asBlock = rule.inspect(layout('block'), declaration);
  assert.ok(asBlock);
  assert.equal(asBlock.reasonCode, REASON_CODES.REQUIRES_GRID_CONTAINER);

  // Missing display data → no decision.
  assert.equal(rule.inspect(layout(''), declaration), undefined);
});

test('gap family: covers the six gap/grid-gap properties', () => {
  const gapRules = gridContainerRules.filter((r) => r.propertyName !== 'justify-items');
  assert.deepEqual(
    gapRules.map((r) => r.propertyName).sort(),
    ['column-gap', 'gap', 'grid-column-gap', 'grid-gap', 'grid-row-gap', 'row-gap']
  );
});

test('gap family: active on flex, grid, grid-lanes and multicol containers', () => {
  const gapRules = gridContainerRules.filter((r) => r.propertyName !== 'justify-items');

  for (const rule of gapRules) {
    for (const display of ['flex', 'inline-flex', 'grid', 'inline-grid', 'grid-lanes', 'inline-grid-lanes']) {
      assert.equal(
        rule.inspect(layout(display), declaration),
        undefined,
        `${rule.propertyName} should be active on display=${display}`
      );
    }
    // A multicol container (display block + column-count) honors gap.
    assert.equal(
      rule.inspect(layout('block', [['column-count', '2']]), declaration),
      undefined,
      `${rule.propertyName} should be active on a multicol container`
    );
    assert.equal(
      rule.inspect(layout('block', [['column-width', '100px']]), declaration),
      undefined,
      `${rule.propertyName} should be active with a fixed column-width`
    );
  }
});

test('gap family: inactive on plain block boxes', () => {
  const gapRules = gridContainerRules.filter((r) => r.propertyName !== 'justify-items');

  for (const rule of gapRules) {
    const asBlock = rule.inspect(layout('block'), declaration);
    assert.ok(asBlock, `${rule.propertyName} should be inactive on display=block`);
    assert.equal(asBlock.reasonCode, REASON_CODES.REQUIRES_FLEX_GRID_OR_MULTICOL_CONTAINER);

    // Explicit auto column values are NOT a multicol container.
    const autoColumns = rule.inspect(
      layout('block', [['column-count', 'auto'], ['column-width', 'auto']]),
      declaration
    );
    assert.ok(autoColumns, 'column-count: auto + column-width: auto must still be inactive');
    assert.equal(autoColumns.reasonCode, REASON_CODES.REQUIRES_FLEX_GRID_OR_MULTICOL_CONTAINER);

    assert.equal(rule.inspect(layout(''), declaration), undefined);
  }
});

test('grid template rules: inactive unless the element is a grid container', () => {
  assert.equal(gridTemplateRules.length, 8);

  for (const rule of gridTemplateRules) {
    for (const display of ['grid', 'inline-grid', 'grid-lanes', 'inline-grid-lanes']) {
      assert.equal(
        rule.inspect(layout(display), declaration),
        undefined,
        `${rule.propertyName} should be active on display=${display}`
      );
    }

    // Flex containers are NOT grid containers for the template family.
    const asFlex = rule.inspect(layout('flex'), declaration);
    assert.ok(asFlex, `${rule.propertyName} should be inactive on a flex container`);
    assert.equal(asFlex.reasonCode, REASON_CODES.REQUIRES_GRID_CONTAINER);

    const asBlock = rule.inspect(layout('block'), declaration);
    assert.ok(asBlock);
    assert.equal(asBlock.reasonCode, REASON_CODES.REQUIRES_GRID_CONTAINER);

    assert.equal(rule.inspect(layout(''), declaration), undefined);
  }
});

test('grid container rules: display normalization is handled by the context', () => {
  for (const rule of gridContainerRules) {
    assert.equal(rule.inspect(layout(' GRID '), declaration), undefined);
    assert.ok(rule.inspect(layout('BLOCK'), declaration));
  }
  for (const rule of gridTemplateRules) {
    assert.equal(rule.inspect(layout(' GRID '), declaration), undefined);
    assert.ok(rule.inspect(layout('BLOCK'), declaration));
    // The template family is grid-only: FLEX stays inactive.
    const asFlex = rule.inspect(layout('FLEX'), declaration);
    assert.ok(asFlex, `${rule.propertyName} should be inactive on FLEX`);
    assert.equal(asFlex.reasonCode, REASON_CODES.REQUIRES_GRID_CONTAINER);
  }

  // 'FLEX' is active only for the gap family — justify-items is grid-only.
  const justifyItems = gridContainerRules.find((r) => r.propertyName === 'justify-items');
  const gapRules = gridContainerRules.filter((r) => r.propertyName !== 'justify-items');
  assert.ok(justifyItems);
  assert.ok(justifyItems.inspect(layout('FLEX'), declaration), 'justify-items is grid-only');
  for (const rule of gapRules) {
    assert.equal(rule.inspect(layout('FLEX'), declaration), undefined);
  }
});

test('grid container rules: multi-value shorthand values never crash', () => {
  const multiValue = { ...declaration, propertyValue: '10px  20%' };
  for (const rule of gridContainerRules) {
    assert.ok(rule.inspect(layout('block'), multiValue));
  }
});
