/**
 * Maps a CDP `MatchedCssDeclaration` to its authored local declaration by
 * matching against the parsed local stylesheet AST.
 *
 * Matching rules (PR4):
 *   - the CDP property name and value must match an authored declaration
 *     (case- and whitespace-insensitively);
 *   - the CDP selector text is matched as exactly as possible: an exact
 *     selector match beats a comma-list match, which beats no information;
 *   - range-less protocol entries are tolerated (they still carry enough
 *     name/value/selector information to be located);
 *   - one local declaration is never claimed twice — duplicate CDP entries
 *     map to a single local declaration;
 *   - malformed or incomplete CDP entries produce no false positives.
 */

import { logger } from '../utils/logger';
import { CssDeclaration, CssRule, CssSourceRange } from '../parser/cssAst';
import { MatchedCssDeclaration } from '../engine/inactivePropertyEngine';
import { CssLocation } from '../models';

/** Result of a successful CDP → local declaration mapping. */
export interface LocalDeclarationMatch {
  /** Absolute path of the local CSS file that owns the declaration. */
  filePath: string;

  /** Selector of the local rule that owns the declaration. */
  selector: string;

  /** The matched authored declaration. */
  declaration: CssDeclaration;

  /** Local range of the whole authored declaration. */
  declarationRange: CssLocation;

  /** Local range of just the property name text. */
  propertyNameRange: CssLocation;

  /** Local range of just the value text. */
  valueRange: CssLocation;

  /** Local one-character range at the end of the declaration (the icon anchor). */
  iconAnchorRange: CssLocation;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeSelector(selector: string): string {
  return selector
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*([>+~])\s*/g, '$1');
}

function selectorContains(candidate: string, target: string): boolean {
  return candidate
    .split(',')
    .map((s) => normalizeSelector(s))
    .some((s) => s === target);
}

function formatRange(r: CssLocation): string {
  return `L${r.startLine}:C${r.startColumn}–L${r.endLine}:C${r.endColumn}`;
}

export class DeclarationMapper {
  private readonly filePath: string;
  private readonly candidatesByKey: Map<string, CssDeclaration[]>;
  private readonly claimed: Set<CssDeclaration> = new Set();

  constructor(rules: CssRule[], filePath: string) {
    this.filePath = filePath;
    this.candidatesByKey = new Map();

    for (const rule of rules) {
      for (const declaration of rule.declarations) {
        const key = this.candidateKey(declaration);
        let list = this.candidatesByKey.get(key);
        if (!list) {
          list = [];
          this.candidatesByKey.set(key, list);
        }
        list.push(declaration);
      }
    }
  }

  /**
   * Map a CDP declaration to a local authored declaration, or return `null`
   * when no reliable match exists. Each local declaration is claimed on the
   * first successful match so later duplicates return `null`.
   */
  match(cdp: MatchedCssDeclaration): LocalDeclarationMatch | null {
    const name = normalizeName(cdp.propertyName);
    const value = normalizeValue(cdp.propertyValue);

    if (!name || !value) {
      logger.debug(
        `[Mapper] No local declaration matched for incomplete CDP declaration (name='${cdp.propertyName}', value='${cdp.propertyValue}')`
      );
      return null;
    }

    const candidates = this.candidatesByKey.get(this.candidateKey({ name, value }));
    if (!candidates || candidates.length === 0) {
      logger.debug(
        `[Mapper] No local declaration matched for ${name}: ${value} — not present in ${this.filePath}`
      );
      return null;
    }

    const cdpSelector = normalizeSelector(cdp.selectorText);

    const exact = candidates.filter(
      (c) => cdpSelector && normalizeSelector(c.selector) === cdpSelector
    );
    const contained = candidates.filter(
      (c) => cdpSelector && selectorContains(normalizeSelector(c.selector), cdpSelector)
    );
    const matchesSelector = new Set([...exact, ...contained]);

    const unclaimed = (list: CssDeclaration[]): CssDeclaration | null =>
      list.find((c) => !this.claimed.has(c)) ?? null;

    let best: CssDeclaration | null = null;

    if (!cdpSelector) {
      // No selector information at all: only an unambiguous single candidate
      // can be matched safely (tolerates range-less protocol entries).
      const available = candidates.filter((c) => !this.claimed.has(c));
      if (available.length === 1) {
        best = available[0];
      }
    } else {
      best = unclaimed(exact) ?? unclaimed(contained);
    }

    if (!best && cdpSelector && matchesSelector.size === candidates.length) {
      // Every candidate matched the selector but is already claimed — a
      // duplicate of an already-mapped local declaration.
      logger.debug(
        `[Mapper] CDP declaration ${name}: ${value} is a duplicate of an already-mapped local declaration`
      );
      return null;
    }

    if (!best) {
      logger.debug(
        `[Mapper] No local declaration matched for ${name}: ${value} with selector '${cdpSelector}' in ${this.filePath}`
      );
      return null;
    }

    this.claimed.add(best);

    const match = this.toMatch(best);
    logger.info(
      `[Mapper] Matched CDP declaration to local declaration: ${name} ` +
      `(selector '${cdpSelector || '(none)'}' -> '${best.selector}')`
    );
    logger.info(`[Mapper] Resolved declaration range: ${formatRange(match.declarationRange)}`);
    logger.info(`[Mapper] Resolved icon anchor range: ${formatRange(match.iconAnchorRange)}`);
    return match;
  }

  private candidateKey(d: Pick<CssDeclaration, 'name' | 'value'>): string {
    return `${normalizeName(d.name)}|${normalizeValue(d.value)}`;
  }

  private toMatch(declaration: CssDeclaration): LocalDeclarationMatch {
    return toLocalMatch(declaration, this.filePath);
  }
}

/**
 * Match an INLINE `style=""` declaration against one parsed attribute
 * fragment. Inline declarations carry no selector, so the match is purely
 * content-based (property name/value, case- and whitespace-insensitive).
 *
 * The fragment may legitimately contain SEVERAL declarations of the same
 * property (authored duplicates — only the last has an effect). CDP reports
 * the duplicates in source order, so the `occurrenceIndex` (0-based rank of
 * this declaration among same-name/value declarations of the node's inline
 * section) pairs with the same rank inside the fragment: both orders are
 * the authored source order. A missing candidate (index beyond the
 * fragment, or an empty name/value) returns `null` (conservative — never a
 * guess).
 */
export function matchInlineDeclaration(
  cdp: MatchedCssDeclaration,
  filePath: string,
  fragmentDeclarations: CssDeclaration[],
  occurrenceIndex: number = 0
): LocalDeclarationMatch | null {
  const name = normalizeName(cdp.propertyName);
  const value = normalizeValue(cdp.propertyValue);

  if (!name || !value) {
    logger.debug(
      `[Mapper] Inline match skipped for incomplete CDP declaration (name='${cdp.propertyName}', value='${cdp.propertyValue}')`
    );
    return null;
  }

  const candidates = fragmentDeclarations.filter(
    (d) => normalizeName(d.name) === name && normalizeValue(d.value) === value
  );

  if (occurrenceIndex < 0 || occurrenceIndex >= candidates.length) {
    logger.debug(
      `[Mapper] Inline ${name}: ${value} occurrence #${occurrenceIndex} has no ` +
      `candidate in the attribute (${candidates.length} candidate(s)) — skipping`
    );
    return null;
  }

  const match = toLocalMatch(candidates[occurrenceIndex], filePath);
  logger.info(
    `[Mapper] Matched inline declaration to ${filePath}: ${name} ` +
    `(range L${match.declarationRange.startLine}:C${match.declarationRange.startColumn})`
  );
  return match;
}

/** Convert a parsed declaration to a match bound to `filePath`. */
function toLocalMatch(declaration: CssDeclaration, filePath: string): LocalDeclarationMatch {
  const toLocation = (range: CssSourceRange): CssLocation => ({
    filePath,
    startLine: range.startLine,
    startColumn: range.startColumn,
    endLine: range.endLine,
    endColumn: range.endColumn,
  });

  return {
    filePath,
    selector: declaration.selector,
    declaration,
    declarationRange: toLocation(declaration.range),
    propertyNameRange: toLocation(declaration.nameRange),
    valueRange: toLocation(declaration.valueRange),
    iconAnchorRange: toLocation(declaration.endAnchorRange),
  };
}
