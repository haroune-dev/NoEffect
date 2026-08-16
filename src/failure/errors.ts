/**
 * Typed analysis errors.
 *
 * The analysis orchestration and the lifecycle modules throw these so that
 * the central classifier can map them deterministically. A typed error
 * always carries enough explicit signal (kind / code / source / severity)
 * that no inference or guessing is required.
 */

import {
  FailureCode,
  FailureKind,
  FailureSeverity,
  FailureSource,
  KIND_PROFILE,
  KIND_TO_CODE,
} from './model';

export interface AnalysisErrorOptions {
  kind: FailureKind;
  code?: FailureCode;
  severity?: FailureSeverity;
  recoverable?: boolean;
  source: FailureSource;
  message: string;
  userMessage?: string;
  details?: string;
  cause?: unknown;
  context?: Record<string, unknown>;
}

export class AnalysisError extends Error {
  readonly kind: FailureKind;
  readonly code: FailureCode;
  readonly severity: FailureSeverity;
  readonly recoverable: boolean;
  readonly source: FailureSource;
  readonly userMessage?: string;
  readonly details?: string;
  readonly cause?: unknown;
  readonly context?: Record<string, unknown>;

  constructor(options: AnalysisErrorOptions) {
    super(options.message);
    this.name = 'AnalysisError';
    this.kind = options.kind;
    this.code = options.code ?? KIND_TO_CODE[options.kind];
    const profile = KIND_PROFILE[options.kind];
    this.severity = options.severity ?? profile.severity;
    this.recoverable = options.recoverable ?? profile.recoverable;
    this.source = options.source;
    this.userMessage = options.userMessage;
    this.details = options.details;
    this.cause = options.cause;
    this.context = options.context;
  }
}

/** A run superseded (cancelled) by a newer analysis trigger. */
export class AnalysisCancelledError extends AnalysisError {
  constructor(message = 'Analysis cancelled', cause?: unknown) {
    super({
      kind: 'analysis_cancelled',
      source: 'analysis',
      message,
      cause,
      userMessage: 'The analysis was superseded by a newer run.',
    });
    this.name = 'AnalysisCancelledError';
  }
}

/** The analysis exceeded its time budget without being cancelled. */
export class AnalysisTimeoutError extends AnalysisError {
  constructor(message = 'Analysis timed out', cause?: unknown) {
    super({
      kind: 'analysis_timeout',
      source: 'analysis',
      message,
      cause,
      userMessage: 'The analysis took too long and was abandoned.',
    });
    this.name = 'AnalysisTimeoutError';
  }
}

/** Chromium binary process failed to come up (crash, unresponsive, no endpoint). */
export class BrowserLaunchError extends AnalysisError {
  constructor(message: string, options: { code?: FailureCode; cause?: unknown; context?: Record<string, unknown> } = {}) {
    super({ kind: 'browser_crashed', source: 'browser', message, ...options });
    this.name = 'BrowserLaunchError';
  }
}

/** The Chromium executable was not found at all (auto-detect failure). */
export class ChromiumNotFoundError extends AnalysisError {
  constructor(chromiumPath: string, cause?: unknown) {
    super({
      kind: 'chromium_missing',
      source: 'browser',
      message: `Chromium executable not found ('${chromiumPath}')`,
      cause,
      userMessage: 'No Chromium-based browser was found. Install Chrome/Chromium or set the noEffect.chromiumPath setting.',
      context: { chromiumPath },
    });
    this.name = 'ChromiumNotFoundError';
  }
}

/** A user-configured Chromium path does not resolve to an executable. */
export class ChromiumPathInvalidError extends AnalysisError {
  constructor(chromiumPath: string, cause?: unknown) {
    super({
      kind: 'chromium_path_invalid',
      source: 'browser',
      message: `Configured Chromium path is invalid: '${chromiumPath}'`,
      cause,
      userMessage: `The configured chromiumPath '${chromiumPath}' does not point to a usable browser.`,
      context: { chromiumPath },
    });
    this.name = 'ChromiumPathInvalidError';
  }
}

/** DevServer failed to start or refused to serve its root. */
export class DevServerError extends AnalysisError {
  constructor(message: string, options: { code?: FailureCode; cause?: unknown; context?: Record<string, unknown> } = {}) {
    super({ kind: 'devserver_start_failed', source: 'devserver', message, ...options });
    this.name = 'DevServerError';
  }
}

/** The DevServer port is already taken. */
export class DevServerPortBusyError extends AnalysisError {
  constructor(port?: number, cause?: unknown) {
    super({
      kind: 'devserver_port_busy',
      source: 'devserver',
      message: `DevServer port${port ? ` ${port}` : ''} is already in use`,
      cause,
      context: port ? { port } : undefined,
    });
    this.name = 'DevServerPortBusyError';
  }
}

/** Could not establish a fresh CDP connection. */
export class CdpConnectionError extends AnalysisError {
  constructor(message: string, cause?: unknown) {
    super({
      kind: 'cdp_connection_failed',
      code: 'CDP_CONNECTION_FAILED',
      source: 'cdp',
      message,
      cause,
      userMessage: 'Could not connect to the headless browser debugging endpoint.',
    });
    this.name = 'CdpConnectionError';
  }
}

/** An established CDP session was lost mid-analysis (recoverable). */
export class CdpDisconnectedError extends AnalysisError {
  constructor(message = 'CDP session disconnected', cause?: unknown) {
    super({
      kind: 'cdp_connection_failed',
      code: 'CDP_DISCONNECTED',
      source: 'cdp',
      message,
      recoverable: true,
      cause,
      userMessage: 'The browser session was lost and is being recovered.',
    });
    this.name = 'CdpDisconnectedError';
  }
}

/** Navigation to the analysis URL failed outright. */
export class PageLoadError extends AnalysisError {
  constructor(message: string, cause?: unknown) {
    super({
      kind: 'page_load_failed',
      source: 'browser',
      message,
      cause,
      userMessage: 'The analysis page could not be loaded.',
    });
    this.name = 'PageLoadError';
  }
}

/** Navigation was issued but the load event never arrived (recoverable). */
export class PageLoadTimeoutError extends AnalysisError {
  constructor(url?: string, cause?: unknown) {
    super({
      kind: 'page_load_timeout',
      source: 'browser',
      message: url ? `Page load timed out for ${url}` : 'Page load timed out',
      recoverable: true,
      cause,
      userMessage: 'The analysis page loaded slowly; analysis proceeded against an incompletely loaded page.',
    });
    this.name = 'PageLoadTimeoutError';
  }
}