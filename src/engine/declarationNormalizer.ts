import { logger } from '../utils/logger';
import { MatchedCssDeclaration } from './inactivePropertyEngine';

/**
 * Deduplication strategy for matched declarations coming from CDP.
 *
 * CDP can report the same authored declaration more than once (e.g. a
 * representation with a valid source range and an equivalent range-less
 * representation). This module normalizes those representations so that
 * one authored declaration is inspected exactly once.
 */

/**
 * Identity of an authored declaration, ignoring source position.
 * Two representations are "the same declaration" when this matches.
 */
function identityKey(d: MatchedCssDeclaration): string {
  return [
    d.styleSheetId ?? '',
    d.selectorText,
    d.propertyName,
    d.propertyValue,
  ].join('|');
}

/**
 * Full deduplication key, including the source range, so that two
 * genuinely different declarations (different ranges) stay distinct.
 */
function rangedKey(d: MatchedCssDeclaration): string {
  const r = d.propertyRange;
  if (!r) {
    return identityKey(d);
  }
  return `${identityKey(d)}|${r.startLine}|${r.startColumn}|${r.endLine}|${r.endColumn}`;
}

/**
 * Normalize and deduplicate matched declarations:
 *
 * 1. Partition declarations into ranged and range-less.
 * 2. Deduplicate ranged declarations by their full key; when the same key
 *    appears twice, prefer the one with `author` origin.
 * 3. Drop range-less declarations when an equivalent ranged declaration
 *    exists (same stylesheet, selector, property name and value).
 * 4. Keep range-less declarations that have no ranged equivalent — they
 *    cannot be source-mapped safely, but are not duplicates.
 * 5. Log every skipped duplicate at DEBUG level.
 */
export function normalizeAndDeduplicate(
  declarations: MatchedCssDeclaration[]
): MatchedCssDeclaration[] {
  const ranged: MatchedCssDeclaration[] = [];
  const rangeLess: MatchedCssDeclaration[] = [];

  for (const d of declarations) {
    if (d.propertyRange) {
      ranged.push(d);
    } else {
      rangeLess.push(d);
    }
  }

  // ── Step 2: deduplicate ranged declarations ──
  const result: MatchedCssDeclaration[] = [];

  for (const d of ranged) {
    const key = rangedKey(d);
    const existingIndex = result.findIndex((r) => rangedKey(r) === key);

    if (existingIndex === -1) {
      result.push(d);
      continue;
    }

    const existing = result[existingIndex];
    if (d.origin === 'author' && existing.origin !== 'author') {
      result[existingIndex] = d;
      logger.debug(`[Dedup] Preferred author declaration for ${d.propertyName} (${key})`);
    } else {
      logger.debug(`[Dedup] Skipped duplicate ranged declaration ${d.propertyName} (${key})`);
    }
  }

  // ── Steps 3-4: filter range-less duplicates ──
  // CDP's range-less section is the RESOLVED representation of the
  // authored declarations: a copy of the winning value, or a serialized/
  // expanded form of the same authored declaration (`center` → `center
  // center`, `#b00` → `rgb(176, 0, 0)`, shorthand `border` → the
  // border-* longhands...). A range-less declaration is NEVER a separate
  // authored declaration when the same block already reports the property
  // with a source range, so the name check drops every such resolved copy
  // — the identity check alone cannot (the serialized value differs).
  const rangedBlockNames = new Set<string>();
  for (const d of ranged) {
    rangedBlockNames.add(`${d.blockId ?? ''}|${d.propertyName.trim().toLowerCase()}`);
  }
  const rangedIdentities = new Set(ranged.map(identityKey));
  const keptRangeLessIdentities = new Set<string>();

  for (const d of rangeLess) {
    const idKey = identityKey(d);
    const blockNameKey = `${d.blockId ?? ''}|${d.propertyName.trim().toLowerCase()}`;

    if (rangedIdentities.has(idKey) || rangedBlockNames.has(blockNameKey)) {
      logger.debug(
        `[Dedup] Skipped range-less copy of ${d.propertyName} ` +
        `(same declaration exists with a source range: ${idKey})`
      );
      continue;
    }

    if (keptRangeLessIdentities.has(idKey)) {
      logger.debug(`[Dedup] Skipped duplicate range-less declaration ${d.propertyName} (${idKey})`);
      continue;
    }

    keptRangeLessIdentities.add(idKey);
    result.push(d);
  }

  return result;
}

/**
 * Mark the earlier duplicates of a property inside ONE declaration block.
 *
 * CSS semantics: within a single declaration block (one rule or one
 * `style=""` attribute) the LAST declaration of a property wins, so every
 * earlier declaration of the same property provably has no effect. The
 * engine answers marked declarations with a fixed override verdict — the
 * property's context rule never runs for them, because the override fact
 * is definitive.
 *
 * The block is identified by `blockId` (attached by the collector); the
 * ordering is the SOURCE order of the declarations (CDP reports
 * `cssProperties` in source order with distinct ranges per authored
 * declaration — verified against real Chromium — so the last per property
 * is the cascade winner). Range-less declarations sort last as a
 * tie-break; within one block they are normally dropped anyway.
 *
 * Every marked declaration also receives an `overriddenBy` pointer to
 * the cascade winner (the last declaration of the property in the
 * block), so consumers can navigate the user from the dead duplicate
 * to the live one.
 *
 * ── Cross-rule cascade pass ──
 *
 * The same node usually matches SEVERAL rules declaring the same
 * property (`.action-button { color: #fff }` vs
 * `.action-button.is-danger { color: #ff4d4f }`): only the cascade
 * winner has an effect, every other declaration on that node is dead.
 * The second pass of this function resolves that competition per
 * (pseudo scope, property):
 *
 *   - the batch is one node's declarations, so every declaration in a
 *     scope group competes for the SAME element;
 *   - CDP lists `matchedCSSRules` in cascade order (least → most
 *     priorous; the same fact `collectDeclaredDisplay` relies on), so
 *     the collector's `rule-<N>` blockId ORDER is the rule cascade
 *     order (specificity, then source order);
 *   - `!important` flips rule-vs-rule and beats the inline attribute's
 *     normal declarations; the inline attribute beats every normal
 *     rule. Encoded as a tier: rule 0 < inline 1 < !important rule 2 <
 *     !important inline 3;
 *   - user-agent / injected / inspector origins never compete with
 *     authored declarations (a normal UA rule never overrides an
 *     author rule) — they are excluded from the cross-rule pass, while
 *     same-block duplicates inside them are still marked by the first
 *     pass;
 *   - pseudo-element declarations compete only within their own pseudo
 *     scope (a `::before` rule never overrides the element's rules).
 *
 * Losing declarations are flagged `isCrossRuleOverride` so the engine
 * can name the winning selector in the reason text; their
 * `overriddenBy` pointer is (re)pointed at the GLOBAL winner — the
 * declaration the user should read instead.
 *
 * The cross-rule pass is a fact about REAL documents only: the CSS-file
 * wrapper flow fabricates one element per selector, and two selectors
 * can overlap on one fabricated element (`.x` and `img.x` both match the
 * wrapper's `<img class="x">`) even though no real document co-locates
 * them. Cross-rule losses observed on the synthetic wrapper are not
 * provable, so that flow passes `{ crossRule: false }` and gets the
 * same-block pass alone (a block-internal duplicate is dead regardless
 * of which element matched).
 *
 * Returns the declarations unchanged (mutates the flags in place) — the
 * batch the analyzer inspects and maps is the exact same array.
 */
export function markOverriddenDeclarations(
  declarations: MatchedCssDeclaration[],
  options: { crossRule?: boolean } = {}
): void {
  const byBlock = new Map<string, MatchedCssDeclaration[]>();
  for (const d of declarations) {
    if (!d || typeof d.propertyName !== 'string') {
      continue;
    }
    const key = d.blockId ?? 'block';
    let block = byBlock.get(key);
    if (!block) {
      block = [];
      byBlock.set(key, block);
    }
    block.push(d);
  }

  // The last declaration of a property in each block, after the first
  // (same-block) pass — the per-block winners are the candidates the
  // cross-rule pass competes.
  const blockWinner = new Map<string, Map<string, MatchedCssDeclaration>>();

  for (const [blockId, block] of byBlock) {
    const positionOf = (d: MatchedCssDeclaration): number => {
      const r = d.propertyRange;
      if (!r) {
        return Number.MAX_SAFE_INTEGER;
      }
      return r.startLine * 1_000_000_000 + r.startColumn;
    };

    const ordered = [...block].sort((a, b) => positionOf(a) - positionOf(b));

    const lastPerProperty = new Map<string, MatchedCssDeclaration>();
    for (const d of ordered) {
      lastPerProperty.set(d.propertyName.trim().toLowerCase(), d);
    }
    blockWinner.set(blockId, lastPerProperty);

    for (const d of ordered) {
      const winner = lastPerProperty.get(d.propertyName.trim().toLowerCase());
      if (winner !== d) {
        d.isOverridden = true;
        d.overriddenBy = winner;
        logger.debug(
          `[Dedup] Overridden earlier duplicate: ${d.propertyName} (${d.selectorText || 'inline'})`
        );
      }
    }
  }

  if (options.crossRule !== false) {
    markCrossRuleOverridden(declarations, byBlock, blockWinner);
  }
}

/** Origins that never compete with authored declarations cross-rule. */
const FOREIGN_ORIGINS = new Set(['user-agent', 'injected', 'inspector']);

/** Cascade tier: normal rule 0 < inline 1 < !important rule 2 < !important inline 3. */
function cascadeTier(d: MatchedCssDeclaration): number {
  if (d.important) {
    return d.isInlineStyle || d.blockId === 'inline' ? 3 : 2;
  }
  return d.isInlineStyle || d.blockId === 'inline' ? 1 : 0;
}

/** Rule index from the collector's `rule-<N>` blockId (response = cascade order). */
function ruleOrder(d: MatchedCssDeclaration): number {
  const match = /^rule-(\d+)$/.exec(d.blockId ?? '');
  return match ? Number(match[1]) : -1;
}

/**
 * Cross-rule cascade resolution (see the header comment of
 * `markOverriddenDeclarations`). Per (pseudo scope, property) the
 * winning BLOCK is the one with the highest (tier, rule order) among
 * authored blocks; every authored declaration of that property in
 * ANOTHER block loses and is pointed at the winning declaration.
 */
function markCrossRuleOverridden(
  declarations: MatchedCssDeclaration[],
  byBlock: Map<string, MatchedCssDeclaration[]>,
  blockWinner: Map<string, Map<string, MatchedCssDeclaration>>
): void {
  const isAuthored = (d: MatchedCssDeclaration): boolean =>
    !FOREIGN_ORIGINS.has(d.origin ?? 'regular');

  // Winning block per (pseudo scope, property): (tier, rule order) key.
  const winningBlock = new Map<string, { blockId: string; tier: number; order: number }>();

  for (const [blockId, perProperty] of blockWinner) {
    // A block competes only when it holds at least one authored
    // declaration (foreign-origin blocks are excluded wholesale).
    const blockDeclarations = byBlock.get(blockId) ?? [];
    if (!blockDeclarations.some(isAuthored)) {
      continue;
    }

    for (const [property, winner] of perProperty) {
      if (!isAuthored(winner)) {
        continue;
      }
      const scope = `${winner.pseudoElement ?? ''}|${property}`;
      const rank = { blockId, tier: cascadeTier(winner), order: ruleOrder(winner) };
      const current = winningBlock.get(scope);
      if (
        !current ||
        rank.tier > current.tier ||
        (rank.tier === current.tier && rank.order > current.order)
      ) {
        winningBlock.set(scope, rank);
      }
    }
  }

  for (const d of declarations) {
    if (!d || typeof d.propertyName !== 'string' || !isAuthored(d)) {
      continue;
    }
    const property = d.propertyName.trim().toLowerCase();
    const scope = `${d.pseudoElement ?? ''}|${property}`;
    const winnerBlock = winningBlock.get(scope);
    if (!winnerBlock || winnerBlock.blockId === d.blockId) {
      continue;
    }
    const winner = blockWinner.get(winnerBlock.blockId)?.get(property);
    if (!winner) {
      continue;
    }
    d.isOverridden = true;
    d.isCrossRuleOverride = true;
    d.overriddenBy = winner;
    logger.debug(
      `[Dedup] Cross-rule override: ${d.propertyName} in '${d.selectorText || 'inline'}' ` +
      `loses to '${winner.selectorText || 'inline'}'`
    );
  }
}
