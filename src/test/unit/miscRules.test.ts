import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointerEventsRule } from '../../inactive/rules/misc/pointerEvents';
import { verticalAlignRule } from '../../inactive/rules/misc/verticalAlign';
import { objectFitRules } from '../../inactive/rules/misc/objectFit';
import { REASON_CODES } from '../../inactive/reasonCode';
import { MatchedCssDeclaration } from '../../engine/inactivePropertyEngine';
import { LayoutContext, createLayoutContext } from '../../engine/layoutContext';

const declaration: MatchedCssDeclaration = {
  nodeId: 1,
  styleSheetId: 'sheet-1',
  selectorText: '.x',
  propertyName: '',
  propertyValue: 'none',
  origin: 'author',
};

function layout(display: string, nodeName = 'div'): LayoutContext {
  const computedStyles = new Map<string, string>([['display', display]]);
  return createLayoutContext({ display, parentDisplay: 'none', nodeName, computedStyles });
}

function layoutWithTableContext(
  display: string,
  hasTableBoxAncestor: boolean | undefined
): LayoutContext {
  const computedStyles = new Map<string, string>([['display', display]]);
  return createLayoutContext({
    display,
    parentDisplay: 'none',
    nodeName: 'div',
    computedStyles,
    hasTableBoxAncestor,
  });
}

test('pointer-events: inactive only on box-suppressed elements', () => {
  const result = pointerEventsRule.inspect(layout('contents'), declaration);
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX);

  for (const display of ['block', 'inline', 'inline-block', 'flex', 'grid']) {
    assert.equal(
      pointerEventsRule.inspect(layout(display), declaration),
      undefined,
      `pointer-events should stay active on display: ${display}`
    );
  }
  assert.equal(pointerEventsRule.inspect(layout(''), declaration), undefined);
});

test('object-fit and object-position: box-suppressed elements are inactive', () => {
  for (const rule of objectFitRules) {
    const result = rule.inspect(layout('contents'), declaration);
    assert.ok(result, `${rule.propertyName} should be flagged on display: contents`);
    assert.equal(result.inactive, true);
    assert.equal(result.propertyName, rule.propertyName);
    assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX);
  }
});

test('object-fit and object-position: active only on replaced elements', () => {
  for (const rule of objectFitRules) {
    for (const nodeName of ['img', 'video', 'canvas', 'iframe', 'audio', 'embed', 'object', 'input']) {
      assert.equal(
        rule.inspect(layout('block', nodeName), declaration),
        undefined,
        `${rule.propertyName} should be active on <${nodeName}>`
      );
    }
  }
});

test('object-fit and object-position: inactive on non-replaced elements', () => {
  for (const rule of objectFitRules) {
    for (const nodeName of ['div', 'span', 'p', 'a', 'section']) {
      const result = rule.inspect(layout('block', nodeName), declaration);
      assert.ok(result, `${rule.propertyName} should be inactive on <${nodeName}>`);
      assert.equal(result.reasonCode, REASON_CODES.REQUIRES_REPLACED_ELEMENT);
      assert.ok(result.reasonText.length > 0);
    }
  }
});

test('object-fit and object-position: no decision when node name is missing', () => {
  for (const rule of objectFitRules) {
    assert.equal(rule.inspect(layout('block', ''), declaration), undefined);
    assert.equal(rule.inspect(layout('', 'div'), declaration), undefined);
  }
});

test('object-fit and object-position: node names are case-safe', () => {
  for (const rule of objectFitRules) {
    assert.equal(rule.inspect(layout('block', 'IMG'), declaration), undefined);
    const divUpper = rule.inspect(layout('block', 'DIV'), declaration);
    assert.ok(divUpper);
    assert.equal(divUpper.reasonCode, REASON_CODES.REQUIRES_REPLACED_ELEMENT);
  }
});

test('vertical-align: active on inline-level boxes and table cells', () => {
  for (const display of ['inline', 'inline-block', 'inline-flex', 'inline-grid', 'inline-table', 'table-cell', 'ruby']) {
    assert.equal(
      verticalAlignRule.inspect(layout(display), declaration),
      undefined,
      `vertical-align should be active on display: ${display}`
    );
  }
});

test('vertical-align: inactive on block-level boxes', () => {
  for (const display of ['block', 'flex', 'grid', 'flow-root', 'table', 'table-row', 'table-row-group', 'table-column', 'table-caption', 'list-item']) {
    const result = verticalAlignRule.inspect(layout(display), declaration);
    assert.ok(result, `vertical-align should be inactive on display: ${display}`);
    assert.equal(result.reasonCode, REASON_CODES.REQUIRES_INLINE_LEVEL_OR_TABLE_CELL);
  }
});

test('vertical-align: box suppressed uses the box-suppressed code', () => {
  const result = verticalAlignRule.inspect(layout('contents'), declaration);
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX);
});

test('vertical-align: no decision when display data is missing', () => {
  assert.equal(verticalAlignRule.inspect(layout(''), declaration), undefined);
});

test('vertical-align: normalization is handled by the context', () => {
  assert.equal(verticalAlignRule.inspect(layout(' INLINE '), declaration), undefined);
  const blockUpper = verticalAlignRule.inspect(layout('BLOCK'), declaration);
  assert.ok(blockUpper);
  assert.equal(blockUpper.reasonCode, REASON_CODES.REQUIRES_INLINE_LEVEL_OR_TABLE_CELL);
});

test('vertical-align: table cell with an intact table box ancestor stays active', () => {
  const result = verticalAlignRule.inspect(layoutWithTableContext('table-cell', true), declaration);
  assert.equal(result, undefined, 'a real table formatting context keeps vertical-align active');
});

test('vertical-align: table cell with a broken table context is inactive', () => {
  const result = verticalAlignRule.inspect(layoutWithTableContext('table-cell', false), declaration);
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.BROKEN_TABLE_CONTEXT);
  assert.ok(result.reasonText.length > 0);
});

test('vertical-align: table cell with an unresolved ancestor chain yields no decision', () => {
  assert.equal(
    verticalAlignRule.inspect(layoutWithTableContext('table-cell', undefined), declaration),
    undefined,
    'an un-judgeable chain must never produce a flag'
  );
});

test('vertical-align: inline boxes ignore the table context entirely', () => {
  assert.equal(
    verticalAlignRule.inspect(layoutWithTableContext('inline-block', false), declaration),
    undefined,
    'the table-context check applies to table cells only'
  );
});

test('misc rules: malformed values never crash', () => {
  const weird = { ...declaration, propertyValue: '!!broken value!!' };
  assert.ok(pointerEventsRule.inspect(layout('contents'), weird));
  assert.ok(objectFitRules[0].inspect(layout('contents'), weird));
  assert.ok(objectFitRules[1].inspect(layout('block'), weird));
  assert.ok(verticalAlignRule.inspect(layout('block'), weird));
  assert.equal(verticalAlignRule.inspect(layout('inline'), weird), undefined);
});
