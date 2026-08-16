/**
 * Phase 3 (first-run & visibility): status bar state model.
 *
 * Pure derivation of the high-level status presentation from the Phase 2
 * readiness state. No `vscode` dependency - the presentation contract is a
 * plain object the UI adapter renders - so the mapping is unit-testable.
 */

import { ReadinessState } from '../environment/readiness';
import { COMMAND_IDS } from './constants';

export type StatusState =
  | 'initializing'
  | 'ready'
  | 'analyzing'
  | 'partial'
  | 'limited'
  | 'idle'
  | 'failed'
  | 'browser_not_found'
  | 'browser_path_invalid'
  | 'browser_launch_failed'
  | 'workspace_untrusted'
  | 'workspace_unsupported'
  | 'disabled'
  | 'unknown';

export interface StatusPresentation {
  state: StatusState;

  /** Short status-bar text (no raw error messages, no paths). */
  text: string;

  /** Longer explanation, possibly including the next action. */
  tooltip: string;

  /** Whether the item should be visible at all. */
  visible: boolean;
}

/**
 * The command the status bar item opens. Always the Show Status command -
 * set once, never re-pointed.
 */
export const STATUS_BAR_COMMAND = COMMAND_IDS.showStatus;

/**
 * Derive the status presentation.
 *
 * `readiness === null` means "no meaningful snapshot yet":
 *   - before the first refresh resolves (`known = false`): Initializing,
 *   - after a refresh failed (`known = true`): a neutral Unknown state -
 *     never a misleading success/failure.
 */
export function deriveStatus(
  enabled: boolean,
  readiness: ReadinessState | null,
  known: boolean = true
): StatusPresentation {
  if (!enabled) {
    return {
      state: 'disabled',
      text: 'NoEffect: Disabled',
      tooltip: 'NoEffect is disabled by the noEffect.enabled setting. Enable it to analyze CSS.',
      visible: false,
    };
  }

  if (readiness === null) {
    return known
      ? {
          state: 'unknown',
          text: 'NoEffect: Status unknown',
          tooltip: 'NoEffect could not determine its status. Click to diagnose.',
          visible: true,
        }
      : {
          state: 'initializing',
          text: 'NoEffect: Initializing...',
          tooltip: 'Checking the environment (browser, workspace)...',
          visible: true,
        };
  }

  switch (readiness.reason) {
    case 'ready':
      return {
        state: 'ready',
        text: 'NoEffect: Ready',
        tooltip: 'NoEffect is ready to analyze CSS. Click to see details or run an analysis.',
        visible: true,
      };
    case 'browser_not_found':
      return {
        state: 'browser_not_found',
        text: 'NoEffect: Browser not found',
        tooltip: 'NoEffect needs a local Chrome, Chromium or Edge browser. Click to diagnose.',
        visible: true,
      };
    case 'browser_path_invalid':
      return {
        state: 'browser_path_invalid',
        text: 'NoEffect: Browser path invalid',
        tooltip: 'The configured browser path is not usable. Click to open settings.',
        visible: true,
      };
    case 'browser_launch_failed':
      return {
        state: 'browser_launch_failed',
        text: 'NoEffect: Setup needed',
        tooltip: 'The detected browser could not be launched. Click to diagnose.',
        visible: true,
      };
    case 'untrusted_workspace':
      return {
        state: 'workspace_untrusted',
        text: 'NoEffect: Untrusted workspace',
        tooltip: 'NoEffect requires a trusted workspace to analyze rendering behavior.',
        visible: true,
      };
    case 'unsupported_workspace':
      return {
        state: 'workspace_unsupported',
        text: 'NoEffect: Workspace unsupported',
        tooltip: 'This workspace type cannot run a local browser analysis.',
        visible: true,
      };
    case 'disabled':
      return {
        state: 'disabled',
        text: 'NoEffect: Disabled',
        tooltip: 'NoEffect is disabled. Enable the noEffect.enabled setting to analyze CSS.',
        visible: false,
      };
    default:
      return {
        state: 'unknown',
        text: 'NoEffect: Status unknown',
        tooltip: 'NoEffect could not determine its status. Click to diagnose.',
        visible: true,
      };
  }
}
