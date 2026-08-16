import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RuleRegistry,
  createDefaultRuleRegistry,
  normalizePropertyName,
  registerDefaultRules,
} from '../../inactive/ruleRegistry';
import { InactiveRule } from '../../inactive/inactiveRule';

function makeRule(propertyName: string): InactiveRule {
  return {
    propertyName,
    inspect(): undefined {
      return undefined;
    },
  };
}

test('normalizePropertyName trims, collapses whitespace and lowercases', () => {
  assert.equal(normalizePropertyName('  Justify-Content  '), 'justify-content');
  assert.equal(normalizePropertyName('grid\tCOLUMN'), 'grid column');
  assert.equal(normalizePropertyName('  gap '), 'gap');
  assert.equal(normalizePropertyName(''), '');
});

test('register + lookup round-trip with normalization', () => {
  const registry = new RuleRegistry();
  registry.register(makeRule('justify-content'));
  assert.ok(registry.lookup('  Justify-Content  '));
  assert.ok(registry.lookup('JUSTIFY-CONTENT'));
  assert.equal(registry.lookup('justify-content')?.propertyName, 'justify-content');
  assert.equal(registry.size, 1);
});

test('lookup returns undefined for unknown properties', () => {
  const registry = new RuleRegistry();
  registry.register(makeRule('justify-content'));
  assert.equal(registry.lookup('color'), undefined);
  assert.equal(registry.lookup('   '), undefined);
  assert.equal(registry.lookup(''), undefined);
});

test('has() reflects registration', () => {
  const registry = new RuleRegistry();
  registry.register(makeRule('justify-content'));
  assert.ok(registry.has('Justify-Content'));
  assert.ok(!registry.has('color'));
});

test('register throws on a duplicate canonical name', () => {
  const registry = new RuleRegistry();
  registry.register(makeRule('Justify-Content'));
  assert.throws(() => registry.register(makeRule('justify-content')), /Duplicate rule/);
});

test('register throws on an empty property name', () => {
  const registry = new RuleRegistry();
  assert.throws(() => registry.register(makeRule('   ')), /empty property name/);
});

test('registerAll registers every rule in order', () => {
  const registry = new RuleRegistry();
  registry.registerAll([makeRule('gap'), makeRule('flex'), makeRule('grid-area')]);
  assert.equal(registry.size, 3);
  assert.ok(registry.has('gap'));
  assert.ok(registry.has('flex'));
  assert.ok(registry.has('grid-area'));
});

test('propertyNames lists canonical names', () => {
  const registry = new RuleRegistry();
  registry.registerAll([makeRule(' Gap '), makeRule('FLEX')]);
  assert.deepEqual([...registry.propertyNames].sort(), ['flex', 'gap']);
});

test('registerDefaultRules registers the complete default rule set', () => {
  const registry = new RuleRegistry();
  registerDefaultRules(registry);

  const expected = [
    // PR6 Phase 2 — flex/grid families.
    'justify-content',
    'align-items',
    'align-content',
    'place-items',
    'place-content',
    'align-self',
    'order',
    'flex-grow',
    'flex-shrink',
    'flex-basis',
    'flex',
    'justify-items',
    'gap',
    'row-gap',
    'column-gap',
    'justify-self',
    'grid-column',
    'grid-row',
    'grid-area',
    'place-self',
    // PR7 — flex-only / grid-template container families.
    'flex-direction',
    'flex-flow',
    'flex-wrap',
    'grid',
    'grid-auto-columns',
    'grid-auto-flow',
    'grid-auto-rows',
    'grid-template',
    'grid-template-areas',
    'grid-template-columns',
    'grid-template-rows',
    'grid-row-start',
    'grid-row-end',
    'grid-column-start',
    'grid-column-end',
    'grid-gap',
    'grid-column-gap',
    'grid-row-gap',
    // PR6 Phase 3 — position / flow / overflow / misc families.
    'top',
    'right',
    'bottom',
    'left',
    'inset',
    'z-index',
    'float',
    'clear',
    'overflow',
    'overflow-x',
    'overflow-y',
    'text-overflow',
    'pointer-events',
    'vertical-align',
    'object-fit',
    // PR7 — anchor positioning / table / sizing families.
    'position-anchor',
    'padding',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'width',
    'height',
    // Final-PR7 — element-kind / context families.
    'object-position',
    'border',
    'margin',
    'background',
    'transform-box',
    'transform-origin',
    'backface-visibility',
    'backdrop-filter',
    'transform',
    'perspective',
    'margin-top',
    'margin-bottom',
    'resize',
    'overflow-clip-margin',
    'scroll-snap-type',
    'scroll-snap-align',
    'scroll-margin',
    'border-spacing',
    'empty-cells',
    'caption-side',
    'list-style-type',
    'list-style-position',
    'list-style-image',
    // PR Level 3 — scroll-container-dependent properties and the
    // pseudo-element family.
    'scrollbar-gutter',
    'overscroll-behavior',
    '::before',
    '::after',
    '::first-letter',
  ];
  assert.deepEqual([...registry.propertyNames].sort(), [...expected].sort());
  assert.equal(registry.size, expected.length);
});

test('registerDefaultRules rejects accidental double registration', () => {
  const registry = new RuleRegistry();
  registerDefaultRules(registry);
  assert.throws(() => registerDefaultRules(registry), /Duplicate rule/);
});

test('createDefaultRuleRegistry is fully populated and functional', () => {
  const registry = createDefaultRuleRegistry();
  assert.ok(registry.has('justify-content'));
  assert.ok(registry.has('flex'));
  assert.ok(registry.has('gap'));
  assert.ok(registry.has('grid-area'));
  assert.ok(registry.has('place-content'));
  assert.ok(registry.has('place-self'));
  assert.ok(registry.has('text-overflow'));
  assert.ok(registry.has('transform'));
  assert.ok(registry.has('perspective'));
  assert.ok(registry.has('margin-top'));
  assert.ok(registry.has('grid-column-start'));
  assert.ok(registry.has('top'));
  assert.ok(registry.has('inset'));
  assert.ok(registry.has('z-index'));
  assert.ok(registry.has('float'));
  assert.ok(registry.has('clear'));
  assert.ok(registry.has('overflow'));
  assert.ok(registry.has('overflow-x'));
  assert.ok(registry.has('overflow-y'));
  assert.ok(registry.has('pointer-events'));
  assert.ok(registry.has('vertical-align'));
  assert.ok(registry.has('object-fit'));
  assert.ok(registry.has('object-position'));
  assert.ok(registry.has('backdrop-filter'));
  assert.ok(registry.has('resize'));
  assert.ok(registry.has('border-spacing'));
  assert.ok(registry.has('list-style-type'));
  assert.ok(registry.has('scrollbar-gutter'));
  assert.ok(registry.has('overscroll-behavior'));
  assert.ok(registry.has('::before'));
  assert.ok(registry.has('::after'));
  assert.ok(registry.has('::first-letter'));
});
