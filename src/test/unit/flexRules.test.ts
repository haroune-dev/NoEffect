import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flexContainerRules } from '../../inactive/rules/flex/flexContainerRules';
import { flexItemRules } from '../../inactive/rules/flex/flexItemRules';
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

function layout(
  display: string,
  parentDisplay = 'none',
  extraStyles: Array<[string, string]> = []
): LayoutContext {
  const computedStyles = new Map([['display', display], ...extraStyles]);
  return createLayoutContext({ display, parentDisplay, computedStyles });
}

const NON_CONTAINER_DISPLAYS = ['block', 'inline', 'inline-block', 'flow-root', 'table', 'contents', 'none'];
const CONTAINER_DISPLAYS = ['flex', 'inline-flex', 'grid', 'inline-grid'];

/** align-items / place-items — plain container-required properties. */
const sharedContainerRules = flexContainerRules.filter((r) =>
  ['align-items', 'place-items'].includes(r.propertyName)
);
/** justify-content — reference FlexGridValidator semantics. */
const justifyContentRule = flexContainerRules.find((r) => r.propertyName === 'justify-content');
/** align-content / place-content — PR6 container-required semantics, with the PR7 additive nowrap conflict. */
const alignmentContentRules = flexContainerRules.filter((r) =>
  ['align-content', 'place-content'].includes(r.propertyName)
);
assert.equal(sharedContainerRules.length, 2);
assert.ok(justifyContentRule);
assert.equal(alignmentContentRules.length, 2);

test('align-items and place-items: inactive on non-container displays', () => {
  for (const rule of sharedContainerRules) {
    for (const display of NON_CONTAINER_DISPLAYS) {
      const result = rule.inspect(layout(display), declaration);
      assert.ok(result, `${rule.propertyName} should be inactive on display=${display}`);
      assert.equal(result.inactive, true);
      assert.equal(result.propertyName, rule.propertyName);
      assert.equal(result.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);
      assert.ok(result.reasonText.length > 0);
    }
  }
});

test('align-items and place-items: active on flex and grid containers (incl. inline-*)', () => {
  for (const rule of sharedContainerRules) {
    for (const display of CONTAINER_DISPLAYS) {
      assert.equal(
        rule.inspect(layout(display), declaration),
        undefined,
        `${rule.propertyName} should be active on display=${display}`
      );
    }
  }
});

test('justify-content: inactive on non-container displays', () => {
  for (const display of NON_CONTAINER_DISPLAYS) {
    const result = justifyContentRule!.inspect(layout(display), declaration);
    assert.ok(result, `expected inactive for display=${display}`);
    assert.equal(result.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);
  }
});

test('justify-content: active on flex/grid/grid-lanes containers', () => {
  for (const display of ['flex', 'inline-flex', 'grid', 'inline-grid', 'grid-lanes', 'inline-grid-lanes']) {
    assert.equal(
      justifyContentRule!.inspect(layout(display), declaration),
      undefined,
      `expected active for display=${display}`
    );
  }
});

test('justify-content: inactive on flex and grid items (container-only property)', () => {
  for (const parent of ['flex', 'inline-flex', 'grid', 'inline-grid', 'grid-lanes']) {
    const result = justifyContentRule!.inspect(layout('block', parent), declaration);
    assert.ok(result, `expected inactive with parent=${parent}`);
    assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_FLEX_GRID_ITEM);
  }
});

test('align-content and place-content: inactive on non-flex/grid displays (PR6 semantics)', () => {
  for (const rule of alignmentContentRules) {
    for (const display of NON_CONTAINER_DISPLAYS) {
      const result = rule.inspect(layout(display), declaration);
      assert.ok(result, `${rule.propertyName} should be inactive on display=${display}`);
      assert.equal(result.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);
    }
  }
});

test('align-content: flex-wrap: nowrap prevents the effect on flex containers', () => {
  for (const rule of alignmentContentRules) {
    const nowrap = rule.inspect(
      layout('flex', 'none', [['flex-wrap', 'nowrap']]),
      declaration
    );
    assert.ok(nowrap, `${rule.propertyName} should be inactive with flex-wrap: nowrap`);
    assert.equal(nowrap.reasonCode, REASON_CODES.PREVENTED_BY_FLEX_WRAP_NOWRAP);

    // wrapping (or an unknown wrap mode) keeps it active.
    assert.equal(
      rule.inspect(layout('flex', 'none', [['flex-wrap', 'wrap']]), declaration),
      undefined
    );
    assert.equal(rule.inspect(layout('flex'), declaration), undefined);
  }
});

test('flex container rules: no decision when display data is missing', () => {
  for (const rule of flexContainerRules) {
    assert.equal(rule.inspect(layout(''), declaration), undefined);
  }
});

test('flex container rules: display normalization is handled by the context', () => {
  for (const rule of flexContainerRules) {
    assert.equal(rule.inspect(layout(' FLEX '), declaration), undefined);
    assert.equal(rule.inspect(layout('GRID'), declaration), undefined);
  }
  // BLOCK normalizes to block → the container-required properties
  // (including align-content, PR6 semantics) all flag it.
  for (const rule of flexContainerRules) {
    assert.ok(rule.inspect(layout('BLOCK'), declaration));
  }
  const blockAlignItems = sharedContainerRules[0].inspect(layout('BLOCK'), declaration);
  assert.ok(blockAlignItems);
  assert.equal(blockAlignItems.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);
  const blockJustify = justifyContentRule!.inspect(layout('BLOCK'), declaration);
  assert.ok(blockJustify);
  assert.equal(blockJustify.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);
});

test('flex container rules: multi-value shorthand values never crash', () => {
  const multiValue = { ...declaration, propertyValue: 'center  /  stretch' };
  // 'inline' is inactive for every flex-container rule (it is not a
  // flex/grid container and not a flex/grid item).
  for (const rule of flexContainerRules) {
    assert.ok(rule.inspect(layout('inline'), multiValue));
  }
});

test('flex item rules: flex-only properties are active on flex items only', () => {
  const flexOnly = flexItemRules.filter((r) =>
    ['flex-grow', 'flex-shrink', 'flex-basis', 'flex'].includes(r.propertyName)
  );
  assert.equal(flexOnly.length, 4);

  for (const rule of flexOnly) {
    // Active as a flex item.
    assert.equal(
      rule.inspect(layout('block', 'flex'), declaration),
      undefined,
      `${rule.propertyName} should be active as a flex item`
    );
    assert.equal(rule.inspect(layout('block', 'inline-flex'), declaration), undefined);

    // Inactive as a grid item (flex-only properties).
    const asGridItem = rule.inspect(layout('block', 'grid'), declaration);
    assert.ok(asGridItem, `${rule.propertyName} should be inactive as a grid item`);
    assert.equal(asGridItem.reasonCode, REASON_CODES.REQUIRES_FLEX_ITEM);

    // Inactive as a plain block child.
    const asBlockChild = rule.inspect(layout('block', 'block'), declaration);
    assert.ok(asBlockChild, `${rule.propertyName} should be inactive as a block child`);
    assert.equal(asBlockChild.reasonCode, REASON_CODES.REQUIRES_FLEX_ITEM);
  }
});

test('align-self and order: active on flex and grid items', () => {
  const shared = flexItemRules.filter((r) => ['align-self', 'order'].includes(r.propertyName));
  assert.equal(shared.length, 2);

  for (const rule of shared) {
    assert.equal(rule.inspect(layout('block', 'flex'), declaration), undefined);
    assert.equal(rule.inspect(layout('block', 'grid'), declaration), undefined);
    const asBlockChild = rule.inspect(layout('block', 'block'), declaration);
    assert.ok(asBlockChild);
    assert.equal(asBlockChild.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_ITEM);
  }
});

test('flex item rules: no decision when the parent is unknown (none)', () => {
  for (const rule of flexItemRules) {
    assert.equal(rule.inspect(layout('block', 'none'), declaration), undefined);
    assert.equal(rule.inspect(layout('block', ''), declaration), undefined);
  }
});
