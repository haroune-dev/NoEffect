/**
 * Interactive jump-and-flash for overridden CSS declarations
 * (`noEffect.jumpAndHighlight`).
 *
 * The hover tooltip of an overridden declaration embeds a trusted command
 * link carrying `{ line, character, length, propertyName }` (1-based
 * line/character display coordinates). This controller:
 *
 *   1. focuses the active editor's document in the active view column,
 *   2. moves the cursor to the overriding declaration's start
 *      (`(line - 1, character - 1)`) and reveals it centered,
 *   3. flashes the declaration with the THEME-NATIVE word-highlight
 *      color (adaptive in Dark, Light and High Contrast themes) for
 *      ~1s, then removes it,
 *   4. shows the TRANSIENT `→|` override-winner gutter badge on the
 *      winning declaration line — and only then. The badge is never
 *      rendered by the static analysis pass; it exists solely while this
 *      navigation is active and is dismissed by the FIRST subsequent
 *      selection change in the badged editor (click, caret move, typing).
 *
 * Safety:
 *   - Stale guard: before flashing, the text at the target range must
 *     still read the expected property name (the file may have been
 *     edited since the analysis). A stale or out-of-bounds range only
 *     reveals the target line — never flashes wrong text, never crashes.
 *   - Single active flash AND badge: a repeated click cancels the
 *     previous timer/badge immediately; the old highlight or badge can
 *     never linger as a "ghost".
 *   - Self-dismissal guard: placing the cursor fires a selection event
 *     itself — the TransientBadgeDismissalGate consumes that one event
 *     so the badge survives its own jump.
 *   - Lifecycle: any editor/document change or close clears the active
 *     flash and badge; `dispose()` tears everything down.
 */
import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { DecorationManager } from '../diagnostics/decorations';
import {
  OverrideJumpTarget,
  SelectionShape,
  TransientBadgeDismissalGate,
  parseJumpPayload,
  textMatchesPropertyAt,
} from '../diagnostics/overrideJumpTarget';

/** How long the flash highlight stays visible before auto-clearing. */
const FLASH_DURATION_MS = 1000;

export class OverrideJumpController {
  private flashDecorationType: vscode.TextEditorDecorationType | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private flashEditor: vscode.TextEditor | null = null;

  /** Selection watcher for the active transient badge, if any. */
  private badgeListener: vscode.Disposable | null = null;

  /** Dismissal gate of the active transient badge, if any. */
  private badgeGate: TransientBadgeDismissalGate | null = null;

  constructor(private readonly decorationManager: DecorationManager) {}

  /** Entry point for the `noEffect.jumpAndHighlight` command. */
  handle(payload: unknown): void {
    const target = parseJumpPayload(payload);
    if (!target) {
      logger.warn('[OverrideJump] Ignored malformed jump payload');
      return;
    }
    void this.jumpToDeclaration(target).catch((err: unknown) => {
      // showTextDocument (or the editor work after it) can reject — a
      // closed editor, a failed reveal. A navigation failure must never
      // surface as an unhandled rejection (P3-LOG-24).
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[OverrideJump] Jump failed: ${message}`);
    });
  }

  /**
   * Cancel every transient effect of a jump: the flash highlight AND the
   * override-winner gutter badge. Called by the activation lifecycle
   * hooks (active editor change, document edit/close) and before every
   * new jump, so a badge or highlight can never outlive its navigation.
   */
  cancelTransientEffects(): void {
    this.cancelFlash();
    this.cancelBadge();
  }

  /**
   * Navigate to the overriding declaration and flash it. Any previously
   * active flash is cancelled first (single-flash invariant).
   */
  private async jumpToDeclaration(target: OverrideJumpTarget): Promise<void> {
    const active = vscode.window.activeTextEditor;
    if (!active) {
      return;
    }

    this.cancelTransientEffects();

    const document = active.document;
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus: false,
    });

    const lineIndex = target.line - 1;
    const characterIndex = target.character - 1;

    if (textMatchesPropertyAt(editor.document.getText(), target)) {
      const start = new vscode.Position(lineIndex, characterIndex);
      const range = new vscode.Range(start, start.translate(0, target.length));
      const placement = new vscode.Selection(start, start);

      editor.selection = placement;
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      this.flash(editor, range);
      this.showBadge(editor, range, placement);
      logger.info(`[OverrideJump] Highlighting overriding ${target.propertyName ?? 'declaration'} at line ${target.line}`);
    } else {
      // Stale or out-of-bounds range (the file was edited after the
      // analysis): reveal the target line without flashing any text —
      // and without the badge, whose winning line can no longer be
      // trusted.
      const safeLine = Math.max(0, Math.min(lineIndex, editor.document.lineCount - 1));
      const lineRange = editor.document.lineAt(safeLine).range;
      editor.selection = new vscode.Selection(lineRange.start, lineRange.start);
      editor.revealRange(lineRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      logger.info(`[OverrideJump] Stale target at line ${target.line} — revealed line only, no flash`);
    }
  }

  /** Apply the theme-native flash highlight and schedule its removal. */
  private flash(editor: vscode.TextEditor, range: vscode.Range): void {
    this.cancelFlash();
    this.flashEditor = editor;

    if (!this.flashDecorationType) {
      this.flashDecorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground'),
        borderRadius: '2px',
      });
    }
    editor.setDecorations(this.flashDecorationType, [range]);

    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      this.clearAppliedFlash();
    }, FLASH_DURATION_MS);
  }

  /**
   * Show the transient override-winner gutter badge and arm its dismissal.
   *
   * The badge outlives the 1s flash — it persists until the user actually
   * interacts with the editor again. Dismissal is driven by
   * `onDidChangeTextEditorSelection` in the badged editor only (clicks or
   * caret moves in other editors leave it alone); the gate consumes the
   * selection event the jump itself produced.
   */
  private showBadge(
    editor: vscode.TextEditor,
    range: vscode.Range,
    placement: vscode.Selection
  ): void {
    this.cancelBadge();

    this.decorationManager.showTransientWinnerBadge(editor, range);
    this.badgeGate = new TransientBadgeDismissalGate(toSelectionShape(placement));

    const badgedEditor = editor;
    this.badgeListener = vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor !== badgedEditor || !this.badgeGate) {
        return;
      }
      if (this.badgeGate.consume(event.selections.map(toSelectionShape))) {
        logger.info('[OverrideJump] Selection changed — dismissing winner badge');
        this.cancelBadge();
      }
    });
  }

  /**
   * Remove the transient badge and its selection watcher immediately.
   * Safe to call repeatedly (rapid link clicks, editor changes, dispose).
   */
  private cancelBadge(): void {
    this.badgeListener?.dispose();
    this.badgeListener = null;
    this.badgeGate = null;
    this.decorationManager.clearTransientWinnerBadge();
  }

  /** Remove the applied flash decoration (no timer interaction). */
  private clearAppliedFlash(): void {
    if (this.flashDecorationType && this.flashEditor) {
      const editor = this.flashEditor;
      try {
        editor.setDecorations(this.flashDecorationType, []);
      } catch {
        // The editor may be closed already — nothing to clear.
      }
    }
    this.flashEditor = null;
  }

  /**
   * Cancel the pending auto-clear timer AND remove any visible flash
   * immediately. Safe to call repeatedly (rapid link clicks, editor or
   * document changes, dispose).
   */
  cancelFlash(): void {
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }
    this.clearAppliedFlash();
  }

  dispose(): void {
    this.cancelTransientEffects();
    this.flashDecorationType?.dispose();
    this.flashDecorationType = null;
  }
}

/** Convert a VS Code selection to the vscode-free shape the gate compares. */
function toSelectionShape(selection: vscode.Selection): SelectionShape {
  return {
    startLine: selection.start.line,
    startCharacter: selection.start.character,
    endLine: selection.end.line,
    endCharacter: selection.end.character,
  };
}