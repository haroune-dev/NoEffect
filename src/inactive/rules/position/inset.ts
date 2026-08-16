/**
 * PR6 Phase 3 — the `inset` shorthand rule.
 *
 * `inset` sets all four offsets at once, so it shares the exact
 * inactivity contract of the individual offset properties.
 */
import { InactiveRule } from '../../inactiveRule';
import { createPositionOffsetRule } from '../shared';

export const insetRule: InactiveRule = createPositionOffsetRule('inset');
