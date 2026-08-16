import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flexItemRules } from '../../inactive/rules/flex/flexItemRules';
import { gridItemRules } from '../../inactive/rules/grid/gridItemRules';
import { REASON_CODES } from '../../inactive/reasonCode';
import { MatchedCssDeclaration } from '../../engine/inactivePropertyEngine';
import { LayoutContext, createLayoutContext } from '../../engine/layoutContext';

const declaration: MatchedCssDeclaration = {
  nodeId: 1,
  styleSheetId: 'sheet-1',
  selectorText: '.abs',
  propertyName: '',
  propertyValue: '1',
  origin: 'author',
};

function layout(
  display: string,
  parentDisplay: string,
  position?: string,
  extraStyles: Array<[string, string]> = []
): LayoutContext {
  const computedStyles = new Map<string, string>([['display', display], ...extraStyles]);
  if (position) {
    computedStyles.set('position', position);
  }
  return createLayoutContext({ display, parentDisplay, position, computedStyles });
}

const FLEX_ONLY = flexItemRules.filter((r) =>
  ['flex-grow', 'flex-shrink', 'flex-basis', 'flex'].includes(r.propertyName)
);
const FLEX_OR_GRID = flexItemRules.filter((r) => ['align-self', 'order'].includes(r.propertyName));
const GRID_RULES = gridItemRules;

test('flex item rules: cover the exact flex item property list', () => {
  assert.deepEqual(
    [...flexItemRules.map((r) => r.propertyName)].sort(),
    ['align-self', 'flex', 'flex-basis', 'flex-grow', 'flex-shrink', 'order']
  );
});

test('out-of-flow flex items: flex-only properties are inactive with position: absolute', () => {
  for (const rule of FLEX_ONLY) {
    const result = rule.inspect(layout('block', 'flex', 'absolute'), declaration);
    assert.ok(result, `${rule.propertyName} should be inactive on an out-of-flow flex child`);
    assert.equal(
      result.reasonCode,
      REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX,
      `${rule.propertyName} must use the out-of-flow reason code`
    );
  }
});

test('out-of-flow flex items: align-self/order are inactive with position: absolute', () => {
  for (const rule of FLEX_OR_GRID) {
    const result = rule.inspect(layout('block', 'flex', 'absolute'), declaration);
    assert.ok(result, `${rule.propertyName} should be inactive on an out-of-flow flex child`);
    assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX);
  }
});

test('out-of-flow grid items: every grid item property is inactive with position: fixed', () => {
  for (const rule of GRID_RULES) {
    const result = rule.inspect(layout('block', 'grid', 'fixed'), declaration);
    assert.ok(result, `${rule.propertyName} should be inactive on an out-of-flow grid child`);
    assert.equal(
      result.reasonCode,
      REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX,
      `${rule.propertyName} must use the out-of-flow reason code`
    );
  }
});

test('out-of-flow item rules: in-flow flex/grid items stay active', () => {
  for (const rule of FLEX_ONLY) {
    assert.equal(rule.inspect(layout('block', 'flex'), declaration), undefined);
    assert.equal(rule.inspect(layout('block', 'inline-flex'), declaration), undefined);
  }
  for (const rule of FLEX_OR_GRID) {
    assert.equal(rule.inspect(layout('block', 'flex'), declaration), undefined);
    assert.equal(rule.inspect(layout('block', 'grid'), declaration), undefined);
  }
  for (const rule of GRID_RULES) {
    assert.equal(rule.inspect(layout('block', 'grid'), declaration), undefined);
    assert.equal(rule.inspect(layout('block', 'inline-grid'), declaration), undefined);
  }
});

test('out-of-flow item rules: out-of-flow wins over any known parent display', () => {
  for (const rule of FLEX_ONLY) {
    const result = rule.inspect(layout('block', 'block', 'absolute'), declaration);
    assert.ok(result);
    assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX);
  }
  for (const rule of FLEX_OR_GRID) {
    const result = rule.inspect(layout('block', 'block', 'absolute'), declaration);
    assert.ok(result);
    assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX);
  }
  for (const rule of GRID_RULES) {
    const result = rule.inspect(layout('block', 'block', 'fixed'), declaration);
    assert.ok(result);
    assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX);
  }
});

test('out-of-flow item rules: out-of-flow is flagged even with an unknown parent (none)', () => {
  // Level-5 regression: the standalone CSS-file flow reports no parent, but
  // `flex-basis` on a `position: absolute` rule must still be dimmed — an
  // out-of-flow box is never a flex/grid item regardless of its parent.
  for (const rule of [...FLEX_ONLY, ...FLEX_OR_GRID, ...GRID_RULES]) {
    assert.equal(
      rule.inspect(layout('block', 'none', 'absolute'), declaration)?.reasonCode,
      REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX,
      `${rule.propertyName} must flag out-of-flow even when the parent is unknown`
    );
    assert.equal(
      rule.inspect(layout('block', '', 'fixed'), declaration)?.reasonCode,
      REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX,
      `${rule.propertyName} must flag out-of-flow even when the parent is unknown`
    );
  }
});

test('out-of-flow item rules: in-flow keeps the parent-unknown guard (no decision)', () => {
  for (const rule of [...FLEX_ONLY, ...FLEX_OR_GRID, ...GRID_RULES]) {
    assert.equal(rule.inspect(layout('block', 'none'), declaration), undefined);
    assert.equal(rule.inspect(layout('block', ''), declaration), undefined);
  }
});

test('grid item rules: cover the Level-2 line-placement longhands', () => {
  assert.deepEqual(
    gridItemRules.map((r) => r.propertyName).sort(),
    [
      'grid-area',
      'grid-column',
      'grid-column-end',
      'grid-column-start',
      'grid-row',
      'grid-row-end',
      'grid-row-start',
      'justify-self',
    ]
  );
});

test('grid item rules: grid-lanes parents count as grid containers for the line-placement family', () => {
  const lanesAware = GRID_RULES.filter((r) => r.propertyName !== 'justify-self');
  const justifySelf = GRID_RULES.find((r) => r.propertyName === 'justify-self');
  assert.ok(justifySelf);

  for (const rule of lanesAware) {
    assert.equal(rule.inspect(layout('block', 'grid-lanes'), declaration), undefined);
    assert.equal(rule.inspect(layout('block', 'inline-grid-lanes'), declaration), undefined);
  }
  assert.ok(justifySelf.inspect(layout('block', 'grid-lanes'), declaration));
});
