/**
 * PR6 Phase 3 — the `pointer-events` rule.
 *
 * `pointer-events` is inert only when there is no box to hit-test:
 * `display: contents` elements generate no box and can never be a pointer
 * target, so the declaration has no observable effect. Everything else
 * participates in hit-testing and stays active.
 */
import { InactiveRule } from '../../inactiveRule';
import { createBoxSuppressedRule } from '../shared';

export const pointerEventsRule: InactiveRule = createBoxSuppressedRule('pointer-events');
