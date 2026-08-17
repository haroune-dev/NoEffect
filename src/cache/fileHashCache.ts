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

/** On-disk identity of the content a hash was computed against. */
interface FileIdentity {
  /** Hash of the file contents. */
  hash: string;

  /** Size of the file when the hash was computed (cheap freshness gate). */
  size: number;

  /** Last-modified time when the hash was computed (cheap freshness gate). */
  mtimeMs: number;
}

class FileHashCache {
  private readonly entries = new Map<string, FileIdentity>();
  private hits: number = 0;
  private misses: number = 0;

  /**
   * Read a file and compare its content hash with the previously observed
   * one. A hit means nothing changed since the last read.
   *
   * The warm path is gated by a cheap `stat` (size + mtime): an unchanged
   * file is returned as a hit WITHOUT re-reading and re-hashing it — the
   * probe costs one stat, not a full read + SHA-256 on the extension-host
   * thread (P2-PERF-09). A vanished file drops its entry lazily.
   */
  getOrRead(filePath: string): FileHashEntry {
    const cached = this.entries.get(filePath);
    if (cached) {
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(filePath);
      } catch {
        // The file vanished — lazily drop the stale entry (P2-MEM-07) and
        // fall through to the read, which throws as it always did; callers
        // decide how to degrade.
        this.entries.delete(filePath);
      }
      if (stat && stat.size === cached.size && stat.mtimeMs === cached.mtimeMs) {
        this.hits++;
        logger.debug(`[FileHash Cache] Hit: ${filePath}`);
        return { hash: cached.hash, hit: true };
      }
    }

    // The gate did not hit: either the file looks changed or it is new.
    const hash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(filePath, 'utf-8'), 'utf-8')
      .digest('hex');

    if (cached?.hash === hash) {
      // Identical bytes rewritten (same content, newer mtime): not a
      // content change — a hit (no miss is recorded for it), with the
      // fresh stat stored below.
      this.hits++;
      logger.debug(`[FileHash Cache] Hit after identical rewrite: ${filePath}`);
    } else {
      this.misses++;
      logger.debug(`[FileHash Cache] Miss: ${filePath}`);
    }

    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(filePath);
    } catch {
      // The file vanished between read and stat — keep only the hash; the
      // next probe re-reads.
    }
    const identity: FileIdentity = {
      hash,
      size: stat?.size ?? -1,
      mtimeMs: stat?.mtimeMs ?? -1,
    };
    this.entries.set(filePath, identity);
    return { hash, hit: cached?.hash === hash };
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
