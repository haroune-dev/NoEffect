import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topRightBottomLeftRules } from '../../inactive/rules/position/topRightBottomLeft';
import { insetRule } from '../../inactive/rules/position/inset';
import { REASON_CODES } from '../../inactive/reasonCode';
import { MatchedCssDeclaration } from '../../engine/inactivePropertyEngine';
import { LayoutContext, createLayoutContext } from '../../engine/layoutContext';

const declaration: MatchedCssDeclaration = {
  nodeId: 1,
  styleSheetId: 'sheet-1',
  selectorText: '.x',
  propertyName: '',
  propertyValue: '10px',
  origin: 'author',
};

function layout(display: string, position: string, parentDisplay = 'none'): LayoutContext {
  const computedStyles = new Map<string, string>([
    ['display', display],
    ['position', position],
  ]);
  return createLayoutContext({ display, position, parentDisplay, computedStyles });
}

const offsetRules = [...topRightBottomLeftRules, insetRule];

test('offset rules: inactive when position is static', () => {
  for (const rule of offsetRules) {
    const result = rule.inspect(layout('block', 'static'), declaration);
    assert.ok(result, `${rule.propertyName} should be inactive at position: static`);
    assert.equal(result.inactive, true);
    assert.equal(result.propertyName, rule.propertyName);
    assert.equal(result.reasonCode, REASON_CODES.REQUIRES_POSITIONED_ELEMENT);
    assert.ok(result.reasonText.length > 0);
  }
});

test('offset rules: active for every positioned value', () => {
  for (const rule of offsetRules) {
    for (const position of ['relative', 'absolute', 'fixed', 'sticky']) {
      assert.equal(
        rule.inspect(layout('block', position), declaration),
        undefined,
        `${rule.propertyName} should be active at position: ${position}`
      );
    }
  }
});

test('offset rules: active on flex/grid items even when static', () => {
  for (const rule of offsetRules) {
    assert.equal(rule.inspect(layout('block', 'static', 'flex'), declaration), undefined);
    assert.equal(rule.inspect(layout('block', 'static', 'grid'), declaration), undefined);
    assert.equal(rule.inspect(layout('block', 'static', 'inline-flex'), declaration), undefined);
  }
});

test('offset rules: no decision when position data is missing', () => {
  for (const rule of offsetRules) {
    assert.equal(rule.inspect(layout('block', ''), declaration), undefined);
  }
});

test('offset rules: no decision when display data is missing', () => {
  for (const rule of offsetRules) {
    assert.equal(rule.inspect(layout('', 'static'), declaration), undefined);
  }
});

test('offset rules: box suppressed (display: contents) wins over everything', () => {
  for (const rule of offsetRules) {
    // Even a positioned contents element has no box to offset.
    for (const position of ['static', 'absolute', 'relative']) {
      const result = rule.inspect(layout('contents', position), declaration);
      assert.ok(result, `${rule.propertyName} should be flagged on display: contents (position: ${position})`);
      assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX);
    }
  }
});

test('offset rules: normalization is handled by the context', () => {
  for (const rule of offsetRules) {
    const result = rule.inspect(layout('block', ' STATIC '), declaration);
    assert.ok(result);
    assert.equal(result.reasonCode, REASON_CODES.REQUIRES_POSITIONED_ELEMENT);
    assert.equal(rule.inspect(layout('block', 'RELATIVE'), declaration), undefined);
  }
});

test('offset rules: malformed values never crash', () => {
  for (const rule of offsetRules) {
    const malformed = { ...declaration, propertyValue: '10px !important broken' };
    assert.ok(rule.inspect(layout('block', 'static'), malformed));
  }
});
