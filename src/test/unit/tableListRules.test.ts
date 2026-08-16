import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tableRules } from '../../inactive/rules/table/tableRules';
import { listRules } from '../../inactive/rules/flow/listRules';
import { REASON_CODES } from '../../inactive/reasonCode';
import { MatchedCssDeclaration } from '../../engine/inactivePropertyEngine';
import { LayoutContext, createLayoutContext } from '../../engine/layoutContext';

const declaration: MatchedCssDeclaration = {
  nodeId: 1,
  styleSheetId: 'sheet-1',
  selectorText: '.x',
  propertyName: '',
  propertyValue: 'auto',
  origin: 'author',
};

function layout(display: string): LayoutContext {
  const computedStyles = new Map([['display', display]]);
  return createLayoutContext({ display, parentDisplay: 'none', computedStyles });
}

const TABLE_DISPLAYS = [
  'table',
  'inline-table',
  'table-row-group',
  'table-header-group',
  'table-footer-group',
  'table-row',
  'table-column-group',
  'table-column',
  'table-cell',
  'table-caption',
];

test('table rules: cover border-spacing, empty-cells and caption-side', () => {
  assert.deepEqual(
    tableRules.map((r) => r.propertyName).sort(),
    ['border-spacing', 'caption-side', 'empty-cells']
  );
});

test('table rules: inactive on non-table elements', () => {
  for (const rule of tableRules) {
    for (const display of ['block', 'inline', 'inline-block', 'flex', 'grid', 'contents', 'none']) {
      const result = rule.inspect(layout(display), declaration);
      assert.ok(result, `${rule.propertyName} should be inactive on display: ${display}`);
      assert.equal(result.inactive, true);
      assert.equal(result.propertyName, rule.propertyName);
      assert.equal(result.reasonCode, REASON_CODES.REQUIRES_TABLE);
      assert.ok(result.reasonText.length > 0);
    }
  }
});

test('table rules: active on every table display', () => {
  for (const rule of tableRules) {
    for (const display of TABLE_DISPLAYS) {
      assert.equal(
        rule.inspect(layout(display), declaration),
        undefined,
        `${rule.propertyName} should be active on display: ${display}`
      );
    }
  }
});

test('table rules: no decision when display data is missing', () => {
  for (const rule of tableRules) {
    assert.equal(rule.inspect(layout(''), declaration), undefined);
  }
});

test('list rules: cover all three list-style properties', () => {
  assert.deepEqual(
    listRules.map((r) => r.propertyName).sort(),
    ['list-style-image', 'list-style-position', 'list-style-type']
  );
});

test('list rules: inactive on non-list items', () => {
  for (const rule of listRules) {
    for (const display of ['block', 'inline', 'flex', 'grid', 'table-cell', 'contents', 'none']) {
      const result = rule.inspect(layout(display), declaration);
      assert.ok(result, `${rule.propertyName} should be inactive on display: ${display}`);
      assert.equal(result.reasonCode, REASON_CODES.REQUIRES_LIST_ITEM);
    }
  }
});

test('list rules: active on display: list-item', () => {
  for (const rule of listRules) {
    assert.equal(rule.inspect(layout('list-item'), declaration), undefined);
  }
});

test('list rules: no decision when display data is missing', () => {
  for (const rule of listRules) {
    assert.equal(rule.inspect(layout(''), declaration), undefined);
  }
});
