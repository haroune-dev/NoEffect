/**
 * Deterministic mapping cache (performance PR).
 *
 * Wraps the DeclarationMapper: mapping outcomes for a complete CDP
 * declaration batch are cached under a key that fully determines the result:
 *
 *   CSS file path + CSS content hash + rules fingerprint
 *   + signature of the CDP declaration batch
 *
 * Because the DeclarationMapper result depends only on the parsed local
 * stylesheet (its content hash and the exact rules — the fingerprint also
 * covers identical content embedded at different source offsets, e.g.
 * `<style>` blocks) and the exact CDP declaration batch (its signature),
 * identical inputs always hit the cache and changed inputs transparently
 * build a fresh entry. Nothing is ever cleared wholesale — each content
 * version owns its own entry, so invalidation is per cause:
 *   - CSS content change → cssHash changes → miss;
 *   - different CDP declaration batch → batch signature changes → miss;
 *   - nothing else invalidates a mapping entry.
 */

import * as crypto from 'crypto';
import { CssRule } from '../parser/cssAst';
import { MatchedCssDeclaration } from '../engine/inactivePropertyEngine';
import { DeclarationMapper, LocalDeclarationMatch } from '../matcher/declarationMapper';
import { logger } from '../utils/logger';

/**
 * Stable per-declaration cache key. Built from the same raw CDP fields the
 * mapper normalizes, so lookups always agree with what was stored.
 *
 * The key does NOT include the source range: two reports of the SAME
 * authored declaration (the same rule matching several nodes) share one
 * key and must collapse onto the same local declaration. Authored
 * DUPLICATES of a property inside one declaration block are distinct
 * reports with the same name/value — they are told apart by the
 * occurrence rank (`batchKeys`), never by the key alone.
 */
export function mappingKeyFor(cdp: MatchedCssDeclaration): string {
  return [
    cdp.selectorText,
    cdp.propertyName,
    cdp.propertyValue,
  ].join('|');
}

/**
 * Per-declaration occurrence-scoped keys for a whole batch: the `#n`
 * suffix ranks equal reports (same selector/name/value) in batch order,
 * which is the inspection order and therefore the SOURCE order of
 * authored duplicates. Both the mapper (storage) and the analyzer
 * (lookup) derive the keys from the SAME batch array, so the k-th
 * report of a property maps to the k-th local declaration.
 */
export function batchKeys(
  declarations: MatchedCssDeclaration[]
): Map<MatchedCssDeclaration, string> {
  const counts = new Map<string, number>();
  const keys = new Map<MatchedCssDeclaration, string>();
  for (const d of declarations) {
    const base = mappingKeyFor(d);
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    keys.set(d, `${base}#${n}`);
  }
  return keys;
}

function normalizeValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Deterministic signature of the whole CDP declaration batch. */
function batchSignature(declarations: MatchedCssDeclaration[]): string {
  const hash = crypto.createHash('sha256');
  for (const declaration of declarations) {
    hash.update(mappingKeyFor(declaration));
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * Deterministic fingerprint of the passed RULES. Identical selector/name/
 * value content at the SAME source ranges fingerprints identically; a
 * positional difference (same CSS text embedded at different offsets in an
 * HTML document, e.g. two `<style>` blocks with identical text) produces a
 * different fingerprint. This keeps per-target mapping entries distinct
 * even when the content hash is shared.
 */
function rulesFingerprint(rules: CssRule[]): string {
  const hash = crypto.createHash('sha256');
  for (const rule of rules) {
    hash.update(rule.selector);
    hash.update('\n');
    hash.update(
      `${rule.range.startLine}|${rule.range.startColumn}|${rule.range.endLine}|${rule.range.endColumn}`
    );
    hash.update('\n');
    for (const d of rule.declarations) {
      hash.update(
        [
          d.name,
          d.value,
          d.selector,
          d.range.startLine,
          d.range.startColumn,
          d.range.endLine,
          d.range.endColumn,
          d.nameRange.startLine,
          d.nameRange.startColumn,
          d.nameRange.endLine,
          d.nameRange.endColumn,
          d.valueRange.startLine,
          d.valueRange.startColumn,
          d.valueRange.endLine,
          d.valueRange.endColumn,
          d.endAnchorRange.startLine,
          d.endAnchorRange.startColumn,
          d.endAnchorRange.endLine,
          d.endAnchorRange.endColumn,
        ].join('|')
      );
      hash.update('\n');
    }
  }
  return hash.digest('hex');
}

class MappingCache {
  private readonly entries = new Map<string, Map<string, LocalDeclarationMatch | null>>();
  private hits: number = 0;
  private misses: number = 0;

  /**
   * Entry cap — each entry is a whole batch result map and the key embeds
   * the CSS content hash, so every analyzed content version owns its own
   * entry: unbounded growth across a save history without oldest-first
   * eviction (P2-MEM-07).
   */
  private static readonly LIMIT = 128;

  /**
   * Map a complete CDP declaration batch to its local declarations, caching
   * the whole batch so identical inputs never re-run the mapper.
   *
   * Returns a key → match map covering every declaration in the batch
   * (values are `null` for declarations that cannot be mapped locally).
   */
  matchAll(
    cssHash: string,
    cssFilePath: string,
    rules: CssRule[],
    declarations: MatchedCssDeclaration[]
  ): Map<string, LocalDeclarationMatch | null> {
    const signature = batchSignature(declarations);
    const entryKey = `${cssFilePath}|${cssHash}|${rulesFingerprint(rules)}|${signature}`;

    const cached = this.entries.get(entryKey);
    if (cached) {
      this.hits++;
      // Refresh recency: a hit re-inserts the batch at the back of the
      // insertion order, so the LRU cap evicts least-recently-USED batches.
      this.entries.delete(entryKey);
      this.entries.set(entryKey, cached);
      logger.debug(`[Mapper Cache] Hit: ${declarations.length} declaration(s)`);
      return cached;
    }

    this.misses++;
    logger.debug(`[Mapper Cache] Miss: ${declarations.length} declaration(s)`);

    const mapper = new DeclarationMapper(rules, cssFilePath);
    const results = new Map<string, LocalDeclarationMatch | null>();
    const keys = batchKeys(declarations);

    for (const declaration of declarations) {
      if (!declaration.propertyName || !normalizeValue(declaration.propertyValue)) {
        results.set(keys.get(declaration)!, null);
        continue;
      }
      // Each declaration owns its occurrence-scoped key: equal reports of
      // one authored declaration (same rule matching several nodes) map
      // through the same key — the first one claims the local declaration
      // and the later ones resolve to null (the mapper refuses to claim
      // twice) — while authored DUPLICATES rank by occurrence and each
      // claims its own local declaration.
      results.set(keys.get(declaration)!, mapper.match(declaration));
    }

    if (this.entries.size >= MappingCache.LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
    this.entries.set(entryKey, results);
    return results;
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
export const mappingCache = new MappingCache();
