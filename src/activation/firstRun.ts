/**
 * Phase 3 (first-run & visibility): one-time onboarding.
 *
 * Decides whether (and which) first-run message to show, shows it exactly
 * once per user (global state), never nags, stays quiet when disabled, and
 * fails quietly when persistence or messaging misbehaves.
 *
 * The vscode surface (globalState, showInformationMessage) is injected, so
 * the whole policy is unit-testable without the extension host.
 */

import { ReadinessState } from '../environment/readiness';
import { COMMAND_IDS, FIRST_RUN_STATE_KEY } from './constants';

/** Persistence of the one-time completion flag (global state). */
export interface FirstRunStore {
  hasCompleted(): boolean;
  markCompleted(): void;
}

export interface FirstRunAction {
  title: string;
  detail?: string;
  run(): void | Promise<void>;
}

/** The vscode notification surface (stubbed in tests). */
export interface FirstRunMessenger {
  show(message: FirstRunMessage, actions: FirstRunAction[]): Promise<void>;
}

export type FirstRunDecision = 'none' | 'ready' | 'setup' | 'workspace';

/**
 * Structured notification content. `title` is the notification headline;
 * `body` is rendered underneath it. VS Code flattens raw newlines in
 * notification messages, so the body is passed via the native `detail`
 * option instead.
 */
export interface FirstRunMessage {
  title: string;
  body?: string;
}

/**
 * VS Code notifications render a single line only: raw newlines are
 * stripped from the message and the `detail` option is ignored for
 * non-modal notifications. The title and body are therefore composed
 * into one compact sentence (no long command names).
 */
export function composeFirstRunMessage(message: FirstRunMessage): string {
  return message.body ? `${message.title} — ${message.body}` : message.title;
}

/** Stable product strings (asserted by tests where useful). */
export const FIRST_RUN_MESSAGES: Record<Exclude<FirstRunDecision, 'none'>, FirstRunMessage> = {
  ready: {
    title: 'NoEffect is ready',
    body: 'Open a CSS or HTML file and run analysis to check for inactive properties.',
  },
  setup: {
    title: 'NoEffect needs a browser',
    body: 'Install a local Chrome, Chromium, or Edge browser, or configure the browser path setting.',
  },
  workspace: {
    title: 'NoEffect needs a trusted workspace',
    body: 'Trust this local workspace to analyze rendering behavior.',
  },
};

/**
 * The native VS Code Workspace Trust management command (opens the trust
 * dialog / security editor) — the handler of the workspace toast's
 * primary action.
 */
export const TRUST_MANAGE_COMMAND = 'workbench.trust.manage';

/**
 * The workspace-toast actions: **Trust Workspace** opens VS Code's native
 * Workspace Trust management; **Diagnose Setup** keeps the in-extension
 * diagnostics. `execute` is injected (the extension host command runner),
 * keeping this factory unit-testable without `vscode`.
 */
export function createWorkspaceActions(
  execute: (id: string) => void | Promise<void>
): FirstRunAction[] {
  return [
    {
      title: 'Trust Workspace',
      run: () => execute(TRUST_MANAGE_COMMAND),
    },
    {
      title: 'Diagnose Setup',
      run: () => execute(COMMAND_IDS.diagnoseSetup),
    },
  ];
}

/**
 * The deterministic first-run decision for a readiness snapshot:
 *
 *   - disabled (or unknown snapshot)      → quiet,
 *   - environment ready                   → ready welcome,
 *   - browser missing/invalid/launch fail → setup message with actions,
 *   - untrusted/unsupported workspace     → workspace message,
 *   - anything else (file-level reasons)  → quiet.
 */
export function decideFirstRun(
  enabled: boolean,
  readiness: ReadinessState | null
): FirstRunDecision {
  if (!enabled || readiness === null) {
    return 'none';
  }
  switch (readiness.reason) {
    case 'ready':
      return 'ready';
    case 'browser_not_found':
    case 'browser_path_invalid':
    case 'browser_launch_failed':
      return 'setup';
    case 'untrusted_workspace':
    case 'unsupported_workspace':
      return 'workspace';
    default:
      return 'none';
  }
}

export class FirstRunCoordinator {
  /** In-flight guard: concurrent snapshots can never double-show. */
  private showing = false;

  /**
   * Session guard: once shown (or known completed), never show again in
   * this activation even when persistence is unreadable/broken - a broken
   * store must not cause a re-show loop.
   */
  private completed = false;

  constructor(
    private readonly store: FirstRunStore,
    private readonly messenger: FirstRunMessenger,
    private readonly actions: Record<Exclude<FirstRunDecision, 'none'>, FirstRunAction[]> = {
      ready: [],
      setup: [],
      workspace: [],
    },
    private readonly onShown: () => void = () => {}
  ) {}

  /**
   * Show the first-run message if (and only if) it has never been shown.
   * Safe to call repeatedly (settings changes, trust changes, refreshes).
   *
   * The WORKSPACE decision is deliberately NOT one-time onboarding: it is
   * a per-session security prompt that must reappear whenever an
   * untrusted workspace is open (a user who completed onboarding years
   * ago still gets it), so it bypasses the global completion flag, never
   * writes it, and is suppressed only by the session guards (`showing`
   * while visible, `completed` after a show/dismiss in THIS activation —
   * no duplicates on active-file switching).
   */
  async runOnce(enabled: boolean, readiness: ReadinessState | null): Promise<void> {
    const decision = decideFirstRun(enabled, readiness);
    if (decision === 'none' || this.showing || this.completed) {
      return;
    }

    if (decision !== 'workspace') {
      let storedCompleted = false;
      try {
        storedCompleted = this.store.hasCompleted();
      } catch {
        // Unreadable state: treat as not completed (safe reset) - never crash.
        storedCompleted = false;
      }
      if (storedCompleted) {
        this.completed = true;
        return;
      }
    }

    this.showing = true;
    try {
      await this.messenger.show(FIRST_RUN_MESSAGES[decision], this.actions[decision]);
    } catch {
      // Messaging failed: stay quiet, do not retry this activation. The
      // session guard must latch even on failure (P3-LOG-25) — otherwise a
      // broken messenger re-shows on every subsequent snapshot, nagging the
      // user with a notification they can never act on.
      this.showing = false;
      this.completed = true;
      return;
    }
    this.showing = false;
    this.completed = true;

    if (decision === 'workspace') {
      // The workspace prompt never touches the one-time onboarding flag:
      // a future session with an untrusted workspace must prompt again.
      this.onShown();
      return;
    }

    // Marked completed even when the environment is not ready: persistent
    // problems stay visible through status bar / Show Status / Diagnose
    // Setup, never through repeated notifications.
    try {
      this.store.markCompleted();
      this.onShown();
    } catch {
      // Persistence failed: fail quietly; the session guard already prevents
      // any re-show in this activation.
    }
  }

  /**
   * Dev-only: show the welcome again regardless of the one-time guards.
   * Never marks completion, so the real first-run still happens for users.
   * Falls back to the ready message when the decision would be quiet.
   */
  async forceShow(enabled: boolean, readiness: ReadinessState | null): Promise<void> {
    const decision = decideFirstRun(enabled, readiness);
    const effective: Exclude<FirstRunDecision, 'none'> = decision === 'none' ? 'ready' : decision;
    await this.messenger.show(FIRST_RUN_MESSAGES[effective], this.actions[effective]);
  }
}

/** Re-export for callers that need the persistence key name. */
export { FIRST_RUN_STATE_KEY };
