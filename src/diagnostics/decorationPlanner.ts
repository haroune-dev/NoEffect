/**
 * Pure decoration planner — converts the already-mapped CssIssue list into
 * the exact decoration ranges the DecorationManager renders.
 *
 * PR5 responsibilities:
 *   - use the real local declaration range (PR4) for dimming,
 *   - use the real local end-anchor range (PR4) for the inline icon,
 *   - never plan a decoration for an empty or invalid local range,
 *   - never plan two decorations for the same issue,
 *   - keep this module free of any `vscode` dependency so the decoration
 *     behavior is unit-testable outside the extension host.
 *
 * The visual style is unchanged: dimming the declaration and placing the
 * existing inline warning icon at the end of the declaration.
 */

import { CssIssue } from '../models';
import { CssLocation } from '../models/cssLocation';
import { logger } from '../utils/logger';
import { pathEquals } from '../utils/pathUtils';

/** A single issue ready to be rendered as an editor decoration. */
export interface PlannedDecoration {
  issue: CssIssue;

  /** Local declaration range used for dimming (always non-empty). */
  dimRange: CssLocation;

  /** Local one-character anchor range at the end of the declaration. */
  iconAnchorRange: CssLocation;
}

function isValidRange(range: CssLocation | undefined): range is CssLocation {
  if (!range) {
    return false;
  }

  const { startLine, startColumn, endLine, endColumn } = range;
  const values = [startLine, startColumn, endLine, endColumn];

  if (values.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
    return false;
  }
  if (endLine < startLine) {
    return false;
  }
  if (endLine === startLine && endColumn <= startColumn) {
    return false;
  }
  return true;
}

/**
 * The inline icon anchors on the final source character of the declaration
 * (normally the `;`), exactly as derived by the PR4 AST `endAnchorRange`.
 * This is only a fallback for issues that do not carry an explicit
 * `iconAnchorRange` (e.g. mock analyzer output) — the real pipeline always
 * supplies the exact anchor.
 */
function anchorFromDeclarationEnd(declarationRange: CssLocation): CssLocation {
  const { filePath, endLine, endColumn } = declarationRange;

  if (endColumn > 0) {
    return {
      filePath,
      startLine: endLine,
      startColumn: endColumn - 1,
      endLine,
      endColumn,
    };
  }

  // A declaration ending at column zero cannot be anchored to a single
  // character without the document text. Keep its valid non-empty source
  // range so the decoration is still applied rather than skipped.
  return declarationRange;
}

/**
 * Plan the decorations for a single editor document.
 *
 * Returns one entry per distinct mapped issue; an empty result means the
 * caller must clear any previously applied decorations.
 */
export function planDecorations(issues: CssIssue[], filePath: string): PlannedDecoration[] {
  const relevant = issues.filter((issue) => pathEquals(issue.location?.filePath, filePath));

  if (relevant.length === 0) {
    logger.info('[Decorations] No issues to display');
    return [];
  }

  const planned: PlannedDecoration[] = [];
  const seen = new Set<string>();

  for (const issue of relevant) {
    const dimRange = issue.declarationRange ?? issue.location;

    if (!isValidRange(dimRange)) {
      logger.warn('[Decorations] Skipped issue because local range is invalid');
      continue;
    }

    const iconAnchorRange =
      issue.iconAnchorRange && isValidRange(issue.iconAnchorRange)
        ? issue.iconAnchorRange
        : anchorFromDeclarationEnd(dimRange);

    const key = [
      filePath,
      dimRange.startLine,
      dimRange.startColumn,
      dimRange.endLine,
      dimRange.endColumn,
    ].join('|');

    if (seen.has(key)) {
      // Same local declaration reported twice — one decoration only.
      continue;
    }
    seen.add(key);

    planned.push({ issue, dimRange, iconAnchorRange });
  }

  return planned;
}

/**
 * Deterministic signature of a decoration plan (decoration cache).
 *
 * The signature covers everything that changes what the editor renders:
 * the dim range, the icon anchor range, and the hover content (property,
 * value and reasons — including the interactive override-jump target).
 * Identical plans produce identical signatures; any change that would
 * alter the visible decorations changes the signature.
 */
export function signatureFromPlan(plan: PlannedDecoration[]): string {
  const parts = plan.map(({ dimRange, iconAnchorRange, issue }) =>
    [
      dimRange.startLine,
      dimRange.startColumn,
      dimRange.endLine,
      dimRange.endColumn,
      iconAnchorRange.startLine,
      iconAnchorRange.startColumn,
      iconAnchorRange.endLine,
      iconAnchorRange.endColumn,
      issue.propertyName,
      issue.propertyValue,
      issue.reasonCode ?? '',
      issue.reasonText ?? '',
      issue.reason ?? '',
      issue.overrideTarget
        ? `${issue.overrideTarget.startLine}|${issue.overrideTarget.startColumn}|${issue.overrideTarget.endLine}|${issue.overrideTarget.endColumn}`
        : '',
    ].join('|')
  );
  return parts.join(';');
}

/**
 * Convenience wrapper: plan the decorations for a document and return the
 * signature of the resulting plan (an empty plan has the empty signature).
 */
export function decorationSignature(issues: CssIssue[], filePath: string): string {
  return signatureFromPlan(planDecorations(issues, filePath));
}
