/**
 * Matches individual CSS properties from CDP data with local AST properties.
 *
 * Stub for Phase 1 — will be implemented in Phase 5.
 */

import { logger } from '../utils/logger';

export class PropertyMatcher {
  /**
   * Match a CDP property with its local AST counterpart.
   */
  async matchProperty(
    _cdpPropertyName: string,
    _cdpPropertyValue: string,
    _localProperties: unknown[]
  ): Promise<unknown | null> {
    // Phase 5: Implement property matching
    logger.info('[PropertyMatcher] matchProperty() — not yet implemented (Phase 5)');
    return null;
  }

  dispose(): void {
    // Nothing to clean up
  }
}
