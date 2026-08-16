/**
 * Pure override-winner gutter planner — turns the already-mapped
 * `OVERRIDDEN_*` issues into the gutter badges shown on the WINNING
 * declaration lines (the `→|` marker in the line-number margin).
 *
 * The loser side of an override is what the analyser reports as a
 * `CssIssue` (the dimmed declaration); the winner side exists only as the
 * issue's `overrideTarget` (the winning declaration's property-name
 * range). This module inverts that relationship: every distinct winner
 * range in a document collects the issue(s) it overrode, producing one
 * badge per winner with the losing declarations attached as hover data.
 *
 * Like `decorationPlanner`, this module imports nothing from `vscode` so
 * the badge planning and hover text are unit-testable outside the
 * extension host.
 */

import { CssIssue } from '../models';
import { CssLocation } from '../models/cssLocation';
import { isOverrideReasonCode } from '../inactive/reasonCode';
import { isValidRange } from './decorationPlanner';
import {
  JUMP_AND_HIGHLIGHT_COMMAND,
  encodeJumpArgs,
  isValidJumpTarget,
  jumpTargetFromLocation,
} from './overrideJumpTarget';

/** One overridden (losing) declaration attributed to a winner badge. */
export interface OverrideLoser {
  /** The losing declaration's issue (selector, property, value, ranges). */
  issue: CssIssue;

  /** 1-based display line of the losing declaration (hover text). */
  line: number;
}

/** A single `→|` gutter badge: the winning declaration plus its losers. */
export interface OverrideWinnerBadge {
  /** Local property-name range of the winning declaration. */
  winnerRange: CssLocation;

  /** The declarations this winner overrode, sorted by line. */
  losers: OverrideLoser[];
}

/**
 * Plan the override-winner gutter badges for one editor document.
 *
 * Only override-family issues whose `overrideTarget` is a valid range in
 * THIS document contribute (a badge can only be drawn in the file that
 * physically contains the winning line; the losing declaration may live
 * in any file). Losers pointing at the same winner range collapse into a
 * single badge; the result is sorted by winner position so identical
 * inputs always produce identical plans.
 */
export function planOverrideWinnerBadges(
  issues: CssIssue[],
  filePath: string
): OverrideWinnerBadge[] {
  const byWinner = new Map<string, OverrideWinnerBadge>();

  for (const issue of issues) {
    if (!isOverrideReasonCode(issue.reasonCode)) {
      continue;
    }

    const target = issue.overrideTarget;
    if (!target || target.filePath !== filePath || !isValidRange(target)) {
      continue;
    }

    const loserStartLine = issue.location?.startLine;
    if (
      typeof loserStartLine !== 'number' ||
      !Number.isFinite(loserStartLine) ||
      loserStartLine < 0
    ) {
      continue;
    }

    const winnerKey = rangeKey(target);
    const badge = byWinner.get(winnerKey) ?? { winnerRange: target, losers: [] };

    // The same losing declaration can be reported more than once (one
    // authored declaration matched by several nodes) — one hover entry.
    const duplicate = badge.losers.some(
      ({ issue: seen, line }) =>
        line === loserStartLine + 1 && seen.propertyName === issue.propertyName
    );
    if (!duplicate) {
      badge.losers.push({ issue, line: loserStartLine + 1 });
      byWinner.set(winnerKey, badge);
    }
  }

  const badges = Array.from(byWinner.values());
  for (const badge of badges) {
    badge.losers.sort(
      (a, b) =>
        a.line - b.line || a.issue.propertyName.localeCompare(b.issue.propertyName)
    );
  }
  badges.sort(
    (a, b) =>
      a.winnerRange.startLine - b.winnerRange.startLine ||
      a.winnerRange.startColumn - b.winnerRange.startColumn
  );
  return badges;
}

/**
 * The gutter-badge hover text: one entry per overridden declaration in
 * the DevTools-style format, plus a trusted command link jumping to the
 * overridden declaration (the same `noeffect.jumpAndHighlight` command
 * the inline-icon tooltip uses, mirrored winner→loser).
 *
 *   ⚡ Overrides property on Line 20: `.action-button { color: #ffffff; }`
 *   Go to overridden declaration (Line 20)
 */
export function buildWinnerBadgeHover(badge: OverrideWinnerBadge): {
  markdown: string;
  hasCommandLink: boolean;
} {
  let hasCommandLink = false;

  const parts = badge.losers.map(({ issue, line }) => {
    const snippet = `${issue.selector} { ${issue.propertyName}: ${issue.propertyValue}; }`;
    let part = `⚡ Overrides property on Line ${line}: \`${snippet}\``;

    const jumpSource =
      issue.propertyNameRange && isValidRange(issue.propertyNameRange)
        ? issue.propertyNameRange
        : isValidRange(issue.location)
          ? issue.location
          : undefined;
    if (jumpSource) {
      const target = jumpTargetFromLocation(jumpSource, issue.propertyName);
      if (isValidJumpTarget(target)) {
        part +=
          `\n\n[Go to overridden declaration (Line ${target.line})]` +
          `(command:${JUMP_AND_HIGHLIGHT_COMMAND}?${encodeJumpArgs(target)})`;
        hasCommandLink = true;
      }
    }

    return part;
  });

  return { markdown: parts.join('\n\n'), hasCommandLink };
}

/**
 * Deterministic signature of a winner-badge plan (decoration cache).
 *
 * Covers everything the editor renders for the badges: the winner range
 * and every loser's line, property and value (the hover content). Mirrors
 * `signatureFromPlan` — any change that would alter the visible badges
 * changes the signature.
 */
export function signatureFromWinnerBadges(badges: OverrideWinnerBadge[]): string {
  return badges
    .map(({ winnerRange, losers }) =>
      [
        winnerRange.startLine,
        winnerRange.startColumn,
        winnerRange.endLine,
        winnerRange.endColumn,
        losers
          .map(({ line, issue }) =>
            [line, issue.propertyName, issue.propertyValue, issue.reasonCode ?? ''].join('~')
          )
          .join(','),
      ].join('|')
    )
    .join(';');
}

function rangeKey(range: CssLocation): string {
  return [
    range.startLine,
    range.startColumn,
    range.endLine,
    range.endColumn,
  ].join('|');
}
