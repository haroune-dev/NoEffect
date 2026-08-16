/**
 * Content-hash tracker for non-CSS files (performance PR extension).
 *
 * The HTML document drives which selectors are queried, so its content
 * changes must trigger a page refresh. The AST cache only understands CSS,
 * so this tiny cache tracks plain content hashes: identical content is a
 * hit, a content change is the only invalidator.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import { logger } from '../utils/logger';

export interface FileHashEntry {
  /** SHA-256 of the file contents. */
  hash: string;

  /** Whether this access hit the cache (false = the content changed). */
  hit: boolean;
}

class FileHashCache {
  private readonly entries = new Map<string, string>();
  private hits: number = 0;
  private misses: number = 0;

  /**
   * Read a file and compare its content hash with the previously observed
   * one. A hit means nothing changed since the last read.
   */
  getOrRead(filePath: string): FileHashEntry {
    const hash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(filePath, 'utf-8'), 'utf-8')
      .digest('hex');

    const cached = this.entries.get(filePath);
    if (cached === hash) {
      this.hits++;
      logger.info(`[FileHash Cache] Hit: ${filePath}`);
      return { hash, hit: true };
    }

    this.misses++;
    logger.info(`[FileHash Cache] Miss: ${filePath}`);
    this.entries.set(filePath, hash);
    return { hash, hit: false };
  }

  /** Number of cache hits and misses since the cache was created/reset. */
  stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  /** Clear all entries and counters (used by tests). */
  reset(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

/** Shared cache instance used by the analyzer pipeline. */
export const fileHashCache = new FileHashCache();
