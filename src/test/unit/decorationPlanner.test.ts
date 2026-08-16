import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDecorations, decorationSignature } from '../../diagnostics/decorationPlanner';
import { CssIssue } from '../../models';

/**
 * Unit tests for PR5: the pure decoration planner.
 *
 * The planner turns the already-mapped CssIssue list into the exact
 * decoration ranges (dim + icon anchor), so the decoration behavior is
 * testable without the VS Code extension host.
 */

const FILE = '/fake/styles.css';

const DECLARATION_RANGE = { filePath: FILE, startLine: 4, startColumn: 2, endLine: 4, endColumn: 26 };
const NAME_RANGE = { filePath: FILE, startLine: 4, startColumn: 2, endLine: 4, endColumn: 17 };
const ICON_ANCHOR_RANGE = { filePath: FILE, startLine: 4, startColumn: 25, endLine: 4, endColumn: 26 };

function issue(overrides: Partial<CssIssue>): CssIssue {
  return {
    propertyName: 'justify-content',
    propertyValue: 'center',
    selector: '.non-flex',
    location: DECLARATION_RANGE,
    ...overrides,
  };
}

/** A fully mapped issue, exactly as PR4 produces it. */
function mappedIssue(): CssIssue {
  return issue({
    declarationRange: DECLARATION_RANGE,
    propertyNameRange: NAME_RANGE,
    iconAnchorRange: ICON_ANCHOR_RANGE,
  });
}

test('plans a decoration when a valid mapped range exists', () => {
  const plan = planDecorations([mappedIssue()], FILE);

  assert.equal(plan.length, 1);
  assert.equal(plan[0].issue.propertyName, 'justify-content');
  assert.deepEqual(plan[0].dimRange, DECLARATION_RANGE);
  assert.deepEqual(plan[0].iconAnchorRange, ICON_ANCHOR_RANGE);
});

test('plans dimming and icon anchor as separate ranges', () => {
  const plan = planDecorations([mappedIssue()], FILE);

  assert.equal(plan.length, 1);
  // Dimming covers the whole declaration; the icon anchor is the final
  // single character (the semicolon).
  assert.deepEqual(plan[0].dimRange, DECLARATION_RANGE);
  assert.deepEqual(plan[0].iconAnchorRange, ICON_ANCHOR_RANGE);
  assert.notDeepEqual(plan[0].dimRange, plan[0].iconAnchorRange);
  assert.equal(
    plan[0].iconAnchorRange.startColumn + 1,
    plan[0].iconAnchorRange.endColumn,
    'icon anchor must be a single character'
  );
});

test('returns an empty plan when the issue list is empty', () => {
  assert.deepEqual(planDecorations([], FILE), []);
});

test('filters out issues that belong to other files', () => {
  const otherFile = issue({ location: { ...DECLARATION_RANGE, filePath: '/other/styles.css' } });
  assert.deepEqual(planDecorations([mappedIssue(), otherFile], FILE).map((p) => p.issue.propertyName), ['justify-content']);
  assert.deepEqual(planDecorations([otherFile], FILE), []);
});

test('skips issues whose local range is invalid (empty/placeholder)', () => {
  const placeholder = issue({
    declarationRange: { filePath: FILE, startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
    location: { filePath: FILE, startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
    iconAnchorRange: { filePath: FILE, startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
  });
  assert.deepEqual(planDecorations([placeholder], FILE), []);
});

test('skips issues with no location at all', () => {
  const noLocation = issue({ location: undefined });
  assert.deepEqual(planDecorations([noLocation], FILE), []);
});

test('skips issues whose declaration range is empty', () => {
  const empty = issue({
    declarationRange: { filePath: FILE, startLine: 4, startColumn: 10, endLine: 4, endColumn: 10 },
  });
  assert.deepEqual(planDecorations([empty], FILE), []);
});

test('does not plan duplicate decorations for the same issue', () => {
  const duplicate = mappedIssue();
  const plan = planDecorations([duplicate, { ...duplicate }], FILE);
  assert.equal(plan.length, 1);
});

test('deduplicates two identical issues while keeping distinct ones', () => {
  const a = mappedIssue();
  const b = issue({
    propertyName: 'align-items',
    propertyValue: 'center',
    declarationRange: { filePath: FILE, startLine: 5, startColumn: 2, endLine: 5, endColumn: 22 },
    iconAnchorRange: { filePath: FILE, startLine: 5, startColumn: 21, endLine: 5, endColumn: 22 },
  });
  const plan = planDecorations([a, { ...a }, b], FILE);
  assert.equal(plan.length, 2);
  assert.deepEqual(
    plan.map((p) => p.issue.propertyName).sort(),
    ['align-items', 'justify-content']
  );
});

test('derives the icon anchor from the declaration end when it is missing', () => {
  const noAnchor = mappedIssue();
  delete noAnchor.iconAnchorRange;

  const plan = planDecorations([noAnchor], FILE);
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].iconAnchorRange, {
    filePath: FILE,
    startLine: 4,
    startColumn: 25,
    endLine: 4,
    endColumn: 26,
  });
});

test('derives the icon anchor when the explicit one is invalid', () => {
  const badAnchor = mappedIssue();
  badAnchor.iconAnchorRange = { filePath: FILE, startLine: 4, startColumn: 26, endLine: 4, endColumn: 26 };

  const plan = planDecorations([badAnchor], FILE);
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].iconAnchorRange, ICON_ANCHOR_RANGE);
});

test('keeps a valid non-empty anchor for a declaration ending at column zero', () => {
  const wrapped = issue({
    declarationRange: { filePath: FILE, startLine: 4, startColumn: 2, endLine: 5, endColumn: 0 },
  });

  const plan = planDecorations([wrapped], FILE);
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].iconAnchorRange, wrapped.declarationRange);
});

test('decoration signature: identical issue lists produce identical signatures', () => {
  const a = mappedIssue();
  const b = mappedIssue();

  assert.equal(decorationSignature([a], FILE), decorationSignature([b], FILE));
});

test('decoration signature: a changed property value changes the signature', () => {
  const original = mappedIssue();
  const changed = mappedIssue();
  changed.propertyValue = 'flex-start';

  assert.notEqual(decorationSignature([original], FILE), decorationSignature([changed], FILE));
});

test('decoration signature: a changed reason changes the signature', () => {
  const original = mappedIssue();
  const changed = mappedIssue();
  changed.reasonText = 'A different cause';

  assert.notEqual(decorationSignature([original], FILE), decorationSignature([changed], FILE));
});

test('decoration signature: a changed range changes the signature', () => {
  const original = mappedIssue();
  const changed = mappedIssue();
  changed.declarationRange = { ...DECLARATION_RANGE, startColumn: 3 };

  assert.notEqual(decorationSignature([original], FILE), decorationSignature([changed], FILE));
});

test('decoration signature: an empty issue list always has the empty signature', () => {
  assert.equal(decorationSignature([], FILE), '');
  assert.equal(decorationSignature([], FILE), decorationSignature([], '/other/styles.css'));
});

test('decoration signature: a single-character value of the empty plan is stable', () => {
  const empty = decorationSignature([], FILE);
  const emptyAgain = decorationSignature([], FILE);
  assert.equal(empty, emptyAgain);
});

test('decoration signature: reordering issues changes the signature (dedupe still applies)', () => {
  const first = mappedIssue();
  const second = mappedIssue();
  second.declarationRange = { ...DECLARATION_RANGE, startLine: 5, endLine: 5 };

  const forward = decorationSignature([first, second], FILE);
  const backward = decorationSignature([second, first], FILE);

  assert.notEqual(forward, backward);
});
