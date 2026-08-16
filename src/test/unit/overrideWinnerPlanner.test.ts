import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWinnerBadgeHover,
  planOverrideWinnerBadges,
  signatureFromWinnerBadges,
} from '../../diagnostics/overrideWinnerPlanner';
import { encodeJumpArgs, jumpTargetFromLocation } from '../../diagnostics/overrideJumpTarget';
import { CssIssue } from '../../models';

/**
 * Unit tests for the override-winner gutter planner.
 *
 * The planner inverts the override relationship: issues report the LOSING
 * declaration and carry the winner only as `overrideTarget`, while the
 * `→|` gutter badge must sit on the WINNING line. All planning and hover
 * text is vscode-free and testable outside the extension host.
 */

const FILE = '/fake/styles.css';
const OTHER = '/fake/other.css';

/** 0-based line 19 → hover says "Line 20", mirroring the mockup. */
const LOSER_DECL = { filePath: FILE, startLine: 19, startColumn: 4, endLine: 19, endColumn: 26 };
const LOSER_NAME = { filePath: FILE, startLine: 19, startColumn: 4, endLine: 19, endColumn: 9 };
/** 0-based line 25 → the badge sits on display line 26 (mockup winner). */
const WINNER_RANGE = { filePath: FILE, startLine: 25, startColumn: 4, endLine: 25, endColumn: 9 };

function overrideIssue(overrides: Partial<CssIssue> = {}): CssIssue {
  return {
    propertyName: 'color',
    propertyValue: '#ffffff',
    selector: '.action-button',
    location: LOSER_DECL,
    reasonCode: 'OVERRIDDEN_BY_LATER_DECLARATION',
    overrideTarget: WINNER_RANGE,
    propertyNameRange: LOSER_NAME,
    ...overrides,
  };
}

test('plans a badge for an override issue whose winner lives in this file', () => {
  const badges = planOverrideWinnerBadges([overrideIssue()], FILE);

  assert.equal(badges.length, 1);
  assert.deepEqual(badges[0].winnerRange, WINNER_RANGE);
  assert.equal(badges[0].losers.length, 1);
  assert.equal(badges[0].losers[0].line, 20, 'loser line must be 1-based in the hover data');
  assert.equal(badges[0].losers[0].issue.selector, '.action-button');
});

test('returns no badges for an empty issue list', () => {
  assert.deepEqual(planOverrideWinnerBadges([], FILE), []);
});

test('ignores issues that are not override verdicts', () => {
  const inactive = overrideIssue({
    reasonCode: 'REQUIRES_FLEX_OR_GRID_CONTAINER',
  });
  const noCode = overrideIssue({ reasonCode: undefined });
  assert.deepEqual(planOverrideWinnerBadges([inactive, noCode], FILE), []);
});

test('ignores issues with no override target', () => {
  const unmapped = overrideIssue({ overrideTarget: undefined });
  assert.deepEqual(planOverrideWinnerBadges([unmapped], FILE), []);
});

test('ignores issues whose winner lives in another file', () => {
  const foreign = overrideIssue({
    overrideTarget: { ...WINNER_RANGE, filePath: OTHER },
  });
  assert.deepEqual(planOverrideWinnerBadges([foreign], FILE), []);
});

test('ignores an invalid winner range', () => {
  const empty = overrideIssue({
    overrideTarget: { filePath: FILE, startLine: 25, startColumn: 4, endLine: 25, endColumn: 4 },
  });
  assert.deepEqual(planOverrideWinnerBadges([empty], FILE), []);
});

test('badges the winning file even when the loser lives in another file', () => {
  // Cross-file cascade loss: the dim decoration renders in the loser's
  // editor, but the winner badge still belongs to the winner's editor.
  const crossFile = overrideIssue({
    location: { ...LOSER_DECL, filePath: OTHER },
    propertyNameRange: { ...LOSER_NAME, filePath: OTHER },
  });
  const badges = planOverrideWinnerBadges([crossFile], FILE);

  assert.equal(badges.length, 1);
  assert.equal(badges[0].losers[0].line, 20);
});

test('also plans badges for the cross-rule override code', () => {
  const crossRule = overrideIssue({ reasonCode: 'OVERRIDDEN_BY_CROSS_RULE_DECLARATION' });
  assert.equal(planOverrideWinnerBadges([crossRule], FILE).length, 1);
});

test('collapses multiple losers of one winner into a single sorted badge', () => {
  const first = overrideIssue();
  const second = overrideIssue({
    propertyName: 'background-color',
    propertyValue: 'red',
    location: { filePath: FILE, startLine: 9, startColumn: 4, endLine: 9, endColumn: 30 },
    propertyNameRange: { filePath: FILE, startLine: 9, startColumn: 4, endLine: 9, endColumn: 21 },
  });
  const badges = planOverrideWinnerBadges([first, second], FILE);

  assert.equal(badges.length, 1);
  assert.deepEqual(
    badges[0].losers.map(({ line }) => line),
    [10, 20],
    'losers are sorted by line'
  );
});

test('deduplicates the same losing declaration reported twice', () => {
  const issue = overrideIssue();
  const badges = planOverrideWinnerBadges([issue, { ...issue }], FILE);

  assert.equal(badges.length, 1);
  assert.equal(badges[0].losers.length, 1);
});

test('keeps two losers on the same line when the properties differ', () => {
  const color = overrideIssue();
  const margin = overrideIssue({
    propertyName: 'margin',
    propertyValue: '0',
  });
  const badges = planOverrideWinnerBadges([color, margin], FILE);

  assert.equal(badges.length, 1);
  assert.equal(badges[0].losers.length, 2);
});

test('plans one badge per distinct winner, sorted by winner line', () => {
  const later = overrideIssue();
  const earlier = overrideIssue({
    location: { filePath: FILE, startLine: 4, startColumn: 4, endLine: 4, endColumn: 26 },
    propertyNameRange: { filePath: FILE, startLine: 4, startColumn: 4, endLine: 4, endColumn: 9 },
    overrideTarget: { filePath: FILE, startLine: 12, startColumn: 4, endLine: 12, endColumn: 9 },
  });
  const badges = planOverrideWinnerBadges([later, earlier], FILE);

  assert.deepEqual(
    badges.map(({ winnerRange }) => winnerRange.startLine),
    [12, 25]
  );
});

test('hover text follows the DevTools-style override format', () => {
  const [badge] = planOverrideWinnerBadges([overrideIssue()], FILE);
  const { markdown, hasCommandLink } = buildWinnerBadgeHover(badge);

  assert.ok(
    markdown.includes('⚡ Overrides property on Line 20: `.action-button { color: #ffffff; }`'),
    `unexpected hover text: ${markdown}`
  );
  assert.ok(hasCommandLink);
});

test('hover text carries a jump link to the overridden declaration', () => {
  const [badge] = planOverrideWinnerBadges([overrideIssue()], FILE);
  const { markdown } = buildWinnerBadgeHover(badge);

  const target = jumpTargetFromLocation(LOSER_NAME, 'color');
  const expected =
    '⚡ Overrides property on Line 20: `.action-button { color: #ffffff; }`' +
    `\n\n[Go to overridden declaration (Line 20)]` +
    `(command:noeffect.jumpAndHighlight?${encodeJumpArgs(target)})`;
  assert.equal(markdown, expected);
});

test('hover text lists every overridden line, separated by blank lines', () => {
  const first = overrideIssue();
  const second = overrideIssue({
    propertyName: 'background-color',
    propertyValue: 'red',
    location: { filePath: FILE, startLine: 9, startColumn: 4, endLine: 9, endColumn: 30 },
    propertyNameRange: { filePath: FILE, startLine: 9, startColumn: 4, endLine: 9, endColumn: 21 },
  });
  const [badge] = planOverrideWinnerBadges([first, second], FILE);
  const { markdown } = buildWinnerBadgeHover(badge);

  const entries = markdown.split('\n\n').filter((p) => p.startsWith('⚡'));
  assert.equal(entries.length, 2);
  assert.match(entries[0], /Line 10/);
  assert.match(entries[1], /Line 20/);
});

test('hover text omits the link when no valid loser range exists', () => {
  const broken = overrideIssue({
    location: { filePath: FILE, startLine: 19, startColumn: 4, endLine: 19, endColumn: 4 },
    propertyNameRange: { filePath: FILE, startLine: 19, startColumn: 4, endLine: 19, endColumn: 4 },
  });
  const [badge] = planOverrideWinnerBadges([broken], FILE);
  const { markdown, hasCommandLink } = buildWinnerBadgeHover(badge);

  assert.equal(hasCommandLink, false);
  assert.ok(markdown.startsWith('⚡ Overrides property on Line 20:'));
  assert.ok(!markdown.includes('command:'));
});

test('winner badge signature: identical plans produce identical signatures', () => {
  const a = planOverrideWinnerBadges([overrideIssue()], FILE);
  const b = planOverrideWinnerBadges([overrideIssue()], FILE);
  assert.equal(signatureFromWinnerBadges(a), signatureFromWinnerBadges(b));
});

test('winner badge signature: the empty plan has the empty signature', () => {
  assert.equal(signatureFromWinnerBadges([]), '');
});

test('winner badge signature: a changed loser value changes the signature', () => {
  const original = planOverrideWinnerBadges([overrideIssue()], FILE);
  const changed = planOverrideWinnerBadges(
    [overrideIssue({ propertyValue: '#000000' })],
    FILE
  );
  assert.notEqual(signatureFromWinnerBadges(original), signatureFromWinnerBadges(changed));
});

test('winner badge signature: a changed winner range changes the signature', () => {
  const original = planOverrideWinnerBadges([overrideIssue()], FILE);
  const moved = planOverrideWinnerBadges(
    [
      overrideIssue({
        overrideTarget: { ...WINNER_RANGE, startLine: 26, endLine: 26 },
      }),
    ],
    FILE
  );
  assert.notEqual(signatureFromWinnerBadges(original), signatureFromWinnerBadges(moved));
});

test('winner badge signature: a dropped loser changes the signature', () => {
  const first = overrideIssue();
  const second = overrideIssue({
    propertyName: 'background-color',
    propertyValue: 'red',
    location: { filePath: FILE, startLine: 9, startColumn: 4, endLine: 9, endColumn: 30 },
    propertyNameRange: { filePath: FILE, startLine: 9, startColumn: 4, endLine: 9, endColumn: 21 },
  });
  const both = planOverrideWinnerBadges([first, second], FILE);
  const one = planOverrideWinnerBadges([first], FILE);
  assert.notEqual(signatureFromWinnerBadges(both), signatureFromWinnerBadges(one));
});
