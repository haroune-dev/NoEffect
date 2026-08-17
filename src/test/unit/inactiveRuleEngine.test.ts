import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InactiveRuleEngine } from '../../inactive/inactiveRuleEngine';
import { RuleRegistry } from '../../inactive/ruleRegistry';
import { InactiveResult, InactiveRule } from '../../inactive/inactiveRule';
import { REASON_CODES } from '../../inactive/reasonCode';
import { MatchedCssDeclaration, PropertyInspectionContext } from '../../engine/inactivePropertyEngine';
import { LayoutContext, createLayoutContext } from '../../engine/layoutContext';

/** Records every dispatch so tests can assert the engine's behavior. */
let calls: Array<{ layout: LayoutContext; declaration: MatchedCssDeclaration }> = [];

function makeRule(propertyName: string, result: InactiveResult | undefined): InactiveRule {
  return {
    propertyName,
    inspect(layout: LayoutContext, declaration: MatchedCssDeclaration) {
      calls.push({ layout, declaration });
      return result;
    },
  };
}

const INACTIVE_RESULT: InactiveResult = {
  inactive: true,
  propertyName: 'flex-grow',
  reasonCode: REASON_CODES.REQUIRES_FLEX_ITEM,
  reasonText: 'flex-grow has no effect because this element is not a flex item.',
};

function makeLayout(display = 'flex'): LayoutContext {
  const computedStyles = new Map([['display', display]]);
  return createLayoutContext({ display, parentDisplay: 'none', computedStyles });
}

function makeDeclaration(propertyName = 'flex-grow'): MatchedCssDeclaration {
  return {
    nodeId: 1,
    styleSheetId: 'sheet-1',
    selectorText: '.x',
    propertyName,
    propertyValue: '1',
    origin: 'author',
  };
}

function makeContext(declaration: MatchedCssDeclaration, layout: LayoutContext): PropertyInspectionContext {
  return { declaration, computedStyles: layout.computedStyles, layout };
}

test('dispatches to the single rule owning the property', () => {
  calls = [];
  const registry = new RuleRegistry();
  registry.register(makeRule('flex-grow', INACTIVE_RESULT));
  const engine = new InactiveRuleEngine(registry);

  const layout = makeLayout();
  const declaration = makeDeclaration();
  const result = engine.inspect(makeContext(declaration, layout));

  assert.equal(result, INACTIVE_RESULT);
  assert.equal(calls.length, 1);
  // The prebuilt context and the declaration pass through untouched.
  assert.equal(calls[0].layout, layout);
  assert.equal(calls[0].declaration, declaration);
});

test('passes the rule result through verbatim (shape contract)', () => {
  calls = [];
  const registry = new RuleRegistry();
  registry.register(makeRule('flex-grow', INACTIVE_RESULT));
  const engine = new InactiveRuleEngine(registry);

  const result = engine.inspect(makeContext(makeDeclaration(), makeLayout()));
  assert.ok(result);
  assert.equal(result.inactive, true);
  assert.equal(result.propertyName, 'flex-grow');
  assert.equal(result.reasonCode, REASON_CODES.REQUIRES_FLEX_ITEM);
  assert.ok(result.reasonText.length > 0);
});

test('returns undefined when no rule owns the property', () => {
  calls = [];
  const registry = new RuleRegistry();
  registry.register(makeRule('flex-grow', INACTIVE_RESULT));
  const engine = new InactiveRuleEngine(registry);

  assert.equal(engine.inspect(makeContext(makeDeclaration('color'), makeLayout())), undefined);
  assert.equal(calls.length, 0, 'no rule may be invoked for an unowned property');
});

test('returns undefined when the LayoutContext is missing', () => {
  calls = [];
  const registry = new RuleRegistry();
  registry.register(makeRule('flex-grow', INACTIVE_RESULT));
  const engine = new InactiveRuleEngine(registry);

  const context: PropertyInspectionContext = {
    declaration: makeDeclaration(),
    computedStyles: new Map([['display', 'block']]),
  };
  assert.equal(engine.inspect(context), undefined);
  assert.equal(calls.length, 0, 'the rule must not run without a LayoutContext');
});

test('does not crash on malformed declarations', () => {
  calls = [];
  const registry = new RuleRegistry();
  registry.register(makeRule('flex-grow', INACTIVE_RESULT));
  const engine = new InactiveRuleEngine(registry);

  const layout = makeLayout();
  assert.equal(
    engine.inspect({ declaration: undefined as unknown as MatchedCssDeclaration, computedStyles: new Map(), layout }),
    undefined
  );
  assert.equal(
    engine.inspect({ declaration: makeDeclaration('   '), computedStyles: new Map(), layout }),
    undefined
  );
  assert.equal(
    engine.inspect({
      declaration: { nodeId: 0, selectorText: '', propertyName: '', propertyValue: '' },
      computedStyles: new Map(),
      layout,
    }),
    undefined
  );
  assert.equal(calls.length, 0);
});

test('normalizes the requested property name before dispatch', () => {
  calls = [];
  const registry = new RuleRegistry();
  registry.register(makeRule('flex-grow', INACTIVE_RESULT));
  const engine = new InactiveRuleEngine(registry);

  assert.equal(engine.inspect(makeContext(makeDeclaration('  Flex-Grow  '), makeLayout())), INACTIVE_RESULT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].declaration.propertyName, '  Flex-Grow  ', 'declaration itself is never mutated');
});

test('is deterministic for identical input', () => {
  calls = [];
  const registry = new RuleRegistry();
  registry.register(makeRule('flex-grow', INACTIVE_RESULT));
  const engine = new InactiveRuleEngine(registry);

  const context = makeContext(makeDeclaration(), makeLayout());
  assert.deepEqual(engine.inspect(context), engine.inspect(context));
  assert.equal(calls.length, 2);
});

// ── PR Level 3: pseudo declaration dispatch ─────────────────────────────

function pseudoDeclaration(propertyName = 'flex-grow', pseudoElement = 'before'): MatchedCssDeclaration {
  return { ...makeDeclaration(propertyName), pseudoElement };
}

test('dispatches pseudo declarations to the ::<type> pseudo rule', () => {
  calls = [];
  const registry = new RuleRegistry();
  registry.register(makeRule('flex-grow', INACTIVE_RESULT));
  const pseudoResult: InactiveResult = {
    inactive: true,
    propertyName: '::before',
    reasonCode: REASON_CODES.GENERATED_PSEUDO_MISSING,
    reasonText: 'width has no effect.',
  };
  registry.register(makeRule('::before', pseudoResult));
  const engine = new InactiveRuleEngine(registry);

  const layout = makeLayout();
  const result = engine.inspect(makeContext(pseudoDeclaration('width', 'before'), layout));

  assert.equal(result, pseudoResult);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].declaration.pseudoElement, 'before');
  assert.equal(calls[0].layout, layout);
});

test('pseudo stage 2: an unregistered pseudo type yields no decision and never reaches a property rule', () => {
  calls = [];
  const registry = new RuleRegistry();
  registry.register(makeRule('flex-grow', INACTIVE_RESULT));
  const engine = new InactiveRuleEngine(registry);

  const declaration = pseudoDeclaration('flex-grow', 'selection');
  assert.equal(engine.inspect(makeContext(declaration, makeLayout())), undefined);
  assert.equal(calls.length, 0);
});

test('pseudo stage 2: when the ::<type> rule abstains, the property rule is consulted', () => {
  calls = [];
  const registry = new RuleRegistry();
  registry.register(makeRule('::before', undefined));
  const widthResult: InactiveResult = {
    inactive: true,
    propertyName: 'width',
    reasonCode: REASON_CODES.NOT_APPLICABLE_TO_INLINE_BOX,
    reasonText: 'width has no effect on an inline box.',
  };
  registry.register(makeRule('width', widthResult));
  const engine = new InactiveRuleEngine(registry);

  const layout = makeLayout('block');
  const result = engine.inspect(makeContext(pseudoDeclaration('width', 'before'), layout));

  assert.equal(result, widthResult);
  assert.equal(calls.length, 2, 'the ::before rule abstains, then the width rule decides');
  assert.equal(calls[0].declaration.pseudoElement, 'before');
  assert.equal(calls[1].layout, layout, 'stage 2 falls back to the origin layout without pseudo-box facts');
});

test('pseudo stage 2: the property rule runs against the pseudo box context when available', () => {
  calls = [];
  const registry = new RuleRegistry();
  registry.register(makeRule('::first-letter', undefined));
  const marginResult: InactiveResult = {
    inactive: true,
    propertyName: 'margin-top',
    reasonCode: REASON_CODES.NOT_APPLICABLE_TO_INLINE_BOX,
    reasonText: 'margin-top has no effect on an inline box.',
  };
  registry.register(makeRule('margin-top', marginResult));
  const engine = new InactiveRuleEngine(registry);

  const origin = createLayoutContext({
    display: 'block',
    parentDisplay: 'none',
    nodeName: 'p',
    pseudoBoxFacts: new Map([['first-letter', {}]]),
    computedStyles: new Map([['display', 'block']]),
  });
  const pseudoBox = origin.pseudoBoxContexts!.get('first-letter')!;
  assert.equal(pseudoBox.display, 'inline', 'the first-letter box is an inline box');

  const result = engine.inspect(
    makeContext(pseudoDeclaration('margin-top', 'first-letter'), origin)
  );

  assert.equal(result, marginResult);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].layout, pseudoBox, 'stage 2 must reason about the pseudo BOX, not the origin');
});

test('pseudo stage 2: the pseudo-type verdict still wins when it decides', () => {
  calls = [];
  const registry = new RuleRegistry();
  const pseudoResult: InactiveResult = {
    inactive: true,
    propertyName: '::first-letter',
    reasonCode: REASON_CODES.FIRST_LETTER_UNSUPPORTED_PROPERTY,
    reasonText: 'display has no effect on the first letter.',
  };
  registry.register(makeRule('::first-letter', pseudoResult));
  registry.register(makeRule('display', INACTIVE_RESULT));
  const engine = new InactiveRuleEngine(registry);

  const origin = createLayoutContext({
    display: 'block',
    parentDisplay: 'none',
    nodeName: 'p',
    pseudoBoxFacts: new Map([['first-letter', {}]]),
    computedStyles: new Map([['display', 'block']]),
  });

  const result = engine.inspect(
    makeContext(pseudoDeclaration('display', 'first-letter'), origin)
  );

  assert.equal(result, pseudoResult);
  assert.equal(calls.length, 1, 'the pseudo-type verdict is final — no property rule runs');
});

/**
 * Duplicate-declaration verdict: an earlier duplicate of a property in its
 * own declaration block has no effect by CSS semantics — the engine must
 * answer with the fixed override verdict, without consulting any rule.
 */

test('an overridden declaration gets the fixed override verdict regardless of context', () => {
  calls = [];
  const registry = new RuleRegistry();
  registry.register(makeRule('justify-content', INACTIVE_RESULT));
  const engine = new InactiveRuleEngine(registry);
  const declaration = makeDeclaration('justify-content');
  declaration.isOverridden = true;

  const result = engine.inspect(makeContext(declaration, makeLayout()));
  assert.ok(result, 'an overridden declaration is always inactive');
  assert.equal(result.reasonCode, REASON_CODES.OVERRIDDEN_BY_LATER_DECLARATION);
  assert.equal(result.propertyName, 'justify-content');
  assert.equal(calls.length, 0, 'no rule may run for an overridden declaration');
});

test('an overridden declaration with no registered rule is still inactive', () => {
  calls = [];
  const registry = new RuleRegistry();
  const engine = new InactiveRuleEngine(registry);
  const declaration = makeDeclaration('display');
  declaration.isOverridden = true;

  const result = engine.inspect(makeContext(declaration, makeLayout()));
  assert.ok(result, 'the override fact does not depend on the registry');
  assert.equal(result.reasonCode, REASON_CODES.OVERRIDDEN_BY_LATER_DECLARATION);
});

test('the effective last duplicate is judged by its property rule as usual', () => {
  calls = [];
  const registry = new RuleRegistry();
  registry.register(makeRule('justify-content', INACTIVE_RESULT));
  const engine = new InactiveRuleEngine(registry);
  const declaration = makeDeclaration('justify-content');
  declaration.isOverridden = undefined;

  const result = engine.inspect(makeContext(declaration, makeLayout()));
  assert.equal(result, INACTIVE_RESULT);
  assert.equal(calls.length, 1, 'the effective declaration goes through the normal dispatch');
});

test('a cross-rule override backtick-wraps and escapes the winner selector (P2-SEC-06)', () => {
  calls = [];
  const registry = new RuleRegistry();
  const engine = new InactiveRuleEngine(registry);
  const declaration = makeDeclaration('color');
  declaration.isOverridden = true;
  declaration.isCrossRuleOverride = true;
  // A backtick is legal inside a quoted attribute value; a backslash is a
  // legal CSS escape — both must not break out of the Markdown code span.
  declaration.overriddenBy = {
    ...makeDeclaration('color'),
    selectorText: '[data-x="a`b"]\\.c',
  };

  const result = engine.inspect(makeContext(declaration, makeLayout()));
  assert.ok(result, 'a cross-rule override is always inactive');
  assert.equal(result.reasonCode, REASON_CODES.OVERRIDDEN_BY_CROSS_RULE_DECLARATION);
  assert.ok(
    result.reasonText.includes('Overridden by `'),
    'the winner selector is backtick-wrapped'
  );
  assert.ok(
    !result.reasonText.includes('a`b'),
    'a raw backtick from the selector never reaches the markdown text'
  );
  assert.ok(
    result.reasonText.includes('[data-x="a\\`b"]\\\\.c'),
    'backticks and backslashes are escaped inside the code span'
  );
});
