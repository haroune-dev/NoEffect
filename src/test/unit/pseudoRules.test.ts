import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pseudoRules } from '../../inactive/rules/pseudo/pseudoRules';
import { REASON_CODES } from '../../inactive/reasonCode';
import { MatchedCssDeclaration } from '../../engine/inactivePropertyEngine';
import { LayoutContext, createLayoutContext } from '../../engine/layoutContext';
import { InactiveRuleEngine } from '../../inactive/inactiveRuleEngine';
import { createDefaultRuleRegistry } from '../../inactive/ruleRegistry';
import { InactiveRule } from '../../inactive/inactiveRule';

const beforeRule = pseudoRules.find((r) => r.propertyName === '::before');
const afterRule = pseudoRules.find((r) => r.propertyName === '::after');
const firstLetterRule = pseudoRules.find((r) => r.propertyName === '::first-letter');
assert.ok(beforeRule && afterRule && firstLetterRule);

function makeDeclaration(
  propertyName: string,
  pseudoElement: string | undefined,
  propertyValue = '1px'
): MatchedCssDeclaration {
  return {
    nodeId: 1,
    styleSheetId: 'sheet-1',
    selectorText: '.x::' + (pseudoElement ?? ''),
    pseudoElement,
    propertyName,
    propertyValue,
    origin: 'author',
  };
}

function makeLayout(pseudoContent?: Map<string, string>): LayoutContext {
  return createLayoutContext({
    display: 'block',
    parentDisplay: 'none',
    // Default: the pseudo facts WERE collected and no content is declared
    // on any pseudo — the production collector always supplies a map.
    pseudoContent: pseudoContent ?? new Map(),
    computedStyles: new Map([['display', 'block']]),
  });
}

// ── Generated-content guard (::before / ::after) ────────────────────────

test('pseudo rules: cover the three pseudo-element types', () => {
  assert.deepEqual(
    pseudoRules.map((r) => r.propertyName).sort(),
    ['::after', '::before', '::first-letter']
  );
});

test('::before: every property is inactive when content is missing', () => {
  for (const propertyName of ['width', 'height', 'background-color', 'display']) {
    const result = beforeRule.inspect(
      makeLayout(),
      makeDeclaration(propertyName, 'before')
    );
    assert.ok(result, `${propertyName} should be inactive without content`);
    assert.equal(result.reasonCode, REASON_CODES.GENERATED_PSEUDO_MISSING);
    assert.equal(result.propertyName, propertyName);
  }
});

test('::before: active when content is a real value', () => {
  for (const content of ['"hi"', 'attr(data-x)', 'url("x.png")', 'counter(x)']) {
    const layout = makeLayout(new Map([['before', content]]));
    assert.equal(
      beforeRule.inspect(layout, makeDeclaration('width', 'before')),
      undefined,
      `width should stay active with content: ${content}`
    );
  }
});

test('::before: inactive when the winning content is none or normal', () => {
  for (const content of ['none', 'normal']) {
    const layout = makeLayout(new Map([['before', content]]));
    const result = beforeRule.inspect(layout, makeDeclaration('width', 'before'));
    assert.ok(result, `width should be inactive with content: ${content}`);
    assert.equal(result.reasonCode, REASON_CODES.GENERATED_PSEUDO_MISSING);
  }
});

test('::before: the content declaration itself is never flagged', () => {
  for (const content of [undefined, 'none', '"hi"']) {
    const layout = makeLayout(content === undefined ? undefined : new Map([['before', content]]));
    assert.equal(
      beforeRule.inspect(layout, makeDeclaration('content', 'before')),
      undefined,
      'the content declaration itself is meaningful'
    );
  }
});

test('::after: every property is inactive when content is missing', () => {
  for (const propertyName of ['width', 'height', 'background-color', 'display']) {
    const result = afterRule.inspect(makeLayout(), makeDeclaration(propertyName, 'after'));
    assert.ok(result, `${propertyName} should be inactive without content`);
    assert.equal(result.reasonCode, REASON_CODES.GENERATED_PSEUDO_MISSING);
  }

  const withContent = makeLayout(new Map([['after', '"x"']]));
  assert.equal(afterRule.inspect(withContent, makeDeclaration('width', 'after')), undefined);
});

test('computed pseudo content overrides the declared-content fallback', () => {
  for (const pseudoType of ['before', 'after'] as const) {
    const layout = createLayoutContext({
      display: 'block',
      parentDisplay: 'none',
      pseudoContent: new Map([[pseudoType, '"declared"']]),
      pseudoBoxFacts: new Map([[pseudoType, { computedContent: 'none' }]]),
      computedStyles: new Map([['display', 'block']]),
    });
    const rule: InactiveRule = pseudoType === 'before' ? beforeRule! : afterRule!;
    assert.equal(
      layout.pseudoBoxContexts?.has(pseudoType) ?? false,
      false,
      `::${pseudoType} must not receive a pseudo-box context when Chromium reports no content`
    );
    assert.equal(
      rule.inspect(layout, makeDeclaration('width', pseudoType))?.reasonCode,
      REASON_CODES.GENERATED_PSEUDO_MISSING,
      `computed content controls whether ::${pseudoType} has a box`
    );
  }
});

test('::before: a declaration for another pseudo type is ignored', () => {
  assert.equal(beforeRule.inspect(makeLayout(), makeDeclaration('width', 'after')), undefined);
  assert.equal(afterRule.inspect(makeLayout(), makeDeclaration('width', 'before')), undefined);
});

test('::before: no decision when the pseudo facts are missing', () => {
  const noFacts = createLayoutContext({
    display: 'block',
    parentDisplay: 'none',
    computedStyles: new Map([['display', 'block']]),
  });
  assert.equal(beforeRule.inspect(noFacts, makeDeclaration('width', 'before')), undefined);
});

test('::before: no decision when display data is missing', () => {
  const noDisplay = createLayoutContext({
    display: '',
    parentDisplay: 'none',
    pseudoContent: new Map(),
    computedStyles: new Map(),
  });
  assert.equal(beforeRule.inspect(noDisplay, makeDeclaration('width', 'before')), undefined);
});

// ── Generated pseudo boxes use their real box context ───────────────────

function makeGeneratedBoxLayout(pseudoType: 'before' | 'after', display: string): LayoutContext {
  return createLayoutContext({
    display: 'block',
    parentDisplay: 'none',
    nodeName: 'div',
    // Deliberately contradictory fallback evidence proves that the computed
    // pseudo fact, captured from Chromium, is the source of truth.
    pseudoContent: new Map([[pseudoType, 'none']]),
    pseudoBoxFacts: new Map([[pseudoType, { display, position: 'relative', computedContent: '"box"' }]]),
    computedStyles: new Map([['display', 'block']]),
  });
}

test('::before with computed generated content is a real flex box for every supported rule', () => {
  const layout = makeGeneratedBoxLayout('before', 'flex');
  const pseudoBox = layout.pseudoBoxContexts?.get('before');
  assert.equal(pseudoBox?.display, 'flex');

  const engine = new InactiveRuleEngine(createDefaultRuleRegistry());
  for (const [propertyName, propertyValue] of [
    ['display', 'flex'],
    ['justify-content', 'center'],
    ['position', 'relative'],
    ['width', '10px'],
    ['height', '10px'],
  ]) {
    assert.equal(
      engine.inspect({
        declaration: makeDeclaration(propertyName, 'before', propertyValue),
        computedStyles: layout.computedStyles,
        layout,
      }),
      undefined,
      `${propertyName} must be judged on the generated ::before box`
    );
  }
});

test('::after with computed generated content is a real grid box for every supported rule', () => {
  const layout = makeGeneratedBoxLayout('after', 'grid');
  const pseudoBox = layout.pseudoBoxContexts?.get('after');
  assert.equal(pseudoBox?.display, 'grid');

  const engine = new InactiveRuleEngine(createDefaultRuleRegistry());
  for (const [propertyName, propertyValue] of [
    ['display', 'grid'],
    ['grid-template-columns', '1fr'],
    ['position', 'relative'],
    ['width', '10px'],
    ['height', '10px'],
  ]) {
    assert.equal(
      engine.inspect({
        declaration: makeDeclaration(propertyName, 'after', propertyValue),
        computedStyles: layout.computedStyles,
        layout,
      }),
      undefined,
      `${propertyName} must be judged on the generated ::after box`
    );
  }
});

test('generated pseudo applicability is deterministic', () => {
  const layout = makeGeneratedBoxLayout('before', 'flex');
  const engine = new InactiveRuleEngine(createDefaultRuleRegistry());
  const context = {
    declaration: makeDeclaration('justify-content', 'before', 'center'),
    computedStyles: layout.computedStyles,
    layout,
  };
  assert.deepEqual(engine.inspect(context), engine.inspect(context));
});

test('::first-letter behavior does not use generated-content facts', () => {
  const layout = makeGeneratedBoxLayout('before', 'flex');
  const result = firstLetterRule.inspect(layout, makeDeclaration('display', 'first-letter', 'flex'));
  assert.equal(result?.reasonCode, REASON_CODES.FIRST_LETTER_UNSUPPORTED_PROPERTY);
});

// ── ::first-letter eligibility ──────────────────────────────────────────

test('::first-letter: unsupported properties are inactive', () => {
  for (const propertyName of [
    'display',
    'position',
    'top',
    'width',
    'height',
    'box-sizing',
    'transform',
    'overflow',
    'flex',
    'grid-column',
    'align-items',
    'content',
    'cursor',
    'outline',
    'text-align',
    'clear',
    'text-emphasis',
  ]) {
    const result = firstLetterRule.inspect(
      makeLayout(),
      makeDeclaration(propertyName, 'first-letter')
    );
    assert.ok(result, `${propertyName} should be inactive on ::first-letter`);
    assert.equal(result.reasonCode, REASON_CODES.FIRST_LETTER_UNSUPPORTED_PROPERTY);
    assert.equal(result.propertyName, propertyName);
  }
});

test('::first-letter: supported properties stay active', () => {
  for (const propertyName of [
    'font-size',
    'font-weight',
    'font-family',
    'color',
    'opacity',
    'background-color',
    'margin',
    'margin-top',
    'padding',
    'border',
    'border-radius',
    'box-shadow',
    'line-height',
    'letter-spacing',
    'text-transform',
    'text-decoration',
    'text-shadow',
    'float',
    'vertical-align',
    'initial-letter',
  ]) {
    assert.equal(
      firstLetterRule.inspect(makeLayout(), makeDeclaration(propertyName, 'first-letter')),
      undefined,
      `${propertyName} should stay active on ::first-letter`
    );
  }
});

test('::first-letter: custom properties apply everywhere', () => {
  assert.equal(
    firstLetterRule.inspect(makeLayout(), makeDeclaration('--brand-color', 'first-letter')),
    undefined
  );
});

test('::first-letter: a declaration for another pseudo type is ignored', () => {
  assert.equal(
    firstLetterRule.inspect(makeLayout(), makeDeclaration('display', 'before')),
    undefined
  );
});

test('::first-letter: no decision when display data is missing', () => {
  const noDisplay = createLayoutContext({
    display: '',
    parentDisplay: 'none',
    computedStyles: new Map(),
  });
  assert.equal(
    firstLetterRule.inspect(noDisplay, makeDeclaration('display', 'first-letter')),
    undefined
  );
});
