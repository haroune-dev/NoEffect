import * as vscode from 'vscode';
import * as path from 'path';
import { NoEffectSettings } from '../config/settings';
import { CssIssue } from '../models/cssIssue';
import { CssLocation } from '../models/cssLocation';
import { logger } from '../utils/logger';
import { createInactivePropertyExplanation } from './inactivePropertyExplanation';
import { planDecorations, signatureFromPlan } from './decorationPlanner';
import { evidenceLine } from '../status/derive';
import { isOverrideReasonCode } from '../inactive/reasonCode';
import {
  buildOverrideHoverMarkdown,
  isValidJumpTarget,
  jumpTargetFromLocation,
} from './overrideJumpTarget';
import {
  buildWinnerBadgeHover,
  OverrideWinnerBadge,
  planOverrideWinnerBadges,
  signatureFromWinnerBadges,
} from './overrideWinnerPlanner';

interface IconHoverEntry {
  /** The one-character source anchor immediately before the inline icon. */
  range: vscode.Range;
  issues: CssIssue[];
}

/**
 * Manages the visual decorations applied to the editor to indicate
 * inactive CSS properties.
 *
 * Three decoration types are used:
 *   1. **Dim decoration** — reduces the opacity of the property text.
 *   2. **Inline icon decoration** — places a ⚠ warning icon immediately
 *      after the CSS declaration with a hover tooltip explaining the issue.
 *   3. **Winning gutter decoration** — places a `→|` badge in the glyph
 *      margin of the declaration that WON a cascade override, with a
 *      hover tooltip listing the declaration(s) it overrode.
 *
 * The first two can be independently toggled via user settings; the
 * winner badge is derived from the same issues and always rendered.
 */
export class DecorationManager {
  private dimDecorationType: vscode.TextEditorDecorationType | null = null;
  private iconDecorationType: vscode.TextEditorDecorationType | null = null;
  private winningGutterDecorationType: vscode.TextEditorDecorationType | null = null;
  private extensionPath: string;

  /** Track which files currently have decorations applied */
  private decoratedFiles: Set<string> = new Set();

  /** Hover data for inline attachments, keyed by document path. */
  private iconHoverEntries: Map<string, IconHoverEntry[]> = new Map();

  /**
   * The latest issue list applied per document path. Decoration types are
   * recreated when settings OR the color theme change, and recreating a
   * type drops every decoration it rendered — this snapshot lets
   * `reapplyAllDecorations` restore the exact visible state without a
   * new analysis.
   */
  private lastIssues: Map<string, CssIssue[]> = new Map();

  /**
   * Signature of the last decoration state applied per document path
   * (decoration cache). An identical signature means the editor already
   * renders exactly this state, so `setDecorations` is skipped entirely.
   */
  private appliedSignatures: Map<string, string> = new Map();

  constructor(extensionPath: string) {
    this.extensionPath = extensionPath;
  }

  /**
   * Create the decoration types. Must be called once after construction.
   * Separated from the constructor so that settings can be re-read
   * to recreate decorations when user preferences change.
   */
  createDecorationTypes(settings: NoEffectSettings): void {
    // Dispose any existing decoration types first
    this.disposeDecorationTypes();
    this.iconHoverEntries.clear();
    // Recreated decoration types render nothing until the next apply, so the
    // cached signatures must not suppress that apply.
    this.appliedSignatures.clear();

    const inlineIconPath = path.join(this.extensionPath, 'assets', 'inline', 'warning-icon.svg');

    // Override-winner gutter badge (`→|`). The public API has no themable
    // `gutterIconPath` (string | Uri only), so the light/dark SVG variant
    // is selected from the ACTIVE color theme and the decoration types
    // are recreated on theme change (see the watcher in activate.ts).
    const themeKind = vscode.window.activeColorTheme.kind;
    const winnerIconFile =
      themeKind === vscode.ColorThemeKind.Light ||
      themeKind === vscode.ColorThemeKind.HighContrastLight
        ? 'override-winner-light.svg'
        : 'override-winner-dark.svg';

    this.winningGutterDecorationType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.file(
        path.join(this.extensionPath, 'assets', 'gutter', winnerIconFile)
      ),
      gutterIconSize: 'contain',
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.infoForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });

    // Dim decoration: reduces opacity of the property text
    if (settings.highlightStyle === 'both' || settings.highlightStyle === 'dimOnly') {
      this.dimDecorationType = vscode.window.createTextEditorDecorationType({
        opacity: '0.45',
        // Subtle styling to indicate inactivity without being noisy
        fontStyle: 'italic',
      });
    }

    if (settings.highlightStyle === 'both' || settings.highlightStyle === 'iconOnly') {
      this.iconDecorationType = vscode.window.createTextEditorDecorationType({
        // This decoration is applied only to the icon's one-character anchor
        // (normally the semicolon), not to the whole CSS property.
        cursor: 'pointer',
        after: {
          contentIconPath: vscode.Uri.file(inlineIconPath),
          margin: '0 0 0 4px',
          width: '14px',
          height: '14px',
          textDecoration: 'none; cursor: pointer;',
        },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      });
    }
    logger.info(
      `Decoration types created (style: ${settings.highlightStyle}, ` +
      `dim: ${!!this.dimDecorationType}, icon: ${!!this.iconDecorationType})`
    );
  }

  /**
   * Apply decorations to a text editor based on the analysis results.
   *
   * Every range comes from the real mapped local declaration (PR4):
   * the declaration range is dimmed and the end-anchor range hosts the
   * inline icon. Additionally, the override-winner badges are planned
   * from the same issues and rendered in the gutter of the winning
   * declaration lines. When there is nothing to render at all, previously
   * applied decorations for this editor are cleared instead.
   *
   * Decoration cache (performance PR): when the planned state equals the
   * state already applied to this document, the editor is left untouched —
   * no `setDecorations` calls at all. `force` bypasses the cache (used when
   * re-applying to a different editor that shows the same document).
   *
   * @param editor - The active text editor to decorate
   * @param issues - The inactive CSS properties to highlight
   * @param force - Re-apply even when the decoration state is unchanged
   */
  applyDecorations(editor: vscode.TextEditor, issues: CssIssue[], force: boolean = false): void {
    const filePath = editor.document.uri.fsPath;
    this.lastIssues.set(filePath, issues);

    const plan = planDecorations(issues, filePath);
    const winnerBadges = planOverrideWinnerBadges(issues, filePath);
    const signature = [signatureFromPlan(plan), signatureFromWinnerBadges(winnerBadges)].join(
      '#'
    );

    if (!force && this.appliedSignatures.get(filePath) === signature) {
      logger.info('[Decorations] Skipping — decoration state unchanged');
      return;
    }

    if (plan.length === 0 && winnerBadges.length === 0) {
      this.clearDecorationsForEditor(editor);
      this.appliedSignatures.set(filePath, signature);
      return;
    }

    logger.info(
      `[Decorations] Applying ${plan.length} issue${plan.length === 1 ? '' : 's'} ` +
        `and ${winnerBadges.length} override-winner badge${winnerBadges.length === 1 ? '' : 's'}`
    );

    // Dimming uses the full local declaration range resolved by PR4.
    const dimRanges: vscode.DecorationOptions[] = plan.map(({ dimRange }) => ({
      range: this.toVscodeRange(dimRange),
    }));

    if (this.dimDecorationType) {
      editor.setDecorations(this.dimDecorationType, dimRanges);
      logger.info('[Decorations] Dimming range resolved');
    }

    // Inline icon anchored on the exact end position derived from the local
    // AST range (normally the semicolon). One icon per declaration; multiple
    // diagnostics for the exact same declaration share the icon and are
    // shown together in its hover.
    if (this.iconDecorationType) {
      const issuesByAnchor = new Map<string, { range: vscode.Range; issues: CssIssue[] }>();

      for (const { issue, iconAnchorRange } of plan) {
        const anchorRange = this.toVscodeRange(iconAnchorRange);
        const rangeKey = [
          anchorRange.start.line,
          anchorRange.start.character,
          anchorRange.end.line,
          anchorRange.end.character,
        ].join(':');
        const existing = issuesByAnchor.get(rangeKey);

        if (existing) {
          existing.issues.push(issue);
        } else {
          issuesByAnchor.set(rangeKey, { range: anchorRange, issues: [issue] });
        }
      }

      const hoverEntries = Array.from(issuesByAnchor.values());
      this.iconHoverEntries.set(filePath, hoverEntries);

      // The hover tooltip is deliberately NOT attached here: the language
      // hover provider (provideInlineIconHover) is the single hover source,
      // otherwise the identical message would be rendered twice — once by
      // the decoration and once by the provider — at the same position.
      const iconRanges = hoverEntries.map(({ range }) => ({ range }));

      editor.setDecorations(this.iconDecorationType, iconRanges);

      if (iconRanges.length > 0) {
        logger.info('[Decorations] Inline icon applied');
      }
    } else {
      this.iconHoverEntries.delete(filePath);
    }

    // Override-winner gutter badges on the winning declaration lines.
    // The hover message is attached directly to the decoration options:
    // hover providers cannot serve the glyph margin, and unlike the inline
    // icon there is no second hover source that could duplicate it.
    if (this.winningGutterDecorationType) {
      const winnerOptions = winnerBadges.map((badge) => ({
        range: this.toVscodeRange(badge.winnerRange),
        hoverMessage: this.winnerHoverMessage(badge),
      }));
      editor.setDecorations(this.winningGutterDecorationType, winnerOptions);

      if (winnerOptions.length > 0) {
        logger.info('[Decorations] Override-winner gutter badges applied');
      }
    }

    this.decoratedFiles.add(filePath);
    this.appliedSignatures.set(filePath, signature);
    logger.info('[Decorations] Decorations updated successfully');
  }

  /**
   * Remove all decorations from a specific editor.
   */
  clearDecorationsForEditor(editor: vscode.TextEditor): void {
    if (this.dimDecorationType) {
      editor.setDecorations(this.dimDecorationType, []);
    }
    if (this.iconDecorationType) {
      editor.setDecorations(this.iconDecorationType, []);
    }
    if (this.winningGutterDecorationType) {
      editor.setDecorations(this.winningGutterDecorationType, []);
    }
    this.decoratedFiles.delete(editor.document.uri.fsPath);
    this.iconHoverEntries.delete(editor.document.uri.fsPath);
    this.appliedSignatures.delete(editor.document.uri.fsPath);
    this.lastIssues.delete(editor.document.uri.fsPath);
    logger.info('[Decorations] Clearing decorations');
  }

  /**
   * Remove all decorations for a file, regardless of which visible editor
   * is showing it. Used when the document changes or closes so stale
   * ranges never remain visible.
   */
  clearDecorationsForFile(filePath: string): void {
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.fsPath === filePath
    );

    if (editor) {
      this.clearDecorationsForEditor(editor);
    } else {
      this.decoratedFiles.delete(filePath);
      this.iconHoverEntries.delete(filePath);
      this.appliedSignatures.delete(filePath);
      this.lastIssues.delete(filePath);
      logger.info('[Decorations] Clearing decorations');
    }
  }

  /**
   * Remove all decorations from all visible editors.
   */
  clearAllDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.clearDecorationsForEditor(editor);
    }
    this.decoratedFiles.clear();
    this.iconHoverEntries.clear();
    this.appliedSignatures.clear();
    this.lastIssues.clear();
    logger.info('Cleared all decorations');
  }

  /**
   * Re-apply the latest known decoration state to every visible editor
   * from the `lastIssues` snapshot. Used after the decoration types were
   * recreated (settings or color-theme change): the fresh types render
   * nothing until `setDecorations` runs again, so without this the editor
   * would go blank until the next analysis.
   */
  reapplyAllDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const issues = this.lastIssues.get(editor.document.uri.fsPath);
      if (issues) {
        this.applyDecorations(editor, issues, true);
      }
    }
    logger.info('[Decorations] Re-applied decorations after decoration-type recreation');
  }

  /**
   * Returns whether the given file currently has decorations applied.
   */
  hasDecorations(filePath: string): boolean {
    return this.decoratedFiles.has(filePath);
  }

  /**
   * Single hover source for the inactive-property tooltip.
   *
   * The icon is an `after` attachment whose anchor is the final source
   * character of the declaration (normally the `;`), so this provider
   * serves the tooltip for any pointer position over that one-character
   * anchor range — both the semicolon and the rendered icon. The icon
   * decoration itself carries no `hoverMessage`, so the exact same message
   * can never be rendered twice in one tooltip.
   */
  provideInlineIconHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | undefined {
    const entries = this.iconHoverEntries.get(document.uri.fsPath);
    if (!entries) {
      return undefined;
    }

    const entry = entries.find(({ range }) => range.contains(position));
    if (!entry) {
      return undefined;
    }

    return new vscode.Hover(this.buildHoverMessage(entry.issues), entry.range);
  }

  /**
   * The public decoration API cannot give an `after` attachment a range of
   * its own. The planner anchors it to the final source character of the
   * declaration (normally the semicolon) via the PR4 end-anchor range, so
   * CSS language hovers remain available on the property name and value
   * while this tooltip is limited to the warning icon/semicolon.
   */
  private toVscodeRange(loc: CssLocation): vscode.Range {
    return new vscode.Range(
      new vscode.Position(loc.startLine, loc.startColumn),
      new vscode.Position(loc.endLine, loc.endColumn)
    );
  }

  /**
   * Tooltip for one override-winner gutter badge. The pure planner builds
   * the markdown (override listing + jump link); `isTrusted` is enabled
   * ONLY when a command link is present, exactly like the inline-icon
   * hover message.
   */
  private winnerHoverMessage(badge: OverrideWinnerBadge): vscode.MarkdownString {
    const { markdown, hasCommandLink } = buildWinnerBadgeHover(badge);
    const md = new vscode.MarkdownString();
    md.appendMarkdown(markdown);
    if (hasCommandLink) {
      md.isTrusted = true;
    }
    return md;
  }

  /**
   * Dispose of decoration types (but not the manager itself).
   * Called when settings change so types can be recreated.
   */
  private disposeDecorationTypes(): void {
    this.dimDecorationType?.dispose();
    this.iconDecorationType?.dispose();
    this.winningGutterDecorationType?.dispose();
    this.dimDecorationType = null;
    this.iconDecorationType = null;
    this.winningGutterDecorationType = null;
  }

  /**
   * Build a Markdown hover message for the warning icon, matching
   * the Chromium DevTools inactive-property tooltip format.
   *
   * Example output:
   *   The **display: block** property prevents **justify-content** from having an effect.
   *
   *   Try adding **display: grid** or **display: flex** to make this element into a container.
   *
   * An overridden declaration (OVERRIDDEN_BY_LATER_DECLARATION) with a
   * mapped winning declaration gets the INTERACTIVE override tooltip:
   * the fixed sentence plus a trusted command link that jumps to the
   * overriding declaration. `isTrusted` is enabled ONLY for messages
   * that actually carry a command link — command execution in the hover
   * widget requires it, and untrusted messages have no reason to allow
   * it.
   */
  private buildHoverMessage(issues: CssIssue[]): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    let hasCommandLink = false;

    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i];

      const overrideTarget = issue.overrideTarget;
      if (
        isOverrideReasonCode(issue.reasonCode) &&
        overrideTarget &&
        isValidJumpTarget(jumpTargetFromLocation(overrideTarget, issue.propertyName))
      ) {
        md.appendMarkdown(buildOverrideHoverMarkdown(jumpTargetFromLocation(overrideTarget, issue.propertyName)));
        hasCommandLink = true;
      } else {
        // Prefer the browser/analyser's detailed explanation. The fallback is
        // still a complete DevTools-style cause and suggestion, never a terse
        // "has no effect" message.
        md.appendMarkdown(issue.reason?.trim() || createInactivePropertyExplanation(issue.propertyName));
      }

      // Multi-companion evidence (Level 11): the bounded line comes ONLY
      // from the pure derive formatter (guarded on metadata presence here —
      // wrapper-flow issues carry none). Rendered as its own secondary
      // italic footnote paragraph, subordinate to the primary reason —
      // never a second verdict.
      const { evaluatedCount, inactiveCount, analyzedCompanions } = issue;
      if (
        typeof evaluatedCount === 'number' &&
        typeof inactiveCount === 'number' &&
        typeof analyzedCompanions === 'number'
      ) {
        const evidence = evidenceLine(evaluatedCount, inactiveCount, analyzedCompanions);
        if (evidence) {
          md.appendMarkdown(`\n\n_${evidence}_`);
        }
      }

      // Separate multiple issues with a horizontal rule
      if (i < issues.length - 1) {
        md.appendMarkdown('\n\n---\n\n');
      }
    }

    if (hasCommandLink) {
      md.isTrusted = true;
    }

    return md;
  }

  /**
   * Full disposal — call during extension deactivation.
   */
  dispose(): void {
    this.clearAllDecorations();
    this.iconHoverEntries.clear();
    this.disposeDecorationTypes();
  }
}
