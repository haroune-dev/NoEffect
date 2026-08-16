/**
 * PR6 Phase 3 — position offset rules (`top`/`right`/`bottom`/`left`).
 *
 * These properties only move a box that is positioned (or a flex/grid
 * item, which honors offsets even with `position: static`). On a plain
 * static element they have no effect.
 */
import { InactiveRule } from '../../inactiveRule';
import { createPositionOffsetRule } from '../shared';

export const topRightBottomLeftRules: readonly InactiveRule[] = [
  createPositionOffsetRule('top'),
  createPositionOffsetRule('right'),
  createPositionOffsetRule('bottom'),
  createPositionOffsetRule('left'),
];
