import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrollRules } from '../../inactive/rules/overflow/scrollRules';
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

function layout(display: string, overflow = 'visible', hasScrollSnapAncestor?: boolean): LayoutContext {
  const computedStyles = new Map<string, string>([['display', display], ['overflow', overflow]]);
  return createLayoutContext({
    display,
    parentDisplay: 'none',
    computedStyles,
    ...(hasScrollSnapAncestor === undefined ? {} : { hasScrollSnapAncestor }),
  });
}

const resizeRule = scrollRules.find((r) => r.propertyName === 'resize');
const clipMarginRule = scrollRules.find((r) => r.propertyName === 'overflow-clip-margin');
const snapTypeRule = scrollRules.find((r) => r.propertyName === 'scroll-snap-type');
const snapAlignRule = scrollRules.find((r) => r.propertyName === 'scroll-snap-align');
const snapMarginRule = scrollRules.find((r) => r.propertyName === 'scroll-margin');
const gutterRule = scrollRules.find((r) => r.propertyName === 'scrollbar-gutter');
const overscrollRule = scrollRules.find((r) => r.propertyName === 'overscroll-behavior');
assert.ok(
  resizeRule && clipMarginRule && snapTypeRule && snapAlignRule && snapMarginRule &&
  gutterRule && overscrollRule
);

test('scroll rules: cover all seven properties', () => {
  assert.deepEqual(
    scrollRules.map((r) => r.propertyName).sort(),
    [
      'overflow-clip-margin',
      'overscroll-behavior',
      'resize',
      'scroll-margin',
      'scroll-snap-align',
      'scroll-snap-type',
      'scrollbar-gutter',
    ]
  );
});

test('resize: inactive with overflow: visible or clip', () => {
  for (const overflow of ['visible', 'clip']) {
    const result = resizeRule.inspect(layout('block', overflow), declaration);
    assert.ok(result, `resize should be inactive with overflow: ${overflow}`);
    assert.equal(result.reasonCode, REASON_CODES.REQUIRES_SCROLL_CONTAINER);
  }
});

test('resize: active with a scrollable overflow', () => {
  for (const overflow of ['hidden', 'auto', 'scroll']) {
    assert.equal(
      resizeRule.inspect(layout('block', overflow), declaration),
      undefined,
      `resize should stay active with overflow: ${overflow}`
    );
  }
});

test('resize: no decision when overflow is unknown', () => {
  const context = createLayoutContext({
    display: 'block',
    parentDisplay: 'none',
    computedStyles: new Map([['display', 'block']]),
  });
  assert.equal(resizeRule.inspect(context, declaration), undefined);
});

test('overflow-clip-margin: inactive unless overflow is clip', () => {
  for (const overflow of ['visible', 'hidden', 'auto', 'scroll']) {
    const result = clipMarginRule.inspect(layout('block', overflow), declaration);
    assert.ok(result, `overflow-clip-margin should be inactive with overflow: ${overflow}`);
    assert.equal(result.reasonCode, REASON_CODES.REQUIRES_CLIP_OVERFLOW);
  }
  assert.equal(clipMarginRule.inspect(layout('block', 'clip'), declaration), undefined);
});

test('scroll-snap-type: inactive when the element is not a scroll container', () => {
  for (const overflow of ['visible', 'clip']) {
    const result = snapTypeRule.inspect(layout('block', overflow), declaration);
    assert.ok(result, `scroll-snap-type should be inactive with overflow: ${overflow}`);
    assert.equal(result.reasonCode, REASON_CODES.REQUIRES_SCROLL_CONTAINER);
  }
});

test('scroll-snap-type: active on a scroll container', () => {
  for (const overflow of ['hidden', 'auto', 'scroll']) {
    assert.equal(
      snapTypeRule.inspect(layout('block', overflow), declaration),
      undefined,
      `scroll-snap-type should stay active with overflow: ${overflow}`
    );
  }
});

test('scroll-snap-align and scroll-margin: inactive without a snap ancestor', () => {
  for (const rule of [snapAlignRule, snapMarginRule]) {
    const result = rule.inspect(layout('block', 'visible', false), declaration);
    assert.ok(result, `${rule.propertyName} should be inactive without a snap ancestor`);
    assert.equal(result.reasonCode, REASON_CODES.REQUIRES_SCROLL_SNAP_CONTAINER);
  }
});

test('scroll-snap-align and scroll-margin: active with a snap ancestor', () => {
  for (const rule of [snapAlignRule, snapMarginRule]) {
    assert.equal(
      rule.inspect(layout('block', 'visible', true), declaration),
      undefined,
      `${rule.propertyName} should stay active with a snap ancestor`
    );
  }
});

test('scroll-snap-align and scroll-margin: no decision when the chain is unknown', () => {
  for (const rule of [snapAlignRule, snapMarginRule]) {
    assert.equal(
      rule.inspect(layout('block', 'visible'), declaration),
      undefined,
      `${rule.propertyName} must not flag when the ancestor chain is unresolved`
    );
  }
});

// ── PR Level 3: scrollbar-gutter and overscroll-behavior ────────────────
// Chromium never resets their computed values (probes keep
// `scrollbar-gutter: stable` and `overscroll-behavior-x: contain` even with
// `overflow: visible`), so the only provable signal is the effective
// overflow reported by CDP in the longhands.

function longhandLayout(overflowX: string, overflowY: string): LayoutContext {
  const computedStyles = new Map<string, string>([
    ['display', 'block'],
    ['overflow-x', overflowX],
    ['overflow-y', overflowY],
  ]);
  return createLayoutContext({ display: 'block', parentDisplay: 'none', computedStyles });
}

test('scrollbar-gutter and overscroll-behavior: inactive on a provably non-scrollable box', () => {
  for (const rule of [gutterRule, overscrollRule]) {
    for (const [x, y] of [
      ['visible', 'visible'],
      ['visible', 'clip'],
      ['clip', 'visible'],
      ['clip', 'clip'],
    ]) {
      const result = rule.inspect(longhandLayout(x, y), declaration);
      assert.ok(result, `${rule.propertyName} should be inactive with overflow ${x}/${y}`);
      assert.equal(result.reasonCode, REASON_CODES.REQUIRES_SCROLL_CONTAINER);
    }
  }
});

test('scrollbar-gutter and overscroll-behavior: active on a scroll container', () => {
  for (const rule of [gutterRule, overscrollRule]) {
    // Effective values as CDP pre-resolves them (visible+auto → auto/auto,
    // clip+scroll → hidden/scroll, scroll+visible → scroll/auto).
    for (const [x, y] of [
      ['auto', 'auto'],
      ['hidden', 'auto'],
      ['scroll', 'auto'],
      ['hidden', 'scroll'],
      ['auto', 'hidden'],
    ]) {
      assert.equal(
        rule.inspect(longhandLayout(x, y), declaration),
        undefined,
        `${rule.propertyName} should stay active with effective overflow ${x}/${y}`
      );
    }
  }
});

test('scrollbar-gutter and overscroll-behavior: no decision when overflow is unknown', () => {
  for (const rule of [gutterRule, overscrollRule]) {
    const onlyX = createLayoutContext({
      display: 'block',
      parentDisplay: 'none',
      computedStyles: new Map([
        ['display', 'block'],
        ['overflow-x', 'visible'],
      ]),
    });
    assert.equal(rule.inspect(onlyX, declaration), undefined);

    const none = createLayoutContext({
      display: 'block',
      parentDisplay: 'none',
      computedStyles: new Map([['display', 'block']]),
    });
    assert.equal(rule.inspect(none, declaration), undefined);
  }
});

test('scroll rules: no decision when display data is missing', () => {
  for (const rule of scrollRules) {
    assert.equal(rule.inspect(layout(''), declaration), undefined);
  }
});

test('scroll rules: malformed values never crash', () => {
  for (const rule of scrollRules) {
    const weird = { ...declaration, propertyValue: '!!broken value!!' };
    assert.ok(rule.inspect(layout('block', 'visible', false), weird));
  }
  // overflow-clip-margin flags everything except overflow: clip.
  const weird = { ...declaration, propertyValue: '!!broken value!!' };
  assert.ok(clipMarginRule.inspect(layout('block', 'auto', true), weird));
  assert.equal(resizeRule.inspect(layout('block', 'auto', true), weird), undefined);
  assert.equal(snapTypeRule.inspect(layout('block', 'auto', true), weird), undefined);
  assert.equal(snapAlignRule.inspect(layout('block', 'auto', true), weird), undefined);
  assert.equal(snapMarginRule.inspect(layout('block', 'auto', true), weird), undefined);
});
