/**
 * Cross-directory companion-document resolution (Level 10).
 *
 * Finds the HTML document an analyzed CSS file should be judged against when
 * the two do not share a directory — e.g. `styles/theme.css` linked from
 * `pages/index.html` via `../styles/theme.css`, or a root-relative `/css/x.css`
 * link. The matcher resolves every authored href through the SAME
 * `companionUrl` model the DevServer serves with, so "what resolves is what
 * serves".
 *
 *   Phase A (bounded discovery): BFS from the search root (the CSS file's
 *     workspace folder, or — without one — the ancestor chain up to the
 *     depth bound) collecting candidate `.html`/`.htm` files, pruning
 *     ignored directories (eligibility globs + user `ignoredFiles`) and
 *     capping both depth and candidate count. Candidates over the size
 *     threshold or that fail to read are skipped — never a crash.
 *   Phase B (precise matching): extract `<link rel="stylesheet">` hrefs and
 *     the optional `<base href>` from each candidate, resolve them through
 *     the shared URL model and compare the fs-normalized result with the
 *     analyzed CSS file. Undecodable/external hrefs are skipped
 *     conservatively. A root-relative link whose URL model output does not
 *     exist on disk falls back to a BASENAME pair (see `matchRoot`) so
 *     deployment-style links (served root ≠ local layout) still contribute
 *     document evidence instead of silently vanishing.
 *
 * Selection is deterministic (pure comparator, unit-tested):
 *   1. directory distance ascending (segments between the CSS file's
 *      directory and the companion's directory; 0 = same directory),
 *   2. `index.html` first within equal distance,
 *   3. full path lexicographic ascending.
 * Distance 0 reproduces the legacy same-directory policy exactly.
 *
 * The resolution's `serverRoot` is the root that yielded the winner: the
 * workspace folder when one is available, else the lowest ancestor of the
 * CSS file that contains both files (their LCA — for same-directory matches
 * this IS the legacy root, so served behavior stays bit-identical).
 *
 * Pure module (no `vscode`): file I/O goes through `fs`, config through
 * `companionSettings` (kept in sync by the vscode layer), and nothing here
 * ever hardcodes selectors, class names or project paths.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_IGNORED_PATTERNS, matchGlobPattern } from '../environment/fileEligibility';
import { logger } from '../utils/logger';
import { normalizeFsPath, pathEquals } from '../utils/pathUtils';
import { companionSettings } from './companionSettings';
import { resolveLocalPath, toServedPath } from './companionUrl';

/** How the winning href links the stylesheet. */
export type CompanionHrefKind = 'relative-down' | 'relative-up' | 'root-relative' | 'base';

/** A resolved companion document. */
export interface CompanionResolution {
  /** Absolute path of the HTML document. */
  htmlPath: string;

  /** The authored href that linked the stylesheet. */
  href: string;

  /** How `href` was written relative to the document. */
  kind: CompanionHrefKind;

  /** Directory distance from the CSS file's directory (0 = same directory). */
  distance: number;

  /** The root both files are served from (workspace folder or LCA). */
  serverRoot: string;
}

export interface CompanionResolverOptions {
  /** Absolute path of the CSS file being analyzed. */
  cssFilePath: string;

  /** Extra user ignore globs (defaults to `companionSettings.ignoredPatterns`). */
  ignoredPatterns?: string[];

  /** Candidate size threshold in bytes (defaults to `companionSettings`). */
  maxFileSizeBytes?: number;

  /** Max scan depth (defaults to `companionSettings.maxDepth`). */
  maxDepth?: number;

  /** Max scan operations per resolution (defaults to `companionSettings`). */
  maxCandidates?: number;

  /** Evidence budget: how many companions the ranked list is truncated to. */
  maxCompanions?: number;

  /** Search-root resolver (defaults to `companionSettings.workspaceFolderProvider`). */
  workspaceFolderProvider?: ((fsPath: string) => string | null) | null;
}

/**
 * Injectable filesystem layer for the canonical-deduplication step, so the
 * symlink logic stays vscode-free and unit-testable without real symlinks.
 */
export interface CompanionFs {
  /** Resolve the canonical path of a file (symlinks followed). */
  realpathSync(filePath: string): string;
}

/** The default fs layer over Node's `fs.realpathSync`. */
export const nodeCompanionFs: CompanionFs = {
  realpathSync: (filePath) => fs.realpathSync(filePath),
};

/**
 * Cooperative yield to the event loop, so a bounded scan over a large
 * workspace never stalls the extension-host thread for its whole duration
 * (P2-PERF-12). Resolution order and budget accounting are untouched — the
 * scan is only paused between directory batches, never reordered.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Linked stylesheet hrefs of one document, in document order. */
export interface LinkedHrefs {
  /** The optional `<base href="...">` of the document. */
  baseHref?: string;

  /** Every `<link rel="stylesheet" href="...">` href, in document order. */
  hrefs: string[];
}

/**
 * The stylesheet hrefs (and base href) authored in an HTML document. The
 * extraction mirrors the legacy tokenizer-safe regex: only quoted attributes
 * of `<link>` tags with a `stylesheet` rel are considered; href-less or
 * empty links are ignored.
 */
export function extractLinkedHrefs(html: string): LinkedHrefs {
  const baseMatch = html.match(/<base\b[^>]*>/gi) ?? [];
  for (const tag of baseMatch) {
    const attrs = extractAttrs(tag);
    const href = attrs.get('href');
    if (href && href.length > 0) {
      return { baseHref: href, hrefs: extractLinkHrefs(html) };
    }
  }

  return { baseHref: undefined, hrefs: extractLinkHrefs(html) };
}

function extractLinkHrefs(html: string): string[] {
  const hrefs: string[] = [];
  const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of linkTags) {
    const attrs = extractAttrs(tag);
    const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
    const href = attrs.get('href') ?? '';
    if (!rel.includes('stylesheet') || !href) {
      continue;
    }
    hrefs.push(href);
  }
  return hrefs;
}

function extractAttrs(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const attrRe = /([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(tag)) !== null) {
    attrs.set(match[1].toLowerCase(), match[2] ?? match[3] ?? '');
  }
  return attrs;
}

/** The absolute, normalized path of the analyzed CSS file. */
function cssRealPath(cssFilePath: string): string {
  return normalizeFsPath(path.resolve(cssFilePath));
}

/** Whether a path matches any ignore glob (directories and files alike). */
function isIgnoredPath(fsPath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchGlobPattern(pattern, fsPath));
}

/**
 * The ordered search roots: the workspace folder when one is known, else
 * the ancestor chain of the CSS file's directory (bounded by `maxDepth`),
 * which makes the server root the LCA of the two files by construction.
 */
function searchRootsFor(cssDir: string, provider: ((fsPath: string) => string | null) | null, maxDepth: number): string[] {
  if (provider) {
    const root = provider(cssDir);
    if (root) {
      return [root];
    }
    // The file is not inside any workspace folder — fall through to the
    // bounded ancestor chain below.
  }
  const roots: string[] = [];
  let dir = path.resolve(cssDir);
  for (let level = 0; level <= maxDepth; level++) {
    roots.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return roots;
}

/**
 * Scan one root's subtree for documents that link the stylesheet (Phase A +
 * B for one root). `budget` is the shared scan-operation budget (every
 * visited directory AND every candidate document counts), decremented in
 * place; the scan stops when it is exhausted, so even an ancestor root that
 * reaches the filesystem root stays strictly bounded and deterministic.
 *
 * Cooperative: the walk yields to the event loop between directory batches
 * (every 16 processed directories with work remaining) so a big-workspace
 * scan does not hold the extension-host thread for its whole duration
 * (P2-PERF-12). Determinism is unaffected — the visit order, budget and
 * results are identical, only the wall-clock completion is deferred.
 */
async function matchRoot(
  root: string,
  cssReal: string,
  cssDir: string,
  patterns: string[],
  maxDepth: number,
  maxFileSizeBytes: number,
  budget: { remaining: number }
): Promise<CompanionResolution[]> {
  const matches: CompanionResolution[] = [];
  if (budget.remaining <= 0 || isIgnoredPath(root, patterns)) {
    return matches;
  }

  // Phase A: deterministic BFS (sorted entries, depth + operation bounds).
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let processedDirs = 0;
  while (queue.length > 0 && budget.remaining > 0) {
    const { dir, depth } = queue.shift()!;
    budget.remaining--;
    processedDirs++;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      logger.debug(
        `[Companion] Could not scan ${dir}: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }

    const subdirs: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (isIgnoredPath(full, patterns)) {
        continue;
      }
      if (entry.isDirectory()) {
        if (depth < maxDepth) {
          subdirs.push(full);
        }
        continue;
      }
      if (!entry.isFile() || !/\.(html|htm)$/i.test(entry.name) || budget.remaining <= 0) {
        continue;
      }
      budget.remaining--;

      // Phase B: read, gate by size, then match every stylesheet link
      // through the shared URL model.
      let content: string;
      try {
        content = fs.readFileSync(full, 'utf-8');
      } catch (err) {
        logger.debug(
          `[Companion] Could not read candidate ${full}: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }
      if (content.length > maxFileSizeBytes) {
        continue;
      }

      const pagePath = toServedPath(root, full);
      if (pagePath === null) {
        continue;
      }
      const { baseHref, hrefs } = extractLinkedHrefs(content);
      for (const href of hrefs) {
        let resolved: string | null = null;
        try {
          resolved = resolveLocalPath({ serverRoot: root, pagePath, baseHref, href });
        } catch {
          continue;
        }
        if (resolved === null) {
          continue;
        }
        if (pathEquals(resolved, cssReal)) {
          matches.push({
            htmlPath: full,
            href,
            kind: classifyKind(href, baseHref),
            distance: dirDistance(cssDir, path.dirname(full)),
            serverRoot: root,
          });
          break;
        }
        // Deployment-style fallback: a root-relative or base-relative link
        // (e.g. `<base href>` with a `/…` href) points at a file that does
        // not exist on disk — the served root differs from the local
        // layout. The ONLY remaining signal is the basename: when it equals
        // the analyzed stylesheet's basename, the page is paired with it.
        // Gated to deployment-kind links ONLY: a plain relative `../` URL
        // that resolves to nothing is a broken project link, not a served
        // URL space — pairing by basename would be guesswork. A link that
        // URL-resolves to an EXISTING file never reaches this branch, so
        // multi-stylesheet projects keep exact URL matching.
        const kind = classifyKind(href, baseHref);
        if (
          (kind === 'root-relative' || kind === 'base') &&
          path.basename(resolved) === path.basename(cssReal) &&
          !fs.existsSync(resolved)
        ) {
          matches.push({
            htmlPath: full,
            href,
            kind,
            distance: dirDistance(cssDir, path.dirname(full)),
            serverRoot: root,
          });
          break;
        }
      }
    }

    for (const sub of subdirs) {
      queue.push({ dir: sub, depth: depth + 1 });
    }

    // Cooperative scanning: every 16 processed directories with work
    // remaining, hand the event loop back so other extension work (UI,
    // decorations, CDP traffic) is not starved for the whole scan.
    if (queue.length > 0 && processedDirs % 16 === 0) {
      await yieldToEventLoop();
    }
  }

  return matches;
}

/** The authored form of a stylesheet link. */
function classifyKind(href: string, baseHref?: string): CompanionHrefKind {
  if (href.startsWith('/')) {
    return 'root-relative';
  }
  if (baseHref !== undefined) {
    return 'base';
  }
  if (href.startsWith('../')) {
    return 'relative-up';
  }
  return 'relative-down';
}

/** Directory distance: path segments between two directories (0 = equal). */
export function dirDistance(fromDir: string, toDir: string): number {
  const normFrom = normalizeFsPath(path.resolve(fromDir));
  const normTo = normalizeFsPath(path.resolve(toDir));
  const rel = path.relative(normFrom, normTo);
  if (rel === '') {
    return 0;
  }
  return rel.split(path.sep).length;
}

/**
 * The deterministic selection comparator: directory distance ascending,
 * `index.html` first within equal distance, then full-path lexicographic
 * ascending. Distance 0 reproduces the legacy same-directory order exactly.
 */
export function compareCompanions(a: { htmlPath: string; distance: number }, b: { htmlPath: string; distance: number }): number {
  if (a.distance !== b.distance) {
    return a.distance - b.distance;
  }
  const rankA = path.basename(a.htmlPath).toLowerCase() === 'index.html' ? 0 : 1;
  const rankB = path.basename(b.htmlPath).toLowerCase() === 'index.html' ? 0 : 1;
  if (rankA !== rankB) {
    return rankA - rankB;
  }
  return a.htmlPath.localeCompare(b.htmlPath);
}

/**
 * Canonical-deduplicate a ranked list BEFORE any truncation: two matches
 * pointing at the same physical file through different symlink paths would
 * otherwise look like two companions. The canonical identity comes from
 * `fs.realpathSync`, wrapped in try/catch with a fallback to the original
 * path (an ENOENT race — the file vanished between scan and dedupe — must
 * not crash the resolution). First occurrence wins; relative rank order is
 * preserved.
 */
export function deduplicateByCanonicalPath(
  resolutions: readonly CompanionResolution[],
  fsLayer: CompanionFs = nodeCompanionFs
): CompanionResolution[] {
  const seen = new Set<string>();
  const deduped: CompanionResolution[] = [];
  for (const resolution of resolutions) {
    let canonical = resolution.htmlPath;
    try {
      canonical = fsLayer.realpathSync(resolution.htmlPath);
    } catch {
      // ENOENT-style race: keep the original path — the companion stays
      // valid as authored; a later analysis re-resolves it.
    }
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    deduped.push(resolution);
  }
  return deduped;
}

/**
 * Ranked, canonical-deduplicated list of EVERY companion document that
 * links the stylesheet (pre-truncation). Deterministic comparator order:
 * distance ascending, `index.html` first within equal distance, then full
 * path lexicographic. Deduplication by canonical filesystem identity runs
 * BEFORE ranking.
 *
 * Cooperative: the underlying BFS yields to the event loop between
 * directory batches (see `matchRoot`) — resolution on big workspaces must
 * be awaited on the extension-host thread (P2-PERF-12).
 */
export async function resolveCompanionsAll(options: CompanionResolverOptions): Promise<CompanionResolution[]> {
  const cssReal = cssRealPath(options.cssFilePath);
  const cssDir = path.dirname(cssReal);

  const patterns = [
    ...DEFAULT_IGNORED_PATTERNS,
    ...(options.ignoredPatterns ?? companionSettings.ignoredPatterns),
  ];
  const maxDepth = options.maxDepth ?? companionSettings.maxDepth;
  const maxCandidates = options.maxCandidates ?? companionSettings.maxCandidates;
  const maxFileSizeBytes = options.maxFileSizeBytes ?? companionSettings.maxFileSizeBytes;
  const provider =
    options.workspaceFolderProvider !== undefined
      ? options.workspaceFolderProvider
      : companionSettings.workspaceFolderProvider;

  const roots = searchRootsFor(cssDir, provider, maxDepth);
  const budget = { remaining: maxCandidates };

  const matches: CompanionResolution[] = [];
  for (const root of roots) {
    if (budget.remaining <= 0) {
      break;
    }
    matches.push(...(await matchRoot(root, cssReal, cssDir, patterns, maxDepth, maxFileSizeBytes, budget)));
  }

  return deduplicateByCanonicalPath(matches).sort(compareCompanions);
}

/**
 * The Top-K companion selection: `resolveCompanionsAll` truncated to the
 * evidence budget (`maxCompanions`, defaulting to
 * `companionSettings.maxCompanions`). The budget is EXACTLY an evidence
 * budget — a correctness ceiling on how many real pages are polled — never
 * a correctness guarantee. Zero companions means the caller falls back to
 * the synthetic wrapper flow.
 */
export async function resolveCompanions(options: CompanionResolverOptions): Promise<CompanionResolution[]> {
  const all = await resolveCompanionsAll(options);
  const maxCompanions = options.maxCompanions ?? companionSettings.maxCompanions;
  return all.slice(0, maxCompanions);
}

/**
 * Find the single top-ranked companion document for a CSS file, or null
 * when none links it. Backward-compatible: exactly the first element of
 * the ranked Top-K selection.
 */
export async function resolveCompanion(options: CompanionResolverOptions): Promise<CompanionResolution | null> {
  return (await resolveCompanions(options))[0] ?? null;
}
