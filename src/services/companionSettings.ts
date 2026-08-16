/**
 * Mutable companion-resolution configuration, kept in sync by the vscode
 * layer (activation + settings changes). The analyzer/resolver read it so
 * they stay vscode-free and plain-node testable.
 */

export interface CompanionSettingsBag {
  /** User-configured extra ignore globs (merged over the built-in defaults). */
  ignoredPatterns: string[];

  /** Size threshold in bytes for candidate HTML documents. */
  maxFileSizeBytes: number;

  /** Max directory depth of the Phase-A discovery scan. */
  maxDepth: number;

  /** Max scan operations per resolution (directory visits + candidates). */
  maxCandidates: number;

  /**
   * Evidence budget (Top-K): how many companions the ranked selection is
   * truncated to. An evidence budget — never a correctness guarantee.
   */
  maxCompanions: number;

  /**
   * Resolves the search root of a file: the workspace folder containing it.
   * null (default) falls back to the bounded ancestor-chain root (LCA).
   */
  workspaceFolderProvider: ((fsPath: string) => string | null) | null;
}

export const companionSettings: CompanionSettingsBag = {
  ignoredPatterns: [],
  maxFileSizeBytes: 512 * 1024,
  maxDepth: 6,
  maxCandidates: 500,
  maxCompanions: 3,
  workspaceFolderProvider: null,
};
