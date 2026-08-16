import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InactiveRuleEngine } from '../../inactive/inactiveRuleEngine';
import { createDefaultRuleRegistry } from '../../inactive/ruleRegistry';
import { REASON_CODES } from '../../inactive/reasonCode';
import { MatchedCssDeclaration, PropertyInspectionContext } from '../../engine/inactivePropertyEngine';
import { LayoutContext, createLayoutContext } from '../../engine/layoutContext';

const engine = new InactiveRuleEngine(createDefaultRuleRegistry());

function makeDeclaration(
  propertyName = 'justify-content',
  propertyValue = 'center'
): MatchedCssDeclaration {
  return {
    nodeId: 1,
    styleSheetId: 'sheet-1',
    selectorText: '.non-flex',
    propertyName,
    propertyValue,
    origin: 'author',
  };
}

function makeLayout(
  display: string | undefined,
  parentDisplay = 'none',
  position?: string,
  floatValue?: string,
  nodeName?: string,
  extraStyles: Array<[string, string]> = []
): LayoutContext {
  const computedStyles = new Map<string, string>();
  if (display !== undefined) {
    computedStyles.set('display', display);
  }
  if (position !== undefined) {
    computedStyles.set('position', position);
  }
  if (floatValue !== undefined) {
    computedStyles.set('float', floatValue);
  }
  for (const [name, value] of extraStyles) {
    computedStyles.set(name, value);
  }
  return createLayoutContext({ display: display ?? '', parentDisplay, position, nodeName, computedStyles });
}

function inspectWith(
  display: string | undefined,
  declaration: MatchedCssDeclaration = makeDeclaration(),
  parentDisplay = 'none',
  position?: string,
  floatValue?: string
) {
  const layout = makeLayout(display, parentDisplay, position, floatValue);
  const context: PropertyInspectionContext = {
    declaration,
    computedStyles: layout.computedStyles,
    layout,
  };
  return engine.inspect(context);
}

test('reports inactive for non-container display values', () => {
  for (const display of ['block', 'inline', 'inline-block', 'flow-root', 'table', 'contents', 'none']) {
    const result = inspectWith(display);
    assert.ok(result, `expected inactive for display=${display}`);
    assert.equal(result.inactive, true);
    assert.equal(result.propertyName, 'justify-content');
    assert.equal(result.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);
    assert.ok(result.reasonText.length > 0);
  }
});

test('reports active (undefined) for flex/grid display values', () => {
  for (const display of ['flex', 'inline-flex', 'grid', 'inline-grid']) {
    assert.equal(inspectWith(display), undefined, `expected active for display=${display}`);
  }
});

test('normalizes property name case and whitespace safely', () => {
  const result = inspectWith('block', makeDeclaration('  Justify-Content  '));
  assert.ok(result);
  assert.equal(result.propertyName, 'justify-content');
});

test('normalizes computed display case and whitespace', () => {
  assert.equal(inspectWith(' Flex '), undefined, 'expected active for " Flex "');
  assert.equal(inspectWith('FLEX'), undefined, 'expected active for "FLEX"');
  const blockUpper = inspectWith('BLOCK');
  assert.ok(blockUpper, 'expected inactive for uppercase "BLOCK"');
  assert.equal(blockUpper.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);
});

test('returns undefined for unrelated properties', () => {
  const result = inspectWith('block', makeDeclaration('color', 'red'));
  assert.equal(result, undefined);
});

test('does not produce a false positive when display data is missing', () => {
  assert.equal(inspectWith(undefined), undefined);
});

test('does not crash on empty or malformed declarations', () => {
  // Empty property name
  const emptyName = engine.inspect({
    declaration: makeDeclaration(''),
    computedStyles: new Map([['display', 'block']]),
    layout: makeLayout('block'),
  });
  assert.equal(emptyName, undefined);

  // Whitespace-only property name
  const whitespaceName = engine.inspect({
    declaration: makeDeclaration('   '),
    computedStyles: new Map([['display', 'block']]),
    layout: makeLayout('block'),
  });
  assert.equal(whitespaceName, undefined);

  // Null-ish declaration shape
  assert.equal(
    engine.inspect({ declaration: undefined as unknown as MatchedCssDeclaration, computedStyles: new Map(), layout: makeLayout('block') }),
    undefined
  );
  assert.equal(
    engine.inspect({
      declaration: { nodeId: 0, selectorText: '', propertyName: '', propertyValue: '' },
      computedStyles: new Map(),
      layout: makeLayout('block'),
    }),
    undefined
  );
});

test('returns undefined (no decision) when the LayoutContext is missing', () => {
  // The rule engine contract: rules rely on the prebuilt LayoutContext.
  const context: PropertyInspectionContext = {
    declaration: makeDeclaration(),
    computedStyles: new Map([['display', 'block']]),
  };
  assert.equal(engine.inspect(context), undefined);
});

test('is deterministic for identical input', () => {
  const layout = makeLayout('block');
  const context: PropertyInspectionContext = {
    declaration: makeDeclaration(),
    computedStyles: layout.computedStyles,
    layout,
  };
  assert.deepEqual(engine.inspect(context), engine.inspect(context));
});

/**
 * PR6 Phase 2 — the default registry through the engine: flex item,
 * grid container and grid item rules all dispatch correctly.
 */

test('default registry: flex-only properties are inactive on grid items', () => {
  const result = inspectWith('block', makeDeclaration('flex-grow', '1'), 'grid');
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.REQUIRES_FLEX_ITEM);
});

test('default registry: flex-only properties are active on flex items', () => {
  assert.equal(inspectWith('block', makeDeclaration('flex-grow', '1'), 'flex'), undefined);
  assert.equal(inspectWith('block', makeDeclaration('flex', '1 0 auto'), 'flex'), undefined);
});

test('default registry: grid-column is inactive on a flex item', () => {
  const result = inspectWith('block', makeDeclaration('grid-column', '1 / 3'), 'flex');
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.REQUIRES_GRID_ITEM);
});

test('default registry: grid-column is active on a grid item', () => {
  assert.equal(inspectWith('block', makeDeclaration('grid-column', '1 / 3'), 'grid'), undefined);
});

test('default registry: justify-items is inactive on a flex container', () => {
  const result = inspectWith('flex', makeDeclaration('justify-items', 'center'));
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.REQUIRES_GRID_CONTAINER);
});

test('default registry: gap is active on flex and grid containers', () => {
  assert.equal(inspectWith('flex', makeDeclaration('gap', '8px')), undefined);
  assert.equal(inspectWith('grid', makeDeclaration('gap', '8px')), undefined);
  const result = inspectWith('block', makeDeclaration('gap', '8px'));
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.REQUIRES_FLEX_GRID_OR_MULTICOL_CONTAINER);
});

test('default registry: align-self is active on flex and grid items', () => {
  assert.equal(inspectWith('block', makeDeclaration('align-self', 'center'), 'flex'), undefined);
  assert.equal(inspectWith('block', makeDeclaration('align-self', 'center'), 'grid'), undefined);
  const result = inspectWith('block', makeDeclaration('align-self', 'center'), 'block');
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_ITEM);
});

test('default registry: item rules never flag when the parent is unknown', () => {
  // 'none' parent display means "no parent / lookup failed" — no decision.
  assert.equal(inspectWith('block', makeDeclaration('grid-area', '1 / 2'), 'none'), undefined);
  assert.equal(inspectWith('block', makeDeclaration('order', '2'), 'none'), undefined);
});

/**
 * PR6 Phase 3 — the expanded families dispatch through the engine exactly
 * like the Phase 2 rules: one declaration, one owning rule, one result.
 */

test('default registry: position offsets are inactive on static elements', () => {
  const result = inspectWith('block', makeDeclaration('top', '10px'), 'block', 'static');
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.REQUIRES_POSITIONED_ELEMENT);

  assert.equal(inspectWith('block', makeDeclaration('top', '10px'), 'block', 'relative'), undefined);
  assert.equal(inspectWith('block', makeDeclaration('inset', '10px'), 'flex', 'static'), undefined);
  assert.equal(inspectWith('block', makeDeclaration('left', '10px'), 'block', 'absolute'), undefined);
});

test('default registry: z-index is inactive on static non-item elements', () => {
  const result = inspectWith('block', makeDeclaration('z-index', '5'), 'block', 'static');
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.REQUIRES_POSITIONED_OR_FLEX_GRID_ITEM);

  assert.equal(inspectWith('block', makeDeclaration('z-index', '5'), 'flex', 'static'), undefined);
  assert.equal(inspectWith('block', makeDeclaration('z-index', '5'), 'none', 'static'), undefined);
});

test('default registry: float and clear are inactive on flex/grid items', () => {
  const floatResult = inspectWith('block', makeDeclaration('float', 'left'), 'flex', 'static');
  assert.ok(floatResult);
  assert.equal(floatResult.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_FLEX_GRID_ITEM);

  const clearResult = inspectWith('block', makeDeclaration('clear', 'both'), 'grid', 'static');
  assert.ok(clearResult);
  assert.equal(clearResult.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_FLEX_GRID_ITEM);

  assert.equal(inspectWith('block', makeDeclaration('float', 'left'), 'block', 'static'), undefined);
  assert.equal(inspectWith('block', makeDeclaration('clear', 'both'), 'block', 'static'), undefined);
});

test('default registry: vertical-align is inactive on block-level boxes', () => {
  const result = inspectWith('block', makeDeclaration('vertical-align', 'middle'), 'block', 'static');
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.REQUIRES_INLINE_LEVEL_OR_TABLE_CELL);

  assert.equal(inspectWith('inline', makeDeclaration('vertical-align', 'middle'), 'block', 'static'), undefined);
  assert.equal(inspectWith('table-cell', makeDeclaration('vertical-align', 'middle'), 'block', 'static'), undefined);
});

test('default registry: box-suppressed properties flag only on display: contents', () => {
  const result = inspectWith('contents', makeDeclaration('overflow', 'hidden'), 'block', 'static');
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX);

  assert.equal(inspectWith('block', makeDeclaration('overflow', 'hidden'), 'block', 'static'), undefined);
  assert.equal(inspectWith('block', makeDeclaration('object-fit', 'cover'), 'block', 'static'), undefined);
  assert.equal(inspectWith('block', makeDeclaration('pointer-events', 'none'), 'block', 'static'), undefined);
});

/**
 * PR7 — the extended applicability families dispatch through the engine
 * exactly like every other rule: one declaration, one owning rule, one
 * result.
 */

test('default registry: flex-only properties need a flex container', () => {
  const result = inspectWith('block', makeDeclaration('flex-direction', 'row'));
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.REQUIRES_FLEX_CONTAINER);

  // Grid containers do NOT honor flex-only properties.
  const asGrid = inspectWith('grid', makeDeclaration('flex-wrap', 'wrap'));
  assert.ok(asGrid);
  assert.equal(asGrid.reasonCode, REASON_CODES.REQUIRES_FLEX_CONTAINER);

  assert.equal(inspectWith('flex', makeDeclaration('flex-direction', 'row')), undefined);
  assert.equal(inspectWith('flex', makeDeclaration('flex-wrap', 'wrap')), undefined);
});

test('default registry: grid template properties need a grid container', () => {
  const result = inspectWith('block', makeDeclaration('grid-template-columns', '1fr'));
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.REQUIRES_GRID_CONTAINER);

  // Flex containers do NOT establish a grid formatting context.
  const asFlex = inspectWith('flex', makeDeclaration('grid-auto-rows', 'auto'));
  assert.ok(asFlex);
  assert.equal(asFlex.reasonCode, REASON_CODES.REQUIRES_GRID_CONTAINER);

  assert.equal(inspectWith('grid', makeDeclaration('grid-template-columns', '1fr')), undefined);
});

test('default registry: grid-row-start/end need a grid-item parent', () => {
  const result = inspectWith('block', makeDeclaration('grid-row-start', '1'), 'block');
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.REQUIRES_GRID_ITEM);

  assert.equal(inspectWith('block', makeDeclaration('grid-row-end', '3'), 'grid'), undefined);
});

test('default registry: align-content needs a flex/grid container (PR6 semantics)', () => {
  const block = inspectWith('block', makeDeclaration('align-content', 'center'));
  assert.ok(block);
  assert.equal(block.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);

  const inlineBlock = inspectWith('inline-block', makeDeclaration('place-content', 'center'));
  assert.ok(inlineBlock);
  assert.equal(inlineBlock.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);

  const inline = inspectWith('inline', makeDeclaration('align-content', 'center'));
  assert.ok(inline);
  assert.equal(inline.reasonCode, REASON_CODES.REQUIRES_FLEX_OR_GRID_CONTAINER);

  assert.equal(inspectWith('flex', makeDeclaration('align-content', 'center')), undefined);
  assert.equal(inspectWith('grid', makeDeclaration('place-content', 'center')), undefined);
});

test('default registry: align-content is prevented by flex-wrap: nowrap', () => {
  const layout = makeLayout('flex', 'none', 'static', undefined, undefined, [['flex-wrap', 'nowrap']]);
  const context: PropertyInspectionContext = {
    declaration: makeDeclaration('align-content', 'center'),
    computedStyles: layout.computedStyles,
    layout,
  };
  const result = engine.inspect(context);
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.PREVENTED_BY_FLEX_WRAP_NOWRAP);

  const wrapped = makeLayout('flex', 'none', 'static', undefined, undefined, [['flex-wrap', 'wrap']]);
  assert.equal(
    engine.inspect({
      declaration: makeDeclaration('align-content', 'center'),
      computedStyles: wrapped.computedStyles,
      layout: wrapped,
    }),
    undefined
  );
});

test('default registry: justify-content is a container-only property on items', () => {
  const itemResult = inspectWith('block', makeDeclaration('justify-content', 'center'), 'flex');
  assert.ok(itemResult);
  assert.equal(itemResult.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_FLEX_GRID_ITEM);
});

test('default registry: padding is inactive on table-internal boxes', () => {
  const result = inspectWith('table-row', makeDeclaration('padding', '8px'));
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_TABLE_INTERNAL_BOX);

  assert.equal(inspectWith('block', makeDeclaration('padding', '8px')), undefined);
  assert.equal(inspectWith('table-cell', makeDeclaration('padding', '8px')), undefined);
});

test('default registry: position-anchor requires absolute or fixed positioning', () => {
  const result = inspectWith('block', makeDeclaration('position-anchor', 'auto'), 'block', 'static');
  assert.ok(result);
  assert.equal(result.reasonCode, REASON_CODES.REQUIRES_ABSOLUTE_OR_FIXED_POSITION);

  assert.equal(inspectWith('block', makeDeclaration('position-anchor', 'auto'), 'block', 'absolute'), undefined);
  assert.equal(inspectWith('block', makeDeclaration('position-anchor', 'auto'), 'block', 'fixed'), undefined);
});

test('default registry: width/height are inactive on inline non-replaced elements', () => {
  const layout = makeLayout('inline', 'block', 'static', undefined, 'span');
  const widthResult = engine.inspect({
    declaration: makeDeclaration('width', '200px'),
    computedStyles: layout.computedStyles,
    layout,
  });
  assert.ok(widthResult);
  assert.equal(widthResult.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_INLINE_BOX);

  // Replaced inline elements (img) honor width.
  const imgLayout = makeLayout('inline', 'block', 'static', undefined, 'img');
  assert.equal(
    engine.inspect({
      declaration: makeDeclaration('width', '200px'),
      computedStyles: imgLayout.computedStyles,
      layout: imgLayout,
    }),
    undefined
  );

  // Without a node name there is no decision.
  const unnamed = makeLayout('inline', 'block', 'static', undefined);
  assert.equal(
    engine.inspect({
      declaration: makeDeclaration('width', '200px'),
      computedStyles: unnamed.computedStyles,
      layout: unnamed,
    }),
    undefined
  );
});

test('conflict resolution: every declaration yields at most one result', () => {
  // An abspos child of a flex container could match two conditions
  // conceptually — the most specific one wins, exactly one result.
  const floatResult = inspectWith('block', makeDeclaration('float', 'left'), 'flex', 'absolute');
  assert.ok(floatResult);
  assert.equal(floatResult.reasonCode, REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX);
  // A contents element could match several conditions too — the
  // box-suppressed code is the single winner.
  const topResult = inspectWith('contents', makeDeclaration('top', '10px'), 'block', 'relative');
  assert.ok(topResult);
  assert.equal(topResult.reasonCode, REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX);

  // Across the whole default rule set, every property returns a single
  // result for a given layout.
  const registry = createDefaultRuleRegistry();
  const sampleLayouts: Array<{ display: string; parentDisplay: string; position?: string }> = [
    { display: 'block', parentDisplay: 'block', position: 'static' },
    { display: 'flex', parentDisplay: 'none', position: 'static' },
    { display: 'block', parentDisplay: 'flex', position: 'absolute' },
    { display: 'contents', parentDisplay: 'block', position: 'static' },
  ];
  for (const { display, parentDisplay, position } of sampleLayouts) {
    const layout = makeLayout(display, parentDisplay, position);
    for (const name of registry.propertyNames) {
      const single = engine.inspect({
        declaration: makeDeclaration(name),
        computedStyles: layout.computedStyles,
        layout,
      });
      if (single) {
        assert.equal(single.inactive, true, `single result shape for ${name}`);
      }
    }
  }
});
