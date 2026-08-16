import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OverrideJumpTarget,
  buildOverrideHoverMarkdown,
  encodeJumpArgs,
  isValidJumpTarget,
  jumpTargetFromLocation,
  parseJumpPayload,
  textMatchesPropertyAt,
} from '../../diagnostics/overrideJumpTarget';

const TARGET: OverrideJumpTarget = {
  line: 5,
  character: 3,
  length: 15,
  propertyName: 'justify-content',
};

test('encodeJumpArgs: wraps the target in the documented one-element array', () => {
  const encoded = encodeJumpArgs(TARGET);
  assert.equal(
    encoded,
    encodeURIComponent(
      JSON.stringify([{ line: 5, character: 3, length: 15, propertyName: 'justify-content' }])
    )
  );
  // Round-trip: VS Code parses the URI component and passes the ARRAY.
  assert.deepEqual(JSON.parse(decodeURIComponent(encoded)), [{ ...TARGET }]);
});

test('buildOverrideHoverMarkdown: emits the specified sentence + trusted jump link', () => {
  const md = buildOverrideHoverMarkdown(TARGET);
  assert.ok(md.startsWith('Overridden by a later declaration of the same property.'));
  assert.ok(md.includes('[Go to overriding declaration (Line 5)]'));
  assert.ok(
    !md.includes('→') && !md.includes('$(arrow-right)'),
    'no arrow adornment of any kind in the link label'
  );
  assert.ok(
    md.includes(`(command:noeffect.jumpAndHighlight?${encodeJumpArgs(TARGET)})`),
    'the link carries the encoded jump arguments'
  );
});

test('jumpTargetFromLocation: converts the 0-based local range to 1-based payload', () => {
  const target = jumpTargetFromLocation(
    { filePath: '/x/style.css', startLine: 3, startColumn: 2, endLine: 3, endColumn: 17 },
    'justify-content'
  );
  assert.deepEqual(target, {
    line: 4,
    character: 3,
    length: 15,
    propertyName: 'justify-content',
  });
});

test('isValidJumpTarget: rejects malformed payloads', () => {
  assert.ok(isValidJumpTarget(TARGET));
  assert.ok(!isValidJumpTarget(undefined));
  assert.ok(!isValidJumpTarget(null));
  assert.ok(!isValidJumpTarget('bogus'));
  assert.ok(!isValidJumpTarget({}));
  assert.ok(!isValidJumpTarget({ ...TARGET, line: 0 }), 'line must be 1-based');
  assert.ok(!isValidJumpTarget({ ...TARGET, character: 0 }), 'character must be 1-based');
  assert.ok(!isValidJumpTarget({ ...TARGET, length: 0 }), 'length must be positive');
  assert.ok(!isValidJumpTarget({ ...TARGET, line: 1.5 }), 'line must be an integer');
  assert.ok(!isValidJumpTarget({ ...TARGET, propertyName: 42 }), 'propertyName must be a string');
});

test('parseJumpPayload: accepts the command-link array form', () => {
  assert.deepEqual(parseJumpPayload([TARGET]), TARGET);
});

test('parseJumpPayload: tolerates a bare object and rejects garbage', () => {
  assert.deepEqual(parseJumpPayload(TARGET), TARGET);
  assert.equal(parseJumpPayload('nope'), undefined);
  assert.equal(parseJumpPayload(undefined), undefined);
  assert.equal(parseJumpPayload({}), undefined);
  assert.equal(parseJumpPayload([{}]), undefined);
  assert.equal(parseJumpPayload([TARGET, TARGET]), undefined, 'multiple args are malformed');
});

const DOC = '.dup-ext {\n  justify-content: center;\n  justify-content: flex-end;\n}\n';

test('textMatchesPropertyAt: matches the live text at the target range', () => {
  const target: OverrideJumpTarget = { line: 3, character: 3, length: 15, propertyName: 'justify-content' };
  assert.ok(textMatchesPropertyAt(DOC, target));
});

test('textMatchesPropertyAt: a stale range (property text changed) fails', () => {
  const stale: OverrideJumpTarget = { line: 3, character: 3, length: 15, propertyName: 'color' };
  assert.ok(!textMatchesPropertyAt(DOC, stale));
});

test('textMatchesPropertyAt: out-of-bounds ranges fail instead of crashing', () => {
  const beyondEnd: OverrideJumpTarget = { line: 99, character: 3, length: 15, propertyName: 'justify-content' };
  const beyondColumn: OverrideJumpTarget = { line: 3, character: 99, length: 15, propertyName: 'justify-content' };
  const overshooting: OverrideJumpTarget = { line: 3, character: 3, length: 100, propertyName: 'justify-content' };
  assert.ok(!textMatchesPropertyAt(DOC, beyondEnd));
  assert.ok(!textMatchesPropertyAt(DOC, beyondColumn));
  assert.ok(!textMatchesPropertyAt(DOC, overshooting));
});

test('textMatchesPropertyAt: CRLF documents match cleanly', () => {
  const crlf = DOC.replace(/\n/g, '\r\n');
  assert.ok(textMatchesPropertyAt(crlf, { line: 3, character: 3, length: 15, propertyName: 'justify-content' }));
});

test('textMatchesPropertyAt: property text is compared case-insensitively', () => {
  const target: OverrideJumpTarget = { line: 3, character: 3, length: 15, propertyName: 'Justify-Content' };
  assert.ok(textMatchesPropertyAt(DOC, target));
});