/**
 * Internal environment readiness model (Phase 2: environment readiness).
 *
 * A single, deterministic, machine-readable assessment of whether NoEffect
 * can run local browser-based analysis right now. Future UX layers (status
 * bar, first-run, diagnostics) consume `ReadinessState` instead of probing
 * the environment themselves.
 *
 * The state feeds directly into the Phase 1 failure contracts: every
 * unready condition carries the matching `AnalysisFailure` (kind / code /
 * severity / recoverable) from the central taxonomy, and the analysis layer
 * turns the same conditions into `AnalysisOutcome` skips.
 *
 * vscode-free and injectable: settings and workspace facts are provided by
 * the activation layer, the browser detector is injectable, so the whole
 * model is unit-testable without a real browser or VS Code.
 */

import { AnalysisFailure, FailureSeverity } from '../failure/model';
import {
  browserLaunchFailedFailure,
  browserNotFoundFailure,
  browserPathInvalidFailure,
  extensionDisabledFailure,
  fileUnsavedFailure,
  liveAnalysisUnavailableFailure,
  workspaceUntrustedFailure,
  workspaceUnsupportedFailure,
} from '../failure/classifier';
import { CancellationTokenLike } from '../failure/cancellation';
import { BrowserDetector, BrowserDetectionStatus } from './browserDetection';
import { classifyWorkspace, unsupportedWorkspaceReason, WorkspaceFolderInfo } from './workspace';
import { evaluateFileEligibility, FileEligibility } from './fileEligibility';

/** Map the (wider) failure severity onto the readiness severity vocabulary. */
function mapSeverity(severity: FailureSeverity | undefined): ReadinessSeverity {
  if (severity === 'recoverable' || severity === 'fatal') {
    return 'fatal';
  }
  return severity ?? 'info';
}

export type ReadinessReason =
  | 'ready'
  | 'disabled'
  | 'unsupported_workspace'
  | 'untrusted_workspace'
  | 'browser_not_found'
  | 'browser_path_invalid'
  | 'browser_launch_failed'
  | 'file_ineligible'
  | 'file_too_large'
  | 'file_ignored'
  | 'file_requires_save'
  | 'live_analysis_unavailable';

export type ReadinessSeverity = 'info' | 'warning' | 'fatal';

export interface ReadinessState {
  /** Whether analysis may proceed right now. */
  ready: boolean;

  /** Stable, deterministic reason code. */
  reason: ReadinessReason;

  severity: ReadinessSeverity;

  /** True when retrying (or re-checking) can plausibly succeed. */
  recoverable: boolean;

  /** Stable, human-readable message (output-channel / future UX use). */
  message: string;

  /** The matching Phase 1 failure, when one exists for this reason. */
  failure?: AnalysisFailure;

  /** Extra non-fatal conditions observed alongside the primary state. */
  warnings: AnalysisFailure[];

  /** Free-form structured context (paths, sizes, settings). */
  context?: Record<string, unknown>;
}

/** The settings subset the readiness layer needs (structural). */
export interface ReadinessSettings {
  enabled: boolean;
  chromiumPath: string;
  analyzeOnType: boolean;
  ignoredFiles: string[];
  maxFileSizeKb: number;
}

export interface ReadinessWorkspace {
  isTrusted: boolean;
  folders: WorkspaceFolderInfo[];
}

export interface ReadinessEnvironment {
  getSettings(): ReadinessSettings;
  getWorkspace(): ReadinessWorkspace;
  detector: BrowserDetector;
}

/** Per-file facts for the file-dimension readiness check. */
export interface FileReadinessInput {
  filePath: string;
  extension: string;
  scheme?: string;
  sizeBytes: number;
  isDirty: boolean;
}

const FILE_ELIGIBILITY_TO_REASON: Record<
  FileEligibility['reason'],
  ReadinessReason | null
> = {
  eligible: null,
  not_local_file: 'file_ineligible',
  unsupported_type: 'file_ineligible',
  generated_file: 'file_ignored',
  ignored_pattern: 'file_ignored',
  too_large: 'file_too_large',
};

export class EnvironmentReadiness {
  private readonly env: ReadinessEnvironment;

  constructor(env: ReadinessEnvironment) {
    this.env = env;
  }

  /**
   * The current environment readiness. Deterministic precedence:
   * disabled → unsupported workspace → untrusted workspace → browser.
   * Cached by the detector; never throws.
   */
  async evaluate(token?: CancellationTokenLike): Promise<ReadinessState> {
    const settings = this.env.getSettings();
    const workspace = this.env.getWorkspace();

    if (!settings.enabled) {
      return this.blocked('disabled', extensionDisabledFailure());
    }

    const workspaceKind = classifyWorkspace(workspace.folders);
    if (workspaceKind === 'unsupported') {
      return this.blocked(
        'unsupported_workspace',
        workspaceUnsupportedFailure(unsupportedWorkspaceReason(workspace.folders))
      );
    }

    if (!workspace.isTrusted) {
      return this.blocked('untrusted_workspace', workspaceUntrustedFailure());
    }

    // In untrusted workspaces the override is never executed: workspace-
    // provided strings must not run as browser paths.
    const allowOverride = workspace.isTrusted;
    const overridePath = allowOverride ? settings.chromiumPath : '';

    const detection = await this.env.detector.detect({ overridePath, allowOverride, token });

    const blocked = this.browserBlocked(detection.status);
    if (blocked) {
      return blocked;
    }

    const warnings = settings.analyzeOnType ? [liveAnalysisUnavailableFailure()] : [];
    return {
      ready: true,
      reason: 'ready',
      severity: 'info',
      recoverable: true,
      message: `Environment ready (${detection.executablePath ?? 'browser available'})`,
      warnings,
      context: { executablePath: detection.executablePath },
    };
  }

  /**
   * The file-dimension readiness (environment assumed ready). Deterministic
   * order: unsaved → eligibility. Reuses the same failure contracts as the
   * analysis layer so the gate and the runner never disagree.
   */
  fileReadiness(file: FileReadinessInput, settings: ReadinessSettings): ReadinessState {
    if (file.isDirty) {
      return this.blocked('file_requires_save', fileUnsavedFailure(file.filePath));
    }

    const eligibility = evaluateFileEligibility({
      filePath: file.filePath,
      extension: file.extension,
      scheme: file.scheme,
      sizeBytes: file.sizeBytes,
      ignoredPatterns: settings.ignoredFiles,
      maxFileSizeBytes: settings.maxFileSizeKb * 1024,
    });

    const reason = FILE_ELIGIBILITY_TO_REASON[eligibility.reason];
    if (reason !== null) {
      return this.blocked(reason, eligibility.failure, {
        message: eligibility.reasonText,
        context: eligibility.matchedPattern ? { matchedPattern: eligibility.matchedPattern } : undefined,
      });
    }

    return {
      ready: true,
      reason: 'ready',
      severity: 'info',
      recoverable: true,
      message: 'File is eligible for analysis',
      warnings: [],
    };
  }

  private browserBlocked(status: BrowserDetectionStatus): ReadinessState | null {
    switch (status) {
      case 'found':
      case 'not_attempted':
        return null;
      case 'not_found':
        return this.blocked('browser_not_found', browserNotFoundFailure());
      case 'path_invalid':
        return this.blocked(
          'browser_path_invalid',
          browserPathInvalidFailure(this.env.getSettings().chromiumPath)
        );
      case 'launch_failed':
        return this.blocked(
          'browser_launch_failed',
          browserLaunchFailedFailure(this.env.getSettings().chromiumPath || 'auto-detected browser')
        );
    }
  }

  private blocked(
    reason: ReadinessReason,
    failure: AnalysisFailure | undefined,
    extra: { message?: string; context?: Record<string, unknown> } = {}
  ): ReadinessState {
    return {
      ready: false,
      reason,
      severity: mapSeverity(failure?.severity),
      recoverable: failure?.recoverable ?? false,
      message: failure?.message ?? extra.message ?? 'Analysis is unavailable',
      failure,
      warnings: [],
      context: extra.context,
    };
  }
}