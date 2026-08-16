/**
 * PR6 Phase 3 — the `overflow-y` rule.
 *
 * Shares the conservative `overflow` contract: flagged only when the
 * element generates no box at all (`display: contents`).
 */
import { InactiveRule } from '../../inactiveRule';
import { createBoxSuppressedRule } from '../shared';

export const overflowYRule: InactiveRule = createBoxSuppressedRule('overflow-y');
