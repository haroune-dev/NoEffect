/**
 * Converts CDP-provided style positions to VS Code editor positions.
 *
 * Stub for Phase 1 — will be implemented in Phase 5.
 */

import { logger } from '../utils/logger';
import { CssLocation } from '../models/cssLocation';

export class PositionMapper {
  /**
   * Map a CDP source range to a CssLocation in the local file.
   */
  async mapToLocal(
    _cdpStyleSheetId: string,
    _cdpStartLine: number,
    _cdpStartColumn: number,
    _cdpEndLine: number,
    _cdpEndColumn: number,
    _localFilePath: string
  ): Promise<CssLocation | null> {
    // Phase 5: Implement position mapping
    logger.info('[PositionMapper] mapToLocal() — not yet implemented (Phase 5)');
    return null;
  }

  dispose(): void {
    // Nothing to clean up
  }
}
