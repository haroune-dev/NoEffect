import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sizingRules } from '../../inactive/rules/box/sizingRules';
import { REASON_CODES } from '../../inactive/reasonCode';
import { MatchedCssDeclaration } from '../../engine/inactivePropertyEngine';
import { LayoutContext, createLayoutContext } from '../../engine/layoutContext';

const declaration: MatchedCssDeclaration = {
  nodeId: 1,
  styleSheetId: 'sheet-1',
  selectorText: '.x',
  propertyName: '',
  propertyValue: '200px',
  origin: 'author',
};

function layout(display: string, nodeName: string): LayoutContext {
  const computedStyles = new Map([['display', display]]);
  return createLayoutContext({ display, parentDisplay: 'none', nodeName, computedStyles });
}

test('sizing rules: cover width and height', () => {
  assert.deepEqual(
    sizingRules.map((r) => r.propertyName).sort(),
    ['height', 'width']
  );
});

test('sizing rules: inactive on non-replaced inline elements', () => {
  for (const rule of sizingRules) {
    for (const nodeName of ['span', 'div', 'a', 'em', 'strong', 'p']) {
      const result = rule.inspect(layout('inline', nodeName), declaration);
      assert.ok(result, `${rule.propertyName} should be inactive on inline <${nodeName}>`);
      assert.equal(result.inactive, true);
      assert.equal(result.propertyName, rule.propertyName);
      assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_INLINE_BOX);
      assert.ok(result.reasonText.length > 0);
    }
  }
});

test('sizing rules: inactive on box-suppressed elements (display: contents)', () => {
  for (const rule of sizingRules) {
    const result = rule.inspect(layout('contents', 'div'), declaration);
    assert.ok(result, `${rule.propertyName} should be inactive on display: contents`);
    assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX);
  }
});

test('sizing rules: active on replaced inline elements', () => {
  for (const rule of sizingRules) {
    for (const nodeName of ['img', 'video', 'canvas', 'iframe', 'audio', 'embed', 'object', 'input']) {
      assert.equal(
        rule.inspect(layout('inline', nodeName), declaration),
        undefined,
        `${rule.propertyName} should be active on inline <${nodeName}>`
      );
    }
  }
});

test('sizing rules: active on non-inline elements', () => {
  for (const rule of sizingRules) {
    for (const display of ['block', 'flex', 'grid', 'inline-block', 'table-cell']) {
      assert.equal(
        rule.inspect(layout(display, 'div'), declaration),
        undefined,
        `${rule.propertyName} should be active on display=${display}`
      );
    }
  }
});

test('sizing rules: no decision when display or node name is missing', () => {
  for (const rule of sizingRules) {
    assert.equal(rule.inspect(layout('', 'div'), declaration), undefined);
    assert.equal(rule.inspect(layout('inline', ''), declaration), undefined);
  }
});

test('sizing rules: node names are case-safe (context normalizes)', () => {
  for (const rule of sizingRules) {
    assert.equal(
      rule.inspect(
        createLayoutContext({
          display: 'inline',
          parentDisplay: 'none',
          nodeName: 'IMG',
          computedStyles: new Map([['display', 'inline']]),
        }),
        declaration
      ),
      undefined
    );
    const spanUpper = rule.inspect(layout('inline', 'SPAN'), declaration);
    assert.ok(spanUpper);
    assert.equal(spanUpper.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_INLINE_BOX);
  }
});
