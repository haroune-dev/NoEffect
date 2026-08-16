/**
 * Content-addressed AST cache (performance PR).
 *
 * The parsed rules of a stylesheet are stored under a SHA-256 digest of the
 * file contents. Identical content is never parsed twice: a cached entry is
 * returned as long as the content hash matches, and a content change
 * transparently replaces the entry (the old one is simply never read again).
 *
 * Invalidation is deterministic per cause:
 *   - only a content change can invalidate an AST entry;
 *   - nothing else ever clears it (saving a file with identical bytes is a
 *     cache hit, not a re-parse).
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import { CssRule, CssAstParser } from '../parser/cssAst';
import { logger } from '../utils/logger';

export interface AstCacheEntry {
  /** Parsed rules for the cached content. */
  rules: CssRule[];

  /** SHA-256 of the file contents that produced `rules`. */
  hash: string;

  /** Whether this access hit the cache (false = the file was re-parsed). */
  hit: boolean;
}

class AstCache {
  private readonly entries = new Map<string, { hash: string; rules: CssRule[] }>();
  private hits: number = 0;
  private misses: number = 0;

  /**
   * Read a stylesheet, parse it once per unique content and return the
   * cached rules for subsequent accesses with identical content.
   */
  getOrParse(filePath: string): AstCacheEntry {
    const content = fs.readFileSync(filePath, 'utf-8');
    const hash = this.hash(content);

    const cached = this.entries.get(filePath);
    if (cached && cached.hash === hash) {
      this.hits++;
      logger.info(`[AST Cache] Hit: ${filePath}`);
      return { rules: cached.rules, hash, hit: true };
    }

    this.misses++;
    logger.info(`[AST Cache] Miss: ${filePath}`);
    const rules = new CssAstParser().parse(content, filePath);
    this.entries.set(filePath, { hash, rules });
    return { rules, hash, hit: false };
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

  private hash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
  }
}

/** Shared cache instance used by the analyzer pipeline. */
export const astCache = new AstCache();
