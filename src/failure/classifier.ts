/**
 * Central failure classifier.
 *
 * The ONLY module that maps raw errors, errno codes, WebSocket close codes
 * and typed analysis exceptions onto the `AnalysisFailure` taxonomy. No
 * other module (browser runners, CDP clients, commands) decides a failure
 * kind — they either throw typed signals or annotate the source, and this
 * module produces the deterministic `AnalysisFailure`.
 *
 * Rules are explicit-signal based: a failure is only classified when the
 * evidence is explicit (typed error, errno, close code, an authored
 * sentinel message). Anything else falls through to `unknown` rather than
 * being guessed.
 */

import {
  AnalysisFailure,
  FailureSeverity,
  FailureSource,
  FAILURE_CODES,
  KIND_PROFILE,
  KIND_TO_CODE,
} from './model';
import {
  AnalysisCancelledError,
  AnalysisError,
  AnalysisTimeoutError,
  BrowserLaunchError,
  CdpConnectionError,
  CdpDisconnectedError,
  ChromiumNotFoundError,
  ChromiumPathInvalidError,
  DevServerError,
  DevServerPortBusyError,
  PageLoadError,
  PageLoadTimeoutError,
} from './errors';

/** Symbol keys used to annotate a raw error with its originating subsystem. */
const FAILURE_SOURCE_KEY = 'noeffect__failureSource';

export interface ClassificationContext {
  /** Subsystem the error is believed to have surfaced from. */
  source?: FailureSource;

  /**
   * The effective `noEffect.chromiumPath` value ('' when the browser is
   * auto-detected). Disambiguates `ENOENT` into a missing binary vs an
   * invalid configured path.
   */
  chromiumPath?: string;

  /** Free-form details merged into the failure's context bag. */
  context?: Record<string, unknown>;
}

interface ErrnoLike {
  errno?: number | string;
  code?: string;
  message?: string;
  wsCloseCode?: number;
  wsCloseReason?: string;
}

/** Attach the originating subsystem to a raw error before rethrowing it. */
export function annotateFailureSource(err: unknown, source: FailureSource): unknown {
  if (err && typeof err === 'object') {
    try {
      (err as Record<string | symbol, unknown>)[FAILURE_SOURCE_KEY] = source;
    } catch {
      // Frozen or exotic object — the classifier simply works without a hint.
    }
  }
  return err;
}

function readFailureSource(err: unknown, context: ClassificationContext): FailureSource {
  if (err && typeof err === 'object') {
    const hinted = (err as Record<string | symbol, unknown>)[FAILURE_SOURCE_KEY];
    if (typeof hinted === 'string') {
      return hinted as FailureSource;
    }
  }
  return context.source ?? 'unknown';
}

function failure(options: {
  kind: AnalysisFailure['kind'];
  code?: string;
  source: FailureSource;
  severity?: FailureSeverity;
  recoverable?: boolean;
  message: string;
  userMessage?: string;
  details?: string;
  cause?: unknown;
  context?: Record<string, unknown>;
}): AnalysisFailure {
  const profile = KIND_PROFILE[options.kind];
  return {
    kind: options.kind,
    code: options.code ?? KIND_TO_CODE[options.kind],
    severity: options.severity ?? profile.severity,
    recoverable: options.recoverable ?? profile.recoverable,
    source: options.source,
    message: options.message,
    userMessage: options.userMessage,
    details: options.details,
    cause: options.cause,
    context: options.context,
  };
}

/**
 * Build a failure from a typed `AnalysisError`, trusting every explicit
 * field it carries verbatim (including severity/recoverability overrides).
 */
function failureFromError(
  err: AnalysisError,
  overrides: { code?: string; source?: FailureSource } = {}
): AnalysisFailure {
  return failure({
    kind: err.kind,
    code: overrides.code ?? err.code,
    source: overrides.source ?? err.source,
    severity: err.severity,
    recoverable: err.recoverable,
    message: err.message,
    userMessage: err.userMessage,
    details: err.details,
    cause: err,
    context: err.context,
  });
}

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Classify any thrown value deterministically. Same input always yields the
 * same kind, code, severity and recoverability.
 */
export function classifyFailure(
  cause: unknown,
  context: ClassificationContext = {}
): AnalysisFailure {
  const source = readFailureSource(cause, context);

  // ── Typed analysis errors win: they already carry explicit signals. ──
  if (cause instanceof AnalysisCancelledError) {
    return failureFromError(cause);
  }
  if (cause instanceof AnalysisTimeoutError) {
    return failureFromError(cause);
  }
  if (cause instanceof ChromiumNotFoundError) {
    return failureFromError(cause);
  }
  if (cause instanceof ChromiumPathInvalidError) {
    return failureFromError(cause);
  }
  if (cause instanceof DevServerPortBusyError) {
    return failureFromError(cause);
  }
  if (cause instanceof DevServerError) {
    return failureFromError(cause);
  }
  if (cause instanceof CdpDisconnectedError) {
    return failureFromError(cause);
  }
  if (cause instanceof CdpConnectionError) {
    return failureFromError(cause);
  }
  if (cause instanceof PageLoadTimeoutError) {
    return failureFromError(cause);
  }
  if (cause instanceof PageLoadError) {
    return failureFromError(cause);
  }
  if (cause instanceof BrowserLaunchError) {
    return failureFromError(cause);
  }
  if (cause instanceof AnalysisError) {
    // Any other typed error — trust its explicit fields verbatim.
    return failureFromError(cause);
  }

  // ── Explicit signal probes. `cause` may be any thrown value (null,
  //     undefined, primitives) — the classifier's contract is to classify
  //     ANY thrown value, so the probes are null-guarded before any
  //     property access (P2-BUG-03).
  const errno =
    cause !== null && (typeof cause === 'object' || typeof cause === 'function')
      ? (cause as ErrnoLike)
      : null;

  // ── Explicit WebSocket close codes (our CDP client attaches them). ──
  if (errno && typeof errno.wsCloseCode === 'number') {
    return failure({
      kind: 'cdp_connection_failed',
      code: FAILURE_CODES.CDP_DISCONNECTED,
      source: source === 'unknown' ? 'cdp' : source,
      message: `CDP session closed (close code ${errno.wsCloseCode})`,
      cause,
      context: { wsCloseCode: errno.wsCloseCode, wsCloseReason: errno.wsCloseReason },
    });
  }

  // ── Explicit Node system errno codes. ──
  if (errno) {
    switch (errno.code) {
    case 'ENOENT':
      if (source === 'browser') {
        if (context.chromiumPath) {
          return failure({
            kind: 'chromium_path_invalid',
            source: 'browser',
            message: `Configured Chromium path is invalid: '${context.chromiumPath}'`,
            cause,
            context: { chromiumPath: context.chromiumPath, ...context.context },
          });
        }
        return failure({
          kind: 'chromium_missing',
          source: 'browser',
          message: `Chromium executable not found while launching the browser`,
          cause,
          context: context.context,
        });
      }
      if (source === 'devserver') {
        return failure({
          kind: 'devserver_start_failed',
          source: 'devserver',
          message: `DevServer could not start: ${messageOf(cause)}`,
          cause,
          context: context.context,
        });
      }
      // The wrong filesystem file is missing — we cannot tell what was
      // expected, so this stays unknown rather than guessed.
      return failure({
        kind: 'unknown',
        code: FAILURE_CODES.UNKNOWN_FAILURE,
        source,
        message: messageOf(cause),
        cause,
        context: context.context,
      });

    case 'EADDRINUSE':
      // A port conflict is only ever a dev-server problem in this pipeline.
      return failure({
        kind: 'devserver_port_busy',
        source: source === 'unknown' ? 'devserver' : source,
        message: `Network port is already in use`,
        cause,
        context: context.context,
      });

    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'EHOSTUNREACH':
    case 'EPIPE':
      if (source === 'cdp' || source === 'browser' || source === 'unknown') {
        return failure({
          kind: 'cdp_connection_failed',
          code: FAILURE_CODES.CDP_CONNECTION_FAILED,
          source: source === 'unknown' ? 'cdp' : source,
          message: `Could not connect to the browser debugging session (${errno.code})`,
          cause,
          context: context.context,
        });
      }
      return failure({
        kind: 'unknown',
        code: FAILURE_CODES.UNKNOWN_FAILURE,
        source,
        message: messageOf(cause),
        cause,
        context: context.context,
      });

    case 'ETIMEDOUT':
      if (source === 'cdp' || source === 'browser') {
        return failure({
          kind: 'cdp_connection_failed',
          code: FAILURE_CODES.CDP_CONNECTION_FAILED,
          source,
          message: `The browser debugging session timed out (${errno.code})`,
          cause,
          context: context.context,
        });
      }
      return failure({
        kind: 'analysis_timeout',
        source: source === 'unknown' ? 'analysis' : source,
        message: `The analysis timed out (${errno.code})`,
        cause,
        context: context.context,
      });
    }
  }

  // ── Authored sentinel messages thrown by our own modules. ──
  const message = errno?.message ?? messageOf(cause);
  if (/WebSocket closed while a request was in flight/i.test(message) ||
      /CDP Client is not connected/i.test(message) ||
      /Disconnected/i.test(message)) {
    return failure({
      kind: 'cdp_connection_failed',
      code: FAILURE_CODES.CDP_DISCONNECTED,
      source: source === 'unknown' ? 'cdp' : source,
      message,
      cause,
      context: context.context,
    });
  }
  if (/Timed out waiting for Chromium CDP endpoint/i.test(message) ||
      /No page target found/i.test(message) ||
      /Could not parse port from WebSocket URL/i.test(message)) {
    return failure({
      kind: 'browser_crashed',
      code: FAILURE_CODES.BROWSER_LAUNCH_FAILED,
      source: source === 'unknown' ? 'browser' : source,
      message,
      cause,
      context: context.context,
    });
  }
  if (/Chromium exited before reporting its CDP endpoint/i.test(message)) {
    return failure({
      kind: 'browser_crashed',
      code: FAILURE_CODES.BROWSER_CRASHED,
      source: source === 'unknown' ? 'browser' : source,
      message,
      cause,
      context: context.context,
    });
  }

  // ── Nothing explicit — never guess. ──
  return failure({
    kind: 'unknown',
    code: FAILURE_CODES.UNKNOWN_FAILURE,
    source,
    message: messageOf(cause),
    cause,
    context: context.context,
  });
}

// ---------------------------------------------------------------------------
// Declarative failure factories (input limitations and capability notes).
// These are the same classifiers the analyzer/command layer use, so every
// limitation flows through this single module.
// ---------------------------------------------------------------------------

export function workspaceUntrustedFailure(): AnalysisFailure {
  return failure({
    kind: 'workspace_untrusted',
    source: 'filesystem',
    message: 'The workspace is not trusted - analysis is skipped',
    userMessage: 'Trust the workspace folder to enable NoEffect analysis.',
  });
}

export function workspaceUnsupportedFailure(reason: string): AnalysisFailure {
  return failure({
    kind: 'workspace_unsupported',
    source: 'filesystem',
    message: `The workspace type is not supported for local browser analysis: ${reason}`,
    userMessage: 'Virtual and remote workspaces cannot run a local browser analysis.',
    context: { reason },
  });
}

export function extensionDisabledFailure(): AnalysisFailure {
  return failure({
    kind: 'disabled',
    source: 'analysis',
    message: 'NoEffect is disabled by the noEffect.enabled setting',
    userMessage: 'Enable the noEffect.enabled setting to run analyses.',
  });
}

/** No Chromium-based browser could be found anywhere (readiness). */
export function browserNotFoundFailure(): AnalysisFailure {
  return failure({
    kind: 'chromium_missing',
    source: 'browser',
    message: 'No Chromium-based browser was found on this system',
    userMessage: 'Install Chrome, Chromium or Edge, or set the noEffect.chromiumPath setting.',
  });
}

/** The configured browser path does not point at a usable executable. */
export function browserPathInvalidFailure(browserPath: string): AnalysisFailure {
  return failure({
    kind: 'chromium_path_invalid',
    source: 'browser',
    message: `Configured browser path is not usable: '${browserPath}'`,
    userMessage: `The configured chromiumPath '${browserPath}' does not point to a usable browser.`,
    context: { browserPath },
  });
}

/** A found/configured browser executable exists but cannot run. */
export function browserLaunchFailedFailure(browserPath: string): AnalysisFailure {
  return failure({
    kind: 'browser_crashed',
    code: FAILURE_CODES.BROWSER_LAUNCH_FAILED,
    source: 'browser',
    message: `Browser executable exists but could not be launched: '${browserPath}'`,
    userMessage: 'The detected browser could not be launched; a retry may succeed.',
    context: { browserPath },
  });
}

export function liveAnalysisUnavailableFailure(): AnalysisFailure {
  return failure({
    kind: 'live_analysis_unavailable',
    source: 'analysis',
    message: 'Live in-memory analysis while typing is not supported - analysis reads saved files from disk',
    userMessage: 'Analysis while typing is not available; analyses run against saved file content.',
  });
}

export function fileUnsavedFailure(filePath: string): AnalysisFailure {
  return failure({
    kind: 'file_unsaved',
    source: 'filesystem',
    message: `The file has unsaved changes and was not analyzed: ${filePath}`,
    userMessage: 'Save the file before running the analysis.',
    context: { filePath },
  });
}

export function fileTooLargeFailure(sizeBytes: number, limitBytes: number): AnalysisFailure {
  return failure({
    kind: 'file_too_large',
    source: 'filesystem',
    message: `File is ${sizeBytes} bytes, above the ${limitBytes} byte analysis limit`,
    userMessage: 'This file is too large to be analyzed.',
    context: { sizeBytes, limitBytes },
  });
}

export function fileIgnoredFailure(filePath: string, pattern: string): AnalysisFailure {
  return failure({
    kind: 'file_ignored',
    source: 'filesystem',
    message: `File is excluded from analysis by pattern '${pattern}': ${filePath}`,
    userMessage: 'This file matches an ignored-file pattern.',
    context: { filePath, pattern },
  });
}

export function selectorNotQueryableFailure(selector: string, reason: string): AnalysisFailure {
  return failure({
    kind: 'selector_not_queryable',
    code: FAILURE_CODES.SELECTOR_NOT_QUERYABLE,
    source: 'selector',
    message: `Selector ${selector} is not inspectable — ${reason}`,
    context: { selector },
  });
}

export function selectorsUnqueryableFailure(count: number): AnalysisFailure {
  return failure({
    kind: 'selector_not_queryable',
    code: FAILURE_CODES.SELECTORS_UNQUERYABLE,
    source: 'selector',
    message: `No queryable selectors found (${count} selector(s) dropped)`,
    context: { droppedCount: count },
  });
}

export function noCompanionHtmlFailure(cssFilePath: string): AnalysisFailure {
  return failure({
    kind: 'no_companion_html',
    source: 'selector',
    message: `No companion HTML document found next to ${cssFilePath} — analysis ran against a generated wrapper page`,
    userMessage: 'No HTML document exists to give real element types and parents; a synthetic page was analyzed instead.',
    context: { cssFilePath },
  });
}

export function analysisContextMissingFailure(reason: string): AnalysisFailure {
  return failure({
    kind: 'analysis_context_missing',
    source: 'analysis',
    message: reason,
    userMessage: 'The analyzed page contained no element matching any inspected selector.',
  });
}

export function companionPassFailedFailure(htmlPath: string, message: string): AnalysisFailure {
  return failure({
    kind: 'companion_failed',
    source: 'analysis',
    message: `Companion pass failed for ${htmlPath}: ${message}`,
    userMessage: 'One of the companion documents could not be evaluated; its evidence was excluded, keep the others.',
    context: { htmlPath },
  });
}

export function pageLoadTimeoutFailure(url?: string): AnalysisFailure {
  return failure({
    kind: 'page_load_timeout',
    source: 'browser',
    message: url ? `Page load timed out for ${url}` : 'Page load timed out',
    userMessage: 'The analysis page loaded slowly; analysis proceeded against an incompletely loaded page.',
  });
}