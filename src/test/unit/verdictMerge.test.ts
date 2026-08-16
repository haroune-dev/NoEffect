import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  declarationKeyFor,
  isEffectiveInAnyPass,
  mergePassOutcomes,
  mergeVerdicts,
  PassOutcome,
  PassVerdict,
  Verdict,
} from '../../engine/verdictMerge';
import { CssIssue } from '../../models';

/**
 * The multi-companion verdict lattice (Level 11):
 *
 *   ⊥ ≤ I ≤ A        no evidence ≤ provably inactive ≤ provably effective
 *
 * This suite locks the JOIN (= component-wise max) exhaustively over the
 * 3×3 table, plus the merge contract: failed passes contribute NO lattice
 * elements, `I ⊔ ⊥ = I` never means "a failed companion proved inactive",
 * the issue of a merged `I` comes from the HIGHEST-RANKED pass that issued
 * it, and the merged result depends only on the pass maps and their ranks
 * (array order is irrelevant — determinism).
 */

const VERDICTS: Verdict[] = ['bottom', 'I', 'A'];

/** The full 3×3 JOIN table as the unique extension of the order ⊥ ≤ I ≤ A. */
const JOIN_EXPECTED: Record<Verdict, Record<Verdict, Verdict>> = {
  bottom: { bottom: 'bottom', I: 'I', A: 'A' },
  I: { bottom: 'I', I: 'I', A: 'A' },
  A: { bottom: 'A', I: 'A', A: 'A' },
};

test('mergeVerdicts: exhaustive 3×3 lattice JOIN table', () => {
  for (const a of VERDICTS) {
    for (const b of VERDICTS) {
      assert.equal(
        mergeVerdicts(a, b),
        JOIN_EXPECTED[a][b],
        `JOIN(${a}, ${b}) must equal the lattice max`
      );
    }
  }
});

test('mergeVerdicts: bottom is the identity, A is absorbing', () => {
  for (const v of VERDICTS) {
    assert.equal(mergeVerdicts(v, 'bottom'), v, 'bottom is the identity on the right');
    assert.equal(mergeVerdicts('bottom', v), v, 'bottom is the identity on the left');
    assert.equal(mergeVerdicts(v, 'A'), 'A', 'A is absorbing on the right');
    assert.equal(mergeVerdicts('A', v), 'A', 'A is absorbing on the left');
  }
});

test('mergeVerdicts: commutative, associative and idempotent (total order)', () => {
  for (const a of VERDICTS) {
    for (const b of VERDICTS) {
      assert.equal(mergeVerdicts(a, b), mergeVerdicts(b, a), `commutes for ${a}, ${b}`);
      assert.equal(mergeVerdicts(a, a), a, `idempotent for ${a}`);
      for (const c of VERDICTS) {
        assert.equal(
          mergeVerdicts(mergeVerdicts(a, b), c),
          mergeVerdicts(a, mergeVerdicts(b, c)),
          `associates for ${a}, ${b}, ${c}`
        );
      }
    }
  }
});

function issue(map: { propertyName?: string; startLine?: number } = {}): CssIssue {
  const startLine = map.startLine ?? 3;
  return {
    propertyName: map.propertyName ?? 'justify-content',
    propertyValue: 'center',
    selector: '.non-flex',
    selectorText: '.non-flex',
    reason: 'reason text',
    reasonCode: 'REQUIRES_FLEX_OR_GRID_CONTAINER',
    location: {
      filePath: '/project/styles.css',
      startLine,
      startColumn: 2,
      endLine: startLine + 1,
      endColumn: 24,
    },
    propertyNameRange: {
      filePath: '/project/styles.css',
      startLine,
      startColumn: 2,
      endLine: startLine,
      endColumn: 17,
    },
  };
}

function pass(
  rank: number,
  verdicts: PassVerdict[],
  overrides: Partial<PassOutcome> = {}
): PassOutcome {
  return {
    companionPath: `/project/pages/${rank}.html`,
    companionRank: rank,
    verdicts: new Map(verdicts.map((v) => [v.key, v])),
    success: true,
    ...overrides,
  };
}

test('declarationKeyFor: a pure function of authored declaration + sheet identity', () => {
  const range = { startLine: 3, startColumn: 2, endLine: 3, endColumn: 24 };
  const key = declarationKeyFor('/p/styles.css', '/p/styles.css|abc', range, 'gap');
  assert.equal(
    key,
    declarationKeyFor('/p/styles.css', '/p/styles.css|abc', range, 'gap'),
    'the same authored declaration keys identically every time'
  );
  assert.notEqual(
    key,
    declarationKeyFor('/p/styles.css', '/p/styles.css|abc', range, 'justify-content'),
    'the property name is part of the key'
  );
  assert.notEqual(
    key,
    declarationKeyFor('/p/styles.css', '/p/styles.css|abc', { ...range, startLine: 4 }, 'gap'),
    'the parsed range is part of the key'
  );
  assert.notEqual(
    key,
    declarationKeyFor(
      '/p/styles.css',
      '/p/other.css|abc',
      range,
      'gap'
    ),
    'the sheet identity is part of the key'
  );
  assert.notEqual(
    key,
    declarationKeyFor('/p/other/styles.css', '/p/other/styles.css|abc', range, 'gap'),
    'the sheet path is part of the key'
  );
});

test('declarationKeyFor: the k-th duplicate inside one block keeps its own range → its own key', () => {
  const first = declarationKeyFor(
    '/p/styles.css',
    '/p/styles.css|abc',
    { startLine: 3, startColumn: 2, endLine: 3, endColumn: 24 },
    'gap'
  );
  const second = declarationKeyFor(
    '/p/styles.css',
    '/p/styles.css|abc',
    { startLine: 4, startColumn: 2, endLine: 4, endColumn: 24 },
    'gap'
  );
  assert.notEqual(first, second, 'duplicate authored declarations never collide');
});

test('mergePassOutcomes: failed passes contribute no lattice elements', () => {
  const failed = pass(0, [failedVerdict('k1')], {
    success: false,
    error: 'navigation failed',
  });
  const merged = mergePassOutcomes([failed]);
  assert.equal(merged.size, 0, 'a failed pass alone yields no merged result at all');

  const mergedWithSuccess = mergePassOutcomes([
    failed,
    pass(1, [{ key: 'k1', verdict: 'I', issue: issue() }]),
  ]);
  assert.equal(mergedWithSuccess.get('k1')?.verdict, 'I', 'successful passes still merge');

  const activeFirst = mergePassOutcomes([
    pass(0, [{ key: 'k1', verdict: 'A' }]),
    failed,
  ]);
  assert.equal(activeFirst.get('k1')?.verdict, 'A', 'the failed pass interleaving changes nothing');
});

test('mergePassOutcomes: I ⊔ A = A — an effective pass absorbs the inactive verdict', () => {
  const merged = mergePassOutcomes([
    pass(0, [{ key: 'k1', verdict: 'I', issue: issue() }]),
    pass(1, [{ key: 'k1', verdict: 'A' }]),
  ]);
  const result = merged.get('k1');
  assert.ok(result, 'the declaration is present');
  assert.equal(result?.verdict, 'A', 'A absorbs across passes');
  assert.equal(result?.issue, undefined, 'the absorbed I issue is dropped');
  assert.equal(result?.evaluatedCount, 2, 'both evaluating passes count');
  assert.equal(result?.inactiveCount, 1, 'exactly one `I` pass counted');
  assert.equal(result?.sourceRank, 1, 'the merged A is attributed to the first A pass');
});

test('mergePassOutcomes: I ⊔ ⊥ = I — uncontradicted inactive evidence stands', () => {
  const merged = mergePassOutcomes([
    pass(0, [{ key: 'k1', verdict: 'I', issue: issue() }]),
    pass(1, [{ key: 'k2', verdict: 'A' }]),
  ]);
  const result = merged.get('k1');
  assert.equal(result?.verdict, 'I');
  assert.equal(result?.evaluatedCount, 1, 'only the I pass evaluated k1');
  assert.equal(result?.sourceRank, 0);
});

test('mergePassOutcomes: merged I takes the issue of the highest-ranked I pass', () => {
  const merged = mergePassOutcomes([
    pass(0, [{ key: 'k1', verdict: 'I', issue: issue({ startLine: 10 }) }]),
    pass(2, [{ key: 'k1', verdict: 'I', issue: issue({ startLine: 11 }) }]),
  ]);
  assert.equal(merged.get('k1')?.issue?.location.startLine, 10, 'rank 0 wins over rank 2');
  assert.equal(merged.get('k1')?.sourceRank, 0);
});

test('mergePassOutcomes: result is independent of array order (ranks are the only order)', () => {
  const make = (order: number[]): { verdict: Verdict; sourceRank: number; evaluatedCount: number } => {
    const byRank = new Map<number, PassOutcome>();
    byRank.set(0, pass(0, [{ key: 'k1', verdict: 'I', issue: issue({ startLine: 10 }) }]));
    byRank.set(2, pass(2, [{ key: 'k1', verdict: 'A' }]));
    const merged = mergePassOutcomes(order.map((rank) => byRank.get(rank)!));
    const result = merged.get('k1')!;
    return { verdict: result.verdict, sourceRank: result.sourceRank, evaluatedCount: result.evaluatedCount };
  };
  assert.deepEqual(make([0, 2]), make([2, 0]), 'permuting the input array changes nothing');
});

test('mergePassOutcomes: a pass without a verdict for a declaration is ⊥ for it', () => {
  const merged = mergePassOutcomes([
    pass(0, [{ key: 'k1', verdict: 'I', issue: issue() }]),
    pass(1, []),
  ]);
  assert.equal(merged.get('k1')?.verdict, 'I', 'the empty pass is the identity for k1');
  assert.equal(merged.get('k1')?.evaluatedCount, 1, 'the empty pass does not evaluate k1');
});

test('mergePassOutcomes: keys present only with bottom verdicts do not appear', () => {
  const merged = mergePassOutcomes([
    pass(0, [{ key: 'k1', verdict: 'bottom' }]),
    pass(1, [{ key: 'k2', verdict: 'I', issue: issue() }]),
  ]);
  assert.equal(merged.has('k1'), false, 'a bottom-only declaration never materializes');
  assert.equal(merged.has('k2'), true);
});

test('mergePassOutcomes: merged I keeps the counts of its issuing pass', () => {
  const merged = mergePassOutcomes([
    pass(1, [
      {
        key: 'k1',
        verdict: 'I',
        reasonCode: 'REQUIRES_FLEX_OR_GRID_CONTAINER',
        reasonText: 'no flex context',
        issue: issue(),
      },
    ]),
  ]);
  const result = merged.get('k1');
  assert.equal(result?.issue?.reasonCode, 'REQUIRES_FLEX_OR_GRID_CONTAINER', '…via the issue');
  assert.equal(result?.inactiveCount, 1);
  assert.equal(result?.evaluatedCount, 1);
});

test('invariant: every merged-I result has inactiveCount == evaluatedCount (active-wins lattice)', () => {
  // k1/k3 merge to `I` (all evaluating passes inactive); k2 merges to `A`
  // (one effective pass suppresses the dimmed issue); bottom-only keys never
  // materialize. For EVERY merged-I result the counts must agree — an `A`
  // would have suppressed the issue itself, so I == N by construction.
  const merged = mergePassOutcomes([
    pass(0, [
      { key: 'k1', verdict: 'I', issue: issue({ startLine: 10 }) },
      { key: 'k2', verdict: 'I', issue: issue({ startLine: 20 }) },
      { key: 'k3', verdict: 'I', issue: issue({ startLine: 30 }) },
      { key: 'k4', verdict: 'bottom' },
    ]),
    pass(1, [
      { key: 'k1', verdict: 'I', issue: issue({ startLine: 11 }) },
      { key: 'k2', verdict: 'A' },
      { key: 'k3', verdict: 'I', issue: issue({ startLine: 31 }) },
    ]),
    pass(2, [{ key: 'k3', verdict: 'I', issue: issue({ startLine: 32 }) }]),
  ]);
  for (const result of merged.values()) {
    if (result.verdict === 'I') {
      assert.equal(
        result.inactiveCount,
        result.evaluatedCount,
        `merged I for ${result.key} must have I == N (an A would have suppressed the issue)`
      );
    }
  }
  assert.equal(merged.get('k1')?.verdict, 'I');
  assert.equal(merged.get('k1')?.inactiveCount, 2);
  assert.equal(merged.get('k1')?.evaluatedCount, 2);
  assert.equal(merged.get('k2')?.verdict, 'A', 'any effective pass suppresses the dimmed issue');
  assert.equal(merged.get('k3')?.verdict, 'I');
  assert.equal(merged.get('k3')?.inactiveCount, 3);
  assert.equal(merged.get('k3')?.evaluatedCount, 3);
  assert.equal(merged.has('k4'), false, 'bottom-only declarations never materialize');
});

test('isEffectiveInAnyPass: only the merged A answers true', () => {
  assert.equal(isEffectiveInAnyPass({ key: 'k', verdict: 'A', evaluatedCount: 1, inactiveCount: 0, sourceRank: 1 }), true);
  assert.equal(isEffectiveInAnyPass({ key: 'k', verdict: 'I', evaluatedCount: 2, inactiveCount: 2, sourceRank: 0 }), false);
  assert.equal(isEffectiveInAnyPass({ key: 'k', verdict: 'bottom', evaluatedCount: 0, inactiveCount: 0, sourceRank: -1 }), false);
});

function failedVerdict(key: string): PassVerdict {
  return { key, verdict: 'bottom' };
}

test('mergePassOutcomes: issue from the highest-ranked pass WITH an issue, not the first I', () => {
  const noIssue = { key: 'k1', verdict: 'I', reasonCode: 'X' } as PassVerdict;
  const merged = mergePassOutcomes([
    pass(0, [noIssue]),
    pass(1, [{ key: 'k1', verdict: 'I', issue: issue({ startLine: 42 }) }]),
  ]);
  assert.equal(merged.get('k1')?.issue?.location.startLine, 42, 'the issue-less rank-0 I is skipped');
  assert.equal(merged.get('k1')?.sourceRank, 1);
});