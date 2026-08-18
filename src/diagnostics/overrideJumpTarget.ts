/**
 * Pure jump-and-highlight model for the `OVERRIDDEN_BY_LATER_DECLARATION`
 * hover navigation.
 *
 * Contracts:
 *   - `OverrideJumpTarget.line`/`character` are the 1-BASED display
 *     coordinates of the property-name start (the VS Code UI convention
 *     users see on the "Go to overriding declaration (Line N)" link; the
 *     command converts back with `(line - 1, character - 1)` exactly as
 *     the hover link contract defines).
 *   - `length` is the length in characters of the property name text, so
 *     the command's stale guard can verify the text at the target range
 *     still reads the expected property before flashing anything.
 *   - The link argument encoding is
 *     `encodeURIComponent(JSON.stringify([{ line, character, length, propertyName }]))`
 *     — VS Code parses the JSON and hands the ARRAY to the command.
 *
 * This module deliberately imports nothing from `vscode` so the encoding,
 * markdown text and stale-guard predicate are unit-testable outside the
 * extension host.
 */
import { CssLocation } from '../models/cssLocation';

export interface OverrideJumpTarget {
  /** 1-based display line of the property-name start. */
  line: number;

  /** 1-based display column of the property-name start. */
  character: number;

  /** Length in characters of the property name text at the range. */
  length: number;

  /** The property name expected at the range (stale-guard content). */
  propertyName?: string;
}

/** Command id embedded in the hover link (kept in one place, like COMMAND_IDS). */
export const JUMP_AND_HIGHLIGHT_COMMAND = 'noEffect.jumpAndHighlight';

/** Validate a target payload: integer numbers, 1-based line/character. */
export function isValidJumpTarget(target: unknown): target is OverrideJumpTarget {
  if (!target || typeof target !== 'object') {
    return false;
  }
  const t = target as Record<string, unknown>;
  const { line, character, length } = t;
  return (
    Number.isInteger(line) &&
    Number.isInteger(character) &&
    Number.isInteger(length) &&
    (line as number) >= 1 &&
    (character as number) >= 1 &&
    (length as number) >= 1 &&
    (typeof t.propertyName === 'string' || t.propertyName === undefined)
  );
}

/**
 * The VS Code command-link argument encoding:
 * `encodeURIComponent(JSON.stringify([{ line, character, length, propertyName }]))`.
 */
export function encodeJumpArgs(target: OverrideJumpTarget): string {
  return encodeURIComponent(JSON.stringify([target]));
}

/**
 * The interactive hover text for an overridden declaration, exactly as
 * specified: the override sentence followed by a command link that jumps
 * to the cascade-winning declaration.
 */
export function buildOverrideHoverMarkdown(target: OverrideJumpTarget): string {
  return (
    'Overridden by a later declaration of the same property.\n\n' +
    `[Go to overriding declaration (Line ${target.line})]` +
    `(command:${JUMP_AND_HIGHLIGHT_COMMAND}?${encodeJumpArgs(target)})`
  );
}

/** Convert a 0-based local property-name range into the 1-based jump payload. */
export function jumpTargetFromLocation(loc: CssLocation, propertyName: string): OverrideJumpTarget {
  return {
    line: loc.startLine + 1,
    character: loc.startColumn + 1,
    length: Math.max(0, loc.endColumn - loc.startColumn),
    propertyName,
  };
}

/**
 * Minimal vscode-free shape of an editor selection (0-based positions,
 * start/end only — enough for identity comparison).
 */
export interface SelectionShape {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

function sameSelection(a: SelectionShape, b: SelectionShape): boolean {
  return (
    a.startLine === b.startLine &&
    a.startCharacter === b.startCharacter &&
    a.endLine === b.endLine &&
    a.endCharacter === b.endCharacter
  );
}

/**
 * Dismissal gate for the transient override-winner gutter badge.
 *
 * The jump command places the cursor programmatically
 * (`editor.selection = …`), which itself fires
 * `onDidChangeTextEditorSelection` — the very event that must dismiss the
 * badge. The gate is constructed with the shape of that programmatic
 * placement and consumes selection events:
 *
 *   - the FIRST event exactly matching the placement is the jump's own
 *     effect → keep the badge, consume the placement token;
 *   - every other event (a different first event, or any later event) is
 *     a real user interaction (click, caret move, typing) → dismiss.
 *
 * If the placement event never arrives (VS Code did not emit one), the
 * first real interaction simply fails the match and dismisses — the
 * badge can never outlive its first genuine selection change.
 */
export class TransientBadgeDismissalGate {
  private placement: SelectionShape | null;

  constructor(placement: SelectionShape) {
    this.placement = placement;
  }

  /**
   * Feed one `onDidChangeTextEditorSelection` event (the selections as
   * shapes). Returns `true` when the badge must be dismissed.
   */
  consume(selections: SelectionShape[]): boolean {
    if (this.placement) {
      const isPlacement =
        selections.length === 1 && sameSelection(selections[0], this.placement);
      this.placement = null;
      return !isPlacement;
    }
    return true;
  }
}

/**
 * Parse and validate the value the command receives. Command links hand
 * the handler the JSON-parsed ARRAY from the link arguments
 * (`[{ line, character, length, propertyName }]` — a single-element
 * array in some VS Code versions, the bare object in others); a bare
 * object is tolerated for robustness. `undefined` means "ignore
 * silently".
 */
export function parseJumpPayload(value: unknown): OverrideJumpTarget | undefined {
  let candidate: unknown = value;
  if (Array.isArray(candidate)) {
    if (candidate.length !== 1) {
      return undefined;
    }
    candidate = candidate[0];
  }
  return isValidJumpTarget(candidate) ? candidate : undefined;
}

/**
 * Stale-guard predicate for the flash target: the text at the target
 * range (0-based after the `-1` conversion) must still contain the
 * expected property name, in-bounds. A stale or out-of-bounds range (the
 * file was edited after analysis) fails — the command then only reveals
 * the target line instead of flashing outdated text.
 */
export function textMatchesPropertyAt(text: string, target: OverrideJumpTarget): boolean {
  if (!isValidJumpTarget(target)) {
    return false;
  }
  const lineIndex = target.line - 1;
  const characterIndex = target.character - 1;
  const lines = text.split('\n');
  if (lineIndex < 0 || lineIndex >= lines.length) {
    return false;
  }
  let line = lines[lineIndex];
  // CRLF documents split cleanly too: the trailing \r never belongs to
  // the property-name slice.
  if (line.endsWith('\r')) {
    line = line.slice(0, -1);
  }
  if (characterIndex < 0 || characterIndex >= line.length) {
    return false;
  }
  if (characterIndex + target.length > line.length) {
    return false;
  }
  const slice = line.slice(characterIndex, characterIndex + target.length);
  if (typeof target.propertyName !== 'string' || target.propertyName.trim() === '') {
    return slice.trim() !== '';
  }
  return slice.toLowerCase() === target.propertyName.trim().toLowerCase();
}