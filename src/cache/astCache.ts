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
import { normalizeFsPath } from '../utils/pathUtils';

export interface AstCacheEntry {
  /** Parsed rules for the cached content. */
  rules: CssRule[];

  /** SHA-256 of the file contents that produced `rules`. */
  hash: string;

  /** Whether this access hit the cache (false = the file was re-parsed). */
  hit: boolean;
}

/** On-disk identity of the content an AST entry was parsed from. */
interface AstIdentity {
  hash: string;
  rules: CssRule[];
  size: number;
  mtimeMs: number;
}

class AstCache {
  private readonly entries = new Map<string, AstIdentity>();
  private hits: number = 0;
  private misses: number = 0;

  /**
   * Read a stylesheet, parse it once per unique content and return the
   * cached rules for subsequent accesses with identical content.
   *
   * The warm path is gated by a cheap `stat` (size + mtime): an unchanged
   * file is returned as a hit WITHOUT re-reading and re-hashing it
   * (P2-PERF-09). A vanished file drops its entry lazily (P2-MEM-07) and
   * the read throws as it always did.
   */
  getOrParse(filePath: string): AstCacheEntry {
    const normPath = normalizeFsPath(filePath);
    const cached = this.entries.get(normPath);
    if (cached) {
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(normPath);
      } catch {
        this.entries.delete(normPath);
      }
      if (stat && stat.size === cached.size && stat.mtimeMs === cached.mtimeMs) {
        this.hits++;
        logger.debug(`[AST Cache] Hit: ${normPath}`);
        return { rules: cached.rules, hash: cached.hash, hit: true };
      }
    }

    const content = fs.readFileSync(normPath, 'utf-8');
    const hash = this.hash(content);

    if (cached && cached.hash === hash) {
      // Identical bytes rewritten: not a content change — the cached
      // parse stays valid, only the on-disk identity is refreshed.
      this.hits++;
      logger.debug(`[AST Cache] Hit: ${normPath}`);
      const stat = this.statOf(normPath);
      this.entries.set(normPath, {
        hash,
        rules: cached.rules,
        size: stat?.size ?? -1,
        mtimeMs: stat?.mtimeMs ?? -1,
      });
      return { rules: cached.rules, hash, hit: true };
    }

    this.misses++;
    logger.debug(`[AST Cache] Miss: ${normPath}`);
    const rules = new CssAstParser().parse(content, normPath);
    const stat = this.statOf(normPath);
    this.entries.set(normPath, {
      hash,
      rules,
      size: stat?.size ?? -1,
      mtimeMs: stat?.mtimeMs ?? -1,
    });
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

  private statOf(filePath: string): fs.Stats | null {
    try {
      return fs.statSync(filePath);
    } catch {
      return null;
    }
  }
}

/** Shared cache instance used by the analyzer pipeline. */
export const astCache = new AstCache();
