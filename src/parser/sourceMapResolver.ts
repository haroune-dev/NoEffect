/**
 * Source map resolver for preprocessed CSS files.
 *
 * Stub for Phase 1 — will be implemented in Phase 10.
 * This module will handle SCSS/SASS source maps to trace
 * computed styles back to their original source locations.
 */

import { logger } from '../utils/logger';

export class SourceMapResolver {
  /**
   * Given a position in a compiled CSS file, resolve it back to
   * the original source file position using a source map.
   */
  async resolve(
    _compiledFile: string,
    _line: number,
    _column: number
  ): Promise<{ filePath: string; line: number; column: number } | null> {
    // Phase 10: Implement source map resolution
    logger.info('[SourceMap] resolve() — not yet implemented (Phase 10)');
    return null;
  }

  dispose(): void {
    // Nothing to clean up
  }
}
