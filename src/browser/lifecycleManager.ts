/**
 * Persistent analysis-session lifecycle (performance PR + Phase 5).
 *
 * Owns every long-lived resource of the CDP pipeline and keeps them alive
 * across analyses:
 *   - one DevServer (re-rooted, never restarted),
 *   - one Chromium process,
 *   - one CDP WebSocket (reconnected + domains restored after a loss),
 *   - one analysis page (navigated/reloaded only when actually needed).
 *
 * Phase 5 (recovery, retry and session health):
 *   - the session runs on the `SessionHealth` state machine (states,
 *     transition arcs, counters and epoch) — the single source of truth the
 *     status bar / Show Status / Diagnose layers read,
 *   - every asynchronous operation is bounded by the typed retry/timeout
 *     policy table (`src/session/policy.ts`) — no unbounded awaits,
 *   - every fresh physical session (cold start AND recovery) bumps the
 *     session epoch; analyses tagged against a superseded epoch are dropped
 *     by the command layer,
 *   - restart/recovery is single-flight (one in-flight rebuild; concurrent
 *     requests join it instead of racing),
 *   - a browser exit or CDP loss marks the session dead/degraded and emits a
 *     classifyable `AnalysisFailure`; `dispose()` is bounded and always
 *     releases the temp profile, the port and the process tree.
 *
 * Recovery is transparent: a browser exit or WebSocket close degrades the
 * session; the next analysis detects it and — per the retry policy —
 * relaunches the browser, reconnects CDP, restores the enabled domains and
 * re-loads the page. Nothing else ever tears the session down — only
 * `dispose()` does (extension deactivation) or a deliberate command
 * (`Restart Analysis Session`).
 *
 * State logs are concise per the performance-PR contract:
 *   [Lifecycle] DevServer started / Chromium launched / CDP connected /
 *   Analysis page ready / Reusing Chromium / Reusing CDP session /
 *   Reusing DevServer / Reusing analysis page / Chromium exited /
 *   Restarting browser / CDP restored
 */

import * as http from 'http';
import { logger } from '../utils/logger';
import { BrowserRunner } from './browserRunner';
import { CdpClient } from './cdpClient';
import { DevServer } from './devServer';
import { PageLoadError } from '../failure/errors';
import { browserDetector } from '../environment/browserDetection';
import { SessionHealth } from '../session/health';
import { RETRY_POLICY, backoffFor } from '../session/policy';
import { withTimeout } from '../session/timing';
import { classifyFailure } from '../failure/classifier';
import { BrowserLaunchError, CdpDisconnectedError } from '../failure/errors';
import { AnalysisFailure } from '../failure/model';

export interface LifecycleStats {
  chromiumLaunches: number;
  devServerStarts: number;
  cdpConnects: number;
  cdpReconnects: number;
  pageNavigations: number;
  pageReloads: number;
  pageReuses: number;
}

export interface PreparedSession {
  /** The connected CDP client (domains enabled, page at the fixture URL). */
  cdp: CdpClient;

  /** Port of the persistent DevServer (stable across analyses). */
  port: number;

  /**
   * True when the underlying page navigation hit its load timeout and the
   * analysis proceeds anyway (a recoverable, warning-level condition).
   */
  pageLoadTimedOut?: boolean;

  /**
   * The session epoch of this prepared run. Results tagged with an older
   * epoch are stale once a restart/recovery bumped the session identity.
   */
  epoch: number;
}

/** Session-failure listener (wired by the command layer for notifications). */
export type SessionFailureListener = (failure: AnalysisFailure) => void;

export class LifecycleManager {
  private readonly runner = new BrowserRunner();
  private readonly cdp = new CdpClient();
  private readonly server = new DevServer();
  private readonly health = new SessionHealth();

  private root: string | null = null;
  private pageUrl: string | null = null;
  private pageLoaded: boolean = false;
  private restarting: Promise<void> | null = null;

  /**
   * The Chromium executable to launch ('' = auto-detect). Set from settings
   * at activation so the analyzer respects `noEffect.chromiumPath` and so a
   * bad configured path is truthfully classified as CHROMIUM_PATH_INVALID.
   */
  private chromiumPath: string = '';

  private readonly stats: LifecycleStats = {
    chromiumLaunches: 0,
    devServerStarts: 0,
    cdpConnects: 0,
    cdpReconnects: 0,
    pageNavigations: 0,
    pageReloads: 0,
    pageReuses: 0,
  };

  constructor() {
    this.runner.onExit((code, expected) => {
      if (expected) {
        logger.info(`[Lifecycle] Session shutdown complete (exit code ${code})`);
        return;
      }
      // An unexpected browser exit is a crash: mark the session dead and
      // emit a classifyable failure (notification/readiness layer decides
      // how loudly to surface it). The machine's `dead` state means the
      // next `prepare` lazily re-initializes.
      logger.info(`[Lifecycle] Chromium exited unexpectedly (code ${code})`);
      this.health.markTransition('dead', 'crash.browser_exit');
      this.pageLoaded = false;
      this.pageUrl = null;
      this.notifyFailure(classifyFailure(new BrowserLaunchError(`Chromium exited unexpectedly (code ${code})`)));
    });

    this.cdp.onConnectionClosed(() => {
      // The CDP session was lost while it was live. Guard arcs: this can
      // fire mid-recovery (already `recovering`/`starting`), where it is a
      // no-op via the state machine. Session loss is routine / self-healing
      logger.info('[Lifecycle] CDP session lost — recovering on the next analysis');
      if (this.health.state === 'ready') {
        this.health.markTransition('degraded', 'cdp.session_lost');
      }
      this.pageLoaded = false;
      this.pageUrl = null;
      this.notifyFailure(classifyFailure(new CdpDisconnectedError()));
    });
  }

  /**
   * Current lifecycle counters. Used by integration tests to prove that a
   * browser/server/CDP session is started once and reused afterwards.
   */
  getStats(): LifecycleStats {
    return { ...this.stats };
  }

  /** The DevServer port once the session is ready (0 before the first run). */
  get port(): number {
    return this.server.port;
  }

  /** The live session-health snapshot (state, epoch, counters). */
  getHealth() {
    return this.health.snapshot();
  }

  /** The current session epoch (bumps on every fresh session rebuild). */
  get epoch(): number {
    return this.health.epoch;
  }

  /** Whether a live browser + CDP session is currently available. */
  get isHealthy(): boolean {
    return this.health.state === 'ready' && this.runner.isRunning && this.cdp.isConnected;
  }

  /** Test/health hook: the underlying browser runner. */
  getRunner(): BrowserRunner {
    return this.runner;
  }

  /** Test/health hook: the live CDP client of the persistent session. */
  getCdp(): CdpClient {
    return this.cdp;
  }

  /** Register a listener for session failures (crash, CDP loss). */
  onSessionFailure(listener: SessionFailureListener): { dispose(): void } {
    this.failureListeners.push(listener);
    return {
      dispose: () => {
        const index = this.failureListeners.indexOf(listener);
        if (index >= 0) this.failureListeners.splice(index, 1);
      },
    };
  }

  /**
   * The executable to launch: the configured `chromiumPath` when set, the
   * detector's found browser when known, else the classic PATH default.
   */
  private resolveExecutable(): string {
    if (this.chromiumPath) {
      return this.chromiumPath;
    }
    const detection = browserDetector.getCachedResult();
    if (detection.status === 'found' && detection.executablePath) {
      return detection.executablePath;
    }
    return 'google-chrome';
  }

  /**
   * Set the Chromium executable to launch on the next cold start / recovery
   * ('' = auto-detect). Applied from settings during extension activation.
   */
  setChromiumPath(chromiumPath: string): void {
    this.chromiumPath = chromiumPath;
  }

  /**
   * Register an in-memory page on the persistent DevServer (used for the
   * generated analysis wrapper of a standalone CSS file).
   */
  setVirtualFile(name: string, content: string): void {
    this.server.setVirtualFile(name, content);
  }

  /**
   * Prepare the persistent session for an analysis of `fixturePath`.
   *
   * `targetUrl` is the page to analyze (defaults to `/index.html`). For a
   * standalone CSS file this is the in-memory analysis wrapper; for an HTML
   * file it is the file's own URL.
   *
   * A session that is not fully healthy (cold, dead after a crash, degraded
   * after a CDP loss) is rebuilt single-flight before the request proceeds.
   * Smart refresh: the page is only navigated/reloaded when something that
   * affects what the browser sees actually changed — the fixture root moved,
   * the target URL changed, the CSS content changed (caller signals via
   * `forceRefresh`), or the page is not loaded yet. Identical inputs reuse
   * everything: `[Lifecycle] Reusing ...` for server, browser, CDP and page.
   */
  async prepare(
    fixturePath: string,
    targetUrl: string | null,
    forceRefresh: boolean
  ): Promise<PreparedSession> {
    if (this.health.state === 'disposing') {
      throw new Error('The analysis session is shutting down');
    }

    if (this.isHealthy) {
      logger.info('[Lifecycle] Reusing DevServer');
      logger.info('[Lifecycle] Reusing Chromium');
      logger.info('[Lifecycle] Reusing CDP session');
    } else {
      // Cold start, or the session was left degraded/dead by a crash or a
      // CDP loss — rebuild single-flight (concurrent requests share it).
      await this.restartAnalysisSession();
    }

    // The DevServer is started once and re-rooted afterwards; a defensive
    // restart here only covers the pathological case of it being gone.
    if (!this.server.isRunning) {
      logger.info('[Lifecycle] DevServer started');
      await this.server.start(this.root ?? fixturePath);
      this.stats.devServerStarts++;
    }

    const rootChanged = this.root !== fixturePath;
    if (rootChanged) {
      this.server.setRoot(fixturePath);
      this.root = fixturePath;
    }

    const url = `http://127.0.0.1:${this.server.port}${targetUrl ?? '/index.html'}`;
    const refresh = forceRefresh || rootChanged || !this.pageLoaded || this.pageUrl !== url;

    let pageLoadTimedOut = false;
    if (this.pageLoaded && !refresh && this.pageUrl === url) {
      logger.info('[Lifecycle] Reusing analysis page');
      this.stats.pageReuses++;
    } else if (!this.pageLoaded) {
      pageLoadTimedOut = await this.navigateTo(url, false);
    } else if (refresh && this.pageUrl === url) {
      pageLoadTimedOut = await this.navigateTo(url, true);
    } else {
      pageLoadTimedOut = await this.navigateTo(url, false);
    }

    this.pageUrl = url;
    this.pageLoaded = true;

    return { cdp: this.cdp, port: this.server.port, pageLoadTimedOut, epoch: this.health.epoch };
  }

  /**
   * Deliberate session rebirth: mark degrading/starting, tear down any live
   * resources, then cold-start cleanly. Single-flight — concurrent callers
   * share the one in-flight rebuild instead of racing it. Every fresh
   * physical session bumps the epoch.
   */
  async restartAnalysisSession(): Promise<void> {
    if (this.health.state === 'disposing') {
      throw new Error('The analysis session is shutting down');
    }
    if (!this.restarting) {
      this.restarting = this.restartNow().finally(() => {
        this.restarting = null;
      });
    }
    return this.restarting;
  }

  /** Recover from a lost browser/CDP session (same path as restart). */
  async recover(): Promise<void> {
    await this.restartAnalysisSession();
  }

  private async restartNow(): Promise<void> {
    // The state machine guards the arcs: from `ready` a deliberate restart
    // goes through `recovering`; a degraded session `recovering`; a dead or
    // never-started session starts fresh via `starting`.
    const now = this.health.state;
    if (now === 'ready') {
      this.health.markTransition('recovering', 'restart.requested');
    } else if (now === 'degraded') {
      this.health.markTransition('recovering', 'recover.cdp_lost');
    } else {
      this.health.markTransition('starting', now === 'none' ? 'session.start' : 'restart.recovery');
    }

    try {
      // The cold rebuild (launch + CDP connect + domain setup) is budgeted
      // by session_build — the SUM of its phases — never by a cleanup cap:
      // a cap shorter than the browser's cold start made every first
      // analysis fail its passes with "Session rebuild timed out".
      await withTimeout(
        this.restore(),
        RETRY_POLICY.session_build.timeoutMs,
        'Session rebuild timed out'
      );
      this.health.markTransition('ready', 'session.ready');
      logger.info('[Lifecycle] CDP restored');
    } catch (err) {
      // A failed rebuild leaves no zombie browser behind (restore cleans up
      // on failure); the machine parks in `dead` so the next request retries
      // lazily. The error propagates for central classification.
      this.health.markTransition('dead', 'restart.failed');
      throw err;
    }
  }

  /**
   * Build a fresh physical session: bump the epoch, launch the browser (with
   * the browser_launch retry policy), connect CDP over WebSocket (with the
   * cdp_connect retry policy) and enable the domains. On any failure the
   * partially-opened resources are cleaned up so nothing is left running.
   */
  private async restore(): Promise<void> {
    this.health.bumpEpoch();

    try {
      await this.cdp.disconnect();
    } catch {
      // The session is already gone — nothing to disconnect.
    }
    await this.runner.shutdown();

    logger.info('[Lifecycle] Chromium launched');
    const executable = this.resolveExecutable();

    // Launch with the browser_launch policy: 1 retry, bounded timeout.
    let wsUrl: string | null = null;
    let cause: unknown = null;
    for (let attempt = 0; attempt <= RETRY_POLICY.browser_launch.maxRetries; attempt++) {
      if (attempt > 0) {
        logger.warn(`[Lifecycle] Retrying browser launch (attempt ${attempt + 1})`);
        await sleepBackoff(attempt);
      }
      try {
        wsUrl = await this.runner.launch(executable);
        break;
      } catch (err) {
        cause = err;
      }
    }
    if (!wsUrl) {
      await this.runner.shutdown();
      throw cause ?? new Error('Browser launch failed');
    }
    this.stats.chromiumLaunches++;

    // A real, successful launch confirms the environment: future reads of
    // the readiness layer and the runner's browser gate reuse this fact.
    browserDetector.recordFound(executable, this.chromiumPath ? 'configured_override' : 'auto_detect');

    const pageTarget = await this.fetchPageTarget(wsUrl);

    // Connect with the cdp_connect policy: 2 retries, bounded per attempt.
    let connected = false;
    let cdpCause: unknown = null;
    for (let attempt = 0; attempt <= RETRY_POLICY.cdp_connect.maxRetries; attempt++) {
      if (attempt > 0) {
        logger.warn(`[Lifecycle] Retrying CDP connect (attempt ${attempt + 1})`);
        await sleepBackoff(attempt);
      }
      try {
        await withTimeout(
          this.cdp.connect(pageTarget.webSocketDebuggerUrl),
          RETRY_POLICY.cdp_connect.timeoutMs,
          'Timed out connecting to CDP'
        );
        connected = true;
        break;
      } catch (err) {
        cdpCause = err;
      }
    }
    if (!connected) {
      await this.runner.shutdown();
      throw cdpCause ?? new Error('CDP connect failed');
    }
    this.stats.cdpConnects++;
    this.stats.cdpReconnects++;

    await this.enableDomains();

    this.pageLoaded = false;
    this.pageUrl = null;
  }

  /**
   * Tear down every resource. Called only from extension deactivation and
   * from the explicit Restart command — never from the analysis flow.
   * Bounded by the restart_cleanup policy; graceful close is honored via
   * `shutdown()`'s SIGTERM/SIGKILL escalation and the DevServer socket
   * teardown; the temp profile is removed (or swept later by the stale
   * sweep).
   */
  async dispose(): Promise<void> {
    if (this.health.state === 'disposing' || this.health.state === 'none') {
      // Idempotent: a dignosed session stays disposed; repeated disposes
      // (deactivation + explicit clear) are harmless no-ops.
      return;
    }
    this.health.markTransition('disposing', 'dispose.requested');
    try {
      await withTimeout(
        this.disposeNow(),
        RETRY_POLICY.restart_cleanup.timeoutMs,
        'Dispose timed out'
      );
      logger.info('[Lifecycle] Session disposed');
    } catch (err) {
      logger.warn(`[Lifecycle] Dispose failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.health.markTransition('none', 'dispose.complete');
    }
  }

  private async disposeNow(): Promise<void> {
    try {
      await this.cdp.disconnect();
    } catch {
      // Ignore — the session may already be gone.
    }
    await this.runner.shutdown();
    await this.server.stop();
    this.root = null;
    this.pageUrl = null;
    this.pageLoaded = false;
  }

  /**
   * Fetch the browser target list over the HTTP debugging endpoint and
   * return the first `page` target (the tab that becomes our analysis page).
   */
  private async fetchPageTarget(wsUrl: string): Promise<{ webSocketDebuggerUrl: string }> {
    const match = wsUrl.match(/ws:\/\/127\.0\.0\.1:(\d+)/);
    if (!match) throw new Error('Could not parse port from WebSocket URL');
    const debugPort = match[1];

    const targets: Array<Record<string, unknown>> = await new Promise((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${debugPort}/json/list`, (res: http.IncomingMessage) => {
          let data = '';
          res.on('data', (chunk: string) => (data += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(err);
            }
          });
        })
        .on('error', reject);
    });

    const pageTarget = targets.find((t) => t.type === 'page') as
      { webSocketDebuggerUrl: string } | undefined;
    if (!pageTarget) throw new Error('No page target found');
    return pageTarget;
  }

  /** Enable the CDP domains the analysis pipeline depends on. */
  private async enableDomains(): Promise<void> {
    await this.cdp.send('Page.enable');
    await this.cdp.send('DOM.enable');
    await this.cdp.send('CSS.enable');
    await this.cdp.send('Runtime.enable');
  }

  /**
   * Navigate (or reload) the analysis page and wait for the real page load,
   * ignoring `about:blank` events from the initial tab. Falls back to the
   * existing behavior on timeout: proceed with a warning instead of failing
   * and report `true` so the run can be classified as a recoverable
   * `page_load_timeout`. A hard navigation failure (the CDP send itself
   * rejects) is rethrown as a typed `PageLoadError` for central
   * classification — never swallowed.
   */
  private async navigateTo(url: string, reload: boolean): Promise<boolean> {
    let timedOut = false;
    let targetFrameNavigated = false;

    const onFrameNavigated = (params: unknown) => {
      const frameUrl = (params as { frame?: { url?: string } })?.frame?.url || '';
      if (frameUrl && frameUrl !== 'about:blank') {
        targetFrameNavigated = true;
        logger.info(`[CDP] Frame navigated to target URL: ${frameUrl}`);
      }
    };

    const onLoadEventFired = () => {
      if (targetFrameNavigated) {
        logger.info('[CDP] Page.loadEventFired received for target page');
        cleanup();
        resolveLoad();
      } else {
        logger.info('[CDP] Ignored Page.loadEventFired (prior to target frame navigation / about:blank)');
      }
    };

    let resolveLoad: () => void = () => {};
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      this.cdp.off('Page.frameNavigated', onFrameNavigated);
      this.cdp.off('Page.loadEventFired', onLoadEventFired);
    };

    const pageLoaded = new Promise<void>((resolve) => {
      resolveLoad = resolve;
      // Phase 5: the page-load wait is bounded by the typed policy (no
      // hardcoded timeout), keeping the recovery contract data-driven.
      timeout = setTimeout(() => {
        cleanup();
        timedOut = true;
        logger.warn('[CDP] Page load timeout — proceeding anyway');
        resolve();
      }, RETRY_POLICY.page_load.timeoutMs);

      this.cdp.on('Page.frameNavigated', onFrameNavigated);
      this.cdp.on('Page.loadEventFired', onLoadEventFired);
    });

    try {
      if (reload) {
        logger.info('[CDP] Reloading analysis page...');
        await this.cdp.send('Page.reload');
        this.stats.pageReloads++;
      } else {
        logger.info(`Navigating to ${url}...`);
        await this.cdp.send('Page.navigate', { url });
        this.stats.pageNavigations++;
      }
    } catch (err) {
      // Navigation failed outright (e.g. the page target died): clean up the
      // listeners and surface a typed, classifiable failure.
      cleanup();
      throw new PageLoadError(
        `Page load failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    await pageLoaded;
    logger.info('[Lifecycle] Analysis page ready');
    return timedOut;
  }

  private readonly failureListeners: SessionFailureListener[] = [];

  private notifyFailure(failure: AnalysisFailure): void {
    for (const listener of this.failureListeners.slice()) {
      try {
        listener(failure);
      } catch {
        // A failing listener must never break the lifecycle.
      }
    }
  }
}

/** Bounded backoff wait before a retry attempt. */
async function sleepBackoff(attempt: number): Promise<void> {
  const delayMs = backoffFor(attempt);
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Shared lifecycle instance. The analyzer pipeline (and every CdpAnalyzer)
 * uses this single session, so browser/CDP/DevServer/page survive across
 * command invocations; `dispose()` runs during extension deactivation.
 */
export const defaultLifecycle = new LifecycleManager();