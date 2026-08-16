import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CssAstParser, CssSourceRange } from '../../parser/cssAst';

/**
 * Unit tests for PR4: the positional CSS parser.
 *
 * The parser must extract names, declaration ranges, property-name ranges,
 * value ranges and end-anchor ranges exactly, while being insensitive to
 * whitespace, ignoring comments without breaking positions and preserving
 * declaration order.
 */

const parser = new CssAstParser();

function sliceAt(text: string, r: CssSourceRange): string {
  const lines = text.split('\n');
  const parts: string[] = [];
  for (let ln = r.startLine; ln <= r.endLine; ln++) {
    const line = lines[ln] ?? '';
    if (ln === r.startLine && ln === r.endLine) {
      parts.push(line.slice(r.startColumn, r.endColumn));
    } else if (ln === r.startLine) {
      parts.push(line.slice(r.startColumn));
    } else if (ln === r.endLine) {
      parts.push(line.slice(0, r.endColumn));
    } else {
      parts.push(line);
    }
  }
  return parts.join('\n');
}

test('parses a single rule with exact name/declaration/property/value/anchor ranges', () => {
  const css = '.non-flex {\n  justify-content: center;\n}\n';
  const rules = parser.parse(css, '/fake/styles.css');

  assert.equal(rules.length, 1);
  assert.equal(rules[0].selector, '.non-flex');

  const decl = rules[0].declarations[0];
  assert.equal(decl.name, 'justify-content');
  assert.equal(decl.value, 'center');
  assert.equal(decl.important, false);

  assert.deepEqual(decl.nameRange, { startLine: 1, startColumn: 2, endLine: 1, endColumn: 17 });
  assert.deepEqual(decl.valueRange, { startLine: 1, startColumn: 19, endLine: 1, endColumn: 25 });
  assert.deepEqual(decl.range, { startLine: 1, startColumn: 2, endLine: 1, endColumn: 26 });
  assert.deepEqual(decl.endAnchorRange, { startLine: 1, startColumn: 25, endLine: 1, endColumn: 26 });

  assert.equal(sliceAt(css, decl.range), 'justify-content: center;');
  assert.equal(sliceAt(css, decl.nameRange), 'justify-content');
  assert.equal(sliceAt(css, decl.valueRange), 'center');
  assert.equal(sliceAt(css, decl.endAnchorRange), ';');
});

test('preserves declaration order and supports multiple declarations per rule', () => {
  const css = 'a {\n  color: red;\n  justify-content: center;\n}\n';
  const rules = parser.parse(css, '/fake/styles.css');

  assert.equal(rules.length, 1);
  const names = rules[0].declarations.map((d) => d.name);
  assert.deepEqual(names, ['color', 'justify-content']);
});

test('is whitespace-insensitive', () => {
  const css = '.x{justify-content:center;color : red}';
  const rules = parser.parse(css, '/fake/styles.css');
  const [jc, color] = rules[0].declarations;

  assert.equal(jc.name, 'justify-content');
  assert.equal(jc.value, 'center');
  assert.equal(color.name, 'color');
  assert.equal(color.value, 'red');
  assert.equal(sliceAt(css, jc.nameRange), 'justify-content');
  assert.equal(sliceAt(css, color.nameRange), 'color');
  assert.equal(sliceAt(css, jc.endAnchorRange), ';');
  // No trailing semicolon: the anchor is the last value character.
  assert.equal(sliceAt(css, color.endAnchorRange), 'd');
});

test('ignores comments without breaking positions', () => {
  const css = '/* lead */ .x {\n  /* inner */ justify-content: center; /* after */\n}\n';
  const rules = parser.parse(css, '/fake/styles.css');

  assert.equal(rules.length, 1);
  assert.equal(rules[0].selector, '.x');

  const decl = rules[0].declarations[0];
  assert.equal(decl.name, 'justify-content');
  assert.equal(decl.value, 'center');
  assert.equal(sliceAt(css, decl.nameRange), 'justify-content');
  assert.equal(sliceAt(css, decl.valueRange), 'center');
  assert.equal(sliceAt(css, decl.endAnchorRange), ';');
});

test('parses multiple rules', () => {
  const css = '.a { color: red; }\n.b { justify-content: center; }\n';
  const rules = parser.parse(css, '/fake/styles.css');

  assert.deepEqual(
    rules.map((r) => r.selector),
    ['.a', '.b']
  );
  assert.equal(rules[0].declarations.length, 1);
  assert.equal(rules[1].declarations.length, 1);
});

test('handles a declaration without a trailing semicolon', () => {
  const css = '.a { color: red }\n';
  const rules = parser.parse(css, '/fake/styles.css');
  const decl = rules[0].declarations[0];

  assert.equal(decl.name, 'color');
  assert.equal(decl.value, 'red');
  assert.equal(sliceAt(css, decl.range), 'color: red');
  assert.equal(sliceAt(css, decl.endAnchorRange), 'd');
});

test('keeps parens and strings inside values intact', () => {
  const css = 'a { background: url(http://x/y.png); content: "::"; }\n';
  const rules = parser.parse(css, '/fake/styles.css');
  const [bg, content] = rules[0].declarations;

  assert.equal(bg.name, 'background');
  assert.equal(bg.value, 'url(http://x/y.png)');
  assert.equal(content.name, 'content');
  assert.equal(content.value, '"::"');
  assert.equal(sliceAt(css, bg.valueRange), 'url(http://x/y.png)');
  assert.equal(sliceAt(css, content.valueRange), '"::"');
});

test('does not confuse a colon inside a selector', () => {
  const css = 'a:hover { color: red; }\n';
  const rules = parser.parse(css, '/fake/styles.css');

  assert.equal(rules.length, 1);
  assert.equal(rules[0].selector, 'a:hover');
  assert.equal(rules[0].declarations.length, 1);
  assert.equal(rules[0].declarations[0].name, 'color');
});

test('skips empty declarations and empty rules', () => {
  assert.equal(parser.parse('a { ; }\n', '/fake/a.css')[0].declarations.length, 0);
  assert.equal(parser.parse('a { }\n', '/fake/a.css')[0].declarations.length, 0);
  assert.equal(parser.parse('a { /* nothing */ }\n', '/fake/a.css')[0].declarations.length, 0);
});

test('parses rules nested inside an @media group', () => {
  const css = '@media (min-width: 600px) { .non-flex { justify-content: center; } }\n';
  const rules = parser.parse(css, '/fake/styles.css');

  // The @media wrapper itself is not a rule; its inner rule is collected.
  assert.equal(rules.length, 1);
  assert.equal(rules[0].selector, '.non-flex');
  assert.equal(rules[0].declarations[0].name, 'justify-content');
});

test('parses declarations inside an at-rule declaration block (@font-face)', () => {
  const css = '@font-face { font-family: "X"; src: url(x.woff); }\n';
  const rules = parser.parse(css, '/fake/styles.css');

  assert.equal(rules.length, 1);
  assert.equal(rules[0].selector, '@font-face');
  assert.deepEqual(
    rules[0].declarations.map((d) => d.name),
    ['font-family', 'src']
  );
});

test('parses @keyframes frame rules', () => {
  const css = '@keyframes fade { from { opacity: 0 } to { opacity: 1 } }\n';
  const rules = parser.parse(css, '/fake/styles.css');

  assert.deepEqual(
    rules.map((r) => r.selector),
    ['from', 'to']
  );
  assert.equal(rules[0].declarations[0].name, 'opacity');
  assert.equal(rules[1].declarations[0].name, 'opacity');
});

test('does not crash on malformed input', () => {
  assert.doesNotThrow(() => parser.parse('', '/fake/a.css'));
  assert.doesNotThrow(() => parser.parse('not css at all', '/fake/a.css'));
  assert.doesNotThrow(() => parser.parse('.a { color: red', '/fake/a.css'));
  assert.doesNotThrow(() => parser.parse('@import url("x.css");', '/fake/a.css'));
  assert.doesNotThrow(() => parser.parse('{ stray }', '/fake/a.css'));
});

test('parseDeclarationList: parses a style attribute value with exact ranges', () => {
  const value = 'color: red;  margin-top: 5px';
  const decls = parser.parseDeclarationList(value);

  assert.equal(decls.length, 2);
  assert.equal(decls[0].name, 'color');
  assert.equal(decls[0].value, 'red');
  assert.deepEqual(decls[0].range, { startLine: 0, startColumn: 0, endLine: 0, endColumn: 11 });
  assert.deepEqual(decls[0].endAnchorRange, { startLine: 0, startColumn: 10, endLine: 0, endColumn: 11 });

  // Semicolon-less trailing declaration is still parsed, terminated by the end.
  assert.equal(decls[1].name, 'margin-top');
  assert.equal(decls[1].value, '5px');
  assert.deepEqual(decls[1].range, { startLine: 0, startColumn: 13, endLine: 0, endColumn: 28 });
  assert.deepEqual(decls[1].endAnchorRange, { startLine: 0, startColumn: 27, endLine: 0, endColumn: 28 });
});

test('parseDeclarationList: keeps !important in the value (matching CDP)', () => {
  const decls = parser.parseDeclarationList('margin-top: 5px !important');
  assert.equal(decls.length, 1);
  assert.equal(decls[0].value, '5px !important');
  assert.equal(decls[0].important, true);
});

test('parseDeclarationList: ignores comments and skips malformed items', () => {
  const decls = parser.parseDeclarationList('color: red; /* note */ : broken; gap: 2px');
  assert.equal(decls.length, 2);
  assert.equal(decls[0].name, 'color');
  assert.equal(decls[1].name, 'gap');
});

test('parseDeclarationList: skips stray braces and never crashes', () => {
  assert.equal(parser.parseDeclarationList('{ color: red }').length, 0);
  assert.deepEqual(parser.parseDeclarationList(''), []);
  assert.deepEqual(parser.parseDeclarationList('   ;  '), []);
  assert.deepEqual(parser.parseDeclarationList('not a declaration'), []);
  assert.doesNotThrow(() => parser.parseDeclarationList('color: red'));
});

test('parseDeclarationList: multi-line values carry exact line positions', () => {
  const value = 'color: red;\n  margin: 0;';
  const decls = parser.parseDeclarationList(value);

  assert.equal(decls.length, 2);
  assert.deepEqual(decls[1].range, { startLine: 1, startColumn: 2, endLine: 1, endColumn: 12 });
});
