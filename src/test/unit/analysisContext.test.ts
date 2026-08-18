import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ANALYSIS_CONTEXT_VERSION,
  STALE_CONTEXT_FINGERPRINT,
  analysisContextFingerprint,
  companionContextFingerprintFor,
} from '../../engine/analysisContext';
import { companionCache } from '../../cache/companionCache';
import { companionSettings } from '../../services/companionSettings';
import { CompanionResolution } from '../../services/companionResolver';

/**
 * Unit tests for the Phase 6 analysis-context fingerprint (F1): the pure
 * hash over the selected companions' canonical paths + content hashes, the
 * Top-K budget and the config version — derived EXACTLY from the validated
 * companion-cache snapshot, never from a fresh workspace walk.
 */

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-ctx-'));
}

function htmlFile(project: string, name: string, content: string): string {
  const filePath = path.join(project, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function resolution(htmlPath: string, _rank: number): CompanionResolution {
  return {
    htmlPath,
    href: 'styles.css',
    kind: 'relative-down',
    distance: 0,
    serverRoot: path.dirname(htmlPath),
  };
}

test('F1: the fingerprint is deterministic and order-dependent', () => {
  const project = tmpProject();
  const a = htmlFile(project, 'a.html', '<h1></h1>');
  const b = htmlFile(project, 'b.html', '<h1></h1>');
  const resA = resolution(a, 0);
  const resB = resolution(b, 1);

  const ab = analysisContextFingerprint({
    resolutions: [resA, resB],
    companionHashes: ['hash-a', 'hash-b'],
    maxCompanions: 3,
  });
  const abAgain = analysisContextFingerprint({
    resolutions: [resA, resB],
    companionHashes: ['hash-a', 'hash-b'],
    maxCompanions: 3,
  });
  assert.equal(ab, abAgain, 'the same snapshot always hashes identically');

  const ba = analysisContextFingerprint({
    resolutions: [resB, resA],
    companionHashes: ['hash-b', 'hash-a'],
    maxCompanions: 3,
  });
  assert.notEqual(ab, ba, 'the ranked order is part of the fingerprint');
});

test('F1: any change to selected content, the budget or the config version changes the fingerprint', () => {
  const project = tmpProject();
  const a = htmlFile(project, 'a.html', '<h1></h1>');
  const b = htmlFile(project, 'b.html', '<h1></h1>');
  const resA = resolution(a, 0);
  const resB = resolution(b, 1);

  const base = analysisContextFingerprint({
    resolutions: [resA, resB],
    companionHashes: ['hash-a', 'hash-b'],
    maxCompanions: 3,
  });

  const contentChanged = analysisContextFingerprint({
    resolutions: [resA, resB],
    companionHashes: ['hash-a', 'hash-b-NEW'],
    maxCompanions: 3,
  });
  assert.notEqual(base, contentChanged, 'a companion content change must invalidate the context');

  const budgetChanged = analysisContextFingerprint({
    resolutions: [resA, resB],
    companionHashes: ['hash-a', 'hash-b'],
    maxCompanions: 2,
  });
  assert.notEqual(base, budgetChanged, 'the Top-K budget is part of the fingerprint');

  const versionChanged = contentHashOf(`v${ANALYSIS_CONTEXT_VERSION + 1}|3|...`);
  assert.notEqual(base, versionChanged, 'the config version separates fingerprints across upgrades');
});

function contentHashOf(payload: string): string {
  return crypto.createHash('sha256').update(payload, 'utf-8').digest('hex');
}

test('F1: the fingerprint covers the FULL selection the caller passes — it never truncates silently', () => {
  const project = tmpProject();
  const files = [1, 2, 3, 4].map((i) => htmlFile(project, `c${i}.html`, '<h1></h1>'));
  const resolutions = files.map((f, i) => resolution(f, i));

  const withFour = analysisContextFingerprint({
    resolutions,
    companionHashes: ['1', '2', '3', '4'],
    maxCompanions: 2,
  });
  const withOnlyTwo = analysisContextFingerprint({
    resolutions: resolutions.slice(0, 2),
    companionHashes: ['1', '2'],
    maxCompanions: 2,
  });
  assert.notEqual(
    withFour,
    withOnlyTwo,
    'the fingerprint hashes EXACTLY the selection the caller passes — ' +
      'selection (Top-K + expansions) is the shared rule’s job, never the hash’s'
  );
  assert.equal(
    analysisContextFingerprint({
      resolutions,
      companionHashes: ['1', '2', '3', '4'],
      maxCompanions: 2,
    }),
    withFour,
    'deterministic for the same full selection'
  );
});

test('F1: companionContextFingerprintFor returns STALE without a validated snapshot', () => {
  const project = tmpProject();
  const cssPath = path.join(project, 'styles.css');
  fs.writeFileSync(cssPath, 'a { justify-content: center; }');
  companionCache.reset();
  companionSettings.workspaceFolderProvider = () => project;

  assert.equal(
    companionContextFingerprintFor(cssPath),
    STALE_CONTEXT_FINGERPRINT,
    'an empty resolution cache must never produce a usable fingerprint'
  );
});

test('F1: companionContextFingerprintFor is derived from the validated cache snapshot', () => {
  const project = tmpProject();
  const cssPath = path.join(project, 'styles.css');
  fs.writeFileSync(cssPath, 'a { justify-content: center; }');
  const htmlPath = htmlFile(project, 'index.html', '<a></a>');
  companionSettings.workspaceFolderProvider = () => project;
  companionCache.reset();

  companionCache.set(`${project}|${cssPath}`, [resolution(htmlPath, 0)]);

  const fingerprint = companionContextFingerprintFor(cssPath);
  assert.notEqual(fingerprint, STALE_CONTEXT_FINGERPRINT, 'a validated snapshot produces a real fingerprint');
  const expected = analysisContextFingerprint({
    resolutions: [resolution(htmlPath, 0)],
    companionHashes: [contentHashOf('<a></a>')],
    maxCompanions: companionSettings.maxCompanions,
  });
  assert.equal(
    fingerprint,
    expected,
    'the fingerprint is computed from the cache entry’s resolutions AND its pinned content hashes'
  );
});

test('F1: a deleted companion invalidates the snapshot → STALE', () => {
  const project = tmpProject();
  const cssPath = path.join(project, 'styles.css');
  fs.writeFileSync(cssPath, 'a { justify-content: center; }');
  const htmlPath = htmlFile(project, 'index.html', '<a></a>');
  companionSettings.workspaceFolderProvider = () => project;
  companionCache.reset();

  companionCache.set(`${project}|${cssPath}`, [resolution(htmlPath, 0)]);
  assert.notEqual(companionContextFingerprintFor(cssPath), STALE_CONTEXT_FINGERPRINT);

  fs.unlinkSync(htmlPath);
  assert.equal(
    companionContextFingerprintFor(cssPath),
    STALE_CONTEXT_FINGERPRINT,
    'a deleted companion must invalidate the fingerprint (never trust a stale snapshot)'
  );
});

test('F1: a changed companion invalidates the snapshot → STALE', () => {
  const project = tmpProject();
  const cssPath = path.join(project, 'styles.css');
  fs.writeFileSync(cssPath, 'a { justify-content: center; }');
  const htmlPath = htmlFile(project, 'index.html', '<a></a>');
  companionSettings.workspaceFolderProvider = () => project;
  companionCache.reset();

  companionCache.set(`${project}|${cssPath}`, [resolution(htmlPath, 0)]);
  assert.notEqual(companionContextFingerprintFor(cssPath), STALE_CONTEXT_FINGERPRINT);

  fs.writeFileSync(htmlPath, '<a><b></b></a>');
  assert.equal(
    companionContextFingerprintFor(cssPath),
    STALE_CONTEXT_FINGERPRINT,
    'an in-place companion edit must invalidate the fingerprint (hash re-validation)'
  );
});

test('F1: the workspace folder provider selects the primary root', () => {
  const project = tmpProject();
  const nested = path.join(project, 'deep', 'sub');
  fs.mkdirSync(nested, { recursive: true });
  const cssPath = path.join(nested, 'styles.css');
  fs.writeFileSync(cssPath, 'a { justify-content: center; }');
  const htmlPath = htmlFile(project, 'index.html', '<a></a>');
  companionSettings.workspaceFolderProvider = () => project;
  companionCache.reset();

  companionCache.set(`${project}|${cssPath}`, [resolution(htmlPath, 0)]);
  assert.notEqual(companionContextFingerprintFor(cssPath), STALE_CONTEXT_FINGERPRINT);

  companionSettings.workspaceFolderProvider = () => nested;
  assert.equal(
    companionContextFingerprintFor(cssPath),
    STALE_CONTEXT_FINGERPRINT,
    'a different primary root resolves a different cache key'
  );
});
