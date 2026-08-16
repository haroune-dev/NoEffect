/**
 * A source range as reported by the Chrome DevTools Protocol.
 *
 * CDP SourceRange values are 0-based offsets within a stylesheet.
 * Line and column numbers use the CDP convention (0-based), which
 * differs from 1-based DevTools-frontend conventions.
 */
export interface CdpSourceRange {
  /** 0-based line where the range starts */
  startLine: number;

  /** 0-based column where the range starts */
  startColumn: number;

  /** 0-based line where the range ends */
  endLine: number;

  /** 0-based column where the range ends */
  endColumn: number;
}
