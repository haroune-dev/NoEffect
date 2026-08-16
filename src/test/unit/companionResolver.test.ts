import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CompanionResolution,
  compareCompanions,
  dirDistance,
  extractLinkedHrefs,
  resolveCompanion,
} from '../../services/companionResolver';

/**
 * Companion-document resolution (Level 10): bounded cross-directory
 * discovery (Phase A) + precise matching through the shared URL model
 * (Phase B), with the deterministic selection comparator.
 */

let root: string;

function layout(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-companion-'));
  return root;
}

function write(filePath: string, content: string): string {
  const abs = path.join(root, filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function page(cssHref: string, name = 'index.html'): string {
  return `<!DOCTYPE html><html><head><link rel="stylesheet" href="${cssHref}"></head><body></body></html>`;
}

// ── Phase B: href extraction ───────────────────────────────────────────

test('extractLinkedHrefs: stylesheet links only, in document order', () => {
  const html = [
    '<link rel="icon" href="favicon.ico">',
    '<link rel="stylesheet" href="a.css">',
    '<link rel="preload stylesheet" href="b.css">',
    '<link rel="stylesheet">',
    "<link rel='stylesheet' href='c.css'>",
    '<link rel="stylesheet" href="d.css">',
  ].join('\n');
  assert.deepEqual(extractLinkedHrefs(html).hrefs, ['a.css', 'b.css', 'c.css', 'd.css']);
});

test('extractLinkedHrefs: base href is captured when present', () => {
  const html = '<base href="/assets/"><link rel="stylesheet" href="x.css">';
  const parsed = extractLinkedHrefs(html);
  assert.equal(parsed.baseHref, '/assets/');
  assert.deepEqual(parsed.hrefs, ['x.css']);
});

test('extractLinkedHrefs: base without href is ignored', () => {
  const html = '<base target="_blank"><link rel="stylesheet" href="x.css">';
  const parsed = extractLinkedHrefs(html);
  assert.equal(parsed.baseHref, undefined);
  assert.deepEqual(parsed.hrefs, ['x.css']);
});

// ── Comparator ─────────────────────────────────────────────────────────

test('dirDistance: 0 for same directory, segments otherwise', () => {
  assert.equal(dirDistance('/a/b', '/a/b'), 0);
  assert.equal(dirDistance('/a/b', '/a/c'), 2);
  assert.equal(dirDistance('/a/b', '/a'), 1);
  assert.equal(dirDistance('/a', '/a/b/c'), 2);
});

test('compareCompanions: distance first, then index.html, then alphabetical', () => {
  const a = { htmlPath: '/a/b/x.html', distance: 0 };
  const b = { htmlPath: '/a/c/index.html', distance: 1 };
  assert.ok(compareCompanions(a, b) < 0, 'distance 0 beats distance 1');

  const i = { htmlPath: '/a/index.html', distance: 0 };
  const z = { htmlPath: '/a/z.html', distance: 0 };
  assert.ok(compareCompanions(i, z) < 0, 'index.html wins within equal distance');
  assert.ok(compareCompanions(z, i) > 0);

  const m = { htmlPath: '/a/m.html', distance: 0 };
  const n = { htmlPath: '/a/n.html', distance: 0 };
  assert.ok(compareCompanions(m, n) < 0, 'alphabetical within equal distance and rank');
  assert.ok(compareCompanions(n, m) > 0);
});

test('compareCompanions: distance 0 order reproduces the legacy policy exactly', () => {
  const legacyOrder = ['index.html', 'a.html', 'b.html'];
  const shuffled = ['b.html', 'index.html', 'a.html'];
  const sorted = shuffled
    .map((name) => ({ htmlPath: path.join('/x', name), distance: 0 }))
    .sort(compareCompanions)
    .map((r) => path.basename(r.htmlPath));
  assert.deepEqual(sorted, legacyOrder);
});

// ── Resolution ─────────────────────────────────────────────────────────

test('same-directory companion wins (legacy policy, distance 0)', () => {
  layout();
  write('styles.css', 'body{}');
  write('index.html', page('styles.css'));
  write('a.html', page('styles.css'));

  const resolved = resolveCompanion({ cssFilePath: path.join(root, 'styles.css') })!;
  assert.equal(resolved.htmlPath, path.join(root, 'index.html'));
  assert.equal(resolved.distance, 0);
  assert.equal(resolved.serverRoot, root);
  assert.equal(resolved.kind, 'relative-down');
});

test('crossdir-down: companion in a parent directory via ../ href (LCA root)', () => {
  layout();
  const css = write('styles/theme.css', 'body{}');
  write('index.html', page('../styles/theme.css'));

  const resolved = resolveCompanion({ cssFilePath: css })!;
  assert.equal(resolved.htmlPath, path.join(root, 'index.html'));
  assert.equal(resolved.kind, 'relative-up');
  assert.equal(resolved.serverRoot, root, 'server root is the LCA (workspace root here)');
});

test('crossdir-up: companion in a subdirectory linking back via ../', () => {
  layout();
  const css = write('styles.css', 'body{}');
  write('pages/index.html', page('../styles.css'));

  const resolved = resolveCompanion({ cssFilePath: css })!;
  assert.equal(resolved.htmlPath, path.join(root, 'pages', 'index.html'));
  assert.equal(resolved.kind, 'relative-up');
});

test('root-relative href links resolve from the server root', () => {
  layout();
  const css = write('css/theme.css', 'body{}');
  write('pages/index.html', page('/css/theme.css'));

  const resolved = resolveCompanion({ cssFilePath: css })!;
  assert.equal(resolved.htmlPath, path.join(root, 'pages', 'index.html'));
  assert.equal(resolved.kind, 'root-relative');
});

test('base href: relative links resolve through <base href>', () => {
  layout();
  const css = write('assets/theme.css', 'body{}');
  const html = '<base href="../assets/"><link rel="stylesheet" href="theme.css">';
  write('pages/index.html', html);

  const resolved = resolveCompanion({ cssFilePath: css })!;
  assert.equal(resolved.htmlPath, path.join(root, 'pages', 'index.html'));
  assert.equal(resolved.kind, 'base');
});

test('multi-document projects: distance, then index.html, then alphabetical', () => {
  layout();
  const css = write('styles/x.css', 'body{}');
  write('index.html', page('styles/x.css')); // distance 1
  write('pages/index.html', page('../styles/x.css')); // distance 2, index.html
  write('pages/z.html', page('../styles/x.css')); // distance 2
  write('pages/a.html', page('../styles/x.css')); // distance 2

  const resolved = resolveCompanion({ cssFilePath: css })!;
  assert.equal(resolved.htmlPath, path.join(root, 'index.html'), 'distance 1 beats distance 2');
});

test('multi-document projects: index.html beats alphabetical within equal distance', () => {
  layout();
  const css = write('styles/x.css', 'body{}');
  write('pages/z.html', page('../styles/x.css'));
  write('pages/index.html', page('../styles/x.css'));

  const resolved = resolveCompanion({ cssFilePath: css })!;
  assert.equal(resolved.htmlPath, path.join(root, 'pages', 'index.html'));
});

test('ignored directories (node_modules) are pruned — negative control', () => {
  layout();
  const css = write('styles/x.css', 'body{}');
  write('node_modules/pkg/index.html', page('../styles/x.css'));
  write('dist/index.html', page('../styles/x.css'));

  assert.equal(resolveCompanion({ cssFilePath: css }), null);
});

test('user ignore globs prune candidate trees', () => {
  layout();
  const css = write('styles/x.css', 'body{}');
  write('templates/index.html', page('../styles/x.css'));

  const resolved = resolveCompanion({ cssFilePath: css, ignoredPatterns: ['**/templates/**'] });
  assert.equal(resolved, null);
});

test('depth bound: deep candidates are not scanned', () => {
  layout();
  const css = write('styles/x.css', 'body{}');
  write('a/b/c/d/e/index.html', page('../../../../../styles/x.css'));

  assert.equal(resolveCompanion({ cssFilePath: css, maxDepth: 2 }), null);
  assert.ok(resolveCompanion({ cssFilePath: css, maxDepth: 6 }), 'default depth finds it');
});

test('candidate bound: the scan stops once the budget is exhausted', () => {
  layout();
  const css = write('styles/x.css', 'body{}');
  for (let i = 0; i < 10; i++) {
    write(`a${i}.html`, page('styles/x.css'));
  }

  // Budget 1 = the root directory visit only: no candidate is ever read.
  assert.equal(resolveCompanion({ cssFilePath: css, maxCandidates: 1 }), null);
  // Budget 3 = root visit + a0 + a1: a0 is the first linker read.
  assert.equal(
    resolveCompanion({ cssFilePath: css, maxCandidates: 3 })?.htmlPath,
    path.join(root, 'a0.html')
  );
  assert.ok(resolveCompanion({ cssFilePath: css }), 'default budget finds a linker');
});

test('workspace-folder provider bounds the search to the folder', () => {
  layout();
  const css = write('styles/x.css', 'body{}');
  const linkerOutside = write('outside/index.html', page('../styles/x.css'));

  const provider = (fsPath: string): string | null =>
    fsPath.startsWith(path.join(root, 'styles')) ? path.join(root, 'styles') : null;
  const resolved = resolveCompanion({
    cssFilePath: css,
    workspaceFolderProvider: provider,
  });
  assert.equal(resolved, null, 'linker outside the provided folder is not seen');

  const resolvedWithRoot = resolveCompanion({
    cssFilePath: css,
    workspaceFolderProvider: () => root,
  });
  assert.equal(resolvedWithRoot?.htmlPath, linkerOutside);
});

test('non-linking candidates produce no companion (wrapper flow keeps warning)', () => {
  layout();
  const css = write('styles/x.css', 'body{}');
  write('pages/index.html', '<html><body></body></html>');
  write('pages/other.html', '<link rel="stylesheet" href="../unrelated.css">');

  assert.equal(resolveCompanion({ cssFilePath: css }), null);
});

test('undecodable hrefs are skipped without breaking the scan', () => {
  layout();
  const css = write('styles/x.css', 'body{}');
  write(
    'index.html',
    '<link rel="stylesheet" href="%zz.css"><link rel="stylesheet" href="../styles/x.css">'
  );

  const resolved = resolveCompanion({ cssFilePath: css })!;
  assert.equal(resolved.htmlPath, path.join(root, 'index.html'));
});

test('external hrefs never match (https:, data:, protocol-relative)', () => {
  layout();
  const css = write('styles/x.css', 'body{}');
  write(
    'index.html',
    [
      '<link rel="stylesheet" href="https://cdn/x.css">',
      '<link rel="stylesheet" href="//cdn/x.css">',
      '<link rel="stylesheet" href="data:text/css,x{}">',
    ].join('\n')
  );

  assert.equal(resolveCompanion({ cssFilePath: css }), null);
});

test('same stylesheet linked twice in one document produces one match', () => {
  layout();
  const css = write('styles/x.css', 'body{}');
  write(
    'index.html',
    '<link rel="stylesheet" href="../styles/x.css"><link rel="stylesheet" href="../styles/x.css">'
  );

  const resolved = resolveCompanion({ cssFilePath: css })!;
  assert.equal(resolved.htmlPath, path.join(root, 'index.html'));
});

test('resolution is deterministic across calls', () => {
  layout();
  const css = write('styles/x.css', 'body{}');
  write('index.html', page('styles/x.css'));
  write('pages/index.html', page('../styles/x.css'));

  const first = resolveCompanion({ cssFilePath: css });
  const second = resolveCompanion({ cssFilePath: css });
  assert.deepEqual(first, second);
});

// ── Deployment-style basename fallback ──────────────────────────────────

test('deployment-style links: a base-relative URL that does not exist on disk pairs by basename', () => {
  layout();
  const css = write('css/styles.css', 'body{}');
  const home = write(
    'pages/public/home.html',
    '<base href="/"><link rel="stylesheet" href="/test/manual-multipage-stress/css/styles.css">'
  );

  const resolved = resolveCompanion({ cssFilePath: css })!;
  assert.equal(resolved.htmlPath, home, 'the page pairs with the analyzed stylesheet by basename');
  assert.equal(resolved.kind, 'root-relative');
});

test('deployment-style links: a mismatched basename never pairs', () => {
  layout();
  const css = write('css/styles.css', 'body{}');
  write(
    'pages/public/home.html',
    '<base href="/"><link rel="stylesheet" href="/assets/other.css">'
  );

  assert.equal(resolveCompanion({ cssFilePath: css }), null);
});

test('deployment-style links: a URL that resolves to an EXISTING file never falls back', () => {
  layout();
  const css = write('css/styles.css', 'body{}');
  write('other/styles.css', 'body{}');
  write(
    'pages/public/home.html',
    '<base href="/"><link rel="stylesheet" href="/other/styles.css">'
  );

  assert.equal(resolveCompanion({ cssFilePath: css }), null, 'exact URL resolution is authoritative');
});

test('broken relative links never pair by basename (the fallback is deployment-kind only)', () => {
  layout();
  const css = write('styles/x.css', 'body{}');
  write('pages/index.html', page('../x.css'));

  assert.equal(
    resolveCompanion({ cssFilePath: css }),
    null,
    'a relative ../ link that resolves to nothing is a broken project link, not a served URL space'
  );
});
