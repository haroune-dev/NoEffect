/**
 * Companion-resolution cache (Level 10 → Level 11).
 *
 * Resolution is per (primary root, CSS file) and only invalidated when the
 * world that shapes it changes: an HTML/CSS file event (create/change/
 * delete — wired from the vscode layer's file watchers), a workspace-folder
 * change, or a settings change. Reads additionally validate EVERY cached
 * companion's content hash through `fileHashCache`, so an in-place edit of
 * any linking document re-resolves even without a watcher event. Each
 * companion is validated independently; if ANY of them is stale, the whole
 * entry is invalidated (conservative — the ranked selection must stay a
 * consistent snapshot). The warm path never rescans the filesystem: a
 * validated entry is reused as-is.
 *
 * The cached value is the COMPLETE ranked companion list (canonically
 * deduplicated, pre-truncation) — the analyzer truncates it to the Top-K
 * evidence budget and derives the coverage `total`/`skipped` lists from the
 * same snapshot, so warm and cold runs report identical companion coverage.
 */

import * as fs from 'fs';
import { fileHashCache } from './fileHashCache';
import { CompanionResolution } from '../services/companionResolver';

interface CompanionCacheEntry {
  /** The full ranked list, or null when no companion links the stylesheet. */
  resolutions: CompanionResolution[] | null;

  /** Content hash per resolution (null entries are pinned by events only). */
  companionHashes: (string | null)[];
}

class CompanionCache {
  private readonly entries = new Map<string, CompanionCacheEntry>();
  private hits: number = 0;
  private misses: number = 0;

  /**
   * Read a validated entry. A hit requires the entry to exist and EVERY
   * resolved companion's content hash to be unchanged (and the file to
   * still exist). Returns undefined when the entry is stale or absent.
   */
  getValidated(key: string): CompanionResolution[] | null | undefined {
    const entry = this.getValidatedEntry(key);
    return entry?.resolutions;
  }

  /**
   * Read the RAW validated entry (resolutions + per-companion content
   * hashes). The hash-validated snapshot is the single source the analysis
   * context fingerprint is derived from (F1): the ranked list and its
   * hashes must come from the same validated entry the analysis judged
   * against, never from a fresh walk.
   */
  getValidatedEntry(key: string): CompanionCacheEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }

    if (entry.resolutions) {
      if (entry.resolutions.length !== entry.companionHashes.length) {
        this.misses++;
        return undefined;
      }
      for (let i = 0; i < entry.resolutions.length; i++) {
        const resolution = entry.resolutions[i];
        if (!fs.existsSync(resolution.htmlPath)) {
          this.misses++;
          return undefined;
        }
        try {
          const hash = fileHashCache.getOrRead(resolution.htmlPath);
          if (hash.hit && hash.hash === entry.companionHashes[i]) {
            continue;
          }
        } catch {
          this.misses++;
          return undefined;
        }
        this.misses++;
        return undefined;
      }
      this.hits++;
      return entry;
    }

    // A validated "no companion" entry: nothing on disk pins it, so it stays
    // valid until an event (watcher/workspace/settings) resets the cache.
    this.hits++;
    return entry;
  }

  set(key: string, resolutions: CompanionResolution[] | null): void {
    let companionHashes: (string | null)[] = [];
    if (resolutions) {
      companionHashes = resolutions.map((resolution) => {
        try {
          return fileHashCache.getOrRead(resolution.htmlPath).hash;
        } catch {
          return null;
        }
      });
    }
    this.entries.set(key, { resolutions, companionHashes });
  }

  /** Hit/miss counters since the cache was created/reset. */
  stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  /** Clear all entries and counters (file events, workspace/settings changes). */
  reset(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

/** Shared companion-resolution cache. */
export const companionCache = new CompanionCache();