import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { htmlFragmentCache, embeddedParseCache, embeddedMappingCache, inlineMappingKey } from '../../cache/embeddedCssCache';
import { LocalDeclarationMatch } from '../../matcher/declarationMapper';

/**
 * Unit tests for the embedded-CSS caches: the HTML fragment scan, the
 * fragment parse (document-relative shifts) and the inline mapping cache.
 * All three are content-addressed — only an HTML content change can
 * invalidate an entry.
 */

function writeFixture(name: string, html: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `noeffect-emb-${name}-`));
  const filePath = path.join(dir, 'index.html');
  fs.writeFileSync(filePath, html);
  return filePath;
}

const HTML_WITH_EMBEDDED = [
  '<!DOCTYPE html>',
  '<html>',
  '<head>',
  '<style>',
  '  .box {',
  '    width: 100px;',
  '    margin-top: 10px;',
  '  }',
  '</style>',
  '</head>',
  '<body>',
  '  <div class="box" style="color: red; margin-top: 5px;">x</div>',
  '</body>',
  '</html>',
].join('\n');

test('html fragment cache: identical content hits, changed content re-scans', () => {
  htmlFragmentCache.reset();
  const filePath = writeFixture('frag', HTML_WITH_EMBEDDED);

  const first = htmlFragmentCache.getOrParse(filePath);
  assert.equal(first.hit, false, 'first access must be a miss');
  assert.equal(first.fragments.styleBlocks.length, 1);
  assert.equal(first.fragments.styleAttributes.length, 1);
  assert.equal(first.fragments.styleBlocks[0].content, '\n  .box {\n    width: 100px;\n    margin-top: 10px;\n  }\n');
  assert.equal(first.fragments.styleAttributes[0].value, 'color: red; margin-top: 5px;');

  const second = htmlFragmentCache.getOrParse(filePath);
  assert.equal(second.hit, true, 'identical content must hit');
  assert.equal(second.fragments, first.fragments, 'the cached fragments are reused');

  fs.writeFileSync(filePath, '<div style="top: 1px"></div>');
  const third = htmlFragmentCache.getOrParse(filePath);
  assert.equal(third.hit, false, 'a content change must miss and re-scan');
  assert.equal(third.fragments.styleBlocks.length, 0);
  assert.equal(third.fragments.styleAttributes.length, 1);
  assert.equal(third.fragments.styleAttributes[0].value, 'top: 1px');

  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
});

test('embedded parse cache: block rules are shifted to document positions', () => {
  htmlFragmentCache.reset();
  embeddedParseCache.reset();
  const filePath = writeFixture('parse', HTML_WITH_EMBEDDED);
  const { fragments, hash } = htmlFragmentCache.getOrParse(filePath);

  const parsed = embeddedParseCache.getOrParse(filePath, hash, fragments);
  assert.equal(parsed.blocks.length, 1);
  assert.equal(parsed.blocks[0].rules.length, 1);

  const decl = parsed.blocks[0].rules[0].declarations[0];
  assert.equal(decl.name, 'width');
  // Document line 5 is '    width: 100px;' — the block content line 1
  // shifted by the block start (line 3, after the <style> tag).
  assert.deepEqual(decl.range, { startLine: 5, startColumn: 4, endLine: 5, endColumn: 17 });
  assert.deepEqual(decl.nameRange, { startLine: 5, startColumn: 4, endLine: 5, endColumn: 9 });
  assert.deepEqual(decl.valueRange, { startLine: 5, startColumn: 11, endLine: 5, endColumn: 16 });
  assert.deepEqual(decl.endAnchorRange, { startLine: 5, startColumn: 16, endLine: 5, endColumn: 17 });

  // The parse cache is content-addressed on the HTML hash.
  const again = embeddedParseCache.getOrParse(filePath, hash, fragments);
  assert.equal(again, parsed, 'identical (path, hash) must hit');
});

test('embedded parse cache: attribute declarations are shifted to document positions', () => {
  htmlFragmentCache.reset();
  embeddedParseCache.reset();
  const filePath = writeFixture('attr', HTML_WITH_EMBEDDED);
  const { fragments, hash } = htmlFragmentCache.getOrParse(filePath);

  const parsed = embeddedParseCache.getOrParse(filePath, hash, fragments);
  assert.equal(parsed.attributes.length, 1);

  const [color, marginTop] = parsed.attributes[0].declarations;
  assert.equal(color.name, 'color');
  assert.equal(color.value, 'red');
  // '  <div class="box" style="' — the value starts at document line 11,
  // column 26; 'margin-top: 5px;' starts 12 characters later.
  assert.deepEqual(color.range, { startLine: 11, startColumn: 26, endLine: 11, endColumn: 37 });
  assert.deepEqual(marginTop.range, { startLine: 11, startColumn: 38, endLine: 11, endColumn: 54 });
  assert.deepEqual(marginTop.valueRange, { startLine: 11, startColumn: 50, endLine: 11, endColumn: 53 });
  assert.deepEqual(marginTop.endAnchorRange, { startLine: 11, startColumn: 53, endLine: 11, endColumn: 54 });
});

test('embedded parse cache: identical block text at different positions stays distinct', () => {
  htmlFragmentCache.reset();
  embeddedParseCache.reset();
  const html = [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<style>.x { color: red; }</style>',
    '<style>.x { color: red; }</style>',
    '</head>',
    '<body>',
    '<div class="x"></div>',
    '</body>',
    '</html>',
  ].join('\n');
  const filePath = writeFixture('twoblocks', html);
  const { fragments, hash } = htmlFragmentCache.getOrParse(filePath);

  const parsed = embeddedParseCache.getOrParse(filePath, hash, fragments);
  assert.equal(parsed.blocks.length, 2);
  // Identical text, different content hashes? No — same text, same hash —
  // but the DOCUMENT positions differ, which is what the mapping cache
  // fingerprint must distinguish. The parse cache keeps both entries by
  // construction (one per fragment).
  assert.equal(parsed.blocks[0].contentHash, parsed.blocks[1].contentHash);
  assert.deepEqual(
    parsed.blocks[0].rules[0].declarations[0].range,
    { startLine: 3, startColumn: 12, endLine: 3, endColumn: 23 }
  );
  assert.deepEqual(
    parsed.blocks[1].rules[0].declarations[0].range,
    { startLine: 4, startColumn: 12, endLine: 4, endColumn: 23 }
  );
});

test('embedded mapping cache: stores and retrieves matches deterministically', () => {
  embeddedMappingCache.reset();
  const key = inlineMappingKey('/x/index.html', 'hash-1', 0, 'margin-top', '5px');
  assert.equal(embeddedMappingCache.get(key), undefined, 'unknown key is a miss');

  const match: LocalDeclarationMatch = {
    filePath: '/x/index.html',
    selector: '',
    declaration: {} as never,
    declarationRange: { filePath: '/x/index.html', startLine: 11, startColumn: 37, endLine: 11, endColumn: 52 },
    propertyNameRange: { filePath: '/x/index.html', startLine: 11, startColumn: 37, endLine: 11, endColumn: 47 },
    valueRange: { filePath: '/x/index.html', startLine: 11, startColumn: 49, endLine: 11, endColumn: 52 },
    iconAnchorRange: { filePath: '/x/index.html', startLine: 11, startColumn: 51, endLine: 11, endColumn: 52 },
  };
  embeddedMappingCache.set(key, match);
  assert.deepEqual(embeddedMappingCache.get(key), match);

  // A null result (unmappable) is cached too — the key is known.
  const nullKey = inlineMappingKey('/x/index.html', 'hash-1', 0, 'gap', '8px');
  embeddedMappingCache.set(nullKey, null);
  assert.equal(embeddedMappingCache.get(nullKey), null);

  // A different content hash is a different entry.
  const otherKey = inlineMappingKey('/x/index.html', 'hash-2', 0, 'margin-top', '5px');
  assert.equal(embeddedMappingCache.get(otherKey), undefined);
});

test('inline mapping key is deterministic and includes the content hash', () => {
  const a = inlineMappingKey('/x/i.html', 'h1', 2, 'color', 'red');
  const b = inlineMappingKey('/x/i.html', 'h1', 2, 'color', 'red');
  assert.equal(a, b);
  assert.notEqual(
    a,
    inlineMappingKey('/x/i.html', 'h2', 2, 'color', 'red'),
    'a content change must invalidate the mapping entry'
  );
  assert.notEqual(
    a,
    inlineMappingKey('/x/i.html', 'h1', 3, 'color', 'red'),
    'different attributes stay distinct'
  );
});
