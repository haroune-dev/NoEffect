import { logger } from '../utils/logger';
import { AnalysisResult, CssIssue } from '../models';

/**
 * A recorded global (multi-companion) outcome of one stylesheet (F5). The
 * entry is valid — i.e. describes what the CURRENT world says — exactly
 * when its fingerprints match the current content and analysis context and
 * its session epoch is still live. Anything else means the outcome must be
 * recomputed.
 */
interface CssGlobalEntry {
  /** Content fingerprint (SHA-256) of the stylesheet at analysis time. */
  contentFingerprint: string;

  /** Analysis-context fingerprint (F1) of the resolution it was judged against. */
  contextFingerprint: string;

  /** Session epoch that produced the outcome. */
  epoch: number;

  /** The merged multi-companion issues (mapped into the stylesheet). */
  issues: CssIssue[];
}

/** A recorded page-local outcome of one HTML document (embedded CSS only). */
interface HtmlEmbeddedEntry {
  /** Content fingerprint (SHA-256) of the HTML document at analysis time. */
  contentFingerprint: string;

  /** Session epoch that produced the outcome. */
  epoch: number;

  /** The embedded-CSS issues (mapped into the HTML document). */
  issues: CssIssue[];
}

/** The fingerprint identity of the last recorded successful run (F3). */
interface LastRecordedRun {
  filePath: string;
  contentFingerprint: string;

  /** Context fingerprint for CSS files; null for HTML (no companion context). */
  contextFingerprint: string | null;
}

/**
 * The single writer of global CSS outcomes (F4 single-writer). Implemented
 * by the SessionManager and injected into the analyzer: the HTML flow uses
 * it to REUSE a fresh global outcome or RECORD one it computed, instead of
 * emitting single-page external-sheet issues of its own.
 */
export interface CssGlobalOutcomeStore {
  /**
   * The fresh global outcome of a stylesheet, or undefined when none is
   * recorded that matches the given content fingerprint, context
   * fingerprint and session epoch.
   */
  getFresh(
    cssPath: string,
    contentFingerprint: string,
    contextFingerprint: string,
    epoch: number
  ): CssIssue[] | undefined;

  /** Record a global outcome under its (content, context, epoch) identity. */
  record(
    cssPath: string,
    contentFingerprint: string,
    contextFingerprint: string,
    epoch: number,
    issues: CssIssue[]
  ): void;
}

/**
 * Manages browser analysis sessions.
 *
 * In Phase 1, this is a simple placeholder that stores the last analysis
 * result and provides lifecycle hooks. In later phases, it will manage
 * the actual Chromium CDP session lifecycle — launching, reusing, and
 * tearing down browser instances.
 *
 * Phase 6 (multi-file orchestration): results are namespaced. Global
 * multi-companion CSS outcomes live in `cssGlobal[cssPath]` keyed by
 * (content fingerprint, context fingerprint, epoch); page-local embedded
 * outcomes live in `htmlEmbedded[htmlPath]` keyed by (content fingerprint,
 * epoch). `completeAnalysis` writes exactly ONE namespace per run, and the
 * re-analysis skip gate requires a recorded success/partial run whose
 * content AND context fingerprints are unchanged (F3).
 */
export class SessionManager implements CssGlobalOutcomeStore {
  private lastResult: AnalysisResult | null = null;
  private isRunning: boolean = false;

  /** Global (multi-companion) outcomes per stylesheet (F5). */
  private cssGlobal: Map<string, CssGlobalEntry> = new Map();

  /** Page-local embedded outcomes per HTML document (F5). */
  private htmlEmbedded: Map<string, HtmlEmbeddedEntry> = new Map();

  /** Identity of the last RECORDED (success/partial) run — the skip gate (F3). */
  private lastRecordedRun: LastRecordedRun | null = null;

  /**
   * Whether the last COMPLETED run was recorded (success/partial). Failed,
   * cancelled and blocked runs are never recorded; consumers use this to
   * avoid re-triggering redundant analysis right after an unrecorded run.
   */
  private lastRunRecorded: boolean = false;

  /** Completion listeners (analysis finished, result already stored). */
  private completionListeners: Array<() => void> = [];

  /**
   * Whether an analysis is currently in progress.
   */
  get analysisInProgress(): boolean {
    return this.isRunning;
  }

  /**
   * Get the most recent analysis result, if any.
   */
  get lastAnalysisResult(): AnalysisResult | null {
    return this.lastResult;
  }

  /**
   * The issues of the latest analysis that covered the given file, or
   * undefined when the file has no recorded outcome at all. An empty array
   * means the file was analyzed and has no issues.
   *
   * CSS files read the cssGlobal namespace (the single-writer outcome of
   * the multi-companion flow); everything else reads htmlEmbedded.
   */
  getIssuesForFile(filePath: string): CssIssue[] | undefined {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.css')) {
      return this.cssGlobal.get(filePath)?.issues;
    }
    return this.htmlEmbedded.get(filePath)?.issues;
  }

  /**
   * The FRESHNESS-AWARE read of the cssGlobal namespace — the single
   * authority CSS decorations may be applied from. Returns the issues only
   * when the recorded outcome matches the CURRENT world identity —
   * (content fingerprint, analysis-context fingerprint, session epoch) all
   * equal — and undefined otherwise, so a stale outcome can never reach an
   * editor. The editor paths must probe this BEFORE deciding to decorate:
   * fresh → apply, anything else → clear.
   *
   * `contentFingerprint` = hash of the CURRENT editor text (live buffer),
   * `contextFingerprint` = `companionContextFingerprintFor(cssPath)` (the
   * current validated resolution snapshot), `epoch` = `defaultLifecycle.epoch`.
   */
  getFreshCssIssues(
    cssPath: string,
    contentFingerprint: string,
    contextFingerprint: string,
    epoch: number
  ): CssIssue[] | undefined {
    return this.getFresh(cssPath, contentFingerprint, contextFingerprint, epoch);
  }

  /**
   * Whether the last completed run was recorded (F3). Failed/cancelled/
   * blocked runs return false — a post-run re-evaluation must never
   * immediately re-run identical content after an unrecorded outcome.
   */
  lastRunWasRecorded(): boolean {
    return this.lastRunRecorded;
  }

  /**
   * Record the identity of a successful (or partial) analysis (F3). The
   * skip gate then skips only when BOTH the content fingerprint and the
   * analysis-context fingerprint are unchanged.
   */
  recordSuccessfulAnalysis(
    filePath: string,
    contentFingerprint: string,
    contextFingerprint: string | null
  ): void {
    this.lastRecordedRun = { filePath, contentFingerprint, contextFingerprint };
    logger.info(
      `[Session] Recorded analysis of ${filePath} ` +
        `(content ${contentFingerprint.slice(0, 8)}…, context ${contextFingerprint ?? 'html'})`
    );
  }

  /**
   * Whether re-analyzing this file/content would be redundant (F3): the
   * last run was successful/partial, targeted this exact file, and neither
   * the content fingerprint nor the analysis-context fingerprint changed.
   * A null context fingerprint matches only an HTML (context-free) record.
   */
  shouldSkipReanalysisWithContext(
    filePath: string,
    contentFingerprint: string,
    contextFingerprint: string | null
  ): boolean {
    const recorded = this.lastRecordedRun;
    return (
      recorded !== null &&
      recorded.filePath === filePath &&
      recorded.contentFingerprint === contentFingerprint &&
      recorded.contextFingerprint === contextFingerprint
    );
  }

  /**
   * Register a listener that runs after every analysis completion (the
   * result is already stored when it fires). Used to retry open/switch
   * triggers that collided with an in-flight analysis.
   */
  onAnalysisComplete(listener: () => void): { dispose(): void } {
    this.completionListeners.push(listener);
    return {
      dispose: () => {
        const index = this.completionListeners.indexOf(listener);
        if (index >= 0) {
          this.completionListeners.splice(index, 1);
        }
      },
    };
  }

  /**
   * Mark that an analysis has started. Returns false if one is already running.
   */
  beginAnalysis(): boolean {
    if (this.isRunning) {
      logger.warn('Analysis already in progress — skipping');
      return false;
    }
    this.isRunning = true;
    logger.info('Analysis started');
    return true;
  }

  /**
   * Store the result and mark the analysis as complete.
   *
   * Phase 6: writes EXACTLY ONE namespace — the one the run's
   * `result.namespace` declares (cssGlobal for CSS-file runs,
   * htmlEmbedded for HTML-file runs). A failed/skipped run records
   * nothing: its namespace entry is invalidated instead, and the skip gate
   * stays open so the next trigger genuinely re-attempts the analysis.
   * Cancelled runs never touch the namespaces (the superseding run owns
   * them).
   */
  completeAnalysis(result: AnalysisResult): void {
    this.lastResult = result;
    this.isRunning = false;

    const namespace = result.namespace;
    if (namespace) {
      if (result.success) {
        if (namespace.kind === 'cssGlobal') {
          this.cssGlobal.set(namespace.cssPath, {
            contentFingerprint: namespace.contentFingerprint,
            contextFingerprint: namespace.contextFingerprint,
            epoch: namespace.epoch,
            issues: result.issues,
          });
          logger.info(
            `[Session] cssGlobal[${namespace.cssPath}] recorded ` +
              `(${result.issues.length} issue(s), epoch ${namespace.epoch})`
          );
        } else {
          this.htmlEmbedded.set(namespace.htmlPath, {
            contentFingerprint: namespace.contentFingerprint,
            epoch: namespace.epoch,
            issues: result.issues,
          });
          logger.info(
            `[Session] htmlEmbedded[${namespace.htmlPath}] recorded ` +
              `(${result.issues.length} issue(s), epoch ${namespace.epoch})`
          );
        }
      } else {
        // A failed/skipped run must never resurrect stale decorations: drop
        // the entry of the namespace it targeted.
        if (namespace.kind === 'cssGlobal') {
          this.cssGlobal.delete(namespace.cssPath);
        } else {
          this.htmlEmbedded.delete(namespace.htmlPath);
        }
        logger.info(
          `[Session] ${namespace.kind === 'cssGlobal' ? 'cssGlobal' : 'htmlEmbedded'} ` +
            `entry invalidated by an unrecorded run`
        );
      }
    }

    // F3: only success/partial runs count as recorded; a failed, cancelled
    // or blocked outcome clears the previous identity so the gate opens.
    if (result.success) {
      this.lastRunRecorded = true;
    } else {
      this.lastRunRecorded = false;
      this.lastRecordedRun = null;
    }

    if (result.success) {
      logger.info(
        `Analysis complete: ${result.issues.length} issue(s) found in ${result.durationMs}ms`
      );
    } else {
      logger.error(`Analysis failed: ${result.error}`);
    }

    for (const listener of this.completionListeners) {
      listener();
    }
  }

  /**
   * Cancel an in-progress analysis.
   */
  cancelAnalysis(): void {
    if (this.isRunning) {
      this.isRunning = false;
      logger.info('Analysis cancelled');
    }
  }

  /**
   * Finish a run that was cancelled (superseded by a newer analysis).
   *
   * The gate is released and completion listeners fire, but no result is
   * stored and the namespaces are left untouched — the superseding run
   * owns every subsequent decoration update, so a cancelled run never
   * overwrites a newer outcome or resurrects stale decorations.
   */
  completeAnalysisCancelled(): void {
    if (this.isRunning) {
      this.isRunning = false;
      logger.info('Analysis cancelled (superseded by a newer run)');
    }
    this.lastRunRecorded = false;
    for (const listener of this.completionListeners) {
      listener();
    }
  }

  /**
   * ── CssGlobalOutcomeStore (F4 single-writer) ────────────────────────────
   */

  /** @inheritdoc */
  getFresh(
    cssPath: string,
    contentFingerprint: string,
    contextFingerprint: string,
    epoch: number
  ): CssIssue[] | undefined {
    const entry = this.cssGlobal.get(cssPath);
    if (!entry) {
      return undefined;
    }
    if (entry.contentFingerprint !== contentFingerprint) {
      return undefined;
    }
    if (entry.contextFingerprint !== contextFingerprint) {
      return undefined;
    }
    if (entry.epoch !== epoch) {
      return undefined;
    }
    return entry.issues;
  }

  /** @inheritdoc */
  record(
    cssPath: string,
    contentFingerprint: string,
    contextFingerprint: string,
    epoch: number,
    issues: CssIssue[]
  ): void {
    this.cssGlobal.set(cssPath, { contentFingerprint, contextFingerprint, epoch, issues });
    logger.info(
      `[Session] cssGlobal[${cssPath}] recorded by the HTML flow ` +
        `(${issues.length} issue(s), epoch ${epoch})`
    );
  }

  /**
   * Clean up any resources (browser sessions in later phases).
   */
  async dispose(): Promise<void> {
    this.cancelAnalysis();
    this.lastResult = null;
    this.cssGlobal.clear();
    this.htmlEmbedded.clear();
    this.lastRecordedRun = null;
    this.lastRunRecorded = false;
    this.completionListeners = [];
    logger.info('SessionManager disposed');
  }
}
