import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_IGNORED_PATTERNS,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  evaluateFileEligibility,
  globToRegExp,
  matchGlobPattern,
  FileEligibilityInput,
} from '../../environment/fileEligibility';
import { FAILURE_CODES } from '../../failure/model';

/**
 * Safe-file-eligibility unit tests: deterministic scheme → language →
 * generated → ignore → size gating for what NoEffect will analyze.
 */

function input(overrides: Partial<FileEligibilityInput> = {}): FileEligibilityInput {
  return {
    filePath: '/project/styles.css',
    extension: '.css',
    scheme: 'file',
    sizeBytes: 1024,
    maxFileSizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES,
    ...overrides,
  };
}

test('a small local css file is eligible at the default threshold', () => {
  const result = evaluateFileEligibility(input());

  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'eligible');
});

test('a .htm local file is eligible', () => {
  const result = evaluateFileEligibility(input({ filePath: '/project/index.htm', extension: '.htm' }));

  assert.equal(result.eligible, true);
});

test('a non-file scheme is ineligible with not_local_file', () => {
  const result = evaluateFileEligibility(input({ scheme: 'vscode-vfs', filePath: '/vs-code/vfs/x.css' }));

  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'not_local_file');
  assert.ok(result.reasonText.includes("'vscode-vfs'"));
});

test('an unsupported extension is ineligible with unsupported_type', () => {
  const result = evaluateFileEligibility(input({ extension: '.scss' }));

  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'unsupported_type');
  assert.equal(result.failure, undefined);
});

test('a minified bundle is skipped as generated_file with a FILE_IGNORED failure', () => {
  const result = evaluateFileEligibility(input({ filePath: '/project/styles.min.css' }));

  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'generated_file');
  assert.equal(result.matchedPattern, '*.min.css');
  assert.equal(result.failure?.code, FAILURE_CODES.FILE_IGNORED);
});

test('a bundle css is skipped as generated_file', () => {
  const result = evaluateFileEligibility(input({ filePath: '/project/main.bundle.css' }));

  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'generated_file');
});

test('node_modules paths are ignored by default', () => {
  const result = evaluateFileEligibility(input({ filePath: '/project/node_modules/pkg/styles.css' }));

  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'ignored_pattern');
  assert.equal(result.matchedPattern, '**/node_modules/**');
});

test('user-configured patterns are merged over the defaults', () => {
  const custom = evaluateFileEligibility(input({ ignoredPatterns: ['**/temp/**'], filePath: '/project/temp/a.css' }));
  const defaultStillApplies = evaluateFileEligibility(input({ filePath: '/project/.vscode/a.css' }));

  assert.equal(custom.reason, 'ignored_pattern');
  assert.equal(custom.matchedPattern, '**/temp/**');
  assert.equal(defaultStillApplies.reason, 'ignored_pattern');
  assert.ok(DEFAULT_IGNORED_PATTERNS.includes('**/node_modules/**'));
});

test('a file over the threshold is too_large; the boundary is eligible', () => {
  const over = evaluateFileEligibility(input({ sizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES + 1 }));
  const boundary = evaluateFileEligibility(input({ sizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES }));

  assert.equal(over.eligible, false);
  assert.equal(over.reason, 'too_large');
  assert.equal(over.failure?.code, FAILURE_CODES.FILE_TOO_LARGE);
  assert.equal(boundary.eligible, true);
});

test('deterministic precedence: generated bundle wins over ignore and size', () => {
  const result = evaluateFileEligibility(
    input({ filePath: '/project/node_modules/styles.min.css', sizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES + 1 })
  );

  assert.equal(result.reason, 'generated_file');
});

test('deterministic precedence: ignore glob wins over size', () => {
  const result = evaluateFileEligibility(
    input({ filePath: '/project/node_modules/big.css', sizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES + 1 })
  );

  assert.equal(result.reason, 'ignored_pattern');
});

test('glob matcher: ** crosses segments and bare names match the basename', () => {
  assert.equal(matchGlobPattern('**/vendor/**', '/a/b/vendor/x.css'), true);
  assert.equal(matchGlobPattern('**/vendor/**', 'vendor/x.css'), true);
  assert.equal(matchGlobPattern('styles.css', '/project/styles.css'), true);
  assert.equal(matchGlobPattern('styles.css', '/project/other.css'), false);
  assert.equal(matchGlobPattern('*.css', '/project/other.js'), false);
  assert.equal(matchGlobPattern('*.css', '/project/styles.css'), true);
  assert.equal(matchGlobPattern('**/*.css', '/project/styles.css'), true);
});

test('glob matcher: windows-style paths are normalized for matching', () => {
  assert.equal(matchGlobPattern('**/node_modules/**', 'C:\\project\\node_modules\\x.css'), true);
});

test('globToRegExp anchors the whole string', () => {
  assert.equal(globToRegExp('**/dist/**').test('x/dist/y'), true);
  assert.equal(globToRegExp('**/dist/**').test('x/dist-other/y'), false);
});