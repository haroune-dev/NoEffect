/**
 * Represents an exact location of a CSS property within a source file.
 *
 * All values are 0-based to align with VS Code's internal Position API.
 */
export interface CssLocation {
  /** Absolute path to the CSS file */
  filePath: string;

  /** 0-based line number where the property declaration starts */
  startLine: number;

  /** 0-based column number where the property declaration starts */
  startColumn: number;

  /** 0-based line number where the property declaration ends */
  endLine: number;

  /** 0-based column number where the property declaration ends */
  endColumn: number;
}
