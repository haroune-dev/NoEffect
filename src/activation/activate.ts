import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { contentHash } from '../utils/contentHash';
import { getSettings, onSettingsChanged, NoEffectSettings } from '../config/settings';
import { DecorationManager } from '../diagnostics/decorations';
import { SessionManager, WatchService, Debouncer } from '../services';
import { registerCommands } from './commands';
import { defaultOutcomeReporter } from './commands';
import { defaultLifecycle } from '../browser/lifecycleManager';
import { browserDetector } from '../environment/browserDetection';
import { companionCache } from '../cache/companionCache';
import { companionSettings } from '../services/companionSettings';
import {
  companionContextFingerprintFor,
  STALE_CONTEXT_FINGERPRINT,
} from '../engine/analysisContext';
import { EnvironmentReadiness } from '../environment/readiness';
import { ReadinessController, ReadinessHost, ReadinessSource } from './readinessController';
import { StatusBarController, StatusBarHost } from './statusBarController';
import { FirstRunAction, FirstRunCoordinator, FirstRunMessenger, FirstRunStore } from './firstRun';
import { COMMAND_IDS, FIRST_RUN_STATE_KEY } from './constants';
import { composeFirstRunMessage } from './firstRun';
import { createWorkspaceActions } from './firstRun';
import { OverrideJumpController } from './overrideJump';

/**
 * Push the configured `chromiumPath` into the persistent lifecycle so the
 * browser launcher can distinguish `chromium_missing` (auto-detect) from
 * `chromium_path_invalid` (misconfigured path) when launch fails. Invalidates
 * and lazily re-runs browser detection in the background so the next analysis
 * gate reads a fresh result without blocking the extension host.
 */
function applyChromiumPath(settings: NoEffectSettings): void {
  defaultLifecycle.setChromiumPath(settings.chromiumPath);
  browserDetector.invalidate();
  if (settings.enabled) {
    browserDetector.detect({ overridePath: settings.chromiumPath }).catch(() => {
      // Best-effort background re-detection; the analysis gate re-checks on
      // its own when a run actually needs the browser.
    });
  }
}

/**
 * Sync the companion-resolution config (Level 10) from settings and drop the
 * resolution cache: bounds and ignore globs shape the Phase-A scan, so a
 * settings change invalidates every cached resolution.
 */
function applyCompanionSettings(settings: NoEffectSettings): void {
  companionSettings.ignoredPatterns = settings.ignoredFiles;
  companionSettings.maxFileSizeBytes = settings.maxFileSizeKb * 1024;
  companionSettings.maxDepth = settings.companionSearchDepth;
  companionSettings.maxCandidates = settings.companionMaxCandidates;
  companionSettings.maxCompanions = settings.maxCompanions;
  companionCache.reset();
}

/**
 * The Phase 3 UI layer: status bar, readiness controller (context keys +
 * status + change logging) and the one-time first-run coordinator. All
 * vscode surfaces are adapted here; the logic lives in injectable modules.
 */
function createReadinessUi(
  context: vscode.ExtensionContext,
  onReadyTransition?: () => void
): {
  statusBar: StatusBarController;
  controller: ReadinessController;
  disposables: vscode.Disposable[];
} {
  const disposables: vscode.Disposable[] = [];

  // ── Status bar: one item, created once, right-aligned, priority 100. ──
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const statusBarHost: StatusBarHost = {
    text: '',
    tooltip: '',
    command: COMMAND_IDS.showStatus,
    show: () => statusBarItem.show(),
    hide: () => statusBarItem.hide(),
    dispose: () => statusBarItem.dispose(),
  };
  const statusBar = new StatusBarController(statusBarHost);

  // ── Readiness source: Phase 2 model + shared detector, single owner. ──
  const readinessModel = new EnvironmentReadiness({
    getSettings: () => getSettings(),
    getWorkspace: () => ({
      isTrusted: vscode.workspace.isTrusted,
      folders: (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
        scheme: folder.uri.scheme,
      })),
    }),
    detector: browserDetector,
  });
  const source: ReadinessSource = {
    evaluate: () => readinessModel.evaluate(),
    refresh: async () => {
      browserDetector.invalidate();
      return readinessModel.evaluate();
    },
  };

  const host: ReadinessHost = {
    setContext: (key, value) =>
      Promise.resolve(vscode.commands.executeCommand('setContext', key, value)),
    log: (level, line) => {
      if (level === 'debug') logger.debug(line);
      else if (level === 'warn') logger.warn(line);
      else logger.info(line);
    },
  };

  // ── First-run: one-time global-state welcome, quiet when disabled. ──
  const store: FirstRunStore = {
    hasCompleted: () => {
      try {
        return context.globalState.get<boolean>(FIRST_RUN_STATE_KEY, false);
      } catch {
        return false;
      }
    },
    markCompleted: () => {
      try {
        // Thenable (not Promise) — normalize before attaching the quiet
        // catch (P3-LOG-25): a failed write must never crash or re-notify;
        // the session guard still prevents any re-show this activation.
        void Promise.resolve(context.globalState.update(FIRST_RUN_STATE_KEY, true)).catch(() => {
          // Quiet failure — nothing to surface.
        });
      } catch {
        // Synchronous rejection path — same quiet policy.
      }
    },
  };

  const messenger: FirstRunMessenger = {
    async show(message, actions: FirstRunAction[]) {
      const titles = actions.map((action) => action.title);
      // VS Code flattens newlines and ignores `detail` for non-modal toasts,
      // so the title and body are composed into a single compact line.
      const picked = await vscode.window.showInformationMessage(
        composeFirstRunMessage(message),
        ...titles
      );
      const chosen = actions.find((action) => action.title === picked);
      if (chosen) {
        await chosen.run();
      }
    },
  };

  const runCommand = (id: string): Promise<void> =>
    Promise.resolve(vscode.commands.executeCommand(id)).then(() => undefined);

  const firstRunActions: Record<'ready' | 'setup' | 'workspace', FirstRunAction[]> = {
    ready: [
      {
        title: 'Analyze CSS',
        run: () => runCommand(COMMAND_IDS.analyzeCurrentFile),
      },
      {
        title: 'Show Status',
        run: () => runCommand(COMMAND_IDS.showStatus),
      },
    ],
    setup: [
      {
        title: 'Open Settings',
        run: () => runCommand('workbench.action.openSettings'),
      },
      {
        title: 'Diagnose Setup',
        run: () => runCommand(COMMAND_IDS.diagnoseSetup),
      },
      {
        title: 'Show Status',
        run: () => runCommand(COMMAND_IDS.showStatus),
      },
    ],
    // Untrusted/unsupported workspace: the PRIMARY action opens VS Code's
    // native Workspace Trust management; Diagnose Setup stays secondary.
    workspace: createWorkspaceActions(runCommand),
  };

  const firstRun = new FirstRunCoordinator(store, messenger, firstRunActions, () => {
    logger.info('[FirstRun] Welcome message shown');
  });

  // ── Controller: the single readiness consumer for UI state. ──
  const controller = new ReadinessController(
    source,
    host,
    statusBar,
    () => getSettings(),
    (snapshot) => {
      void firstRun.runOnce(getSettings().enabled, snapshot);
      // Phase 6 (F2): a blocked→ready transition re-evaluates the active
      // editor through the skip gate — environment-blocked runs were never
      // recorded, so the gate opens and the analysis is genuinely retried.
      if (snapshot !== null && snapshot.ready && snapshot.reason === 'ready') {
        onReadyTransition?.();
      }
    }
  );

  // React to settings and workspace-trust changes without heavy work.
  // NOTE: onDidGrantWorkspaceTrust is the ONLY trust event in the VS Code
  // API (there is no onDidChangeWorkspaceTrust). It covers the grant
  // direction; the untrusted direction needs no listener because granting
  // or revoking trust restarts the extension host, which re-runs the whole
  // activation flow (and with `capabilities.untrustedWorkspaces.supported:
  // true` the extension now actually activates in untrusted workspaces, so
  // the trust prompt is evaluated at activation time).
  disposables.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      logger.info('[Readiness] Workspace trust granted - refreshing');
      controller.scheduleRefresh();
    })
  );

  // Dev-only: re-show the welcome message on demand (hidden command, not in
  // the palette; bound to Ctrl+Alt+Shift+N via package.json keybindings).
  // Uses the last readiness snapshot, refreshing first when none exists.
  disposables.push(
    vscode.commands.registerCommand('noEffect.debugShowFirstRun', async () => {
      let snapshot = controller.getLast();
      if (snapshot === null) {
        snapshot = await controller.refreshNow({ timeoutMs: 5000 });
      }
      await firstRun.forceShow(getSettings().enabled, snapshot);
    })
  );

  // controller.dispose() tears down the status bar item as well.
  disposables.push({ dispose: () => controller.dispose() });

  return { statusBar, controller, disposables };
}

/**
 * Core activation logic for the NoEffect extension.
 *
 * Sets up all services, registers commands, and connects watchers.
 * Returns an array of Disposables for cleanup on deactivation.
 */
export function activateExtension(context: vscode.ExtensionContext): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];
  const settings = getSettings();

  logger.info('Activating NoEffect extension...');
  logger.info(`Settings: ${JSON.stringify(settings, null, 2)}`);

  // Phase 6 (F2): the single re-analysis trigger, assigned below after the
  // editor-evaluation machinery is wired. Declared early because the
  // companion watcher and the readiness UI subscribe to it first; the
  // placeholder is never reachable (subscriptions fire only on events,
  // which happen after activation completes synchronously).
  let triggerReanalysis: () => void = () => {
    logger.debug('[Orchestration] Re-analysis trigger not yet wired');
  };

  applyChromiumPath(settings);
  applyCompanionSettings(settings);

  // Companion resolution (Level 10): the search root of a CSS/HTML file is
  // its workspace folder (multi-root aware); without one the resolver falls
  // back to the bounded ancestor chain (LCA). File, workspace-folder and
  // settings changes invalidate the resolution cache.
  companionSettings.workspaceFolderProvider = (fsPath) =>
    vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath))?.uri.fsPath ?? null;

  // A CSS-file event must NOT reset the resolution cache: companions are
  // HTML documents that link the stylesheet, so a CSS create/change/delete
  // can never alter the ranked selection, and a stylesheet content change
  // is already captured by the cssGlobal content fingerprint. A reset here
  // would only poison the freshness probes with an artificial STALE context
  // right after a save, making the recorded (content, context, epoch)
  // outcome look unknown and clearing valid decorations for a moment.
  const companionWatcher = vscode.workspace.createFileSystemWatcher('**/*.{html,htm,css}');
  companionWatcher.onDidCreate((uri) => {
    if (isHtmlDocument(uri)) {
      companionCache.reset();
      triggerReanalysis();
    }
  });
  companionWatcher.onDidDelete((uri) => {
    if (isHtmlDocument(uri)) {
      companionCache.reset();
      triggerReanalysis();
    }
  });
  companionWatcher.onDidChange((uri) => {
    if (isHtmlDocument(uri)) {
      companionCache.reset();
      triggerReanalysis();
    }
  });
  disposables.push(companionWatcher);
  disposables.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      companionCache.reset();
      triggerReanalysis();
    })
  );

  // ── Phase 3 UI layer: status bar + readiness controller + first run. ──
  const readinessUi = createReadinessUi(context, () => triggerReanalysis());
  disposables.push(...readinessUi.disposables);

  // ── Initialize core services ──

  const decorationManager = new DecorationManager(context.extensionPath);
  decorationManager.createDecorationTypes(settings);
  disposables.push({ dispose: () => decorationManager.dispose() });

  const sessionManager = new SessionManager();
  disposables.push({ dispose: () => { sessionManager.dispose(); } });

  const watchService = new WatchService();
  disposables.push({ dispose: () => watchService.dispose() });

  const debouncer = new Debouncer(settings.debounceMs);
  disposables.push({ dispose: () => debouncer.dispose() });

  // ── Register commands ──

  const commandDisposables = registerCommands(
    context,
    decorationManager,
    sessionManager,
    readinessUi.controller,
    defaultOutcomeReporter((row) => readinessUi.statusBar.update(row))
  );
  disposables.push(...commandDisposables);

  // Commands were registered early; the readiness check itself is deferred
  // (controller.start() schedules it on a microtask), so activation stays fast.
  readinessUi.controller.start();

  // Decoration hovers are attached to text ranges. The warning icon is an
  // `after` attachment, so provide the same Markdown hover at the range end
  // to make hovering the icon reliable across VS Code editor renderers.
  // Embedded CSS (<style> blocks and style="" attributes) lives in HTML
  // documents, so the provider must cover both language IDs.
  const inlineIconHoverProvider = vscode.languages.registerHoverProvider(
    ['css', 'html'],
    {
      provideHover(document, position) {
        return decorationManager.provideInlineIconHover(document, position);
      },
    }
  );
  disposables.push(inlineIconHoverProvider);

  // ── Interactive override jump (hover command link) ──
  // The hover tooltip of an overridden declaration embeds a trusted
  // command link to `noEffect.jumpAndHighlight`. The controller owns the
  // single-flash AND single-badge invariants: one active highlight + one
  // transient `→|` winner gutter badge, both cleared on the next
  // selection change after the jump and on editor/document close or
  // change, so neither can ever linger as a ghost.
  const overrideJump = new OverrideJumpController(decorationManager);
  disposables.push(
    vscode.commands.registerCommand(COMMAND_IDS.jumpAndHighlight, (payload) =>
      overrideJump.handle(payload)
    ),
    vscode.window.onDidChangeActiveTextEditor(() => overrideJump.cancelTransientEffects()),
    vscode.workspace.onDidChangeTextDocument(() => overrideJump.cancelTransientEffects()),
    vscode.workspace.onDidCloseTextDocument(() => overrideJump.cancelTransientEffects()),
    { dispose: () => overrideJump.dispose() }
  );

  // ── Wire up file watchers ──

  watchService.onSave((uri) => {
    if (!getSettings().analyzeOnSave) {
      return;
    }

    // Trigger analysis command on save
    logger.debug(`File saved, triggering analysis: ${uri.fsPath}`);
    vscode.commands.executeCommand('noEffect.analyzeCurrentFile');
  });

  watchService.onChange((_uri) => {
    if (!getSettings().analyzeOnType) {
      return;
    }

    // Debounced analysis on text change
    debouncer.debounce(() => {
      vscode.commands.executeCommand('noEffect.analyzeCurrentFile');
    });
  });

  watchService.start();

  // ── React to settings changes ──

  const settingsWatcher = onSettingsChanged((newSettings: NoEffectSettings) => {
    logger.info('Settings changed, reconfiguring...');

    decorationManager.createDecorationTypes(newSettings);
    debouncer.setDelay(newSettings.debounceMs);
    applyChromiumPath(newSettings);
    applyCompanionSettings(newSettings);

    if (!newSettings.enabled) {
      decorationManager.clearAllDecorations();
      debouncer.cancel();
    }

    // Coalesced readiness refresh: status bar + context keys follow the new
    // configuration without heavy work and without duplicate first-run UI
    // (the first-run store guards that path).
    readinessUi.controller.scheduleRefresh();

    // Phase 6 (F2): a settings change re-evaluates the active editor
    // through the skip gate. Companion config lives in the context
    // fingerprint, so a maxCompanions/depth/candidates change with
    // unchanged CSS content still re-analyzes.
    triggerReanalysis();
  });
  disposables.push(settingsWatcher);

  // ── React to color-theme changes ──
  // The override-winner gutter badge ships light and dark SVG variants
  // because the decoration API has no themable `gutterIconPath`: the icon
  // is chosen from the active theme at type creation. A theme change must
  // therefore recreate the decoration types and re-apply the latest known
  // results, or every decoration would vanish until the next analysis.
  const themeWatcher = vscode.window.onDidChangeActiveColorTheme(() => {
    decorationManager.createDecorationTypes(getSettings());
    decorationManager.reapplyAllDecorations();
  });
  disposables.push(themeWatcher);

  // ── Analyze on open / active-editor change ──
  // Opening a supported file (or switching to it) must immediately reflect
  // the decorations, without requiring an edit. Re-apply the latest known
  // result for that file for instant feedback, then run a fresh analysis
  // unless this exact content was already analyzed. Rapid tab switches
  // collapse into a single analysis via a short dedicated debounce.

  const EDITOR_SWITCH_DEBOUNCE_MS = 350;

  function isSupportedFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return lower.endsWith('.css') || lower.endsWith('.html') || lower.endsWith('.htm');
  }

  function isHtmlDocument(uri: vscode.Uri): boolean {
    const lower = uri.fsPath.toLowerCase();
    return lower.endsWith('.html') || lower.endsWith('.htm');
  }

  /**
   * Phase 6 (F2): the fingerprint skip gate — a CSS file skips only when
   * its content fingerprint AND its analysis-context fingerprint (F1, from
   * the validated companion-cache snapshot) are unchanged; an HTML file
   * skips on its content fingerprint alone. A stale/unknown context never
   * skips (conservative: the run re-resolves and records a truthful
   * identity).
   */
  const canSkipReanalysis = (filePath: string, contentHashNow: string): boolean => {
    if (filePath.toLowerCase().endsWith('.css')) {
      const contextFingerprint = companionContextFingerprintFor(filePath);
      if (contextFingerprint === STALE_CONTEXT_FINGERPRINT) {
        return false;
      }
      return sessionManager.shouldSkipReanalysisWithContext(
        filePath,
        contentHashNow,
        contextFingerprint
      );
    }
    return sessionManager.shouldSkipReanalysisWithContext(filePath, contentHashNow, null);
  };

  const editorSwitchDebouncer = new Debouncer(EDITOR_SWITCH_DEBOUNCE_MS);
  disposables.push({ dispose: () => editorSwitchDebouncer.dispose() });

  const evaluateActiveEditor = () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !getSettings().enabled) {
      return;
    }
    const filePath = editor.document.uri.fsPath;
    if (!isSupportedFile(filePath)) {
      return;
    }

    // FRESHNESS FIRST — the single-authority rule: no CSS decoration may be
    // applied unless the stored global snapshot matches the CURRENT world
    // identity (live content hash, current analysis-context fingerprint,
    // current session epoch). The old flow applied the last stored result
    // and only then checked freshness, so a stale multi-companion outcome
    // (e.g. a companion changed since the last run) could be dimmed until
    // some later trigger rebuilt the global outcome. Probe the fresh
    // snapshot BEFORE applying: fresh → apply, anything else → clear.
    const contentHashNow = contentHash(editor.document.getText());
    if (filePath.toLowerCase().endsWith('.css')) {
      const contextFingerprint = companionContextFingerprintFor(filePath);
      const fresh =
        contextFingerprint !== STALE_CONTEXT_FINGERPRINT
          ? sessionManager.getFreshCssIssues(
              filePath,
              contentHashNow,
              contextFingerprint,
              defaultLifecycle.epoch
            )
          : undefined;
      if (fresh !== undefined) {
        decorationManager.applyDecorations(editor, fresh, true);
      }
      // When fresh is undefined (e.g. right after a save or edit while analysis is pending),
      // retain existing decorations so the dimmed state remains continuous and does not flicker.
      // Once the analysis completes, applyDecorations updates or removes decorations seamlessly.
    } else {
      // Instant feedback: re-apply only this file's own latest issues (a
      // per-file result, so switching between analyzed files never clears one
      // file's highlights with another file's result). HTML embedded outcomes
      // are keyed by (content, epoch) — the editor path for HTML keeps its
      // own identity scheme (a separate path by design).
      const known = sessionManager.getIssuesForFile(filePath);
      if (known) {
        decorationManager.applyDecorations(editor, known, true);
      }
    }

    if (canSkipReanalysis(filePath, contentHashNow)) {
      return;
    }

    editorSwitchDebouncer.debounce(() => {
      const current = vscode.window.activeTextEditor;
      if (!current || !getSettings().enabled || !isSupportedFile(current.document.uri.fsPath)) {
        return;
      }
      // Re-check at fire time: the editor or its content may have changed
      // during the debounce window.
      const currentHash = contentHash(current.document.getText());
      if (canSkipReanalysis(current.document.uri.fsPath, currentHash)) {
        return;
      }
      if (sessionManager.analysisInProgress) {
        // The completion listener below re-evaluates once the run finishes.
        return;
      }
      vscode.commands.executeCommand('noEffect.analyzeCurrentFile');
    });
  };

  // Phase 6 (F2): external triggers (companion-document create/change/
  // delete, settings changes, readiness transitions, workspace-folder
  // changes) all funnel through ONE 300ms-coalesced re-evaluation of the
  // active editor. The skip gate does the real work: an event that left
  // the content+context fingerprints unchanged is a no-op, so bursts are
  // cheap and never full-walk the workspace.
  const ORCHESTRATION_DEBOUNCE_MS = 300;
  const orchestrationDebouncer = new Debouncer(ORCHESTRATION_DEBOUNCE_MS);
  disposables.push({ dispose: () => orchestrationDebouncer.dispose() });
  triggerReanalysis = () => {
    if (!getSettings().enabled) {
      return;
    }
    orchestrationDebouncer.debounce(() => {
      evaluateActiveEditor();
    });
  };

  const editorWatcher = vscode.window.onDidChangeActiveTextEditor(evaluateActiveEditor);
  disposables.push(editorWatcher);

  // An open that triggered extension activation may predate the watcher,
  // so evaluate the already-active editor right away.
  evaluateActiveEditor();

  // An open/switch trigger may collide with an in-flight analysis (which
  // drops the request); re-evaluate once it completes. Self-limiting: the
  // skip check above prevents any redundant re-analysis. An unrecorded
  // (failed/cancelled/blocked) run never re-triggers here — that would
  // loop on persistent failures; the readiness transition and the next
  // real trigger retry those instead (F3).
  const analysisCompleteSubscription = sessionManager.onAnalysisComplete(() => {
    if (sessionManager.lastRunWasRecorded()) {
      evaluateActiveEditor();
    }
  });
  disposables.push(analysisCompleteSubscription);

  // ── Invalidate decorations when their document closes ──
  // Decorations are intentionally NOT cleared while the user edits: editor
  // decorations track the edited text (VS Code anchors their ranges), so
  // they persist without flickering until the next analysis result — a save,
  // a debounced type or a manual command — replaces them seamlessly, or
  // removes them only when the issue was actually resolved.
  const documentCloseWatcher = vscode.workspace.onDidCloseTextDocument((document) => {
    const filePath = document.uri.fsPath;
    if (decorationManager.hasDecorations(filePath)) {
      decorationManager.clearDecorationsForFile(filePath);
    }
  });
  disposables.push(documentCloseWatcher);

  logger.info('NoEffect extension activated successfully ✓');

  return disposables;
}
