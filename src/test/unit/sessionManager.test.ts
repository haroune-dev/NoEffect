import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../../services/sessionManager';
import { AnalysisResult, AnalysisNamespace, CssIssue } from '../../models';

/**
 * Unit tests for the Phase 6 multi-file orchestration support in
 * SessionManager: the cssGlobal / htmlEmbedded result namespaces (F5), the
 * fingerprint skip gate (F3), and the CssGlobalOutcomeStore contract (F4).
 */

function issue(filePath: string, propertyName = 'justify-content'): CssIssue {
  return {
    propertyName,
    propertyValue: 'center',
    selector: '.a',
    location: {
      filePath,
      startLine: 0,
      startColumn: 0,
      endLine: 0,
      endColumn: 1,
    },
  };
}

function result(overrides: Partial<AnalysisResult>): AnalysisResult {
  return {
    success: true,
    issues: [],
    timestamp: 0,
    durationMs: 0,
    htmlFilePath: '',
    cssFilePaths: [],
    ...overrides,
  };
}

function cssNamespace(cssPath: string, contentFp = 'css-fp', contextFp = 'ctx-fp'): AnalysisNamespace {
  return { kind: 'cssGlobal', cssPath, contentFingerprint: contentFp, contextFingerprint: contextFp, epoch: 1 };
}

function htmlNamespace(htmlPath: string, contentFp = 'html-fp'): AnalysisNamespace {
  return { kind: 'htmlEmbedded', htmlPath, contentFingerprint: contentFp, epoch: 1 };
}

test('F5: completeAnalysis writes EXACTLY ONE namespace — cssGlobal', () => {
  const manager = new SessionManager();
  const cssPath = '/project/styles.css';
  const issues = [issue(cssPath), issue(cssPath, 'align-items')];

  manager.completeAnalysis(
    result({ cssFilePaths: [cssPath], issues, namespace: cssNamespace(cssPath) })
  );

  const known = manager.getIssuesForFile(cssPath);
  assert.ok(known, 'the analyzed CSS file must be known through cssGlobal');
  assert.equal(known.length, 2);
  // An HTML file must NOT see the CSS run's issues (single-writer).
  assert.equal(manager.getIssuesForFile('/project/index.html'), undefined);
});

test('F5: completeAnalysis writes EXACTLY ONE namespace — htmlEmbedded', () => {
  const manager = new SessionManager();
  const htmlPath = '/project/index.html';

  manager.completeAnalysis(result({ htmlFilePath: htmlPath, issues: [], namespace: htmlNamespace(htmlPath) }));

  assert.deepEqual(manager.getIssuesForFile(htmlPath), [], 'a zero-issue HTML run marks the file as known');
  // The CSS global namespace is untouched by an HTML run (single-writer):
  // linked-sheet issues never flow through the HTML run's result.
  assert.equal(manager.getIssuesForFile('/project/styles.css'), undefined);
});

test('F5: a new analysis replaces only its own namespace entry', () => {
  const manager = new SessionManager();
  const fileA = '/project/a.css';
  const fileB = '/project/b.css';

  manager.completeAnalysis(result({ cssFilePaths: [fileA], issues: [issue(fileA)], namespace: cssNamespace(fileA) }));
  assert.equal(manager.getIssuesForFile(fileA)?.length, 1);

  manager.completeAnalysis(result({ cssFilePaths: [fileB], issues: [issue(fileB)], namespace: cssNamespace(fileB) }));
  assert.equal(manager.getIssuesForFile(fileA)?.length, 1, 'an unrelated run never touches another entry');
  assert.equal(manager.getIssuesForFile(fileB)?.length, 1);

  manager.completeAnalysis(result({ cssFilePaths: [fileA], issues: [], namespace: cssNamespace(fileA) }));
  assert.deepEqual(manager.getIssuesForFile(fileA), [], 're-analyzing the same file replaces its own entry');
  assert.equal(manager.getIssuesForFile(fileB)?.length, 1, 'the other entry is untouched');
});

test('F3/RC2: a failed run is never recorded and invalidates its namespace entry', () => {
  const manager = new SessionManager();
  const filePath = '/project/styles.css';

  manager.completeAnalysis(
    result({ success: true, cssFilePaths: [filePath], issues: [issue(filePath)], namespace: cssNamespace(filePath) })
  );
  manager.recordSuccessfulAnalysis(filePath, 'css-fp', 'ctx-fp');
  assert.equal(manager.shouldSkipReanalysisWithContext(filePath, 'css-fp', 'ctx-fp'), true);

  manager.completeAnalysis(
    result({ success: false, cssFilePaths: [filePath], issues: [], namespace: cssNamespace(filePath) })
  );

  assert.equal(manager.lastRunWasRecorded(), false, 'a failed run is not recorded');
  assert.equal(
    manager.shouldSkipReanalysisWithContext(filePath, 'css-fp', 'ctx-fp'),
    false,
    'the gate opens after a failed run'
  );
  assert.equal(
    manager.getIssuesForFile(filePath),
    undefined,
    'a failed run must not resurrect stale decorations'
  );
});

test('F3: skip ⟺ successful run + unchanged content fingerprint + unchanged context fingerprint', () => {
  const manager = new SessionManager();
  const filePath = '/project/styles.css';
  const contentFp = 'css-fp';
  const contextFp = 'ctx-fp';

  manager.completeAnalysis(result({ cssFilePaths: [filePath], issues: [], namespace: cssNamespace(filePath) }));
  manager.recordSuccessfulAnalysis(filePath, contentFp, contextFp);

  assert.equal(manager.shouldSkipReanalysisWithContext(filePath, contentFp, contextFp), true, 'identical identity skips');
  assert.equal(
    manager.shouldSkipReanalysisWithContext(filePath, 'css-fp-2', contextFp),
    false,
    'changed content fingerprint must re-analyze'
  );
  assert.equal(
    manager.shouldSkipReanalysisWithContext(filePath, contentFp, 'ctx-fp-2'),
    false,
    'a changed context fingerprint must re-analyze (companion create/change/delete)'
  );
  assert.equal(
    manager.shouldSkipReanalysisWithContext('/project/other.css', contentFp, contextFp),
    false,
    'a different file must re-analyze'
  );
});

test('F3: HTML records are context-free (content fingerprint only)', () => {
  const manager = new SessionManager();
  const htmlPath = '/project/index.html';

  manager.completeAnalysis(result({ htmlFilePath: htmlPath, issues: [], namespace: htmlNamespace(htmlPath) }));
  manager.recordSuccessfulAnalysis(htmlPath, 'html-fp', null);

  assert.equal(manager.shouldSkipReanalysisWithContext(htmlPath, 'html-fp', null), true);
  assert.equal(
    manager.shouldSkipReanalysisWithContext(htmlPath, 'html-fp', 'any-context'),
    false,
    'an HTML record never matches a context-bearing probe'
  );
  assert.equal(
    manager.shouldSkipReanalysisWithContext(htmlPath, 'html-fp-2', null),
    false,
    'changed HTML content must re-analyze'
  );
});

test('F5/F4: cssGlobal store getFresh validates content + context + epoch', () => {
  const manager = new SessionManager();
  const cssPath = '/project/styles.css';
  manager.completeAnalysis(
    result({
      cssFilePaths: [cssPath],
      issues: [issue(cssPath)],
      namespace: cssNamespace(cssPath, 'css-fp', 'ctx-fp'),
    })
  );

  assert.equal(manager.getFresh(cssPath, 'css-fp', 'ctx-fp', 1)?.length, 1, 'identical identity is fresh');
  assert.equal(manager.getFresh(cssPath, 'css-fp-2', 'ctx-fp', 1), undefined, 'content change → stale');
  assert.equal(manager.getFresh(cssPath, 'css-fp', 'ctx-fp-2', 1), undefined, 'context change → stale');
  assert.equal(manager.getFresh(cssPath, 'css-fp', 'ctx-fp', 2), undefined, 'superseded epoch → stale');
  assert.equal(manager.getFresh('/project/other.css', 'css-fp', 'ctx-fp', 1), undefined, 'unknown file → stale');
});

test('F5: getFreshCssIssues — the freshness gate CSS decorations must probe', () => {
  const manager = new SessionManager();
  const cssPath = '/project/styles.css';
  const issues = [issue(cssPath)];
  manager.completeAnalysis(
    result({
      cssFilePaths: [cssPath],
      issues,
      namespace: cssNamespace(cssPath, 'content-a', 'ctx-a'),
    })
  );

  // The single authority: fresh (content, context, epoch) → issues.
  assert.equal(
    manager.getFreshCssIssues(cssPath, 'content-a', 'ctx-a', 1),
    issues,
    'the exact current-world identity returns the fresh outcome'
  );
  // Any identity drift → undefined: a stale outcome can never decorate.
  assert.equal(
    manager.getFreshCssIssues(cssPath, 'content-b', 'ctx-a', 1),
    undefined,
    'edited CSS content invalidates the snapshot (live-buffer hash)'
  );
  assert.equal(
    manager.getFreshCssIssues(cssPath, 'content-a', 'ctx-b', 1),
    undefined,
    'a changed analysis context invalidates the snapshot (companion change)'
  );
  assert.equal(
    manager.getFreshCssIssues(cssPath, 'content-a', 'ctx-a', 2),
    undefined,
    'a rebuilt session invalidates the snapshot (epoch)'
  );
  assert.equal(
    manager.getFreshCssIssues('/project/other.css', 'content-a', 'ctx-a', 1),
    undefined,
    'an unrecorded stylesheet has no fresh outcome'
  );
  // getFreshCssIssues must NEVER fall back to the raw getIssuesForFile read:
  // the bare issues are only reachable when the identity matches.
  assert.equal(
    manager.getFreshCssIssues(cssPath, 'content-stale', 'ctx-stale', 1),
    undefined,
    'a stale-identity probe must not return the bare issues'
  );
  assert.equal(manager.getIssuesForFile(cssPath)?.length, 1, 'the raw read still exists for HTML paths');
});

test('F4: the store record/read round trip feeds the HTML flow', () => {
  const manager = new SessionManager();
  const cssPath = '/project/styles.css';
  const issues = [issue(cssPath, 'align-items')];

  manager.record(cssPath, 'css-fp', 'ctx-fp', 7, issues);
  assert.equal(manager.getFresh(cssPath, 'css-fp', 'ctx-fp', 7)?.length, 1, 'a fresh record is reusable');
  assert.equal(manager.getFresh(cssPath, 'css-fp', 'ctx-fp', 8), undefined, 'a different epoch is not fresh');

  manager.record(cssPath, 'css-fp', 'ctx-fp', 8, issues);
  assert.equal(manager.getFresh(cssPath, 'css-fp', 'ctx-fp', 8)?.length, 1, 're-recording refreshes the entry');
});

test('completion listeners fire after the result is stored', () => {
  const manager = new SessionManager();
  const filePath = '/project/styles.css';
  let fired = 0;

  const subscription = manager.onAnalysisComplete(() => {
    fired++;
    assert.ok(manager.getIssuesForFile(filePath), 'the listener must see the stored result');
  });

  manager.completeAnalysis(result({ cssFilePaths: [filePath], issues: [], namespace: cssNamespace(filePath) }));
  assert.equal(fired, 1);

  subscription.dispose();
  manager.completeAnalysis(result({ cssFilePaths: [filePath], issues: [], namespace: cssNamespace(filePath) }));
  assert.equal(fired, 1, 'a disposed listener must not fire again');
});

test('beginAnalysis gates concurrent runs', () => {
  const manager = new SessionManager();
  assert.equal(manager.beginAnalysis(), true);
  assert.equal(manager.beginAnalysis(), false, 'a second concurrent run must be rejected');
  assert.equal(manager.analysisInProgress, true);

  manager.cancelAnalysis();
  assert.equal(manager.analysisInProgress, false);
  assert.equal(manager.beginAnalysis(), true, 'a cancelled session must accept new runs');
});

test('completeAnalysisCancelled never records and leaves namespaces untouched', () => {
  const manager = new SessionManager();
  const filePath = '/project/styles.css';

  manager.completeAnalysis(result({ cssFilePaths: [filePath], issues: [issue(filePath)], namespace: cssNamespace(filePath) }));
  manager.recordSuccessfulAnalysis(filePath, 'css-fp', 'ctx-fp');

  manager.beginAnalysis();
  manager.completeAnalysisCancelled();

  assert.equal(manager.lastRunWasRecorded(), false, 'a cancelled run is not recorded');
  assert.equal(
    manager.shouldSkipReanalysisWithContext(filePath, 'css-fp', 'ctx-fp'),
    true,
    'a cancelled run never clears the previous record'
  );
  assert.equal(manager.getIssuesForFile(filePath)?.length, 1, 'a cancelled run never touches the namespaces');
});

test('T8 [F4+F5] single-writer: an HTML-flow run can NEVER write a CSS-file entry', () => {
  const manager = new SessionManager();
  const htmlPath = '/project/about.html';
  const cssPath = '/project/styles.css';
  const htmlIssues = [issue(htmlPath), issue(htmlPath, 'align-items')];

  manager.completeAnalysis(
    result({ htmlFilePath: htmlPath, issues: htmlIssues, namespace: htmlNamespace(htmlPath) })
  );

  assert.deepEqual(manager.getIssuesForFile(htmlPath), htmlIssues, 'the HTML run owns its htmlEmbedded entry');
  assert.equal(
    manager.getIssuesForFile(cssPath),
    undefined,
    'an HTML-flow run can NEVER produce a decoration/issue write targeting a CSS file'
  );
  assert.equal(
    manager.getFresh(cssPath, 'css-fp', 'ctx-fp', 1),
    undefined,
    'the cssGlobal namespace stays untouched by an HTML run'
  );

  // The CSS flow is equally isolated from the HTML namespace.
  manager.completeAnalysis(result({ cssFilePaths: [cssPath], issues: [], namespace: cssNamespace(cssPath) }));
  assert.deepEqual(manager.getIssuesForFile(cssPath), [], 'the CSS run owns its cssGlobal entry');
  assert.deepEqual(
    manager.getIssuesForFile(htmlPath),
    htmlIssues,
    'a CSS run never writes (or touches) an htmlEmbedded entry'
  );
});

test('dispose resets all tracked state', async () => {
  const manager = new SessionManager();
  const filePath = '/project/styles.css';
  let fired = 0;

  manager.onAnalysisComplete(() => fired++);
  manager.completeAnalysis(result({ cssFilePaths: [filePath], issues: [issue(filePath)], namespace: cssNamespace(filePath) }));
  manager.recordSuccessfulAnalysis(filePath, 'css-fp', 'ctx-fp');

  await manager.dispose();
  assert.equal(manager.lastAnalysisResult, null);
  assert.equal(manager.getIssuesForFile(filePath), undefined);
  assert.equal(manager.shouldSkipReanalysisWithContext(filePath, 'css-fp', 'ctx-fp'), false);

  const firedBefore = fired;
  manager.completeAnalysis(result({ cssFilePaths: [filePath], issues: [], namespace: cssNamespace(filePath) }));
  assert.equal(fired, firedBefore, 'disposed listeners must not fire again');
});
