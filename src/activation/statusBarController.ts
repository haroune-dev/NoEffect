/**
 * Phase 3 (first-run & visibility): status bar controller.
 *
 * Owns the single status bar item for the whole extension lifetime. The
 * item is created exactly once (by the vscode adapter in the activation
 * layer) and updated in place; rapid or redundant updates are skipped when
 * the presented state has not meaningfully changed.
 */

import { StatusPresentation, STATUS_BAR_COMMAND } from './statusModel';
import { rowKey } from '../status/derive';

/** The minimal status bar surface the vscode adapter implements. */
export interface StatusBarHost {
  text: string;
  tooltip: string;
  command: string;
  show(): void;
  hide(): void;
  dispose(): void;
}

export class StatusBarController {
  private lastKey: string | null = null;

  constructor(
    private readonly host: StatusBarHost,
    command: string = STATUS_BAR_COMMAND
  ) {
    // The item always opens Show Status; set once, never re-pointed.
    this.host.command = command;
  }

  /**
   * Apply a presentation. No-op when the displayed state has not changed,
   * so rapid readiness updates never mutate the item needlessly.
   */
  update(presentation: StatusPresentation): void {
    const key = rowKey(presentation);
    if (key === this.lastKey) {
      return;
    }
    this.lastKey = key;

    if (!presentation.visible) {
      this.host.hide();
      return;
    }
    this.host.text = presentation.text;
    this.host.tooltip = presentation.tooltip;
    this.host.show();
  }

  dispose(): void {
    this.host.dispose();
  }
}
