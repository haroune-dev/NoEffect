import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paddingRules } from '../../inactive/rules/table/paddingRules';
import { REASON_CODES } from '../../inactive/reasonCode';
import { MatchedCssDeclaration } from '../../engine/inactivePropertyEngine';
import { LayoutContext, createLayoutContext } from '../../engine/layoutContext';

const declaration: MatchedCssDeclaration = {
  nodeId: 1,
  styleSheetId: 'sheet-1',
  selectorText: '.x',
  propertyName: '',
  propertyValue: '8px',
  origin: 'author',
};

function layout(display: string, nodeName = ''): LayoutContext {
  const computedStyles = new Map([['display', display]]);
  return createLayoutContext({ display, parentDisplay: 'none', nodeName, computedStyles });
}

const TABLE_INTERNAL_DISPLAYS = [
  'table-row-group',
  'table-header-group',
  'table-footer-group',
  'table-row',
  'table-column-group',
  'table-column',
];

test('padding rules: cover all five padding properties', () => {
  assert.deepEqual(
    paddingRules.map((r) => r.propertyName).sort(),
    ['padding', 'padding-bottom', 'padding-left', 'padding-right', 'padding-top']
  );
});

test('padding rules: inactive on every table-internal display', () => {
  for (const rule of paddingRules) {
    for (const display of TABLE_INTERNAL_DISPLAYS) {
      const result = rule.inspect(layout(display), declaration);
      assert.ok(result, `${rule.propertyName} should be inactive on display=${display}`);
      assert.equal(result.inactive, true);
      assert.equal(result.propertyName, rule.propertyName);
      assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_TABLE_INTERNAL_BOX);
      assert.ok(result.reasonText.length > 0);
    }
  }
});

test('padding rules: inactive on box-suppressed elements (display: contents)', () => {
  for (const rule of paddingRules) {
    const result = rule.inspect(layout('contents'), declaration);
    assert.ok(result, `${rule.propertyName} should be inactive on display: contents`);
    assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX);
  }
});

test('padding rules: active on non-table-internal displays', () => {
  for (const rule of paddingRules) {
    for (const display of ['block', 'inline', 'flex', 'grid', 'table', 'table-cell', 'table-caption']) {
      assert.equal(
        rule.inspect(layout(display), declaration),
        undefined,
        `${rule.propertyName} should be active on display=${display}`
      );
    }
  }
});

test('padding rules: no decision when display data is missing', () => {
  for (const rule of paddingRules) {
    assert.equal(rule.inspect(layout(''), declaration), undefined);
  }
});

test('padding rules: display normalization is handled by the context', () => {
  for (const rule of paddingRules) {
    const rowUpper = rule.inspect(layout('TABLE-ROW'), declaration);
    assert.ok(rowUpper, 'TABLE-ROW normalizes to table-row — still table-internal');
    assert.equal(rowUpper.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_TABLE_INTERNAL_BOX);
    const asBlock = rule.inspect(layout('BLOCK'), declaration);
    assert.equal(asBlock, undefined, 'BLOCK normalizes to block — padding applies');
  }
});

test('padding rules: vertical paddings suppressed on a non-replaced inline element', () => {
  for (const propertyName of ['padding-top', 'padding-bottom']) {
    const rule = paddingRules.find((r) => r.propertyName === propertyName)!;
    for (const nodeName of ['span', 'div', 'a', 'em', 'strong', 'p']) {
      const result = rule.inspect(layout('inline', nodeName), declaration);
      assert.ok(result, `${propertyName} should be inactive on an inline <${nodeName}>`);
      assert.equal(result.inactive, true);
      assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_INLINE_BOX);
      assert.ok(result.reasonText.length > 0);
    }
  }
});

test('padding rules: horizontal paddings and the shorthand stay active on inline non-replaced elements', () => {
  for (const propertyName of ['padding', 'padding-left', 'padding-right']) {
    const rule = paddingRules.find((r) => r.propertyName === propertyName)!;
    assert.equal(
      rule.inspect(layout('inline', 'span'), declaration),
      undefined,
      `${propertyName} should stay active on an inline non-replaced element`
    );
  }
});

test('padding rules: vertical paddings stay active on a replaced inline <img>', () => {
  for (const propertyName of ['padding-top', 'padding-bottom']) {
    const rule = paddingRules.find((r) => r.propertyName === propertyName)!;
    assert.equal(
      rule.inspect(layout('inline', 'img'), declaration),
      undefined,
      `${propertyName} should stay active on an inline replaced element`
    );
  }
});

test('padding rules: vertical paddings stay active on inline-block and block boxes', () => {
  for (const propertyName of ['padding-top', 'padding-bottom']) {
    const rule = paddingRules.find((r) => r.propertyName === propertyName)!;
    assert.equal(rule.inspect(layout('inline-block', 'span'), declaration), undefined);
    assert.equal(rule.inspect(layout('block', 'div'), declaration), undefined);
    assert.equal(rule.inspect(layout('flex', 'div'), declaration), undefined);
  }
});

test('padding rules: no decision on inline when the node name is unknown', () => {
  for (const propertyName of ['padding-top', 'padding-bottom']) {
    const rule = paddingRules.find((r) => r.propertyName === propertyName)!;
    assert.equal(rule.inspect(layout('inline'), declaration), undefined);
  }
});
