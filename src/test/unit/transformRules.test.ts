import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformRules, backdropFilterRule } from '../../inactive/rules/box/transformRules';
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

function layout(display: string, transform: string | undefined, nodeName = 'div'): LayoutContext {
  const computedStyles = new Map<string, string>([['display', display]]);
  if (transform !== undefined) {
    computedStyles.set('transform', transform);
  }
  return createLayoutContext({ display, parentDisplay: 'none', nodeName, computedStyles });
}

test('transform rules: cover transform-box, transform-origin and backface-visibility', () => {
  assert.deepEqual(
    transformRules.map((r) => r.propertyName).sort(),
    ['backface-visibility', 'transform-box', 'transform-origin']
  );
});

test('transform rules: inactive when transform: none', () => {
  for (const rule of transformRules) {
    const result = rule.inspect(layout('block', 'none'), declaration);
    assert.ok(result, `${rule.propertyName} should be inactive with transform: none`);
    assert.equal(result.inactive, true);
    assert.equal(result.propertyName, rule.propertyName);
    assert.equal(result.reasonCode, REASON_CODES.REQUIRES_TRANSFORM);
    assert.ok(result.reasonText.length > 0);
  }
});

test('transform rules: active when a transform is applied', () => {
  for (const rule of transformRules) {
    for (const transform of ['translateX(10px)', 'scale(1.5)', 'rotate(45deg)']) {
      assert.equal(
        rule.inspect(layout('block', transform), declaration),
        undefined,
        `${rule.propertyName} should be active with transform: ${transform}`
      );
    }
  }
});

test('transform rules: inactive on non-transformable inline elements', () => {
  for (const rule of transformRules) {
    const result = rule.inspect(layout('inline', 'translateX(10px)'), declaration);
    assert.ok(result, `${rule.propertyName} should be inactive on a plain inline element`);
    assert.equal(result.reasonCode, REASON_CODES.REQUIRES_TRANSFORMABLE_ELEMENT);
  }
});

test('transform rules: active on replaced inline elements', () => {
  for (const rule of transformRules) {
    assert.equal(rule.inspect(layout('inline', 'rotate(10deg)', 'img'), declaration), undefined);
  }
});

test('transform rules: no decision when display is missing', () => {
  for (const rule of transformRules) {
    assert.equal(rule.inspect(layout('', 'none'), declaration), undefined);
  }
});

test('transform rules: no decision when transform is unknown', () => {
  for (const rule of transformRules) {
    assert.equal(rule.inspect(layout('block', undefined), declaration), undefined);
  }
});

test('transform rules: no decision on inline elements with unknown node name', () => {
  for (const rule of transformRules) {
    assert.equal(rule.inspect(layout('inline', 'scale(1.2)', ''), declaration), undefined);
  }
});

test('backdrop-filter: inactive only on box-suppressed elements', () => {
  const contents = backdropFilterRule.inspect(layout('contents', undefined), declaration);
  assert.ok(contents);
  assert.equal(contents.reasonCode, REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX);

  for (const display of ['block', 'inline', 'inline-block', 'flex', 'grid']) {
    assert.equal(
      backdropFilterRule.inspect(layout(display, 'none'), declaration),
      undefined,
      `backdrop-filter should stay active on display: ${display}`
    );
  }
  assert.equal(backdropFilterRule.inspect(layout('', undefined), declaration), undefined);
});

test('transform rules: malformed values never crash', () => {
  for (const rule of transformRules) {
    const weird = { ...declaration, propertyValue: '!!broken value!!' };
    assert.ok(rule.inspect(layout('block', 'none'), weird));
    assert.equal(rule.inspect(layout('block', 'rotate(10deg)'), weird), undefined);
  }
});
