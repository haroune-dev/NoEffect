/**
 * The single URL-resolution model shared by the companion matcher and the
 * DevServer.
 *
 * A document served from a server root `S` lives at the root-relative page
 * path `/pages/index.html`; the browser resolves every authored `href`
 * against that URL. The matcher must reproduce the browser exactly, so BOTH
 * sides derive their answers from the same WHATWG URL math:
 *
 *   - `toServedPath`   — absolute file → root-relative URL path (page URL).
 *   - `fromServedPath` — request URL path → absolute file inside the root.
 *   - `resolveLocalPath` — authored `href` (+ optional `<base href>`) →
 *                          absolute on-disk path, exactly as the browser
 *                          would request it.
 *
 * "What resolves is what serves": a companion found by the matcher is served
 * by the DevServer through the same path the matcher computed, so the browser
 * can never disagree with the analysis context.
 *
 * Pure module (no `vscode`, no fs): fully unit-testable. Only Node-18-safe
 * APIs (`URL`, `path`).
 */

import * as path from 'path';

/** Neutral origin used only for URL math (never contacted). */
const ORIGIN = 'http://noeffect.local';

/**
 * Root-relative URL path of an absolute file under `serverRoot`
 * (`/pages/index.html`). Returns null when the file lies outside the root.
 */
export function toServedPath(serverRoot: string, absolutePath: string): string | null {
  const root = path.resolve(serverRoot);
  const abs = path.resolve(absolutePath);
  const rel = path.relative(root, abs);
  if (rel === '') {
    return '/';
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return (
    '/' +
    rel
      .split(path.sep)
      .join('/')
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')
  );
}

/**
 * Map a request URL to an absolute file path that stays inside `serverRoot`.
 *
 * Returns null for anything that could escape the root or is undecodable:
 * null bytes, backslashes, malformed percent-encoding, and paths that
 * resolve outside the root (raw or encoded `..` traversal — the containment
 * check runs AFTER decoding so `%2e%2e` cannot sneak past). In-bounds `..`
 * segments are collapsed by `path.resolve`, matching the normalized URL a
 * browser requests.
 */
export function fromServedPath(serverRoot: string, requestUrl: string): string | null {
  const raw = (requestUrl.split('?')[0] ?? '/').replace(/^\/+/, '');
  if (raw.includes('\0')) {
    return null;
  }

  let relative: string;
  try {
    relative = raw === '' ? 'index.html' : decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (relative.length === 0 || relative.includes('\\')) {
    return null;
  }

  const root = path.resolve(serverRoot);
  const candidate = path.resolve(root, relative);
  // `root + path.sep` becomes `//` for the filesystem root; a `serverRoot`
  // of `/` must contain everything, not reject every request (P3-LOG-33).
  const containmentPrefix = root === path.sep ? root : root + path.sep;
  if (candidate !== root && !candidate.startsWith(containmentPrefix)) {
    return null;
  }
  return candidate;
}

export interface LocalHrefResolutionInput {
  /** The server root the page is served from. */
  serverRoot: string;

  /** Root-relative served path of the page containing the link. */
  pagePath: string;

  /** Optional `<base href>` authored in the page. */
  baseHref?: string;

  /** The authored link `href`. */
  href: string;
}

/**
 * Resolve an authored `href` exactly like the browser that loads the page:
 * against the page URL (honoring `<base href>`), keeping only same-origin
 * results, then mapping the normalized URL path onto the local filesystem
 * under `serverRoot`.
 *
 * Returns null (conservative skip, never a crash) for anything external,
 * malformed or undecodable: `https:`/`data:`/`blob:`/`javascript:` URLs,
 * protocol-relative (`//host`) URLs, percent-encoded `..` that survive URL
 * normalization, segments decoding to path separators, and malformed
 * percent-encoding.
 */
export function resolveLocalPath(input: LocalHrefResolutionInput): string | null {
  const pageUrl = new URL(ORIGIN + input.pagePath);
  const base = input.baseHref ? new URL(input.baseHref, pageUrl) : pageUrl;

  let url: URL;
  try {
    url = new URL(input.href, base);
  } catch {
    return null;
  }

  if (url.origin !== pageUrl.origin || url.protocol !== pageUrl.protocol) {
    return null;
  }

  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  const decoded: string[] = [];
  for (const segment of segments) {
    let part: string;
    try {
      part = decodeURIComponent(segment);
    } catch {
      return null;
    }
    // `..` cannot survive WHATWG normalization in the pathname, and decoded
    // separators would escape segment boundaries — both are hostile here.
    if (part === '..' || part === '.' || part.includes('/') || part.includes('\\') || part.includes('\0')) {
      return null;
    }
    decoded.push(part);
  }

  return path.join(path.resolve(input.serverRoot), ...decoded);
}
