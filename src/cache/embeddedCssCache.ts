/**
 * Embedded-CSS caches (embedded CSS PR).
 *
 * Three content-addressed caches cover the HTML side of the pipeline:
 *   1. HTML parse cache — the `scanHtmlForCss` fragment result per
 *      (HTML path, content hash);
 *   2. embedded-fragment parse cache — `<style>` blocks parsed through the
 *      shared CSS AST with ranges shifted to the document, and `style=""`
 *      attribute values parsed as declaration lists (also document-relative);
 *   3. embedded-fragment mapping cache — deterministic CDP inline
 *      declaration → local attribute declaration matches.
 *
 * Every entry is keyed by the HTML file path plus a SHA-256 of its
 * content, so ONLY an HTML content change can invalidate an entry:
 * identical content always hits, changed content transparently builds a
 * fresh entry, and nothing else ever clears anything (the same policy as
 * the AST/mapping caches of the CSS flow — existing CSS-file caching is
 * untouched).
 *
 * The shift from fragment-relative to document-relative coordinates is
 * exact: a fragment position points at the first character of its text
 * (the `<style>` text content / the attribute value), so a
 * fragment-relative (line, column) maps to the document as
 * (fragmentLine + line, line === 0 ? fragmentColumn + column : column).
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import { CssAstParser, CssDeclaration, CssRule, CssSourceRange } from '../parser/cssAst';
import { HtmlCssFragments, scanHtmlForCss } from '../parser/htmlScanner';
import { LocalDeclarationMatch } from '../matcher/declarationMapper';
import { logger } from '../utils/logger';

/** A parsed `<style>` block: rules whose ranges are already document-relative. */
export interface ParsedStyleBlock {
  /** SHA-256 of the block's CSS text (mapping-cache discriminator). */
  contentHash: string;

  /** Rules parsed from the block, all ranges shifted into the document. */
  rules: CssRule[];
}

/** A parsed `style=""` attribute: declarations with document-relative ranges. */
export interface ParsedStyleAttribute {
  declarations: CssDeclaration[];
}

/** Result of the embedded-fragment parse cache, mirroring the fragment order. */
export interface EmbeddedCssParse {
  /** Per-block parsed rules, same order as `fragments.styleBlocks`. */
  blocks: ParsedStyleBlock[];

  /** Per-attribute parsed declarations, same order as `fragments.styleAttributes`. */
  attributes: ParsedStyleAttribute[];
}

function hash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** Shift a fragment-relative range into the document (see module doc). */
function shiftRange(
  range: CssSourceRange,
  startLine: number,
  startColumn: number
): CssSourceRange {
  return {
    startLine: range.startLine + startLine,
    startColumn: range.startLine === 0 ? range.startColumn + startColumn : range.startColumn,
    endLine: range.endLine + startLine,
    endColumn: range.endLine === 0 ? range.endColumn + startColumn : range.endColumn,
  };
}

function shiftDeclaration(declaration: CssDeclaration, startLine: number, startColumn: number): CssDeclaration {
  return {
    ...declaration,
    range: shiftRange(declaration.range, startLine, startColumn),
    nameRange: shiftRange(declaration.nameRange, startLine, startColumn),
    valueRange: shiftRange(declaration.valueRange, startLine, startColumn),
    endAnchorRange: shiftRange(declaration.endAnchorRange, startLine, startColumn),
  };
}

function shiftRule(rule: CssRule, startLine: number, startColumn: number): CssRule {
  return {
    ...rule,
    range: shiftRange(rule.range, startLine, startColumn),
    line: rule.line + startLine,
    column: rule.column + (rule.line === 0 ? startColumn : 0),
    declarations: rule.declarations.map((d) => shiftDeclaration(d, startLine, startColumn)),
  };
}

export interface HtmlFragmentCacheEntry {
  /** Full fragment scan of the document. */
  fragments: HtmlCssFragments;

  /** SHA-256 of the file contents. */
  hash: string;

  /** Whether this access hit the cache (false = the content changed). */
  hit: boolean;

  /** The file contents (the caller reads it only here). */
  content: string;
}

/** 1 — HTML parse cache: content-addressed fragment scan. */
class HtmlFragmentCache {
  private readonly entries = new Map<string, { hash: string; fragments: HtmlCssFragments; content: string }>();
  private hits: number = 0;
  private misses: number = 0;

  getOrParse(filePath: string): HtmlFragmentCacheEntry {
    const content = fs.readFileSync(filePath, 'utf-8');
    const contentHash = hash(content);

    const cached = this.entries.get(filePath);
    if (cached && cached.hash === contentHash) {
      this.hits++;
      logger.info(`[HTML Cache] Hit: ${filePath}`);
      return { fragments: cached.fragments, hash: contentHash, hit: true, content };
    }

    this.misses++;
    logger.info(`[HTML Cache] Miss: ${filePath}`);
    const fragments = scanHtmlForCss(content);
    this.entries.set(filePath, { hash: contentHash, fragments, content });
    return { fragments, hash: contentHash, hit: false, content };
  }

  stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  reset(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

/** 2 — Embedded-fragment parse cache: parsed, document-relative rules/declarations. */
class EmbeddedParseCache {
  private readonly entries = new Map<string, { hash: string; parse: EmbeddedCssParse }>();
  private hits: number = 0;
  private misses: number = 0;

  /**
   * Parse (and document-shift) the fragments of one HTML document.
   * `fragments` must be the cache entry of `htmlPath` under `htmlHash`;
   * the key covers both, so any content change rebuilds the entry.
   */
  getOrParse(htmlPath: string, htmlHash: string, fragments: HtmlCssFragments): EmbeddedCssParse {
    const key = `${htmlPath}|${htmlHash}`;
    const cached = this.entries.get(key);
    if (cached) {
      this.hits++;
      logger.info(`[Embedded Parse Cache] Hit: ${htmlPath}`);
      return cached.parse;
    }

    this.misses++;
    logger.info(`[Embedded Parse Cache] Miss: ${htmlPath}`);

    const parser = new CssAstParser();
    const blocks: ParsedStyleBlock[] = fragments.styleBlocks.map((block) => ({
      contentHash: hash(block.content),
      rules: parser
        .parse(block.content, '')
        .map((rule) => shiftRule(rule, block.position.startLine, block.position.startColumn)),
    }));
    const attributes: ParsedStyleAttribute[] = fragments.styleAttributes.map((attribute) => ({
      declarations: parser
        .parseDeclarationList(attribute.value)
        .map((d) => shiftDeclaration(d, attribute.position.startLine, attribute.position.startColumn)),
    }));

    const parse = { blocks, attributes };
    this.entries.set(key, { hash: htmlHash, parse });
    return parse;
  }

  stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  reset(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

/** 3 — Embedded-fragment mapping cache: deterministic inline matches. */
class EmbeddedMappingCache {
  private readonly entries = new Map<string, LocalDeclarationMatch | null>();
  private hits: number = 0;
  private misses: number = 0;

  /** Look up a cached inline match; `undefined` means the key is unknown. */
  get(key: string): LocalDeclarationMatch | null | undefined {
    if (!this.entries.has(key)) {
      return undefined;
    }
    this.hits++;
    return this.entries.get(key) ?? null;
  }

  /** Store an inline match (or its absence) under `key`. */
  set(key: string, match: LocalDeclarationMatch | null): void {
    this.misses++;
    this.entries.set(key, match);
  }

  stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  reset(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

/**
 * Deterministic cache key of one inline declaration of one attribute
 * fragment. `occurrenceIndex` ranks equal name/value reports of the same
 * node (authored duplicates) so each duplicate owns its own entry and its
 * own mapped slice of the attribute text.
 */
export function inlineMappingKey(
  htmlPath: string,
  htmlHash: string,
  fragmentIndex: number,
  propertyName: string,
  propertyValue: string,
  occurrenceIndex: number = 0
): string {
  return [
    htmlPath,
    htmlHash,
    String(fragmentIndex),
    propertyName,
    propertyValue,
    String(occurrenceIndex),
  ].join('|');
}

/** Shared embedded-CSS cache instances used by the analyzer pipeline. */
export const htmlFragmentCache = new HtmlFragmentCache();
export const embeddedParseCache = new EmbeddedParseCache();
export const embeddedMappingCache = new EmbeddedMappingCache();
