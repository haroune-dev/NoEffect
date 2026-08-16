import * as vscode from 'vscode';
import * as path from 'path';
import { logger } from '../utils/logger';
import { getSettings } from '../config/settings';
import { DecorationManager } from '../diagnostics/decorations';
import { SessionManager } from '../services/sessionManager';
import { AnalysisRunner, RunRequest } from '../services/analysisRunner';
import { AnalysisNamespace, CssIssue } from '../models';
import { contentHash } from '../utils/contentHash';
import {
  companionContextFingerprintFor,
  STALE_CONTEXT_FINGERPRINT,
} from '../engine/analysisContext';
import { browserDetector } from '../environment/browserDetection';
import { classifyWorkspace } from '../environment/workspace';
import { evaluateFileEligibility } from '../environment/fileEligibility';
import { ReadinessController } from './readinessController';
import { buildStatusView, ReadinessFacts, UiSettings, ViewAction } from './statusViewModel';
import { collectDiagnoseReport } from './diagnoseSetup';
import { DrGroup } from '../session/report';
import { COMMAND_IDS, CONTEXT_KEYS, FIRST_RUN_STATE_KEY } from './constants';
import { AnalysisFailure, AnalysisOutcome } from '../failure/model';
import { classifyFailure } from '../failure/classifier';
import { deriveOutcome } from '../status/derive';
import { StatusPresentation } from './statusModel';
import { defaultLifecycle } from '../browser/lifecycleManager';
import { astCache } from '../cache/astCache';
import { fileHashCache } from '../cache/fileHashCache';
import { mappingCache } from '../cache/mappingCache';
import { htmlFragmentCache, embeddedParseCache, embeddedMappingCache } from '../cache/embeddedCssCache';
import { messageForFailure, NotificationDedupe, shouldNotify, ActionId } from '../session/notifications';

/** How the run lifecycle is surfaced to the status bar (single provider). */
export type OutcomeReporter = (outcome: AnalysisOutcome | null, opts?: { running?: boolean }) => void;

/** Standard reporter: derive the row from the outcome itself. */
export function defaultOutcomeReporter(update: (row: StatusPresentation) => void): OutcomeReporter {
  return (outcome, opts = {}) => {
    update(deriveOutcome(outcome, { running: opts.running ?? false }));
  };
}

/** Status markers per check (mirrors `renderReport` markers, text form). */
const CHECK_MARK: Readonly<Record<string, string>> = {
  ok: '[OK]',
  warn: '[WARN]',
  fail: '[FAIL]',
  skipped: '[SKIP]',
};

/** Flatten the structured report into lines for output + Quick Pick. */
function reportToLines(report: { hint: string; groups: DrGroup[] }): string[] {
  const lines: string[] = ['NoEffect setup diagnostics'];
  for (const group of report.groups) {
    lines.push(`── ${group.group} ──`);
    for (const result of group.checks) {
      const marker = CHECK_MARK[result.status] ?? '[OK]';
      const skip = result.status === 'skipped' && result.skipReason ? ` (${result.skipReason})` : '';
      const detail = result.status === 'ok' ? '' : ` — ${result.detail ?? ''}`;
      lines.push(`${marker} ${result.label}${skip}${detail}`);
    }
  }
  lines.push(`Hint: ${report.hint}`);
  return lines;
}

/**
 * Apply the analysis results to every visible editor that owns them.
 *
 * The triggering editor is always refreshed (cleared when the run produced
 * no issues for it). HTML-driven runs produce issues that map into the
 * linked stylesheets, so every visible editor owning such issues is dimmed
 * as well.
 */
function applyDecorationsToOwners(
  decorationManager: DecorationManager,
  editor: vscode.TextEditor,
  issues: CssIssue[]
): void {
  const issuesByFile = new Map<string, CssIssue[]>();
  for (const issue of issues) {
    const filePath = issue.location?.filePath;
    if (!filePath) {
      continue;
    }
    const list = issuesByFile.get(filePath) ?? [];
    list.push(issue);
    issuesByFile.set(filePath, list);
  }

  decorationManager.applyDecorations(editor, issues);

  for (const visible of vscode.window.visibleTextEditors) {
    const filePath = visible.document.uri.fsPath;
    if (filePath === editor.document.uri.fsPath) {
      continue;
    }
    const owned = issuesByFile.get(filePath);
    if (owned) {
      decorationManager.applyDecorations(visible, owned);
    }
  }
}

/**
 * F4 single-writer decoration application: refresh every visible CSS editor
 * from the cssGlobal namespace — FRESHNESS-AWARE. A visible CSS editor is
 * decorated only from the global outcome whose (content, analysis-context,
 * epoch) identity matches the CURRENT world; a stale or unknown outcome can
 * never reach the editor and is cleared instead. An HTML run decorates the
 * linked stylesheets exclusively through the fresh global outcome recorded
 * in the store — never through single-page issues emitted by the HTML flow
 * itself.
 *
 * Rule: no CSS decoration may be applied unless the global snapshot is
 * fresh against (current CSS content, current analysis context, current
 * session epoch).
 */
function applyCssGlobalDecorations(
  decorationManager: DecorationManager,
  sessionManager: SessionManager
): void {
  for (const visible of vscode.window.visibleTextEditors) {
    if (!visible.document.uri.fsPath.toLowerCase().endsWith('.css')) {
      continue;
    }
    const cssPath = visible.document.uri.fsPath;
    const contentFingerprint = contentHash(visible.document.getText());
    const contextFingerprint = companionContextFingerprintFor(cssPath);
    if (contextFingerprint !== STALE_CONTEXT_FINGERPRINT) {
      const fresh = sessionManager.getFreshCssIssues(
        cssPath,
        contentFingerprint,
        contextFingerprint,
        defaultLifecycle.epoch
      );
      if (fresh !== undefined) {
        decorationManager.applyDecorations(visible, fresh);
        logger.info(
          `[Result] cssGlobal ${cssPath}: ${fresh.length} dimmed — ` +
            (fresh.map((i) => i.selectorText).join(', ') || '(none)')
        );
        continue;
      }
    }
    // No fresh global outcome exists for the current world: a stale
    // outcome must not linger — the next analysis owns this surface.
    decorationManager.clearDecorationsForEditor(visible);
    logger.info(`[Result] cssGlobal ${cssPath}: cleared (no fresh outcome for the current world)`);
  }
}

/** The currently active analysis run (used to supersede stale runs). */
interface ActiveRun {
  id: number;
  cancel: () => void;
  settled: Promise<void>;
}

/**
 * Whether the current workspace cannot host a local browser analysis: any
 * workspace folder that is not a real local folder (virtual/remote/SSH).
 */
function workspaceIsUnsupported(): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.some((folder) => folder.uri.scheme !== 'file');
}

// ──────────────────────────────────────────────
// Session-failure notifications (Phase 5)
// ──────────────────────────────────────────────

const SESSION_ACTION_LABELS: Readonly<Record<ActionId, string>> = {
  openSettings: 'Open Settings',
  diagnoseSetup: 'Diagnose Setup',
  restartSession: 'Restart Session',
  showOutput: 'Show Output',
  retry: 'Retry',
};

/** Run one suggested action from a failure message. */
function runSessionAction(actionId: ActionId): Promise<void> {
  switch (actionId) {
    case 'openSettings':
      return Promise.resolve(vscode.commands.executeCommand('workbench.action.openSettings')).then(() => undefined);
    case 'diagnoseSetup':
      return Promise.resolve(vscode.commands.executeCommand(COMMAND_IDS.diagnoseSetup)).then(() => undefined);
    case 'restartSession':
      return Promise.resolve(vscode.commands.executeCommand(COMMAND_IDS.restartAnalysisSession)).then(() => undefined);
    case 'showOutput':
      logger.show();
      return Promise.resolve();
    case 'retry':
      return Promise.resolve(vscode.commands.executeCommand(COMMAND_IDS.analyzeCurrentFile)).then(() => undefined);
  }
}

/**
 * Present one failure as a VS Code error notification. Fire-and-forget (the
 * caller decided the failure deserves a notification); a pick runs the
 * chosen action. Dedupe lives in the caller via `NotificationDedupe`.
 */
function notifyFailure(failure: AnalysisFailure): void {
  const message = messageForFailure(failure);
  const titles = message.actions.map((action) => SESSION_ACTION_LABELS[action]);
  void Promise.resolve(vscode.window.showErrorMessage(message.message, ...titles))
    .then((picked) => {
      if (picked) {
        const index = titles.indexOf(picked);
        const action = message.actions[index];
        if (action) {
          void runSessionAction(action);
        }
      }
    })
    .catch(() => {
      // A notification failing to show must never break the extension.
    });
}

export function registerCommands(
  context: vscode.ExtensionContext,
  decorationManager: DecorationManager,
  sessionManager: SessionManager,
  readinessController: ReadinessController,
  reportOutcome?: OutcomeReporter
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // ── Session-failure notifications (Phase 5) ────────────────────────────
  // The lifecycle reports crash/CDP-loss events as classifyable failures.
  // Only failures blocking an explicitly-requested analysis (a manual run
  // in flight) may notify — routine recovery is status + output only. One
  // notification per code per session epoch; the epoch in the dedupe key
  // resets the policy naturally after a restart.
  const notificationDedupe = new NotificationDedupe();
  const sessionFailureSubscription = defaultLifecycle.onSessionFailure((failure) => {
    if (!shouldNotify(failure, activeRun !== null)) {
      return;
    }
    if (!notificationDedupe.shouldSend(failure.code, String(defaultLifecycle.epoch))) {
      return;
    }
    notifyFailure(failure);
  });
  disposables.push({ dispose: () => sessionFailureSubscription.dispose() });

  // ──────────────────────────────────────────────
  // Command: Analyze CSS Inactive Properties
  // ──────────────────────────────────────────────

  // A newer trigger supersedes the in-flight run by cancelling it and
  // waiting for it to release the analysis gate, so rapid triggers never
  // race each other and never leave stale decorations behind.
  let activeRun: ActiveRun | null = null;
  let runSequence = 0;

  disposables.push(
    vscode.commands.registerCommand('noEffect.analyzeCurrentFile', async () => {
      const settings = getSettings();

      if (!settings.enabled) {
        logger.info('Extension is disabled — skipping analysis');
        return;
      }

      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        logger.warn('No active editor — nothing to analyze');
        return;
      }

      const filePath = editor.document.uri.fsPath;
      logger.info(`Manual analysis triggered for: ${filePath}`);

      if (activeRun) {
        activeRun.cancel();
        await activeRun.settled;
      }
      if (!sessionManager.beginAnalysis()) {
        return; // A foreign run still holds the gate — drop this trigger.
      }

      const startTime = Date.now();
      const source = new vscode.CancellationTokenSource();
      const id = ++runSequence;

      const runner = new AnalysisRunner({ globalStore: sessionManager });
      const request: RunRequest = {
        filePath,
        extension: path.extname(filePath).toLowerCase(),
        isDirty: editor.document.isDirty,
        workspaceUntrusted: !vscode.workspace.isTrusted,
        workspaceUnsupported: workspaceIsUnsupported(),
        scheme: editor.document.uri.scheme,
        sizeBytes: editor.document.getText().length,
        chromiumPath: settings.chromiumPath,
        ignoredPatterns: settings.ignoredFiles,
        maxFileSizeBytes: settings.maxFileSizeKb * 1024,
      };

      const promise = runner.run(request, startTime, source.token);
      activeRun = {
        id,
        cancel: () => source.cancel(),
        settled: promise.then(
          () => undefined,
          () => undefined
        ),
      };
      reportOutcome?.(null, { running: true });

      const { outcome, issues } = await promise;

      // Only the newest run may own `activeRun`: a superseded run that
      // settles later must never clobber the newer run's slot.
      if (activeRun?.id === id) {
        activeRun = null;
      }

      if (outcome.status === 'cancelled') {
        sessionManager.completeAnalysisCancelled();
        return; // The superseding run owns the next decoration update.
      }

      // Phase 5: a result produced against a session that was rebuilt while
      // the run was in flight (crash + recovery bumped the epoch) carries a
      // stale epoch — drop it before it can touch any UI surface.
      if (outcome.epoch !== undefined && outcome.epoch !== defaultLifecycle.epoch) {
        outcome.stale = true;
        logger.info(
          `[Lifecycle] Analysis result dropped for ${filePath}: ` +
            `epoch ${outcome.epoch} superseded by ${defaultLifecycle.epoch}`
        );
      }

      reportOutcome?.(outcome, {});
      lastOutcome = outcome;

      const analyzedHash = contentHash(editor.document.getText());
      const succeeded = outcome.status === 'success' || outcome.status === 'partial';
      const isCss = filePath.toLowerCase().endsWith('.css');
      // INCOMPLETE-EVIDENCE GUARD: a CSS run whose companion coverage is
      // incomplete (any selected companion pass failed, even after retries)
      // must never APPLY or RECORD a dimming verdict — its merged ⊥ could
      // be masking an A on the failed page (the `.active-somewhere` case).
      // The analyzer already emits NO issues for such runs; here we also
      // refuse to record the skip identity or the cssGlobal namespace, so
      // the next trigger genuinely re-attempts the failed companion(s).
      const cssEvidenceIncomplete =
        isCss && (outcome.coverage?.companions?.failed?.length ?? 0) > 0;
      const complete = succeeded && !cssEvidenceIncomplete;

      // Phase 6 (F5): the run declares EXACTLY ONE namespace — the global
      // multi-companion outcome for CSS files, the page-local embedded
      // outcome for HTML files — keyed by the content fingerprint (and, for
      // CSS, the analysis-context fingerprint) of what was judged against.
      // The epoch is the session epoch the run produced against: a result
      // from a superseded session carries a different epoch, so the
      // namespace entry never matches a fresh (content, context) probe.
      //
      // Phase 6 (transactional identity): for CSS, the context fingerprint
      // is the one the run ACTUALLY analyzed against, as stated by the
      // analyzer (`getLastContextFingerprint`) — the fingerprint computed
      // from the resolved snapshot at run time, never recomputed after the
      // run. A mid-run companion change therefore can never register this
      // result under a context that was not the one analyzed against.
      const runContextFingerprint = isCss ? runner.getLastContextFingerprint() : null;
      let namespace: AnalysisNamespace | undefined;
      if (isCss && complete) {
        if (runContextFingerprint !== null) {
          namespace = {
            kind: 'cssGlobal',
            cssPath: filePath,
            contentFingerprint: analyzedHash,
            contextFingerprint: runContextFingerprint,
            epoch: outcome.epoch ?? defaultLifecycle.epoch,
          };
        }
      } else if (!isCss && complete) {
        namespace = {
          kind: 'htmlEmbedded',
          htmlPath: filePath,
          contentFingerprint: analyzedHash,
          epoch: outcome.epoch ?? defaultLifecycle.epoch,
        };
      }

      sessionManager.completeAnalysis({
        success: succeeded,
        issues,
        timestamp: Date.now(),
        durationMs: Date.now() - startTime,
        htmlFilePath: '',
        cssFilePaths: [filePath],
        error: succeeded
          ? undefined
          : outcome.errors[0]?.message ?? 'The analysis could not be completed',
        outcome,
        namespace,
      });

      // Phase 6 (F3/RC2): only a SUCCESSFUL or PARTIAL run is recorded —
      // failed, cancelled and blocked runs are never marked "handled", so
      // the next trigger genuinely re-attempts them (the readiness
      // transition re-triggers environment-blocked runs; file events
      // re-trigger content changes). The recorded identity is the content
      // fingerprint AND the analysis-context fingerprint: a companion
      // create/change/delete with identical CSS content still re-analyzes.
      // The identity is the run's own fingerprint (transactional) — a run
      // without a companion context records nothing, so the next trigger
      // re-resolves and records a truthful identity.
      if (complete) {
        const contextFingerprint = isCss ? runContextFingerprint : null;
        if (!isCss || contextFingerprint !== null) {
          sessionManager.recordSuccessfulAnalysis(filePath, analyzedHash, contextFingerprint);
        }
      }

      if (outcome.stale) {
        // A stale-session result must not touch decorations: the current
        // session's run owns that surface.
        logger.debug('[Result] Skipping decoration update for the stale-session result');
      } else if (complete) {
        // applyDecorations clears the editor when there are no relevant
        // issues, so a zero-issue result never leaves stale decorations.
        // The dimmed-selector list is a stable, observable result record:
        // the smoke suite asserts the CORRECTNESS of what was applied from
        // it (e.g. a merged-active declaration must never be listed).
        logger.info(
          `[Result] ${filePath}: ${issues.length} dimmed — ` +
            (issues.map((i) => i.selectorText).join(', ') || '(none)')
        );
        applyDecorationsToOwners(decorationManager, editor, issues);
        // F4: linked-stylesheet decorations come from the cssGlobal
        // namespace only (an HTML run ensured/reused the fresh global
        // outcomes inside the analyzer; a CSS run recorded its own).
        applyCssGlobalDecorations(decorationManager, sessionManager);
      } else {
        // A failed/skipped analysis must not leave stale decorations behind.
        decorationManager.clearDecorationsForEditor(editor);
      }
    })
  );

  // ──────────────────────────────────────────────
  // Command: Clear All Highlights
  // ──────────────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand('noEffect.clearDecorations', () => {
      decorationManager.clearAllDecorations();
      logger.info('All decorations cleared by user command');
    })
  );

  // ──────────────────────────────────────────────
  // Command: Restart Analysis Session
  // ──────────────────────────────────────────────
  // Single-flight inside the lifecycle: concurrent triggers share one
  // rebuild. A failure is classified centrally and, since this is an
  // explicitly-requested command, may notify (deduped per code).
  disposables.push(
    vscode.commands.registerCommand(COMMAND_IDS.restartAnalysisSession, async () => {
      const startTime = Date.now();
      try {
        await defaultLifecycle.restartAnalysisSession();
        notificationDedupe.reset();
        logger.info(`[Lifecycle] Session restarted (${Date.now() - startTime}ms)`);
        await vscode.window.showInformationMessage('NoEffect analysis session restarted.');
      } catch (err) {
        const failure = classifyFailure(err, {
          chromiumPath: getSettings().chromiumPath,
          context: { op: 'restart' },
        });
        logger.error(`[${failure.code}] ${failure.message}`);
        if (shouldNotify(failure, true) && notificationDedupe.shouldSend(failure.code, String(defaultLifecycle.epoch))) {
          notifyFailure(failure);
        }
      }
    })
  );

  // ──────────────────────────────────────────────
  // Command: Clear Cache
  // ──────────────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand(COMMAND_IDS.clearCache, () => {
      astCache.reset();
      mappingCache.reset();
      fileHashCache.reset();
      htmlFragmentCache.reset();
      embeddedParseCache.reset();
      embeddedMappingCache.reset();
      decorationManager.clearAllDecorations();
      logger.info('[Cache] Caches and decorations cleared by user command');
      void vscode.window.showInformationMessage('NoEffect caches cleared.');
    })
  );

  // ──────────────────────────────────────────────
  // Show Status (Quick Pick over the status view model)
  // ──────────────────────────────────────────────

  /** The most recent analysis outcome, surfaced in the Show Status view. */
  let lastOutcome: AnalysisOutcome | null = null;

  /** Assemble the facts the Phase 3 view models are built from. */
  const collectFacts = (): ReadinessFacts => {
    const settings = getSettings();
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      scheme: folder.uri.scheme,
    }));
    const workspaceKind = classifyWorkspace(folders);
    const detection = browserDetector.getCachedResult();

    let currentFile: ReadinessFacts['currentFile'];
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const eligibility = evaluateFileEligibility({
        filePath: editor.document.uri.fsPath,
        extension: path.extname(editor.document.uri.fsPath).toLowerCase(),
        scheme: editor.document.uri.scheme,
        sizeBytes: editor.document.getText().length,
        maxFileSizeBytes: settings.maxFileSizeKb * 1024,
        ignoredPatterns: settings.ignoredFiles,
      });
      currentFile = {
        fileName: path.basename(editor.document.uri.fsPath),
        eligible: eligibility.eligible,
        reasonText: eligibility.reason,
      };
    }

    let firstRunCompleted = false;
    try {
      firstRunCompleted = context.globalState.get<boolean>(FIRST_RUN_STATE_KEY, false);
    } catch {
      // Unreadable state must never break the status command.
    }

    return {
      settings: {
        enabled: settings.enabled,
        analyzeOnSave: settings.analyzeOnSave,
        analyzeOnType: settings.analyzeOnType,
        chromiumPath: settings.chromiumPath,
        ignoredFiles: settings.ignoredFiles,
        maxFileSizeKb: settings.maxFileSizeKb,
      },
      readiness: readinessController.getLast(),
      workspace: { isTrusted: vscode.workspace.isTrusted, kind: workspaceKind },
      detection,
      firstRunCompleted,
      extensionVersion: context.extension.packageJSON.version as string | undefined,
      currentFile,
      outcome: lastOutcome,
      session: defaultLifecycle.getHealth(),
    };
  };

  disposables.push(
    vscode.commands.registerCommand(COMMAND_IDS.showStatus, async () => {
      const view = buildStatusView(collectFacts());

      // Present as Quick Pick items; each line is a selection, actions run on
      // choice via the "Actions" section below. Cancelling (Escape) is fine.
      const items = [
        ...view.lines.map((line) => ({
          label: line.label,
          detail: line.detail,
          action: undefined as ViewAction | undefined,
        })),
        ...view.actions.map((action) => ({
          label: action.title,
          detail: action.detail,
          action: action as ViewAction,
        })),
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: view.heading,
        placeHolder: 'NoEffect status — choose an action, or Escape to close',
        ignoreFocusOut: true,
      });
      if (picked?.action) {
        await vscode.commands.executeCommand(picked.action.command, ...(picked.action.args ?? []));
      }
    })
  );

  // ──────────────────────────────────────────────
  // Diagnose Setup
  // ──────────────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand(COMMAND_IDS.diagnoseSetup, async (opts?: { liveProbe?: boolean }) => {
      // A live probe is ONLY performed when the user explicitly picks it —
      // plain Diagnose Setup never launches a browser on its own.
      let probe: { ok: boolean; detail?: string } | null = null;
      if (opts?.liveProbe) {
        logger.show();
        logger.info('─── NoEffect Live Browser Probe ───');
        try {
          await defaultLifecycle.restartAnalysisSession();
          probe = { ok: true };
        } catch (err) {
          const failure = classifyFailure(err, {
            chromiumPath: getSettings().chromiumPath,
            context: { op: 'diagnose' },
          });
          probe = { ok: false, detail: `[${failure.code}] ${failure.message}` };
        }
      }

      const report = collectDiagnoseReport(collectFacts(), defaultLifecycle.getHealth(), probe);
      const lines = reportToLines(report);

      logger.show();
      logger.info('─── NoEffect Diagnostics ───');
      for (const line of lines) {
        logger.info(line);
      }

      const items = lines.map((line) => ({ label: line }));
      items.push({ label: '▶ Run Live Browser Probe' });
      const picked = await vscode.window.showQuickPick(items, {
        title: 'NoEffect Setup Diagnostics',
        placeHolder: 'Environment summary — full detail is in the output channel',
        ignoreFocusOut: true,
      });
      if (picked?.label.startsWith('▶')) {
        await vscode.commands.executeCommand(COMMAND_IDS.diagnoseSetup, { liveProbe: true });
      }
    })
  );

  // ──────────────────────────────────────────────
  // Show Output Logs
  // ──────────────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand('noEffect.showOutputLogs', () => {
      logger.show();
    })
  );

  return disposables;
}
