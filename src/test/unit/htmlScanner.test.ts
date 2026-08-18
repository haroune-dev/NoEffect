import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanHtmlForCss, CssFragmentPosition } from '../../parser/htmlScanner';

/**
 * Unit tests for the embedded-CSS HTML scanner: it must find `<style>`
 * blocks and `style=""` attributes with EXACT document positions, in
 * document order, while ignoring comments, scripts and anything that is
 * not real markup.
 */

function sliceAt(text: string, pos: CssFragmentPosition, length: number): string {
  const line = text.split('\n')[pos.startLine] ?? '';
  return line.slice(pos.startColumn, pos.startColumn + length);
}

test('finds one style block with its exact content and position', () => {
  const html = '<html><head><style>\n  .box {\n    width: 100px;\n  }\n</style></head></html>';
  const { styleBlocks } = scanHtmlForCss(html);

  assert.equal(styleBlocks.length, 1);
  assert.equal(styleBlocks[0].content, '\n  .box {\n    width: 100px;\n  }\n');
  // The content starts right after the opening `>` of `<style>` — the
  // position is an OFFSET-based (line, column): the leading newline of the
  // content maps to the end of the tag's line (column 19).
  assert.deepEqual(styleBlocks[0].position, { startLine: 0, startColumn: 19 });
});

test('preserves multiple blocks in document order with per-block positions', () => {
  const html = [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<style>.a { color: red; }</style>',
    '<style>',
    '.b {',
    '  margin-top: 1px;',
    '}',
    '</style>',
    '</head>',
    '</html>',
  ].join('\n');
  const { styleBlocks } = scanHtmlForCss(html);

  assert.equal(styleBlocks.length, 2);
  assert.equal(styleBlocks[0].content, '.a { color: red; }');
  assert.deepEqual(styleBlocks[0].position, { startLine: 3, startColumn: 7 });
  assert.equal(styleBlocks[1].content, '\n.b {\n  margin-top: 1px;\n}\n');
  assert.deepEqual(styleBlocks[1].position, { startLine: 4, startColumn: 7 });
});

test('handles a style tag with attributes and a case-insensitive name', () => {
  const html = '<HEAD><STYLE TYPE="text/css">.x { top: 1px; }</STYLE></HEAD>';
  const { styleBlocks } = scanHtmlForCss(html);

  assert.equal(styleBlocks.length, 1);
  assert.equal(styleBlocks[0].content, '.x { top: 1px; }');
});

test('a literal </style> inside CSS strings ends the block (HTML raw-text semantics)', () => {
  const html = '<style>.x::after { content: "</style>"; }</style><div class="x"></div>';
  const { styleBlocks } = scanHtmlForCss(html);

  assert.equal(styleBlocks.length, 1);
  assert.equal(styleBlocks[0].content, '.x::after { content: "');
});

test('an unterminated style block yields its content and ends the scan', () => {
  const { styleBlocks } = scanHtmlForCss('<style>.x { color: red; }');
  assert.equal(styleBlocks.length, 1);
  assert.equal(styleBlocks[0].content, '.x { color: red; }');
});

test('collects style attributes with exact value positions', () => {
  const html = '<div id="a" style="color: red;  margin-top: 5px;">x</div>';
  const { styleAttributes } = scanHtmlForCss(html);

  assert.equal(styleAttributes.length, 1);
  assert.equal(styleAttributes[0].value, 'color: red;  margin-top: 5px;');
  assert.deepEqual(styleAttributes[0].position, { startLine: 0, startColumn: 19 });
  assert.equal(sliceAt(html, styleAttributes[0].position, styleAttributes[0].value.length), styleAttributes[0].value);
});

test('supports single-quoted, bare and case-insensitive style attributes', () => {
  const html = "<div STYLE='color: red'> <p style=top:1px> <span style = \"gap: 2px\">";
  const { styleAttributes } = scanHtmlForCss(html);

  assert.equal(styleAttributes.length, 3);
  assert.equal(styleAttributes[0].value, 'color: red');
  assert.equal(styleAttributes[1].value, 'top:1px');
  assert.equal(styleAttributes[2].value, 'gap: 2px');
});

test('preserves multiple attributes in document order', () => {
  const html = '<div style="color: red">a</div><p style="margin: 0">b</p>';
  const { styleAttributes } = scanHtmlForCss(html);

  assert.equal(styleAttributes.length, 2);
  assert.equal(styleAttributes[0].value, 'color: red');
  assert.equal(styleAttributes[1].value, 'margin: 0');
});

test('a > inside a quoted attribute value does not end the tag', () => {
  const html = '<div title="a > b" style="color: red">x</div>';
  const { styleAttributes } = scanHtmlForCss(html);

  assert.equal(styleAttributes.length, 1);
  assert.equal(styleAttributes[0].value, 'color: red');
});

test('an empty style attribute is collected with its value range', () => {
  const html = '<div style="">x</div>';
  const { styleAttributes } = scanHtmlForCss(html);

  assert.equal(styleAttributes.length, 1);
  assert.equal(styleAttributes[0].value, '');
  // Position points at the value start (right after the opening quote).
  assert.equal(sliceAt(html, styleAttributes[0].position, 1), '"'.slice(0, 1));
  assert.deepEqual(styleAttributes[0].position, { startLine: 0, startColumn: 12 });
});

test('multiline attribute values carry exact positions', () => {
  const html = '<div style="color: red;\n  margin: 0;">x</div>';
  const { styleAttributes } = scanHtmlForCss(html);

  assert.equal(styleAttributes.length, 1);
  assert.equal(styleAttributes[0].value, 'color: red;\n  margin: 0;');
  assert.deepEqual(styleAttributes[0].position, { startLine: 0, startColumn: 12 });
});

test('ignores style markup inside HTML comments', () => {
  const html = '<!-- <style>.a { color: red; }</style> --><div style="color: red"></div>';
  const { styleBlocks, styleAttributes } = scanHtmlForCss(html);

  assert.equal(styleBlocks.length, 0, 'no style block may be read from a comment');
  assert.equal(styleAttributes.length, 1, 'only the real attribute counts');
  assert.equal(styleAttributes[0].value, 'color: red');
});

test('ignores style-looking text inside scripts', () => {
  const html = '<script>const x = \'<style>.a { color: red; }</style>\';</script><div style="top: 1px"></div>';
  const { styleBlocks, styleAttributes } = scanHtmlForCss(html);

  assert.equal(styleBlocks.length, 0, 'no style block may be read from a script');
  assert.equal(styleAttributes.length, 1);
  assert.equal(styleAttributes[0].value, 'top: 1px');
});

test('a text < that does not start a valid tag name is not treated as markup', () => {
  const html = '<p>a < b</p><div style="color: red">x</div>';
  const { styleAttributes } = scanHtmlForCss(html);

  assert.equal(styleAttributes.length, 1);
  assert.equal(styleAttributes[0].value, 'color: red');
});

test('a valid element name after < keeps its style attribute (browser behavior)', () => {
  const html = '<p>see <b style="color: red">x</b></p>';
  const { styleAttributes } = scanHtmlForCss(html);

  assert.equal(styleAttributes.length, 1);
  assert.equal(styleAttributes[0].value, 'color: red');
});

test('malformed HTML never throws', () => {
  assert.doesNotThrow(() => scanHtmlForCss('<!DOCTYPE html><div style="unterminated'));
  assert.doesNotThrow(() => scanHtmlForCss('<style>.a { color: red;'));
  assert.doesNotThrow(() => scanHtmlForCss('<!-- unterminated comment <style>x</style>'));
  assert.doesNotThrow(() => scanHtmlForCss(''));
  assert.doesNotThrow(() => scanHtmlForCss('no markup at all'));
});

test('empty and markup-free documents produce no fragments', () => {
  assert.deepEqual(scanHtmlForCss(''), { styleBlocks: [], styleAttributes: [] });
  assert.deepEqual(scanHtmlForCss('plain text, no tags'), { styleBlocks: [], styleAttributes: [] });
});

test('style attribute with no value is collected as empty', () => {
  const { styleAttributes } = scanHtmlForCss('<div style>x</div>');
  assert.equal(styleAttributes.length, 1);
  assert.equal(styleAttributes[0].value, '');
});
