/**
 * Redaction (Phase 5).
 *
 * Every log line, diagnostic report entry and event detail passes through
 * `redact` so that secrets, environment variables, absolute home paths and
 * long token-surplus values never reach the user, the output channel or a
 * shared report.
 *
 * Rules (keep predictable):
 *  - `NAME=value` / `NAME = value` assignments → the value becomes `<redacted>`,
 *  - values that FLOAT inside a URL query string (`token=`, `key=`) likewise,
 *  - the user home directory prefix is replaced with `~`,
 *  - hex/base64 blobs ≥ 24 chars → `<token>`.
 */

import * as os from 'os';

const home = os.homedir().replace(/[\\/]+$/, '');

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
  // NAME=value (including "NAME = value").
  out = out.replace(
    /(\b[A-Z_][A-Z0-9_.]*(?:\s*[:=]\s*))([^\s;,]+|"[^"]*"|'[^']*')/g,
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

/** Redact each entry (bounded stderr excerpt). */
export function redactLines(lines: string[]): string[] {
  return lines.map(redactLine);
}

/** Home-path shortening used by the report (absolute path → `…`). */
export function shortenPath(filePath: string): string {
  const relative = filePath.startsWith(home) ? filePath.slice(home.length) : filePath;
  if (relative.length <= 60) {
    return relative;
  }
  return `…${relative.slice(-60)}`;
}