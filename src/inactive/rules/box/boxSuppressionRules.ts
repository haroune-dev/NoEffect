/**
 * Final-PR7 — box-suppression rules for the box-model properties.
 *
 * An element with `display: contents` generates no box at all: its
 * width/height/padding/border/margin/background/overflow declarations
 * have nothing to apply to and are inactive. `width`/`height`/`padding`
 * are registered by their own modules (sizing/table families), which
 * already guard the same condition — only the remaining box-model
 * properties live here.
 */
import { InactiveRule } from '../../inactiveRule';
import { createBoxSuppressedRule } from '../shared';

export const boxSuppressionRules: readonly InactiveRule[] = [
  createBoxSuppressedRule('border'),
  createBoxSuppressedRule('margin'),
  createBoxSuppressedRule('background'),
];
