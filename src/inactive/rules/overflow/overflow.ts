/**
 * PR6 Phase 3 — the `overflow` rule.
 *
 * The only inactivity condition provable from the context is
 * `display: contents` (no box to clip). Inline-level non-replaced boxes
 * cannot be distinguished from replaced ones (where overflow applies),
 * so everything else stays active.
 */
import { InactiveRule } from '../../inactiveRule';
import { createBoxSuppressedRule } from '../shared';

export const overflowRule: InactiveRule = createBoxSuppressedRule('overflow');
