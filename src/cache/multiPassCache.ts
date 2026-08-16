/**
 * Multi-pass caches (Level 11) — the per-pass and merged-result caches of
 * the multi-companion flow.
 *
 * PER-PASS: a pass result depends exactly on the CSS content hash and the
 * companion content hash, so it is cached under `cssHash|companionHash`.
 * Maps are not directly serializable, so verdicts are stored as an entries
 * array on write and rebuilt into a `Map` on read (round-trip locked by
 * unit tests). Invalidated exactly by the content the pass derived from: a
 * css or html change produces a different hash → a different key; nothing
 * else invalidates a pass entry. Failed passes (success:false) are never
 * cached — an execution failure is a runtime condition, not content.
 *
 * MERGED: the joined result of one run is cached under
 * `cssHash|K|ordered tuple of selected companion hashes`. A warm run is
 * K lookups + one pure merge — no navigation, no rescan, no I/O.
 *
 * `reset()` clears everything (wired to the cache-reset watchers alongside
 * the companion-resolution cache).
 */

import { PassOutcome, MergedResult } from '../engine/verdictMerge';

/** A pass entry: the outcome plus the selectors its pages located. */
export interface CachedPassEntry {
  outcome: PassOutcome;

  /** Selectors that matched a real element in this companion's page. */
  locatedSelectors: string[];
}

class MultiPassCache {
  private readonly passes = new Map<string, CachedPassEntry>();
  private readonly merged = new Map<string, Map<string, MergedResult>>();
  private passHits: number = 0;
  private passMisses: number = 0;
  private mergedHits: number = 0;
  private mergedMisses: number = 0;

  passKeyFor(cssHash: string, companionHash: string): string {
    return `${cssHash}|${companionHash}`;
  }

  /**
   * The merged-result key (Phase 6): the stylesheet's content fingerprint
   * plus the canonical ANALYSIS-CONTEXT fingerprint (F1) — H(ordered
   * selected companions' canonical paths + content hashes, K, config
   * version). The same context identity the skip gate and the SessionManager
   * result namespaces use, so every layer agrees on what "the same analysis
   * context" means.
   */
  mergedKeyFor(contentFingerprint: string, contextFingerprint: string): string {
    return `${contentFingerprint}|${contextFingerprint}`;
  }

  /**
   * Rebuild a cached pass entry. Verdicts are (de)serialized across the
   * entries-array boundary, so the returned outcome is a FRESH `Map`.
   */
  getPass(key: string): CachedPassEntry | undefined {
    const cached = this.passes.get(key);
    if (!cached) {
      this.passMisses++;
      return undefined;
    }
    this.passHits++;
    return {
      outcome: {
        ...cached.outcome,
        verdicts: new Map(cached.outcome.verdicts),
      },
      locatedSelectors: [...cached.locatedSelectors],
    };
  }

  setPass(key: string, entry: CachedPassEntry): void {
    this.passes.set(key, {
      outcome: {
        ...entry.outcome,
        verdicts: new Map(entry.outcome.verdicts),
      },
      locatedSelectors: [...entry.locatedSelectors],
    });
  }

  getMerged(key: string): Map<string, MergedResult> | undefined {
    const cached = this.merged.get(key);
    if (!cached) {
      this.mergedMisses++;
      return undefined;
    }
    this.mergedHits++;
    return cached;
  }

  setMerged(key: string, merged: Map<string, MergedResult>): void {
    this.merged.set(key, merged);
  }

  stats(): {
    passHits: number;
    passMisses: number;
    mergedHits: number;
    mergedMisses: number;
  } {
    return {
      passHits: this.passHits,
      passMisses: this.passMisses,
      mergedHits: this.mergedHits,
      mergedMisses: this.mergedMisses,
    };
  }

  /** Clear all entries and counters (cache-reset command / watchers). */
  reset(): void {
    this.passes.clear();
    this.merged.clear();
    this.passHits = 0;
    this.passMisses = 0;
    this.mergedHits = 0;
    this.mergedMisses = 0;
  }
}

/** Shared multi-pass cache instance used by the analyzer pipeline. */
export const multiPassCache = new MultiPassCache();