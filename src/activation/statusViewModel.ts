/**
 * Phase 3 (first-run & visibility): Show Status view model.
 *
 * Pure assembly of the Show Status content (heading, lines, actions) from
 * the Phase 2 readiness facts. No `vscode` dependency: actions are plain
 * data (command id + args) that the presentation layer executes, and the
 * whole model is unit-testable. No raw error messages, no full browser
 * paths.
 */

import { ReadinessState } from '../environment/readiness';
import { BrowserDetectionResult } from '../environment/browserDetection';
import { WorkspaceKind } from '../environment/workspace';
import { deriveStatus } from './statusModel';
import { COMMAND_IDS } from './constants';
import { coverageLines } from '../status/derive';
import { AnalysisOutcome } from '../failure/model';
import { SessionHealthSnapshot } from '../session/health';

/** The settings subset the views need (structural; vscode-free). */
export interface UiSettings {
  enabled: boolean;
  analyzeOnSave: boolean;
  analyzeOnType: boolean;
  chromiumPath: string;
  ignoredFiles: string[];
  maxFileSizeKb: number;
}

export interface ReadinessFacts {
  settings: UiSettings;
  /** null = no readiness snapshot yet. */
  readiness: ReadinessState | null;
  workspace: { isTrusted: boolean; kind: WorkspaceKind };
  detection: BrowserDetectionResult;
  firstRunCompleted: boolean;
  extensionVersion?: string;
  /** The active file, when one is open and relevant. */
  currentFile?: { fileName: string; eligible: boolean; reasonText: string };

  /** The most recent analysis outcome (coverage section source). */
  outcome?: AnalysisOutcome | null;

  /** The analysis-session health snapshot (Phase 5 session section). */
  session?: SessionHealthSnapshot | null;
}

export interface StatusLine {
  label: string;
  detail?: string;
}

/** A declarative action: the presentation layer executes `command`. */
export interface ViewAction {
  title: string;
  detail?: string;
  command: string;
  args?: unknown[];
}

export interface StatusView {
  heading: string;
  lines: StatusLine[];
  actions: ViewAction[];
}

/** Standard commands the view model may propose. */
export const OPEN_SETTINGS_COMMAND = 'workbench.action.openSettings';
export const SHOW_OUTPUT_COMMAND = 'noEffect.showOutputLogs';

/** Short, non-path labels for the browser detection source. */
function detectionSource(detection: BrowserDetectionResult): string {
  switch (detection.detectedVia) {
    case 'configured_override':
      return 'configured browser path';
    case 'auto_detect':
      return 'auto-detected';
    default:
      return '';
  }
}

export function buildStatusView(facts: ReadinessFacts): StatusView {
  const { settings, readiness, workspace, detection } = facts;
  const presentation = deriveStatus(settings.enabled, readiness, true);
  const lines: StatusLine[] = [];

  lines.push({
    label: `Extension: ${settings.enabled ? 'enabled' : 'disabled'}`,
    detail: facts.extensionVersion ? `v${facts.extensionVersion}` : undefined,
  });

  if (settings.enabled) {
    const source = detectionSource(detection);
    lines.push({
      label: `Browser: ${detection.status.replace(/_/g, ' ')}`,
      detail: source ? `via ${source}` : undefined,
    });
    lines.push({
      label: `Workspace trust: ${workspace.isTrusted ? 'trusted' : 'untrusted'}`,
    });
    lines.push({ label: `Workspace support: ${workspace.kind}` });

    if (facts.currentFile) {
      const file = facts.currentFile;
      lines.push({
        label: `Current file: ${file.fileName}`,
        detail: file.eligible ? 'eligible for analysis' : file.reasonText,
      });
    }

    if (readiness !== null && readiness.warnings.length > 0) {
      lines.push({
        label: `Warnings: ${readiness.warnings.map((w) => w.code).join(', ')}`,
        detail: 'shown in the output channel',
      });
    }

lines.push({
    label: `First-run welcome: ${facts.firstRunCompleted ? 'shown' : 'not shown yet'}`,
  });
  }

  if (facts.outcome) {
    const coverage = coverageLines(facts.outcome);
    if (coverage.length > 0) {
      lines.push({ label: '─ Coverage (last analysis) ─', detail: undefined });
      for (const line of coverage) {
        lines.push(line);
      }
    }
  }

  if (facts.session) {
    const session = facts.session;
    lines.push({ label: '─ Analysis session ─', detail: undefined });
    lines.push({
      label: `Session state: ${session.state.replace(/_/g, ' ')}`,
      detail: `epoch ${session.epoch}`,
    });
    lines.push({
      label: `Counters: ${session.counters.crashes} crash(es) · ` +
        `${session.counters.recoveries} recovery(ies) · ${session.counters.restarts} restart(s)`,
    });
  }

  lines.push({
    label: 'Logs',
    detail: 'Open the NoEffect output channel for the full detail',
  });

  return {
    heading: presentation.text,
    lines,
    actions: [
      {
        title: 'NoEffect: Analyze CSS Inactive Properties',
        detail: 'Run an analysis on the active file',
        command: COMMAND_IDS.analyzeCurrentFile,
      },
      {
        title: 'NoEffect: Diagnose Setup',
        detail: 'Inspect the environment (browser, workspace, settings)',
        command: COMMAND_IDS.diagnoseSetup,
      },
      {
        title: 'Open Settings',
        detail: 'Adjust NoEffect settings (browser path, file size, ...)',
        command: OPEN_SETTINGS_COMMAND,
        args: ['noEffect'],
      },
      {
        title: 'Show Output',
        detail: 'Open the NoEffect output channel',
        command: SHOW_OUTPUT_COMMAND,
      },
    ],
  };
}
