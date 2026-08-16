import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineSuppressionRules } from '../../inactive/rules/box/inlineSuppressionRules';
import { REASON_CODES } from '../../inactive/reasonCode';
import { MatchedCssDeclaration } from '../../engine/inactivePropertyEngine';
import { LayoutContext, createLayoutContext } from '../../engine/layoutContext';

const declaration: MatchedCssDeclaration = {
  nodeId: 1,
  styleSheetId: 'sheet-1',
  selectorText: '.span',
  propertyName: '',
  propertyValue: '30px',
  origin: 'author',
};

function layout(display: string, nodeName: string): LayoutContext {
  return createLayoutContext({
    display,
    parentDisplay: 'none',
    nodeName,
    computedStyles: new Map([['display', display]]),
  });
}

test('inline suppression: covers the exact target property list', () => {
  assert.deepEqual(
    inlineSuppressionRules.map((r) => r.propertyName).sort(),
    ['margin-bottom', 'margin-top', 'perspective', 'transform']
  );
});

test('inline suppression: margin-top/margin-bottom/transform/perspective flagged on a non-replaced inline span', () => {
  for (const rule of inlineSuppressionRules) {
    const result = rule.inspect(layout('inline', 'span'), declaration);
    assert.ok(result, `${rule.propertyName} should be inactive on an inline <span>`);
    assert.equal(result!.inactive, true);
    assert.equal(result!.propertyName, rule.propertyName);
    assert.equal(result!.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_INLINE_BOX);
    assert.ok(result!.reasonText.length > 0);
  }
});

test('inline suppression: active on a replaced inline <img>', () => {
  for (const rule of inlineSuppressionRules) {
    assert.equal(
      rule.inspect(layout('inline', 'img'), declaration),
      undefined,
      `${rule.propertyName} should stay active on an inline replaced element`
    );
  }
});

test('inline suppression: active on block-level boxes', () => {
  for (const rule of inlineSuppressionRules) {
    assert.equal(rule.inspect(layout('block', 'div'), declaration), undefined);
    assert.equal(rule.inspect(layout('inline-block', 'div'), declaration), undefined);
    assert.equal(rule.inspect(layout('flex', 'div'), declaration), undefined);
  }
});

test('inline suppression: no decision when the node name is unknown', () => {
  const ctx = createLayoutContext({
    display: 'inline',
    parentDisplay: 'none',
    computedStyles: new Map([['display', 'inline']]),
  });
  for (const rule of inlineSuppressionRules) {
    assert.equal(rule.inspect(ctx, declaration), undefined);
  }
});

test('inline suppression: no decision when display data is missing', () => {
  const ctx = createLayoutContext({
    display: '',
    parentDisplay: 'none',
    nodeName: 'span',
    computedStyles: new Map([['display', '']]),
  });
  for (const rule of inlineSuppressionRules) {
    assert.equal(rule.inspect(ctx, declaration), undefined);
  }
});
