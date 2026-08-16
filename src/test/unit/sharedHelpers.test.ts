import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LayoutContext, createLayoutContext } from '../../engine/layoutContext';
import {
  hasPlaceSelfEffect,
  isFlexOrGridOrGridLanesContainer,
  isFlexOrGridOrGridLanesItem,
  isGridLanesContainer,
  isGridLanesItem,
  isGridOrGridLanesContainer,
  isGridOrGridLanesItem,
  isInlineElement,
  isInlineNonReplacedElement,
  isMulticolContainer,
  isPossiblyReplacedElement,
  isProvablyVisibleOverflow,
  isProvablyWrappingWhiteSpace,
} from '../../inactive/rules/shared';

/**
 * PR7 — unit tests for the predicates ported from Chromium's
 * CSSRuleValidatorHelper.ts. The LayoutContext always normalizes first, so
 * the helpers receive canonical values.
 */

function context(
  display: string,
  extraStyles: Array<[string, string]> = [],
  parentDisplay = 'none',
  declaredDisplay?: string
): LayoutContext {
  return createLayoutContext({
    display,
    parentDisplay,
    declaredDisplay,
    computedStyles: new Map([['display', display], ...extraStyles]),
  });
}

test('isInlineElement: only display: inline', () => {
  assert.equal(isInlineElement(context('inline')), true);
  assert.equal(isInlineElement(context('block')), false);
  assert.equal(isInlineElement(context('inline-block')), false);
  assert.equal(isInlineElement(context('')), false);
});

test('isGridLanesContainer / isGridLanesItem', () => {
  assert.equal(isGridLanesContainer(context('grid-lanes')), true);
  assert.equal(isGridLanesContainer(context('inline-grid-lanes')), true);
  assert.equal(isGridLanesContainer(context('grid')), false);
  assert.equal(isGridLanesItem(context('block', [], 'grid-lanes')), true);
  assert.equal(isGridLanesItem(context('block', [], 'inline-grid-lanes')), true);
  assert.equal(isGridLanesItem(context('block', [], 'grid')), false);
});

test('isGridOrGridLanesContainer / isGridOrGridLanesItem', () => {
  for (const display of ['grid', 'inline-grid', 'grid-lanes', 'inline-grid-lanes']) {
    assert.equal(isGridOrGridLanesContainer(context(display)), true, `display: ${display}`);
  }
  assert.equal(isGridOrGridLanesContainer(context('flex')), false);
  assert.equal(isGridOrGridLanesContainer(context('block')), false);

  assert.equal(isGridOrGridLanesItem(context('block', [], 'grid')), true);
  assert.equal(isGridOrGridLanesItem(context('block', [], 'grid-lanes')), true);
  assert.equal(isGridOrGridLanesItem(context('block', [], 'flex')), false);
  assert.equal(isGridOrGridLanesItem(context('block', [], 'block')), false);
});

test('isFlexOrGridOrGridLanesContainer / isFlexOrGridOrGridLanesItem', () => {
  for (const display of ['flex', 'inline-flex', 'grid', 'inline-grid', 'grid-lanes', 'inline-grid-lanes']) {
    assert.equal(isFlexOrGridOrGridLanesContainer(context(display)), true, `display: ${display}`);
  }
  assert.equal(isFlexOrGridOrGridLanesContainer(context('block')), false);

  assert.equal(isFlexOrGridOrGridLanesItem(context('block', [], 'flex')), true);
  assert.equal(isFlexOrGridOrGridLanesItem(context('block', [], 'grid-lanes')), true);
  assert.equal(isFlexOrGridOrGridLanesItem(context('block', [], 'block')), false);
});

test('isMulticolContainer: column-count/column-width determine multicol', () => {
  assert.equal(isMulticolContainer(context('block', [['column-count', '2']])), true);
  assert.equal(isMulticolContainer(context('block', [['column-width', '100px']])), true);
  assert.equal(isMulticolContainer(context('block', [['column-count', 'auto']])), false);
  assert.equal(isMulticolContainer(context('block', [['column-width', 'auto']])), false);
  assert.equal(
    isMulticolContainer(context('block', [['column-count', 'auto'], ['column-width', 'auto']])),
    false
  );
  // Missing styles are not provably multicol (conservative).
  assert.equal(isMulticolContainer(context('block')), false);
  assert.equal(isMulticolContainer(context('')), false);
});

test('isPossiblyReplacedElement: case-safe allow-list lookup', () => {
  for (const nodeName of ['img', 'video', 'canvas', 'iframe', 'audio', 'embed', 'object', 'input']) {
    assert.equal(isPossiblyReplacedElement(nodeName), true, nodeName);
    assert.equal(isPossiblyReplacedElement(nodeName.toUpperCase()), true, `${nodeName} (upper)`);
  }
  for (const nodeName of ['span', 'div', 'a', 'p', 'section']) {
    assert.equal(isPossiblyReplacedElement(nodeName), false, nodeName);
  }
  assert.equal(isPossiblyReplacedElement(undefined), false);
  assert.equal(isPossiblyReplacedElement(''), false);
});

/**
 * Advanced-context (Level 2) — compound-condition helpers.
 */

test('isInlineNonReplacedElement: provable inline non-replaced detection', () => {
  const inlineSpan = context('inline', [], 'none');
  // nodeName must be provided to the LayoutContext.
  const span = createLayoutContext({
    display: 'inline',
    parentDisplay: 'none',
    nodeName: 'span',
    computedStyles: new Map([['display', 'inline']]),
  });
  assert.equal(isInlineNonReplacedElement(span), true);

  const img = createLayoutContext({
    display: 'inline',
    parentDisplay: 'none',
    nodeName: 'img',
    computedStyles: new Map([['display', 'inline']]),
  });
  assert.equal(isInlineNonReplacedElement(img), false);

  assert.equal(isInlineNonReplacedElement(context('block')), false);
  assert.equal(isInlineNonReplacedElement(inlineSpan), undefined, 'unknown node name');
});

test('isProvablyWrappingWhiteSpace: only wrapping values count', () => {
  for (const ws of ['normal', 'pre-wrap', 'break-spaces', 'pre-line']) {
    assert.equal(isProvablyWrappingWhiteSpace(context('block', [['white-space', ws]])), true, ws);
  }
  for (const ws of ['nowrap', 'pre']) {
    assert.equal(isProvablyWrappingWhiteSpace(context('block', [['white-space', ws]])), false, ws);
  }
  assert.equal(isProvablyWrappingWhiteSpace(context('block')), false, 'missing');
  assert.equal(
    isProvablyWrappingWhiteSpace(context('block', [['white-space', ' NOWRAP ']])),
    false,
    'normalized non-wrapping'
  );
});

test('isProvablyWrappingWhiteSpace: falls back to text-wrap-mode longhand', () => {
  // Chromium reports the CSS Text 4 longhands instead of the shorthand.
  assert.equal(
    isProvablyWrappingWhiteSpace(context('block', [['text-wrap-mode', 'wrap']])),
    true,
    'text-wrap-mode: wrap wraps'
  );
  assert.equal(
    isProvablyWrappingWhiteSpace(context('block', [['text-wrap-mode', 'nowrap']])),
    false,
    'text-wrap-mode: nowrap does not wrap'
  );
  assert.equal(
    isProvablyWrappingWhiteSpace(context('block', [['text-wrap-mode', ' WRAP ']])),
    true,
    'normalized wrapping mode'
  );
  assert.equal(
    isProvablyWrappingWhiteSpace(context('block', [['text-wrap-mode', 'balance']])),
    false,
    'non-mode values are not provably wrapping'
  );
  // The shorthand takes precedence over the longhand.
  assert.equal(
    isProvablyWrappingWhiteSpace(
      context('block', [['white-space', 'nowrap'], ['text-wrap-mode', 'wrap']])
    ),
    false,
    'white-space shorthand wins'
  );
});

test('isProvablyVisibleOverflow: shorthand and overflow-x longhand', () => {
  assert.equal(isProvablyVisibleOverflow(context('block', [['overflow', 'visible']])), true);
  assert.equal(isProvablyVisibleOverflow(context('block', [['overflow', 'hidden']])), false);
  assert.equal(isProvablyVisibleOverflow(context('block', [['overflow-x', 'visible']])), true);
  assert.equal(isProvablyVisibleOverflow(context('block', [['overflow-x', 'hidden']])), false);
  assert.equal(isProvablyVisibleOverflow(context('block')), false, 'missing');
});

test('hasPlaceSelfEffect: place-self decomposition (align-self + justify-self)', () => {
  assert.equal(hasPlaceSelfEffect(context('block', [], 'flex')), true);
  assert.equal(hasPlaceSelfEffect(context('block', [], 'grid')), true);
  assert.equal(hasPlaceSelfEffect(context('block', [], 'block')), false);
  assert.equal(hasPlaceSelfEffect(context('block', [], 'inline-block')), false);
  assert.equal(hasPlaceSelfEffect(context('block', [], 'none')), undefined, 'unknown parent');
  assert.equal(hasPlaceSelfEffect(context('block', [], '')), undefined, 'unknown parent');
});

test('hasPlaceSelfEffect: an authored plain-block display removes the placement context', () => {
  assert.equal(
    hasPlaceSelfEffect(context('block', [], 'flex', 'block')),
    false,
    'flex item explicitly overridden to display: block'
  );
  assert.equal(
    hasPlaceSelfEffect(context('block', [], 'grid', 'block')),
    false,
    'grid item explicitly overridden to display: block'
  );
  assert.equal(hasPlaceSelfEffect(context('block', [], 'grid', 'flow-root')), false);
  assert.equal(hasPlaceSelfEffect(context('block', [], 'flex', 'list-item')), false);
});

test('hasPlaceSelfEffect: the declared display is normalized before comparison', () => {
  assert.equal(
    hasPlaceSelfEffect(context('block', [], 'flex', 'BLOCK')),
    false,
    'case must not bypass the override'
  );
  assert.equal(
    hasPlaceSelfEffect(context('block', [], 'flex', ' block ')),
    false,
    'whitespace must not bypass the override'
  );
});

test('hasPlaceSelfEffect: an unrelated declared display keeps the placement context', () => {
  assert.equal(
    hasPlaceSelfEffect(context('block', [], 'flex', 'flex')),
    true,
    'declaring the actual item display must not flag'
  );
  assert.equal(
    hasPlaceSelfEffect(context('block', [], 'grid', 'inline-grid')),
    true,
    'an inline variant is still an item under its parent'
  );
  assert.equal(hasPlaceSelfEffect(context('block', [], 'flex', undefined)), true);
});

test('hasPlaceSelfEffect: no declared display still falls back to the parent classification', () => {
  assert.equal(hasPlaceSelfEffect(context('block', [], 'none', undefined)), undefined, 'parent is still unknown');
  assert.equal(hasPlaceSelfEffect(context('block', [], 'block', 'block')), false, 'still not a flex/grid item');
});

test('hasPlaceSelfEffect: explicit plain-block display overrides an UNKNOWN parent (Level 5)', () => {
  // Level-5 regression: the standalone CSS-file flow reports no parent, but
  // `display: block` + `place-self` must still be dimmed — the authored
  // display removes the box from the placement context regardless of the
  // parent. `.place-item.bad` in the fixture.
  assert.equal(
    hasPlaceSelfEffect(context('block', [], 'none', 'block')),
    false,
    'explicit display: block overrides an unknown parent'
  );
  assert.equal(
    hasPlaceSelfEffect(context('block', [], 'none', 'flow-root')),
    false,
    'explicit display: flow-root overrides an unknown parent'
  );
  assert.equal(
    hasPlaceSelfEffect(context('block', [], 'none', 'list-item')),
    false,
    'explicit display: list-item overrides an unknown parent'
  );
});
