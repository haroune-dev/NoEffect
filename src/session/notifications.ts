/**
 * Actionable failure messages + notification allow-list (Phase 5).
 *
 * The ONLY module that turns a failure code into a user-facing message and
 * suggested actions, and the ONLY place that decides whether a failure
 * deserves a notification (vs. status + output channel only).
 *
 * Allow-list policy (respecting the Phase 4 contract):
 *  - routine recovery / self-healing events are NEVER notified — status bar
 *    and output channel carry them,
 *  - only a failure that BLOCKS an explicitly requested analysis or a
 *    user-initiated command may produce one notification,
 *  - persistent failures are deduplicated: one notification per code until
 *    the session state changes.
 */

import { AnalysisFailure } from '../failure/model';

export type ActionId =
  | 'openSettings'
  | 'diagnoseSetup'
  | 'restartSession'
  | 'showOutput'
  | 'retry';

export interface FailureMessage {
  code: string;
  /** Safe-for-users, single-line message. */
  message: string;
  /** Suggested actions, first = primary. */
  actions: ActionId[];
  /** Whether this failure may ever notify. */
  notifyable: boolean;
}

/** Deterministic code → message/action mapping (see task §10). */
export const FAILURE_MESSAGE_MAP: Readonly<Record<string, FailureMessage>> = {
  CHROMIUM_NOT_FOUND: {
    code: 'CHROMIUM_NOT_FOUND',
    message: 'No Chrome, Chromium or Edge browser was found for NoEffect.',
    actions: ['openSettings', 'diagnoseSetup'],
    notifyable: true,
  },
  CHROMIUM_PATH_INVALID: {
    code: 'CHROMIUM_PATH_INVALID',
    message: 'The configured browser path does not point at a usable browser.',
    actions: ['openSettings', 'diagnoseSetup'],
    notifyable: true,
  },
  BROWSER_LAUNCH_FAILED: {
    code: 'BROWSER_LAUNCH_FAILED',
    message: 'The browser could not be launched; a retry may succeed.',
    actions: ['restartSession', 'showOutput'],
    notifyable: true,
  },
  BROWSER_CRASHED: {
    code: 'BROWSER_CRASHED',
    message: 'The analysis browser crashed and the session was lost.',
    actions: ['restartSession', 'showOutput'],
    notifyable: true,
  },
  CDP_DISCONNECTED: {
    code: 'CDP_DISCONNECTED',
    message: 'The browser debugging session was lost and auto-recovered.',
    actions: ['restartSession', 'showOutput'],
    notifyable: false,
  },
  CDP_CONNECTION_FAILED: {
    code: 'CDP_CONNECTION_FAILED',
    message: 'NoEffect could not connect to the browser debugging session.',
    actions: ['restartSession', 'showOutput'],
    notifyable: true,
  },
  PAGE_LOAD_FAILED: {
    code: 'PAGE_LOAD_FAILED',
    message: 'The analysis page failed to load.',
    actions: ['retry', 'showOutput'],
    notifyable: true,
  },
  PAGE_LOAD_TIMEOUT: {
    code: 'PAGE_LOAD_TIMEOUT',
    message: 'The analysis page loaded slowly; results may be partial.',
    actions: ['retry', 'showOutput'],
    notifyable: false,
  },
  DEVSERVER_START_FAILED: {
    code: 'DEVSERVER_START_FAILED',
    message: 'The local analysis server could not be started.',
    actions: ['retry', 'showOutput'],
    notifyable: true,
  },
  DEVSERVER_PORT_BUSY: {
    code: 'DEVSERVER_PORT_BUSY',
    message: 'The analysis server port is in use; a retry may find it free.',
    actions: ['retry', 'showOutput'],
    notifyable: true,
  },
  COMPANION_FAILED: {
    code: 'COMPANION_FAILED',
    message: 'The companion analysis could not be completed.',
    actions: ['showOutput'],
    notifyable: false,
  },
  ANALYSIS_CANCELLED: {
    code: 'ANALYSIS_CANCELLED',
    message: 'The analysis was cancelled.',
    actions: ['showOutput'],
    notifyable: false,
  },
  SESSION_LOST: {
    code: 'SESSION_LOST',
    message: 'The analysis session was lost; the next analysis recovers it.',
    actions: ['restartSession', 'showOutput'],
    notifyable: false,
  },
  ANALYSIS_TIMEOUT: {
    code: 'ANALYSIS_TIMEOUT',
    message: 'The analysis took too long and was abandoned.',
    actions: ['retry', 'showOutput'],
    notifyable: true,
  },
  WORKSPACE_UNTRUSTED: {
    code: 'WORKSPACE_UNTRUSTED',
    message: 'NoEffect needs a trusted workspace to analyze css.',
    actions: ['diagnoseSetup'],
    notifyable: true,
  },
};

/**
 * Map any classified failure to its entry. Falls back to a deterministic
 * neutral entry — unknown codes never invent a message or notify.
 */
export function messageForFailure(failure: AnalysisFailure): FailureMessage {
  const mapped = FAILURE_MESSAGE_MAP[failure.code];
  if (mapped) {
    return mapped;
  }
  return {
    code: failure.code,
    message: 'The analysis could not be completed.',
    actions: ['showOutput'],
    notifyable: false,
  };
}

/**
 * Allow-list decision: should a failure of this code ever notify?
 * `blocking` = a user explicitly requested the work that failed (a manual
 * command or an explicitly-requested analysis) — the only case where a
 * notification is legitimate.
 */
export function shouldNotify(failure: AnalysisFailure, blocking: boolean): boolean {
  const mapped = messageForFailure(failure);
  return blocking && mapped.notifyable;
}

/**
 * One-notification-per-code dedupe for persistent failures. `stateKey`
 * should change (e.g. session epoch or a block of state) so the policy
 * resets naturally after the state changes.
 */
export class NotificationDedupe {
  private readonly notified = new Map<string, string>();

  /**
   * Returns true when a notification should be shown (meaning: the code was
   * not already noted for this stateKey) and records it.
   */
  shouldSend(code: string, stateKey: string): boolean {
    const prev = this.notified.get(code);
    if (prev === stateKey) {
      return false;
    }
    this.notified.set(code, stateKey);
    return true;
  }

  /** Drop all memory (used on session-state changes). */
  reset(): void {
    this.notified.clear();
  }
}