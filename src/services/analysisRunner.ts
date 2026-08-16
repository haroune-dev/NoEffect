/**
 * Analysis orchestration layer (failure-UX Phase 1).
 *
 * The single entry point the extension commands call. It:
 *   - classifies input/capability limitations (unsaved file, untrusted
 *     workspace, oversized file, unsupported type) BEFORE anything runs,
 *   - cancels nothing by itself - the caller hands it a token - but
 *     guarantees that a cancelled run resolves to a clean `cancelled`
 *     outcome instead of an unhandled rejection,
 *   - runs the production pipeline and wraps the raw issues + metrics into
 *     the unified `AnalysisOutcome` contract,
 *   - maps every thrown error through the central failure classifier and
 *     runs deterministic resource cleanup on fatal failures,
 *   - logs structured, level-prefixed lines for the Output Channel.
 *
 * The runner is deliberately free of any `vscode` runtime dependency so it
 * stays unit-testable outside the extension host.
 */

import * as path from 'path';
import { logger } from '../utils/logger';
import { CssIssue } from '../models';
import {
  AnalysisFailure,
  AnalysisOutcome,
} from '../failure/model';
import { AnalysisCancelledError } from '../failure/errors';
import {
  CancellationTokenLike,
  raceCancellation,
  throwIfCancelled,
} from '../failure/cancellation';
import {
  classifyFailure,
  fileUnsavedFailure,
  workspaceUntrustedFailure,
  workspaceUnsupportedFailure,
  browserNotFoundFailure,
  browserPathInvalidFailure,
  browserLaunchFailedFailure,
} from '../failure/classifier';
import { buildOutcome, RunMetrics } from '../failure/outcome';
import { coverageSummaryLine } from '../status/derive';
import { AnalysisProvider } from './analyzer';
import { CdpAnalyzer } from './cdpAnalyzer';
import { CssGlobalOutcomeStore } from './sessionManager';
import { defaultLifecycle, LifecycleManager } from '../browser/lifecycleManager';
import { RETRY_POLICY } from '../session/policy';
import { withTimeout } from '../session/timing';
import {
  BrowserDetector,
  browserDetector,
} from '../environment/browserDetection';
import {
  DEFAULT_MAX_FILE_SIZE_BYTES,
  evaluateFileEligibility,
} from '../environment/fileEligibility';

/** Everything the runner needs to know about the file to be analyzed. */
export interface RunRequest {
  /** Absolute path of the file. */
  filePath: string;

  /** Lowercased extension including the dot ('.css', '.html', ...). */
  extension: string;

  /** Whether the editor document has unsaved changes. */
  isDirty: boolean;

  /** Whether the workspace is untrusted. */
  workspaceUntrusted: boolean;

  /** Whether the workspace type cannot host local browser analysis. */
  workspaceUnsupported?: boolean;

  /** URI scheme of the document ('file' for local files). */
  scheme?: string;

  /** Approximate document size in characters. */
  sizeBytes: number;

  /** The effective `noEffect.chromiumPath` ('' = auto-detect). */
  chromiumPath: string;

  /** User-configured extra ignore globs (merged over the defaults). */
  ignoredPatterns?: string[];

  /** The effective file size threshold in bytes. */
  maxFileSizeBytes?: number;
}

/**
 * Conservative default file size threshold (Phase 2 safe defaults): single
 * CSS/HTML files above 512 KB are skipped by default. Configurable via
 * `noEffect.maxFileSizeKb`.
 */
export const MAX_ANALYZABLE_FILE_BYTES = DEFAULT_MAX_FILE_SIZE_BYTES;

/** The runner's unified return value: outcome contract + decoration payload. */
export interface AnalysisRunResult {
  outcome: AnalysisOutcome;
  issues: CssIssue[];
}

/** Explicit resource cleanup for fatal failures. */
export interface FailureCleanup {
  cleanup(failure: AnalysisFailure): Promise<void>;
}

/**
 * Fatal runtime failures tear the whole persistent session down so no
 * half-dead Chromium, dangling CDP socket or DevServer port survives the
 * failure; the next analysis cold-starts cleanly. Input limitations and
 * unknown failures carry nothing that needs cleanup.
 */
export const defaultFailureCleanup: FailureCleanup = {
  async cleanup(failure: AnalysisFailure): Promise<void> {
    switch (failure.kind) {
      case 'chromium_missing':
      case 'chromium_path_invalid':
      case 'browser_crashed':
      case 'cdp_connection_failed':
      case 'devserver_port_busy':
      case 'devserver_start_failed':
        await defaultLifecycle.dispose();
        break;
      default:
        break;
    }
  },
};

/** The outcome of a run that was blocked before it started. */
export function inputBlockedOutcome(
  failure: AnalysisFailure | null,
  reasons: string[],
  skippedInput = true
): AnalysisOutcome {
  return buildOutcome({
    issuesCount: 0,
    metrics: new RunMetrics(),
    skipped: failure ? [failure] : undefined,
    skippedInput,
    skippedReasons: reasons,
  });
}

export class AnalysisRunner {
  private readonly analyzer: AnalysisProvider;
  private readonly cleanup: FailureCleanup;
  private readonly detector: BrowserDetector;

  /**
   * The session epoch the current run belongs to (Phase 5). Defaults to the
   * shared lifecycle's live epoch; injected fakes can pin their own.
   */
  private readonly epochSource: () => number;

  constructor(options: {
    analyzer?: AnalysisProvider;
    cleanup?: FailureCleanup;
    lifecycle?: LifecycleManager;
    detector?: BrowserDetector;
    epochSource?: () => number;

    /**
     * The single writer of global CSS outcomes (F4), injected into the
     * production analyzer so the HTML flow reuses/records linked-sheet
     * global outcomes instead of emitting single-page issues.
     */
    globalStore?: CssGlobalOutcomeStore | null;
  } = {}) {
    this.analyzer =
      options.analyzer ?? new CdpAnalyzer({ globalOutcomeStore: options.globalStore });
    this.cleanup = options.cleanup ?? defaultFailureCleanup;
    this.detector = options.detector ?? browserDetector;
    this.epochSource = options.epochSource ?? (() => defaultLifecycle.epoch);
    // `lifecycle` is kept for DI symmetry; the default cleanup closes over
    // the shared instance.
    void options.lifecycle;
  }

  /**
   * The exact analysis-context fingerprint the most recent run analyzed
   * against (Phase 6, transactional): the analyzer's own statement — null
   * for runs without a companion context. The command layer records the
   * result under this identity instead of recomputing it post-run.
   */
  getLastContextFingerprint(): string | null {
    return this.analyzer.getLastContextFingerprint?.() ?? null;
  }

  /**
   * Run one analysis. Never throws: every condition resolves to an
   * `AnalysisRunResult` with a classified `AnalysisOutcome`.
   */
  async run(request: RunRequest, startTime: number, token?: CancellationTokenLike): Promise<AnalysisRunResult> {
    const fileName = path.basename(request.filePath);
    logger.info(`Analysis started for ${fileName}`);

    try {
      // A superseded run (pre-cancelled token) must still resolve to a
      // clean `cancelled` outcome - never a thrown rejection.
      throwIfCancelled(token);

      const environmentBlock = this.classifyEnvironment(request);
      if (environmentBlock) {
        logger.info(`Analysis skipped for ${fileName}`);
        environmentBlock.epoch = this.epochSource();
        return { outcome: environmentBlock, issues: [] };
      }

      const issues = await raceCancellation(
        withTimeout(
          this.runAnalyzer(request, startTime, token),
          RETRY_POLICY.full_analysis.timeoutMs,
          `Analysis of ${fileName} exceeded its time budget`,
          token
        ),
        token
      );
      const epoch = this.analyzer.getLastSessionEpoch?.() ?? this.epochSource();
      const outcome = buildOutcome({
        issuesCount: issues.length,
        metrics: this.analyzer.getRunMetrics(),
        epoch,
      });
      this.logOutcome(request, outcome, Date.now() - startTime);
      return { outcome, issues };
    } catch (err) {
      if (token?.isCancellationRequested || err instanceof AnalysisCancelledError) {
        const outcome = buildOutcome({
          issuesCount: 0,
          metrics: new RunMetrics(),
          cancelled: true,
          epoch: this.epochSource(),
        });
        logger.info(`Analysis cancelled for ${fileName}`);
        return { outcome, issues: [] };
      }

      const failure = classifyFailure(err, {
        chromiumPath: request.chromiumPath,
        context: { filePath: request.filePath },
      });
      const outcome = buildOutcome({
        issuesCount: 0,
        metrics: new RunMetrics(),
        errors: [failure],
        epoch: this.epochSource(),
      });
      this.logOutcome(request, outcome, Date.now() - startTime);

      // Fatal failures must not leave zombie processes or occupied ports
      // behind - clean up explicitly, then classify (never guess) what
      // happens next.
      await this.cleanup.cleanup(failure);
      return { outcome, issues: [] };
    }
  }

  /**
   * Dispatch to the production pipeline. The entry points already classify
   * their own benign skips into run metrics; hard failures propagate for
   * central classification.
   */
  private async runAnalyzer(
    request: RunRequest,
    startTime: number,
    token?: CancellationTokenLike
  ): Promise<CssIssue[]> {
    const ext = request.extension;
    if (ext === '.css') {
      return this.analyzer.analyzeCssFile(request.filePath, startTime, token);
    }
    return this.analyzer.analyzeHtmlFile(request.filePath, startTime, token);
  }

  /**
   * Classify environment/input/capability limitations deterministically.
   * Environment gating (workspace trust/type, known-bad browser state) comes
   * first, then the unsaved-file gate, then deterministic file eligibility.
   */
  private classifyEnvironment(request: RunRequest): AnalysisOutcome | null {
    if (request.workspaceUntrusted) {
      return inputBlockedOutcome(
        workspaceUntrustedFailure(),
        ['Workspace is not trusted - NoEffect analysis is skipped']
      );
    }

    if (request.workspaceUnsupported) {
      return inputBlockedOutcome(
        workspaceUnsupportedFailure('workspace folder scheme is not file'),
        ['The workspace type cannot host a local browser analysis']
      );
    }

    // A known-bad browser state (already probed by the detector) blocks the
    // run for free. `not_attempted` proceeds: the pipeline surfaces real
    // errors through the typed-error path if no browser is truly there.
    const detection = this.detector.getCachedResult();
    if (detection.status === 'not_found') {
      return inputBlockedOutcome(browserNotFoundFailure(), [detection.message]);
    }
    if (detection.status === 'path_invalid') {
      return inputBlockedOutcome(
        browserPathInvalidFailure(request.chromiumPath || 'configured browser path'),
        [detection.message]
      );
    }
    if (detection.status === 'launch_failed') {
      return inputBlockedOutcome(
        browserLaunchFailedFailure(detection.executablePath ?? 'auto-detected browser'),
        [detection.message]
      );
    }

    if (request.isDirty) {
      return inputBlockedOutcome(
        fileUnsavedFailure(request.filePath),
        ['The file has unsaved changes - save before analyzing']
      );
    }

    const eligibility = evaluateFileEligibility({
      filePath: request.filePath,
      extension: request.extension,
      scheme: request.scheme ?? 'file',
      sizeBytes: request.sizeBytes,
      ignoredPatterns: request.ignoredPatterns,
      maxFileSizeBytes: request.maxFileSizeBytes ?? MAX_ANALYZABLE_FILE_BYTES,
    });
    if (!eligibility.eligible) {
      return inputBlockedOutcome(eligibility.failure ?? null, [eligibility.reasonText]);
    }

    return null;
  }

  /**
   * Structured, level-prefixed diagnostic logging for the Output Channel.
   * Errors and warnings are logged by their explicit failure code; verbose
   * traces stay out of the standard lines.
   */
  private logOutcome(request: RunRequest, outcome: AnalysisOutcome, durationMs: number): void {
    const fileName = path.basename(request.filePath);

    if (outcome.status === 'cancelled') {
      return;
    }

    for (const failure of outcome.errors) {
      logger.error(`[${failure.code}] ${failure.message}`);
    }
    for (const failure of outcome.warnings) {
      logger.warn(`[${failure.code}] ${failure.message}`);
    }
    for (const reason of outcome.skippedReasons) {
      logger.debug(`[skipped] ${reason}`);
    }

    logger.info(
      `Analysis ${outcome.status} for ${fileName}: ${outcome.issuesCount} issue(s), ` +
        `${outcome.analyzedSelectorsCount} selector(s) analyzed, ` +
        `${outcome.skippedSelectorsCount} skipped (${durationMs}ms)`
    );
    if (outcome.mode !== undefined) {
      logger.debug(`Coverage ${outcome.mode}: ${coverageSummaryLine(outcome)}`);
    }
  }
}