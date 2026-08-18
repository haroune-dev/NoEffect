import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overflowRule, overflowXRule, overflowYRule } from '../../inactive/rules/overflow/overflow';
import { REASON_CODES } from '../../inactive/reasonCode';
import { MatchedCssDeclaration } from '../../engine/inactivePropertyEngine';
import { LayoutContext, createLayoutContext } from '../../engine/layoutContext';

const declaration: MatchedCssDeclaration = {
  nodeId: 1,
  styleSheetId: 'sheet-1',
  selectorText: '.x',
  propertyName: '',
  propertyValue: 'hidden',
  origin: 'author',
};

const overflowRules = [overflowRule, overflowXRule, overflowYRule];

function layout(display: string): LayoutContext {
  const computedStyles = new Map<string, string>([['display', display]]);
  return createLayoutContext({ display, parentDisplay: 'none', computedStyles });
}

test('overflow family: inactive only on box-suppressed elements', () => {
  for (const rule of overflowRules) {
    const result = rule.inspect(layout('contents'), declaration);
    assert.ok(result, `${rule.propertyName} should be flagged on display: contents`);
    assert.equal(result.inactive, true);
    assert.equal(result.propertyName, rule.propertyName);
    assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX);
    assert.ok(result.reasonText.length > 0);
  }
});

test('overflow family: active everywhere else (conservative)', () => {
  for (const rule of overflowRules) {
    for (const display of ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'table-cell']) {
      assert.equal(
        rule.inspect(layout(display), declaration),
        undefined,
        `${rule.propertyName} should stay active on display: ${display}`
      );
    }
  }
});

test('overflow family: no decision when display data is missing', () => {
  for (const rule of overflowRules) {
    assert.equal(rule.inspect(layout(''), declaration), undefined);
  }
});

test('overflow family: malformed values never crash', () => {
  for (const rule of overflowRules) {
    const weird = { ...declaration, propertyValue: 'hidden auto scroll' };
    assert.ok(rule.inspect(layout('contents'), weird));
    assert.equal(rule.inspect(layout('block'), weird), undefined);
  }
});
