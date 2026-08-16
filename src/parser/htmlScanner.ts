/**
 * Scans HTML documents for embedded CSS: internal `<style>` blocks and
 * `style="..."` attributes, each with its exact source position in the
 * document.
 *
 * The scanner is a lightweight HTML tokenizer, not a full parser:
 *   - it tracks comments, quoted attribute values and raw-text elements
 *     (`<style>`, `<script>`) so `style=` inside scripts, comments or
 *     other attribute values is never misread;
 *   - a `<style>` element ends at the FIRST case-insensitive `</style`
 *     token (matching the HTML raw-text parsing rules — a literal
 *     `</style>` inside CSS strings ends the element in a real browser);
 *   - fragment positions are 0-based (CDP/VS Code convention) and point at
 *     the first character of the fragment text (the `<style>` text content
 *     and the attribute value, respectively).
 *
 * Pure module (no `vscode`, no fs): the cached analysis flow owns file I/O.
 */

export interface LinkedStylesheet {
  /** Absolute path to the CSS file */
  filePath: string;
  /** The original href from the HTML <link> element */
  href: string;
}

/** 0-based document position of the first character of a fragment. */
export interface CssFragmentPosition {
  startLine: number;
  startColumn: number;
}

/** An internal `<style>` element and the document range of its CSS text. */
export interface HtmlStyleBlock {
  /** CSS text of the element, exactly as written in the source. */
  content: string;

  /** Document position of the first character of `content`. */
  position: CssFragmentPosition;
}

/** A `style="..."` attribute and the document range of its value text. */
export interface HtmlStyleAttribute {
  /** Attribute value text, exactly as written in the source. */
  value: string;

  /** Document position of the first character of `value`. */
  position: CssFragmentPosition;
}

/** Everything embedded-CSS relevant the scanner found in one document. */
export interface HtmlCssFragments {
  /** All `<style>` blocks, in document order. */
  styleBlocks: HtmlStyleBlock[];

  /** All `style="..."` attributes, in document order. */
  styleAttributes: HtmlStyleAttribute[];
}

/** Characters that make an HTML tag name impossible (browsers treat it as text). */
const VALID_TAG_START = /^[A-Za-z][A-Za-z0-9-]*$/;

/** Elements whose content is raw text (no markup, no attribute parsing). */
const RAW_TEXT_ELEMENTS = new Set(['style', 'script']);

/** Attribute-name grammar (as written in the source; names are case-insensitive). */
const ATTR_NAME = /[A-Za-z_:][-A-Za-z0-9_:.]*/;

class HtmlPositionMap {
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

  /** Convert a character offset to a 0-based { startLine, startColumn }. */
  at(offset: number): CssFragmentPosition {
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
    return { startLine: lo, startColumn: offset - starts[lo] };
  }
}

/**
 * Index of the `>` that closes the tag starting at `from` (a `<`), or -1
 * when the tag is unterminated. `>` inside quoted attribute values does not
 * close the tag.
 */
function findTagEnd(html: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '>') {
      return i;
    }
  }
  return -1;
}

/** The (lowercased) name of the tag whose content is `tagContent`, or ''. */
function tagNameOf(tagContent: string): string {
  const m = tagContent.match(/^\s*([A-Za-z][A-Za-z0-9-]*)/);
  if (!m) {
    return '';
  }
  const name = m[1].toLowerCase();
  return VALID_TAG_START.test(name) ? name : '';
}

/** Extract `style="..."` attributes of one tag into `out`. */
function collectStyleAttributes(
  tagContent: string,
  baseOffset: number,
  positions: HtmlPositionMap,
  out: HtmlStyleAttribute[]
): void {
  const re = new RegExp(
    `(${ATTR_NAME.source})(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+)))?`,
    'g'
  );

  let match: RegExpExecArray | null;
  while ((match = re.exec(tagContent)) !== null) {
    if (match[1].toLowerCase() !== 'style') {
      continue;
    }
    const double = match[2];
    const single = match[3];
    const bare = match[4];
    if (double === undefined && single === undefined && bare === undefined) {
      // Boolean `style` (no value) — the attribute exists but is empty.
      out.push({ value: '', position: positions.at(baseOffset + match.index) });
      continue;
    }

    // Locate the value token inside the full attribute match, skipping the
    // whitespace between `=` and the value.
    const eqIdx = match[0].indexOf('=');
    let v = eqIdx + 1;
    while (v < match[0].length && /\s/.test(match[0][v])) {
      v++;
    }
    const valueTokenStart = baseOffset + match.index + v;

    if (double !== undefined || single !== undefined) {
      out.push({
        value: double ?? single ?? '',
        position: positions.at(valueTokenStart + 1),
      });
    } else {
      out.push({ value: bare ?? '', position: positions.at(valueTokenStart) });
    }
  }
}

/**
 * Scan an HTML document for embedded CSS fragments.
 *
 * Both lists are in document order. Ranges never drift into surrounding
 * markup: a fragment's position is the first character of its text
 * (after the `<style>` opening tag or after the attribute's opening
 * quote). Malformed HTML never throws — unterminated tags/comments simply
 * end the scan at the fragment start they were found at.
 */
export function scanHtmlForCss(html: string): HtmlCssFragments {
  const positions = new HtmlPositionMap(html);
  const styleBlocks: HtmlStyleBlock[] = [];
  const styleAttributes: HtmlStyleAttribute[] = [];
  let i = 0;
  const len = html.length;

  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      break;
    }

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }

    if (html.startsWith('</', lt)) {
      // Closing tag — skip it; its name never opens new content.
      const tagEnd = findTagEnd(html, lt);
      i = tagEnd === -1 ? len : tagEnd + 1;
      continue;
    }

    const tagEnd = findTagEnd(html, lt);
    if (tagEnd === -1) {
      break;
    }

    const tagContent = html.slice(lt + 1, tagEnd);
    const tagName = tagNameOf(tagContent);
    if (!tagName) {
      // Not a valid tag name — browsers treat the segment as text, so no
      // attribute is read from it.
      i = lt + 1;
      continue;
    }

    if (RAW_TEXT_ELEMENTS.has(tagName)) {
      const contentStart = tagEnd + 1;
      const remaining = html.slice(contentStart);
      const closeTag = remaining.toLowerCase().indexOf(`</${tagName}`);
      const content = closeTag === -1 ? remaining : remaining.slice(0, closeTag);

      if (tagName === 'style') {
        styleBlocks.push({ content, position: positions.at(contentStart) });
      }

      if (closeTag === -1) {
        break;
      }
      const closeEnd = findTagEnd(html, contentStart + closeTag);
      i = closeEnd === -1 ? len : closeEnd + 1;
      continue;
    }

    collectStyleAttributes(tagContent, lt + 1, positions, styleAttributes);
    i = tagEnd + 1;
  }

  return { styleBlocks, styleAttributes };
}
