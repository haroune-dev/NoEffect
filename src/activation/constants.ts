/**
 * Shared identifiers for the Phase 3 (first-run & visibility) layer.
 * Kept in one place so commands, context keys and persistence keys never
 * drift apart, and so tests can assert them cheaply.
 */

export const COMMAND_IDS = {
  analyzeCurrentFile: 'noEffect.analyzeCurrentFile',
  clearDecorations: 'noEffect.clearDecorations',
  showStatus: 'noEffect.showStatus',
  diagnoseSetup: 'noEffect.diagnoseSetup',
  restartAnalysisSession: 'noEffect.restartAnalysisSession',
  clearCache: 'noEffect.clearCache',
  jumpAndHighlight: 'noEffect.jumpAndHighlight',
} as const;

/** VS Code context keys exposed for `when` clauses (safe false defaults). */
export const CONTEXT_KEYS = {
  ready: 'noEffect:ready',
  enabled: 'noEffect:enabled',
  setupNeeded: 'noEffect:setupNeeded',
  workspaceBlocked: 'noEffect:workspaceBlocked',
} as const;

/**
 * Global-state key for one-time first-run completion. Versioned: bump the
 * suffix whenever the welcome message materially changes so existing users
 * see the updated message exactly once more (never re-notify otherwise).
 */
export const FIRST_RUN_STATE_KEY = 'noEffect:firstRunShown.v2';
