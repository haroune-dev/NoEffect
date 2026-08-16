/**
 * Dependency-free positional CSS parser.
 *
 * Parses a CSS stylesheet into rules and declarations while preserving the
 * exact source position of every declaration, its property name, its value
 * and the one-character anchor used for the inline warning icon.
 *
 * Guarantees (PR4):
 *   - whitespace-insensitive: name/value/ranges are trimmed, never shifted
 *     by surrounding whitespace or newlines;
 *   - comments (`/* ... *`` /) are ignored without breaking positions;
 *   - multiple declarations per rule are supported and order is preserved;
 *   - all ranges use the 0-based CDP/VS Code convention (startLine,
 *     startColumn, endLine, endColumn).
 */

export interface CssSourceRange {
  /** 0-based line where the range starts */
  startLine: number;

  /** 0-based column where the range starts */
  startColumn: number;

  /** 0-based line where the range ends */
  endLine: number;

  /** 0-based column where the range ends */
  endColumn: number;
}

/**
 * A single parsed declaration, carrying every range PR4 needs:
 *   - `range`           full declaration (name → trailing `;` when present)
 *   - `nameRange`       just the property name text
 *   - `valueRange`      just the trimmed value text
 *   - `endAnchorRange`  one character at the end of the declaration
 *                       (normally the `;`), used as the icon anchor
 */
export interface CssDeclaration {
  name: string;
  value: string;
  important: boolean;

  /** Selector of the rule that owns this declaration */
  selector: string;

  range: CssSourceRange;
  nameRange: CssSourceRange;
  valueRange: CssSourceRange;
  endAnchorRange: CssSourceRange;

  /** Offset just past this declaration (used internally to resume scanning) */
  afterIndex: number;
}

export interface CssRule {
  selector: string;
  range: CssSourceRange;
  declarations: CssDeclaration[];
  line: number;
  column: number;
}

/** Result of scanning forward to the next structural character. */
interface ScanResult {
  token: '{' | ';' | '}';
  pos: number;
}

/** First top-level `:` in a declaration region (outside strings/comments/parens). */
interface ColonResult {
  pos: number;
}

const CONDITIONAL_GROUPS = new Set([
  '@media',
  '@supports',
  '@layer',
  '@container',
  '@document',
  '@-moz-document',
  '@scope',
]);

const KEYFRAMES = new Set(['@keyframes', '@-webkit-keyframes', '@-moz-keyframes']);

/** Property-name grammar (idents, vendor prefixes and custom properties). */
const IDENT_RE = /^[A-Za-z_-][A-Za-z0-9_-]*$/;

function isWhitespace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c.charCodeAt(0) === 0xfeff;
}

/**
 * Skip whitespace and `/* ... *` `/` comments starting at `i`.
 * Returns the first index that is neither whitespace nor part of a comment.
 */
function skipWsAndComments(text: string, i: number): number {
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (isWhitespace(c)) {
      i++;
    } else {
      break;
    }
  }
  return i;
}

/**
 * Find the offset of the matching closing `}` for the block that opens at
 * `openIdx`. Tracks nested braces, strings, comments and parentheses.
 * Returns `-1` when the block is unbalanced.
 */
function findBlockEnd(text: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  let inString: string | null = null;
  let inComment = false;

  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];

    if (inComment) {
      if (c === '*' && next === '/') {
        inComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (inString) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === inString) {
        inString = null;
      }
      i++;
      continue;
    }

    if (c === '/' && next === '*') {
      inComment = true;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = c;
      i++;
      continue;
    }
    if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
    i++;
  }

  return -1;
}

/**
 * Scan from `from` (inside `[from, limit)`) for the first top-level
 * structural character `{`, `;` or `}` — i.e. outside strings, comments and
 * parentheses. Returns `null` when the limit is reached first.
 */
function scanToStructuralChar(text: string, from: number, limit: number): ScanResult | null {
  let i = from;
  let parenDepth = 0;
  let inString: string | null = null;
  let inComment = false;

  while (i < limit) {
    const c = text[i];
    const next = text[i + 1];

    if (inComment) {
      if (c === '*' && next === '/') {
        inComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (inString) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === inString) {
        inString = null;
      }
      i++;
      continue;
    }

    if (c === '/' && next === '*') {
      inComment = true;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = c;
      i++;
      continue;
    }
    if (c === '(') {
      parenDepth++;
      i++;
      continue;
    }
    if (c === ')') {
      if (parenDepth > 0) {
        parenDepth--;
      }
      i++;
      continue;
    }
    if (parenDepth === 0 && (c === '{' || c === ';' || c === '}')) {
      return { token: c, pos: i };
    }
    i++;
  }

  return null;
}

/**
 * Find the first top-level `:` in `[from, limit)` (outside strings, comments
 * and parentheses). Returns `null` when there is none.
 */
function findFirstColon(text: string, from: number, limit: number): ColonResult | null {
  let i = from;
  let parenDepth = 0;
  let inString: string | null = null;
  let inComment = false;

  while (i < limit) {
    const c = text[i];
    const next = text[i + 1];

    if (inComment) {
      if (c === '*' && next === '/') {
        inComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (inString) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === inString) {
        inString = null;
      }
      i++;
      continue;
    }

    if (c === '/' && next === '*') {
      inComment = true;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = c;
      i++;
      continue;
    }
    if (c === '(') {
      parenDepth++;
      i++;
      continue;
    }
    if (c === ')') {
      if (parenDepth > 0) {
        parenDepth--;
      }
      i++;
      continue;
    }
    if (parenDepth === 0 && c === ':') {
      return { pos: i };
    }
    i++;
  }

  return null;
}

class PositionMap {
  private readonly lineStarts: number[];

  constructor(text: string) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') {
        starts.push(i + 1);
      }
    }
    this.lineStarts = starts;
  }

  /** Convert a character offset to a 0-based { line, column }. */
  at(offset: number): { line: number; column: number } {
    const starts = this.lineStarts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (starts[mid] <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return { line: lo, column: offset - starts[lo] };
  }

  /** Convert a half-open `[start, end)` offset pair to a CssSourceRange. */
  range(start: number, end: number): CssSourceRange {
    const a = this.at(start);
    const b = this.at(end);
    return {
      startLine: a.line,
      startColumn: a.column,
      endLine: b.line,
      endColumn: b.column,
    };
  }
}

export class CssAstParser {
  private text = '';
  private positions: PositionMap = new PositionMap('');
  private rules: CssRule[] = [];

  /**
   * Parse a CSS stylesheet and return its rules and declarations with
   * exact 0-based source ranges.
   */
  parse(cssContent: string, _filePath: string): CssRule[] {
    this.text = cssContent;
    this.positions = new PositionMap(cssContent);
    this.rules = [];
    this.parseContainer(0, cssContent.length);
    return this.rules;
  }

  /**
   * Parse a CSS DECLARATION LIST (the grammar of an HTML `style="..."`
   * attribute value) into declarations with ranges relative to the given
   * text.
   *
   * A declaration list is the same component grammar as the inside of a
   * rule block, but there is no surrounding `{ ... }`: the trailing
   * semicolon is optional, so the final declaration is terminated by the
   * end of the text. Nested `{ ... }` blocks are invalid here and are
   * skipped, never parsed as rules.
   */
  parseDeclarationList(content: string): CssDeclaration[] {
    this.text = content;
    this.positions = new PositionMap(content);
    this.rules = [];

    const declarations: CssDeclaration[] = [];
    let i = 0;

    while (i < content.length) {
      i = skipWsAndComments(this.text, i);
      if (i >= content.length) {
        break;
      }

      const c = this.text[i];
      if (c === ';' || c === '}') {
        i++;
        continue;
      }

      const itemStart = i;
      // Extend the scan limit by one so a final semicolon-less declaration
      // is still seen; with no structural character at all, the remaining
      // text IS one declaration terminated by the end of the list.
      const scan = scanToStructuralChar(this.text, i, content.length + 1);
      if (!scan) {
        const decl = this.parseDeclaration(itemStart, content.length, '');
        if (decl) {
          declarations.push(decl);
        }
        break;
      }

      if (scan.token === '{') {
        // Not valid in a declaration list — skip the malformed block.
        const blockEnd = findBlockEnd(this.text, scan.pos);
        i = blockEnd === -1 ? content.length : blockEnd + 1;
        continue;
      }

      const decl = this.parseDeclaration(itemStart, scan.pos, '');
      if (decl) {
        declarations.push(decl);
      }
      i = scan.token === ';' ? scan.pos + 1 : scan.pos;
    }

    return declarations;
  }

  dispose(): void {
    this.text = '';
    this.rules = [];
  }

  /**
   * Parse a container whose items are rules (the top-level stylesheet and
   * the inside of at-rule groups such as `@media`, `@supports`, `@keyframes`).
   */
  private parseContainer(start: number, end: number): void {
    let i = start;

    while (i < end) {
      i = skipWsAndComments(this.text, i);
      if (i >= end) {
        break;
      }

      const c = this.text[i];
      if (c === '}' || c === ';') {
        i++;
        continue;
      }

      const itemStart = i;
      const scan = scanToStructuralChar(this.text, i, end);
      if (!scan) {
        break;
      }

      if (scan.token === '{') {
        const prelude = this.text.slice(itemStart, scan.pos).trim();
        const blockEnd = findBlockEnd(this.text, scan.pos);
        if (blockEnd === -1) {
          i = end;
          break;
        }

        if (prelude.startsWith('@')) {
          const kind = this.atRuleKind(prelude);
          if (kind === 'group' || kind === 'keyframes') {
            this.parseContainer(scan.pos + 1, blockEnd);
          } else {
            // @font-face, @page, @property, ... — declarations live directly
            // inside the block.
            const rule = this.makeRule(itemStart, prelude, scan.pos, blockEnd);
            this.parseBlockItems(scan.pos + 1, blockEnd, rule);
            this.rules.push(rule);
          }
        } else {
          const rule = this.makeRule(itemStart, prelude, scan.pos, blockEnd);
          this.parseBlockItems(scan.pos + 1, blockEnd, rule);
          this.rules.push(rule);
        }

        i = blockEnd + 1;
      } else {
        // Stray `;` or `}` before any block — malformed, skip it.
        i = scan.pos + 1;
      }
    }
  }

  /**
   * Parse the items inside a rule's `{ ... }`: declarations and nested
   * blocks (CSS nesting, `@keyframes` frames).
   */
  private parseBlockItems(start: number, end: number, ownerRule: CssRule): void {
    let i = start;

    while (i < end) {
      i = skipWsAndComments(this.text, i);
      if (i >= end) {
        break;
      }

      const c = this.text[i];
      if (c === '}') {
        i++;
        continue;
      }
      if (c === ';') {
        i++;
        continue;
      }

      const itemStart = i;
      // The block's closing `}` sits at `end` (exclusive limit), so extend
      // the scan by one to let a semicolon-less declaration see it.
      const scan = scanToStructuralChar(this.text, i, end + 1);
      if (!scan) {
        break;
      }

      if (scan.token === '{') {
        const nestedPrelude = this.text.slice(itemStart, scan.pos).trim();
        const blockEnd = findBlockEnd(this.text, scan.pos);
        if (blockEnd === -1) {
          i = end;
          break;
        }

        if (nestedPrelude.startsWith('@') && (this.atRuleKind(nestedPrelude) === 'group' || this.atRuleKind(nestedPrelude) === 'keyframes')) {
          this.parseContainer(scan.pos + 1, blockEnd);
        } else {
          const nested = this.makeRule(itemStart, nestedPrelude, scan.pos, blockEnd);
          this.parseBlockItems(scan.pos + 1, blockEnd, nested);
          this.rules.push(nested);
        }

        i = blockEnd + 1;
      } else {
        // token is `;` or `}` — a declaration terminated here.
        const decl = this.parseDeclaration(itemStart, scan.pos, ownerRule.selector);
        if (decl) {
          ownerRule.declarations.push(decl);
        }
        i = scan.token === ';' ? scan.pos + 1 : scan.pos;
      }
    }
  }

  /**
   * Parse a single declaration `name : value` whose value ends at
   * `terminatorPos` (the `;` or the closing `}`).
   */
  private parseDeclaration(
    start: number,
    terminatorPos: number,
    ownerSelector: string
  ): CssDeclaration | null {
    const colon = findFirstColon(this.text, start, terminatorPos);
    if (!colon || colon.pos <= start) {
      return null;
    }

    const nameRaw = this.text.slice(start, colon.pos);
    const name = nameRaw.trim();
    if (!IDENT_RE.test(name)) {
      return null;
    }

    const nameStart = start + (nameRaw.length - nameRaw.trimStart().length);
    const nameEnd = start + nameRaw.trimEnd().length;

    const afterColon = colon.pos + 1;
    const valueStart = skipWsAndComments(this.text, afterColon);
    const valueEnd = Math.max(afterColon, this.trimEnd(this.text, afterColon, terminatorPos));

    const hasSemicolon = terminatorPos < this.text.length && this.text[terminatorPos] === ';';
    const value = this.text.slice(valueStart, valueEnd);
    const declEnd = hasSemicolon ? terminatorPos + 1 : (valueEnd > afterColon ? valueEnd : terminatorPos);
    const anchorStart = Math.max(nameStart, declEnd - 1);

    return {
      name,
      value,
      important: /\s*!\s*important\s*$/i.test(value),
      selector: ownerSelector,
      range: this.positions.range(nameStart, declEnd),
      nameRange: this.positions.range(nameStart, nameEnd),
      valueRange: this.positions.range(valueStart, valueEnd),
      endAnchorRange: this.positions.range(anchorStart, declEnd),
      afterIndex: hasSemicolon ? terminatorPos + 1 : terminatorPos,
    };
  }

  private makeRule(
    start: number,
    selector: string,
    blockStart: number,
    blockEnd: number
  ): CssRule {
    const at = this.positions.at(start);
    return {
      selector,
      range: this.positions.range(start, blockEnd + 1),
      declarations: [],
      line: at.line,
      column: at.column,
    };
  }

  /** One-past the last non-whitespace/non-comment character in `[from, limit)`. */
  private trimEnd(text: string, from: number, limit: number): number {
    let i = limit;
    while (i > from) {
      const prev = i - 1;
      const c = text[prev];
      if (isWhitespace(c)) {
        i = prev;
        continue;
      }
      if (c === '/' && text[prev - 1] === '*') {
        // Skip the whole trailing comment so its text is excluded from the
        // value range.
        const open = text.lastIndexOf('/*', prev - 1);
        i = open === -1 ? from : open;
        continue;
      }
      break;
    }
    return i;
  }

  private atRuleKind(prelude: string): 'group' | 'keyframes' | 'declaration-block' {
    const firstToken = prelude.split(/\s+/, 1)[0].toLowerCase();
    if (CONDITIONAL_GROUPS.has(firstToken)) {
      return 'group';
    }
    if (KEYFRAMES.has(firstToken)) {
      return 'keyframes';
    }
    return 'declaration-block';
  }
}
