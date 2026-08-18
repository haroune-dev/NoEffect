/**
 * PR6 Phase 3 — the `overflow` / `overflow-x` / `overflow-y` rules.
 *
 * The only inactivity condition provable from the context is
 * `display: contents` (no box to clip). Inline-level non-replaced boxes
 * cannot be distinguished from replaced ones (where overflow applies),
 * so everything else stays active.
 *
 * All three longhands share the identical conservative contract — flagged
 * only when the element generates no box at all — so one parameterized
 * factory produces the three rule instances (P3-CLEAN-43).
 */
import { InactiveRule } from '../../inactiveRule';
import { createBoxSuppressedRule } from '../shared';

export const overflowRule: InactiveRule = createBoxSuppressedRule('overflow');
export const overflowXRule: InactiveRule = createBoxSuppressedRule('overflow-x');
export const overflowYRule: InactiveRule = createBoxSuppressedRule('overflow-y');
