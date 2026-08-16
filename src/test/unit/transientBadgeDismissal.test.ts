import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransientBadgeDismissalGate } from '../../diagnostics/overrideJumpTarget';

/**
 * Unit tests for the transient override-winner badge dismissal gate.
 *
 * The jump command places the cursor programmatically, and that placement
 * itself fires `onDidChangeTextEditorSelection` — the same event that
 * must dismiss the badge. The gate consumes the jump's own placement
 * event exactly once and dismisses on every other selection change, so
 * the `→|` badge survives its own jump but never a user interaction.
 */

const PLACEMENT = { startLine: 26, startCharacter: 4, endLine: 26, endCharacter: 4 };

function selection(
  startLine: number,
  startCharacter: number,
  endLine = startLine,
  endCharacter = startCharacter
) {
  return { startLine, startCharacter, endLine, endCharacter };
}

test('the gate keeps the badge for its own jump placement event', () => {
  const gate = new TransientBadgeDismissalGate(PLACEMENT);
  assert.equal(gate.consume([PLACEMENT]), false, 'the placement event is not a dismissal');
});

test('the placement token is consumed once — a repeat of the same selection dismisses', () => {
  const gate = new TransientBadgeDismissalGate(PLACEMENT);
  gate.consume([PLACEMENT]);
  assert.equal(gate.consume([PLACEMENT]), true);
});

test('any first event other than the placement dismisses immediately', () => {
  const gate = new TransientBadgeDismissalGate(PLACEMENT);
  assert.equal(gate.consume([selection(3, 8)]), true);
});

test('a first event at a different position on the same line dismisses', () => {
  const gate = new TransientBadgeDismissalGate(PLACEMENT);
  assert.equal(
    gate.consume([selection(26, 9)]),
    true,
    'same line but different character is a real caret move'
  );
});

test('a multi-selection event never matches the single-placement token', () => {
  const gate = new TransientBadgeDismissalGate(PLACEMENT);
  assert.equal(gate.consume([PLACEMENT, selection(0, 0)]), true);
});

test('every event after the placement is a dismissal', () => {
  const gate = new TransientBadgeDismissalGate(PLACEMENT);
  gate.consume([PLACEMENT]);
  assert.equal(gate.consume([selection(10, 0)]), true);
  assert.equal(gate.consume([selection(11, 0)]), true);
  assert.equal(gate.consume([selection(12, 5)]), true);
});

test('a range selection (shift+click) dismisses even before the placement arrives', () => {
  const gate = new TransientBadgeDismissalGate(PLACEMENT);
  assert.equal(gate.consume([selection(20, 0, 26, 4)]), true);
});
