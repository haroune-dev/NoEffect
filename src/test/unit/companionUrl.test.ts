import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { toServedPath, fromServedPath, resolveLocalPath } from '../../services/companionUrl';

/**
 * The shared URL-resolution model (Level 10): one source of truth for the
 * companion matcher AND the DevServer — "what resolves is what serves".
 */

const ROOT = path.resolve('/proj');
const PAGE = '/pages/index.html';

test('toServedPath: maps absolute files to root-relative URL paths', () => {
  assert.equal(toServedPath(ROOT, path.join(ROOT, 'index.html')), '/index.html');
  assert.equal(toServedPath(ROOT, path.join(ROOT, 'pages', 'index.html')), '/pages/index.html');
  assert.equal(toServedPath(ROOT, path.join(ROOT, 'css', 'my styles.css')), '/css/my%20styles.css');
  assert.equal(toServedPath(ROOT, path.join(ROOT, 'deep', 'nested', 'x.html')), '/deep/nested/x.html');
});

test('toServedPath: returns null for files outside the root', () => {
  assert.equal(toServedPath(ROOT, '/elsewhere/x.html'), null);
  assert.equal(toServedPath(ROOT, path.join(ROOT, '..', 'x.html')), null);
});

test('fromServedPath: maps request paths into the root', () => {
  assert.equal(fromServedPath(ROOT, '/'), path.join(ROOT, 'index.html'));
  assert.equal(fromServedPath(ROOT, '/index.html'), path.join(ROOT, 'index.html'));
  assert.equal(fromServedPath(ROOT, '/css/theme.css'), path.join(ROOT, 'css', 'theme.css'));
  assert.equal(fromServedPath(ROOT, '/css/theme.css?x=1'), path.join(ROOT, 'css', 'theme.css'));
  assert.equal(fromServedPath(ROOT, '/a%20b.css'), path.join(ROOT, 'a b.css'));
});

test('fromServedPath: in-bounds .. segments collapse (browser-normalized URLs)', () => {
  assert.equal(fromServedPath(ROOT, '/pages/../css/theme.css'), path.join(ROOT, 'css', 'theme.css'));
  assert.equal(fromServedPath(ROOT, '/css/./theme.css'), path.join(ROOT, 'css', 'theme.css'));
});

test('fromServedPath: rejects anything escaping the root', () => {
  assert.equal(fromServedPath(ROOT, '/../secret.txt'), null);
  assert.equal(fromServedPath(ROOT, '/%2e%2e/secret.txt'), null);
  assert.equal(fromServedPath(ROOT, '/..%2fsecret.txt'), null);
  assert.equal(fromServedPath(ROOT, '/css/../../secret.txt'), null);
});

test('fromServedPath: rejects hostile encodings and malformed input', () => {
  assert.equal(fromServedPath(ROOT, '/a\\b.css'), null);
  assert.equal(fromServedPath(ROOT, '/%5c..%5csecret'), null);
  assert.equal(fromServedPath(ROOT, '/%zz.css'), null);
  // A decoded null byte stays in-bounds (containment holds) — parity with the
  // legacy server behavior; it never escapes the root.
  assert.equal(fromServedPath(ROOT, '/a%00b.css'), path.join(ROOT, 'a\u0000b.css'));
});

test('resolveLocalPath: relative links resolve against the page URL', () => {
  const base = { serverRoot: ROOT, pagePath: PAGE };
  assert.equal(
    resolveLocalPath({ ...base, href: 'styles.css' }),
    path.join(ROOT, 'pages', 'styles.css')
  );
  assert.equal(
    resolveLocalPath({ ...base, href: './x.css' }),
    path.join(ROOT, 'pages', 'x.css')
  );
  assert.equal(
    resolveLocalPath({ ...base, href: '../css/theme.css' }),
    path.join(ROOT, 'css', 'theme.css')
  );
  assert.equal(
    resolveLocalPath({ ...base, href: 'sub/deep.css' }),
    path.join(ROOT, 'pages', 'sub', 'deep.css')
  );
});

test('resolveLocalPath: root-relative links resolve against the server root', () => {
  assert.equal(
    resolveLocalPath({ serverRoot: ROOT, pagePath: '/pages/index.html', href: '/css/theme.css' }),
    path.join(ROOT, 'css', 'theme.css')
  );
});

test('resolveLocalPath: honors <base href> exactly like the browser', () => {
  const base = { serverRoot: ROOT, pagePath: PAGE };
  assert.equal(
    resolveLocalPath({ ...base, baseHref: '../assets/', href: 'theme.css' }),
    path.join(ROOT, 'assets', 'theme.css')
  );
  assert.equal(
    resolveLocalPath({ ...base, baseHref: '/static/', href: 'theme.css' }),
    path.join(ROOT, 'static', 'theme.css')
  );
  assert.equal(
    resolveLocalPath({ ...base, baseHref: 'https://cdn.example.com/', href: 'theme.css' }),
    null
  );
});

test('resolveLocalPath: external URLs never resolve locally', () => {
  const base = { serverRoot: ROOT, pagePath: PAGE };
  assert.equal(resolveLocalPath({ ...base, href: 'https://cdn.example.com/x.css' }), null);
  assert.equal(resolveLocalPath({ ...base, href: 'data:text/css,x{}' }), null);
  assert.equal(resolveLocalPath({ ...base, href: '//cdn.example.com/x.css' }), null);
  assert.equal(resolveLocalPath({ ...base, href: 'javascript:void(0)' }), null);
});

test('resolveLocalPath: percent-encoded input round-trips through decode', () => {
  const base = { serverRoot: ROOT, pagePath: PAGE };
  assert.equal(
    resolveLocalPath({ ...base, href: 'my%20styles.css' }),
    path.join(ROOT, 'pages', 'my styles.css')
  );
  assert.equal(
    resolveLocalPath({ ...base, href: 'my styles.css' }),
    path.join(ROOT, 'pages', 'my styles.css')
  );
});

test('resolveLocalPath: undecodable or hostile hrefs are skipped (never crash)', () => {
  const base = { serverRoot: ROOT, pagePath: PAGE };
  assert.equal(resolveLocalPath({ ...base, href: '%zz.css' }), null);
  assert.equal(resolveLocalPath({ ...base, href: 'a/b%5c..%5csecret.css' }), null);
  // Encoded `..` is normalized by the URL parser exactly like a browser
  // resolves it: in-bounds, consistent between matcher and DevServer.
  assert.equal(
    resolveLocalPath({ ...base, href: '%2e%2e/secret.css' }),
    path.join(ROOT, 'secret.css')
  );
});
