/**
 * Safe file eligibility policies (Phase 2: environment readiness).
 *
 * Deterministic, conservative gating for which files NoEffect will analyze:
 *
 *   - only local files (`file:` URI scheme),
 *   - only existing analysis languages (.css, .html/.htm),
 *   - never generated/minified bundles (.min.css, .bundle.css),
 *   - never files matching ignore globs (dependency dirs, build output,
 *     VCS directories, vendor trees ...),
 *   - never files above a conservative size threshold (512 KB by default).
 *
 * Every ineligible file is skipped without crashing or spamming; the
 * eligibility structure carries a deterministic primary reason and the
 * matching Phase 1 `AnalysisFailure` so future UX layers can surface it.
 *
 * The module is vscode-free and dependency-free (its own tiny glob
 * matcher), so it is fully unit-testable.
 */

import { AnalysisFailure } from '../failure/model';
import { fileIgnoredFailure, fileTooLargeFailure } from '../failure/classifier';

/** Conservative default: 512 KB for a single CSS/HTML file. */
export const DEFAULT_MAX_FILE_SIZE_BYTES = 512 * 1024;

/** Max lines a generated bundle hint may be emitted for (informational only). */
export const MINIFIED_SUFFIXES = ['.min.css', '.bundle.css'];

/**
 * Built-in ignore patterns (additional user patterns are merged in by the
 * settings layer). These always apply to every workspace.
 */
export const DEFAULT_IGNORED_PATTERNS = [
  '**/node_modules/**',
  '**/bower_components/**',
  '**/vendor/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/out/**',
  '**/.git/**',
  '**/.hg/**',
  '**/.svn/**',
  '**/.idea/**',
  '**/.vscode/**',
];

export type FileEligibilityReason =
  | 'eligible'
  | 'not_local_file'
  | 'unsupported_type'
  | 'generated_file'
  | 'ignored_pattern'
  | 'too_large';

export interface FileEligibility {
  eligible: boolean;
  reason: FileEligibilityReason;

  /** Stable, human-readable detail (for output-channel/readiness use). */
  reasonText: string;

  /** The matching Phase 1 failure, when the file is ineligible. */
  failure?: AnalysisFailure;

  /** The glob pattern (or generated suffix) that matched. */
  matchedPattern?: string;
}

export interface FileEligibilityInput {
  /** Absolute path of the candidate file. */
  filePath: string;

  /** Lowercased extension including the dot ('.css', '.html', ...). */
  extension: string;

  /** URI scheme of the document ('file' for local files). */
  scheme?: string;

  /** Document size in characters/bytes. */
  sizeBytes: number;

  /** User-configured extra ignore globs (merged over the defaults). */
  ignoredPatterns?: string[];

  /** The effective size threshold in bytes. */
  maxFileSizeBytes: number;
}

const SUPPORTED_EXTENSIONS = new Set(['.css', '.html', '.htm']);

/**
 * Evaluate eligibility with a deterministic primary-reason order:
 * scheme → language → generated bundle → ignore glob → size.
 * A file is ineligible at the first failing check and never re-classified.
 */
export function evaluateFileEligibility(input: FileEligibilityInput): FileEligibility {
  const { filePath, extension, scheme = 'file' } = input;

  if (scheme !== 'file') {
    return {
      eligible: false,
      reason: 'not_local_file',
      reasonText: `Not a local file (URI scheme '${scheme}') — only disk files can be analyzed`,
    };
  }

  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    return {
      eligible: false,
      reason: 'unsupported_type',
      reasonText: `Unsupported file type '${extension || '(none)'}' — only .css and .html can be analyzed`,
    };
  }

  const generatedSuffix = MINIFIED_SUFFIXES.find((suffix) => filePath.toLowerCase().endsWith(suffix));
  if (generatedSuffix) {
    return {
      eligible: false,
      reason: 'generated_file',
      reasonText: `Generated or minified bundle (${generatedSuffix}) is skipped by default`,
      matchedPattern: `*${generatedSuffix}`,
      failure: fileIgnoredFailure(filePath, `*${generatedSuffix}`),
    };
  }

  const patterns = [...DEFAULT_IGNORED_PATTERNS, ...(input.ignoredPatterns ?? [])];
  const matched = patterns.find((pattern) => matchGlobPattern(pattern, filePath));
  if (matched) {
    return {
      eligible: false,
      reason: 'ignored_pattern',
      reasonText: `Excluded by ignored-file pattern '${matched}'`,
      matchedPattern: matched,
      failure: fileIgnoredFailure(filePath, matched),
    };
  }

  if (input.sizeBytes > input.maxFileSizeBytes) {
    return {
      eligible: false,
      reason: 'too_large',
      reasonText: `File is ${input.sizeBytes} bytes — above the ${input.maxFileSizeBytes} byte analysis limit`,
      failure: fileTooLargeFailure(input.sizeBytes, input.maxFileSizeBytes),
    };
  }

  return { eligible: true, reason: 'eligible', reasonText: 'Eligible for analysis' };
}

// ---------------------------------------------------------------------------
// Minimal dependency-free glob matcher supporting `**`, `*` and `?`.
// Paths are matched as POSIX-style ('/' separators) against the full path;
// patterns without a '/' also match the bare file name.
// ---------------------------------------------------------------------------

function toPosix(filePath: string): string {
  return filePath.split('\\').join('/');
}

/** Convert a glob pattern into an anchored RegExp (POSIX separators). */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  const source = toPosix(pattern);
  let i = 0;

  while (i < source.length) {
    const char = source[i];
    if (char === '*') {
      if (source[i + 1] === '*') {
        // `**` — match zero or more path segments.
        out += '(?:[^/]*(?:/|$))*';
        // Consume a following '/' so `**/` still matches a leading path.
        if (source[i + 2] === '/') {
          i += 3;
          continue;
        }
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    out += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    i += 1;
  }

  return new RegExp(`^${out}$`);
}

/**
 * Match a path against a glob pattern. Patterns with a '/' match the whole
 * normalized path; star/`?` behave as expected and `**` crosses segments.
 */
export function matchGlobPattern(pattern: string, filePath: string): boolean {
  if (!pattern) {
    return false;
  }
  const regex = globToRegExp(pattern);
  const posixPath = toPosix(filePath);

  if (regex.test(posixPath)) {
    return true;
  }
  // A pattern with no directory component may target the bare file name.
  if (!pattern.includes('/')) {
    const basename = posixPath.slice(posixPath.lastIndexOf('/') + 1);
    if (regex.test(basename)) {
      return true;
    }
  }
  return false;
}