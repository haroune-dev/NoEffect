/**
 * Matches CSS rules from CDP with rules parsed from the local AST.
 *
 * Stub for Phase 1 — will be implemented in Phase 5.
 */

import { logger } from '../utils/logger';

export class RuleMatcher {
  /**
   * Match a CDP rule identifier with a local AST rule.
   */
  async matchRule(
    _cdpRuleSelector: string,
    _cdpStyleSheetId: string,
    _localRules: unknown[]
  ): Promise<unknown | null> {
    // Phase 5: Implement rule matching
    logger.info('[RuleMatcher] matchRule() — not yet implemented (Phase 5)');
    return null;
  }

  dispose(): void {
    // Nothing to clean up
  }
}
