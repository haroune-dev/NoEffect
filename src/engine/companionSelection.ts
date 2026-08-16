/**
 * Companion SELECTION for analysis (Level 11 — evidence expansion).
 *
 * The Top-K evidence budget (`maxCompanions`) bounds the multi-pass run,
 * but a declaration must not be judged inactive solely because the ONLY
 * document that gives it effect sits outside the Top-K. The selection
 * therefore expands the Top-K with a small, deterministic, budget-bounded
 * tail: after the K highest-ranked companions, the remaining candidates
 * are picked in ranked order while a cheap CONTAINMENT scan of the
 * stylesheet's queryable selectors against the candidate document keeps
 * matching. The scan is a conservative word-boundary token superset — it
 * may over-expand, never under-expand — so a companion whose DOM actually
 * matches a selector is always reached.
 *
 * The whole selection is a pure function of (ranked list, selectors, K,
 * budget, page contents), so the analysis run and the post-run freshness
 * probes select IDENTICALLY from the same validated companion snapshot.
 * That identity is what keeps the recorded context fingerprint stable: no
 * fabricated STALE, no decoration clearing, no re-analysis flicker.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileHashCache } from '../cache/fileHashCache';
import { CompanionResolution } from '../services/companionResolver';
import { htmlContainsAnySelector } from './selectorScan';

/**
 * How many documents beyond the Top-K budget a single analysis may
 * add to its selection (the evidence-expansion tail). Kept small so the
 * per-run pass count stays bounded even on huge projects (the total
 * per-run ceiling is K + this budget). Sized so that a project whose
 * EVERY document carries unique evidence (7 link pages with K=3, the
 * multi-page stress fixture) still gets every document judged — a
 * declaration effective in only one document must never be dropped.
 */
export const COMPANION_EXPANSION_BUDGET = 4;

/**
 * A scan-result cache for the containment check: (css hash, page path) →
 * whether the page contains any of that stylesheet's selector tokens.
 * The page's content hash (via `fileHashCache`) gates the entry, so an
 * in-place edit re-scans exactly once. Bounded by SCAN_CACHE_LIMIT entries
 * (oldest evicted) — it is a pure optimization, never a correctness input.
 */
interface ScanCacheEntry {
  /** Content hash of the page the result was computed against. */
  pageHash: string;

  /** Content hash of the stylesheet the tokens came from. */
  cssHash: string;

  /** The containment verdict for that exact (page, stylesheet) pair. */
  contains: boolean;
}

const SCAN_CACHE_LIMIT = 256;
const scanCache = new Map<string, ScanCacheEntry>();

/**
 * Whether a candidate companion document plausibly contains an element for
 * any of the stylesheet's selectors. The verdict is memoized per
 * (page content hash, stylesheet content hash) — identical inputs are
 * scanned once.
 */
export function cachedPageContainsAnySelector(
  htmlPath: string,
  selectors: readonly string[],
  cssHash: string
): boolean {
  const key = path.resolve(htmlPath);
  const cached = scanCache.get(key);
  const pageHash = fileHashCache.getOrRead(key).hash;
  if (cached && cached.pageHash === pageHash && cached.cssHash === cssHash) {
    return cached.contains;
  }

  let contains = false;
  try {
    contains = htmlContainsAnySelector(fs.readFileSync(key, 'utf-8'), selectors);
  } catch {
    contains = false;
  }

  if (scanCache.size >= SCAN_CACHE_LIMIT) {
    const oldest = scanCache.keys().next().value;
    if (oldest !== undefined) {
      scanCache.delete(oldest);
    }
  }
  scanCache.set(key, { pageHash, cssHash, contains });
  return contains;
}

/** Clear the scan-result cache (used by tests). */
export function resetSelectionScans(): void {
  scanCache.clear();
}

/**
 * The Level 11 companion selection: the Top-K ranked companions, plus the
 * ranked-order expansion tail of candidates whose documents contain the
 * stylesheet's selector tokens — bounded by `expansionBudget`. Pure and
 * deterministic: the same inputs always yield the same selection.
 */
export function selectCompanionsForAnalysis(
  ranked: readonly CompanionResolution[],
  selectors: readonly string[],
  maxCompanions: number,
  expansionBudget: number,
  pageContains: (companion: CompanionResolution) => boolean
): CompanionResolution[] {
  const primary = ranked.slice(0, maxCompanions);
  if (expansionBudget <= 0 || selectors.length === 0) {
    return primary;
  }

  const selection = [...primary];
  let added = 0;
  for (let i = maxCompanions; i < ranked.length && added < expansionBudget; i++) {
    if (pageContains(ranked[i])) {
      selection.push(ranked[i]);
      added++;
    }
  }
  return selection;
}