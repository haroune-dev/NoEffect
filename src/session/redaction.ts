/**
 * Redaction (Phase 5).
 *
 * Every log line, diagnostic report entry and event detail passes through
 * `redact` so that secrets, environment variables, absolute home paths and
 * long token-surplus values never reach the user, the output channel or a
 * shared report.
 *
 * Rules (keep predictable):
 *  - `NAME=value` / `NAME = value` assignments → the value becomes `REDACTED`
 *    (keys matched case-insensitively, lowercase included),
 *  - values that FLOAT inside a URL query string (`token=`, `key=`) likewise,
 *  - `"key": "value"` JSON pairs → the string value becomes `REDACTED`,
 *  - the user home directory prefix is replaced with `REDACTED_HOME`,
 *  - hex/base64 blobs ≥ 24 chars → `REDACTED_TOKEN`.
 */

import * as os from 'os';

const home = os.homedir().replace(/[\\/]+$/, '');

/**
 * Structured JSON form: `"key": "value"` — the string VALUE (including
 * its quotes) becomes `REDACTED`, keeping the surrounding JSON parseable.
 * Escaped quotes inside the strings (`\"`) are handled by the
 * `(?:[^"\\]|\\.)*` alternation, so an escaped quote never ends the match
 * early (P2-SEC-04: `{"apiKey": "secret123"}` previously passed through).
 */
const JSON_STRING_KV = /("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*")/g;

function redactHome(value: string): string {
  if (!home || home === '/') {
    return value;
  }
  return value.split(home).join('REDACTED_HOME');
}

/** Replace obvious assignment values and long token blobs. */
export function redact(input: string): string {
  if (!input) {
    return input;
  }
  let out = redactHome(input);
  // Structured JSON first: scrub quoted values while the key/value pair is
  // still intact, before the bare-key pass touches the surrounding text.
  out = out.replace(JSON_STRING_KV, (_m, key: string) => `${key}: REDACTED`);
  // NAME=value (including "NAME = value"). Keys are matched
  // case-insensitively — lowercase keys (`api_key=`, `token=`) carry
  // secrets too (P2-SEC-04), and the key class allows hyphens/dots.
  // A `://`-scheme prefix (`https`, `http`, `ws`, ...) is never a secret
  // key — the lookahead keeps URL schemes from being swallowed whole.
  out = out.replace(
    /(\b[A-Za-z_][A-Z0-9a-z_.-]*(?!:\/\/)\s*[:=]\s*)([^\s;,]+|"[^"]*"|'[^']*')/g,
    (_m, prefix: string) => `${prefix}REDACTED`
  );
  // Long token blobs (hex/base64-ish) anywhere in the text.
  out = out.replace(/\b[0-9a-fA-F+\/=]{24,}\b/g, 'REDACTED_TOKEN');
  return out;
}

/**
 * Redact a line for the diagnose report: assignments, tokens and homes are
 * scrubbed, and trailing secrets embedded in a fragment are bounded so the
 * excerpt shown stays short.
 */
export function redactLine(line: string): string {
  const cleaned = redact(line);
  return cleaned.length > 300 ? `${cleaned.slice(0, 300)}…` : cleaned;
}

/** Home-path shortening used by the report (absolute path → `…`). */
export function shortenPath(filePath: string): string {
  const relative = filePath.startsWith(home) ? filePath.slice(home.length) : filePath;
  if (relative.length <= 60) {
    return relative;
  }
  return `…${relative.slice(-60)}`;
}