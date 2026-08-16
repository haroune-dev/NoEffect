import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LayoutContext,
  createLayoutContext,
  normalizeDisplay,
  isFlexContainerDisplay,
  isGridContainerDisplay,
  NO_PARENT_DISPLAY,
  derivePseudoBoxLayout,
} from '../../engine/layoutContext';

/**
 * PR6 Phase 1 — unit tests for the pure LayoutContext module:
 * normalization, container/item detection and immutability.
 */

function styles(entries: Array<[string, string]>): Map<string, string> {
  return new Map(entries);
}

function build(
  display: string,
  parentDisplay: string = NO_PARENT_DISPLAY,
  computedStyles: Map<string, string> = styles([['display', display]])
): LayoutContext {
  return createLayoutContext({ display, parentDisplay, computedStyles });
}

test('normalization: trims whitespace and lowercases', () => {
  assert.equal(normalizeDisplay('flex'), 'flex');
  assert.equal(normalizeDisplay(' FLEX '), 'flex');
  assert.equal(normalizeDisplay('Flex'), 'flex');
  assert.equal(normalizeDisplay(' inline-flex '), 'inline-flex');
  assert.equal(normalizeDisplay('DISPLAY: FLEX'), 'display: flex');
  assert.equal(normalizeDisplay('display:flex'), 'display:flex');
  assert.equal(normalizeDisplay('Display : Flex'), 'display : flex');
});

test('normalization: missing and whitespace-only values are empty', () => {
  assert.equal(normalizeDisplay(undefined), '');
  assert.equal(normalizeDisplay(''), '');
  assert.equal(normalizeDisplay('   '), '');
});

test('detection: flex and inline-flex are flex containers', () => {
  assert.equal(isFlexContainerDisplay('flex'), true);
  assert.equal(isFlexContainerDisplay('inline-flex'), true);
  assert.equal(isFlexContainerDisplay('grid'), false);
  assert.equal(isFlexContainerDisplay('block'), false);
});

test('detection: grid and inline-grid are grid containers', () => {
  assert.equal(isGridContainerDisplay('grid'), true);
  assert.equal(isGridContainerDisplay('inline-grid'), true);
  assert.equal(isGridContainerDisplay('flex'), false);
  assert.equal(isGridContainerDisplay('block'), false);
});

test('block container: not a flex/grid container and not an item', () => {
  const context = build('block');
  assert.equal(context.display, 'block');
  assert.equal(context.isFlexContainer, false);
  assert.equal(context.isGridContainer, false);
  assert.equal(context.parentDisplay, NO_PARENT_DISPLAY);
  assert.equal(context.isFlexItem, false);
  assert.equal(context.isGridItem, false);
});

test('flex container: display flex', () => {
  const context = build('flex');
  assert.equal(context.isFlexContainer, true);
  assert.equal(context.isGridContainer, false);
});

test('inline-flex container: still a flex container', () => {
  const context = build('inline-flex');
  assert.equal(context.isFlexContainer, true);
  assert.equal(context.isGridContainer, false);
});

test('grid container: display grid', () => {
  const context = build('grid');
  assert.equal(context.isGridContainer, true);
  assert.equal(context.isFlexContainer, false);
});

test('inline-grid container: still a grid container', () => {
  const context = build('inline-grid');
  assert.equal(context.isGridContainer, true);
  assert.equal(context.isFlexContainer, false);
});

test('flex item: parent display flex', () => {
  const context = build('block', 'flex');
  assert.equal(context.parentDisplay, 'flex');
  assert.equal(context.isFlexItem, true);
  assert.equal(context.isGridItem, false);
});

test('grid item: parent display grid', () => {
  const context = build('block', 'grid');
  assert.equal(context.parentDisplay, 'grid');
  assert.equal(context.isGridItem, true);
  assert.equal(context.isFlexItem, false);
});

test('inline-flex parent still makes the element a flex item', () => {
  const context = build('block', 'inline-flex');
  assert.equal(context.isFlexItem, true);
});

test('missing parent: safe defaults instead of an error', () => {
  const context = build('block', '');
  assert.equal(context.parentDisplay, '');
  assert.equal(context.isFlexItem, false);
  assert.equal(context.isGridItem, false);
});

test('missing computed styles: safe defaults', () => {
  const context = createLayoutContext({
    display: '',
    parentDisplay: '',
    computedStyles: styles([]),
  });
  assert.equal(context.display, '');
  assert.equal(context.isFlexContainer, false);
  assert.equal(context.isGridContainer, false);
  assert.equal(context.getComputedStyle('display'), undefined);
  assert.equal(context.getComputedStyle('position'), undefined);
});

test('cache lookups: O(1) computed-style reads', () => {
  const context = build('block', 'flex', styles([['display', 'block'], ['position', 'absolute'], ['overflow', 'hidden']]));
  assert.equal(context.getComputedStyle('position'), 'absolute');
  assert.equal(context.getComputedStyle('overflow'), 'hidden');
  assert.equal(context.computedStyles.get('position'), 'absolute');
  assert.equal(context.getComputedStyle('missing'), undefined);
});

test('immutable: the context object is frozen', () => {
  const context = build('flex');
  assert.equal(Object.isFrozen(context), true);
});

test('immutable: the exposed style map is read-only and detached', () => {
  const source = styles([['display', 'flex']]);
  const context = createLayoutContext({ display: 'flex', parentDisplay: 'none', computedStyles: source });

  assert.equal(context.computedStyles.get('display'), 'flex');

  // Mutating the source map after creation must not leak into the context.
  source.set('display', 'block');
  assert.equal(context.display, 'flex', 'display is snapshotted at build time');
  assert.equal(context.computedStyles.get('display'), 'flex', 'the context owns a defensive copy');
});

/**
 * PR6 Phase 3 — position data.
 */

test('position: defaults to empty and not positioned when not provided', () => {
  const context = build('block');
  assert.equal(context.position, '');
  assert.equal(context.isPositioned, false);
});

test('position: normalized (case and whitespace)', () => {
  const context = createLayoutContext({
    display: 'block',
    parentDisplay: 'none',
    position: '  Absolute ',
    computedStyles: styles([['display', 'block'], ['position', 'absolute']]),
  });
  assert.equal(context.position, 'absolute');
  assert.equal(context.isPositioned, true);
});

test('position: only relative/absolute/fixed/sticky count as positioned', () => {
  for (const position of ['relative', 'absolute', 'fixed', 'sticky']) {
    const context = createLayoutContext({
      display: 'block',
      parentDisplay: 'none',
      position,
      computedStyles: styles([]),
    });
    assert.equal(context.isPositioned, true, `position: ${position}`);
  }
  for (const position of ['static', 'unset', 'inherit', '']) {
    const context = createLayoutContext({
      display: 'block',
      parentDisplay: 'none',
      position,
      computedStyles: styles([]),
    });
    assert.equal(context.isPositioned, false, `position: ${position}`);
  }
});

/**
 * Advanced-context (Level 2) — out-of-flow detection.
 */

test('position: only absolute/fixed are out of flow', () => {
  for (const position of ['absolute', 'fixed']) {
    const context = createLayoutContext({
      display: 'block',
      parentDisplay: 'none',
      position,
      computedStyles: styles([]),
    });
    assert.equal(context.isOutOfFlow, true, `position: ${position}`);
  }
  for (const position of ['relative', 'sticky', 'static', '']) {
    const context = createLayoutContext({
      display: 'block',
      parentDisplay: 'none',
      position,
      computedStyles: styles([]),
    });
    assert.equal(context.isOutOfFlow, false, `position: ${position}`);
  }
});

test('position: isOutOfFlow normalizes case and whitespace like isPositioned', () => {
  const context = createLayoutContext({
    display: 'block',
    parentDisplay: 'none',
    position: '  Fixed ',
    computedStyles: styles([]),
  });
  assert.equal(context.isOutOfFlow, true);
  const relative = createLayoutContext({
    display: 'block',
    parentDisplay: 'none',
    position: 'RELATIVE',
    computedStyles: styles([]),
  });
  assert.equal(relative.isOutOfFlow, false);
});

/**
 * PR7 — node name data (required by the inline sizing rules).
 */

test('nodeName: defaults to empty when not provided', () => {
  const context = build('block');
  assert.equal(context.nodeName, '');
});

test('nodeName: normalized to lowercase and trimmed', () => {
  const context = createLayoutContext({
    display: 'inline',
    parentDisplay: 'none',
    nodeName: ' IMG ',
    computedStyles: styles([['display', 'inline']]),
  });
  assert.equal(context.nodeName, 'img');
});

test('nodeName: element names survive (span stays span)', () => {
  const context = createLayoutContext({
    display: 'inline',
    parentDisplay: 'none',
    nodeName: 'SPAN',
    computedStyles: styles([['display', 'inline']]),
  });
  assert.equal(context.nodeName, 'span');
});

// ── Pseudo box derivation ────────────────────────────────────────────────

function origin(display = 'block', nodeName = 'p'): LayoutContext {
  return createLayoutContext({
    display,
    parentDisplay: 'block',
    nodeName,
    computedStyles: styles([['display', display]]),
  });
}

test('pseudo box: defaults to a non-replaced inline box under the origin display', () => {
  const pseudoBox = derivePseudoBoxLayout(origin('block', 'p'));
  assert.equal(pseudoBox.display, 'inline');
  assert.equal(pseudoBox.parentDisplay, 'block');
  assert.equal(pseudoBox.nodeName, 'p');
  assert.equal(pseudoBox.position, 'static');
  assert.equal(pseudoBox.isPositioned, false);
  assert.equal(pseudoBox.isOutOfFlow, false);
  assert.equal(pseudoBox.pseudoContent, origin().pseudoContent);
});

test('pseudo box: the computed display shapes the box', () => {
  const pseudoBox = derivePseudoBoxLayout(origin(), { display: 'block' });
  assert.equal(pseudoBox.display, 'block');
  assert.equal(pseudoBox.isFlexContainer, false);
  const flexBox = derivePseudoBoxLayout(origin(), { display: 'flex' });
  assert.equal(flexBox.display, 'flex');
  assert.equal(flexBox.isFlexContainer, true);
});

test('pseudo box: a computed float blockifies the display', () => {
  assert.equal(derivePseudoBoxLayout(origin(), { float: 'left' }).display, 'block');
  assert.equal(derivePseudoBoxLayout(origin(), { float: 'right' }).display, 'block');
  assert.equal(derivePseudoBoxLayout(origin(), { float: 'left', display: 'inline-flex' }).display, 'flex');
  assert.equal(derivePseudoBoxLayout(origin(), { float: 'left', display: 'inline-grid' }).display, 'grid');
  assert.equal(derivePseudoBoxLayout(origin(), { float: 'left', display: 'table' }).display, 'table');
});

test('pseudo box: a non-float clear value does not blockify', () => {
  const pseudoBox = derivePseudoBoxLayout(origin(), { float: 'none' });
  assert.equal(pseudoBox.display, 'inline');
});

test('pseudo box: the computed position is honored', () => {
  const pseudoBox = derivePseudoBoxLayout(origin(), { position: 'absolute' });
  assert.equal(pseudoBox.position, 'absolute');
  assert.equal(pseudoBox.isPositioned, true);
  assert.equal(pseudoBox.isOutOfFlow, true);
});

test('pseudo box: computed styles are inherited from the origin', () => {
  const pseudoBox = derivePseudoBoxLayout(origin('block', 'div'));
  assert.equal(pseudoBox.computedStyles.get('display'), 'block');
});

test('createLayoutContext: builds pseudo box contexts from the provided facts', () => {
  const context = createLayoutContext({
    display: 'block',
    parentDisplay: 'none',
    nodeName: 'p',
    pseudoBoxFacts: new Map([
      ['first-letter', {}],
      ['::before', { display: 'block', computedContent: '"generated"' }],
    ]),
    computedStyles: styles([['display', 'block']]),
  });

  assert.equal(context.pseudoBoxContexts?.size, 2);
  assert.equal(context.pseudoBoxContexts?.get('first-letter')?.display, 'inline');
  assert.equal(context.pseudoBoxContexts?.get('first-letter')?.parentDisplay, 'block');
  assert.equal(context.pseudoBoxContexts?.get('before')?.display, 'block');
  assert.equal(context.pseudoBoxFacts?.get('before')?.computedContent, '"generated"');
});

test('createLayoutContext: no pseudo box contexts without facts', () => {
  const context = createLayoutContext({
    display: 'block',
    parentDisplay: 'none',
    nodeName: 'p',
    computedStyles: styles([['display', 'block']]),
  });
  assert.equal(context.pseudoBoxContexts, undefined);
});

test('createLayoutContext: pseudo box contexts are part of the frozen surface', () => {
  const context = createLayoutContext({
    display: 'block',
    parentDisplay: 'none',
    nodeName: 'p',
    pseudoBoxFacts: new Map([['first-letter', {}]]),
    computedStyles: styles([['display', 'block']]),
  });
  assert.ok(Object.isFrozen(context));
  assert.ok(Object.isFrozen(context.pseudoBoxContexts));
  assert.ok(Object.isFrozen(context.pseudoBoxFacts));
});
