/**
 * Interactive jump-and-flash for overridden CSS declarations
 * (`noeffect.jumpAndHighlight`).
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
 *      ~1s, then removes it.
 *
 * Safety:
 *   - Stale guard: before flashing, the text at the target range must
 *     still read the expected property name (the file may have been
 *     edited since the analysis). A stale or out-of-bounds range only
 *     reveals the target line — never flashes wrong text, never crashes.
 *   - Single active flash: a repeated click cancels the previous timer
 *     immediately; the old highlight cannot linger as a "ghost".
 *   - Lifecycle: any editor/document change or close clears the active
 *     flash; `dispose()` tears everything down.
 */
import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { OverrideJumpTarget, parseJumpPayload, textMatchesPropertyAt } from '../diagnostics/overrideJumpTarget';

/** How long the flash highlight stays visible before auto-clearing. */
const FLASH_DURATION_MS = 1000;

export class OverrideJumpController {
  private flashDecorationType: vscode.TextEditorDecorationType | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private flashEditor: vscode.TextEditor | null = null;

  /** Entry point for the `noeffect.jumpAndHighlight` command. */
  handle(payload: unknown): void {
    const target = parseJumpPayload(payload);
    if (!target) {
      logger.warn('[OverrideJump] Ignored malformed jump payload');
      return;
    }
    void this.jumpToDeclaration(target);
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

    this.cancelFlash();

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

      editor.selection = new vscode.Selection(start, start);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      this.flash(editor, range);
      logger.info(`[OverrideJump] Highlighting overriding ${target.propertyName ?? 'declaration'} at line ${target.line}`);
    } else {
      // Stale or out-of-bounds range (the file was edited after the
      // analysis): reveal the target line without flashing any text.
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
    this.cancelFlash();
    this.flashDecorationType?.dispose();
    this.flashDecorationType = null;
  }
}