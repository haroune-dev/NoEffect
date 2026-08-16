import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxSuppressionRules } from '../../inactive/rules/box/boxSuppressionRules';
import { REASON_CODES } from '../../inactive/reasonCode';
import { MatchedCssDeclaration } from '../../engine/inactivePropertyEngine';
import { LayoutContext, createLayoutContext } from '../../engine/layoutContext';

const declaration: MatchedCssDeclaration = {
  nodeId: 1,
  styleSheetId: 'sheet-1',
  selectorText: '.x',
  propertyName: '',
  propertyValue: '1px',
  origin: 'author',
};

function layout(display: string): LayoutContext {
  const computedStyles = new Map([['display', display]]);
  return createLayoutContext({ display, parentDisplay: 'none', computedStyles });
}

test('box suppression rules: cover border, margin and background', () => {
  assert.deepEqual(
    boxSuppressionRules.map((r) => r.propertyName).sort(),
    ['background', 'border', 'margin']
  );
});

test('box suppression rules: inactive on display: contents', () => {
  for (const rule of boxSuppressionRules) {
    const result = rule.inspect(layout('contents'), declaration);
    assert.ok(result, `${rule.propertyName} should be flagged on display: contents`);
    assert.equal(result.inactive, true);
    assert.equal(result.propertyName, rule.propertyName);
    assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX);
    assert.ok(result.reasonText.length > 0);
  }
});

test('box suppression rules: active everywhere else (conservative)', () => {
  for (const rule of boxSuppressionRules) {
    for (const display of ['block', 'inline', 'inline-block', 'flex', 'grid', 'table-cell', 'none']) {
      assert.equal(
        rule.inspect(layout(display), declaration),
        undefined,
        `${rule.propertyName} should stay active on display: ${display}`
      );
    }
  }
});

test('box suppression rules: no decision when display data is missing', () => {
  for (const rule of boxSuppressionRules) {
    assert.equal(rule.inspect(layout(''), declaration), undefined);
  }
});

test('box suppression rules: malformed values never crash', () => {
  for (const rule of boxSuppressionRules) {
    const weird = { ...declaration, propertyValue: '!!broken value!!' };
    assert.ok(rule.inspect(layout('contents'), weird));
    assert.equal(rule.inspect(layout('block'), weird), undefined);
  }
});
