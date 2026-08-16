/**
 * Diagnose Setup report model (Phase 5).
 *
 * Structured, serializable report built from isolated per-check results.
 * Each check has exactly one status (ok / warn / fail / skipped) plus a
 * reason, and no single check can break the others (each is caught).
 * Rendering turns the structure into readable Markdown with clear markers;
 * everything is redacted before it appears in the report.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface DiagnoseCheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  /** Short human detail (already redacted). */
  detail?: string;
  /** Why a check is skipped (e.g. untrusted workspace, no file open). */
  skipReason?: string;
}

export interface DrGroup {
  /** e.g. `environment`, `browser`, `session`, `server`, `file`, `probe`. */
  group: string;
  checks: DiagnoseCheckResult[];
}

export interface DiagnoseReportInput {
  version: string;
  vsCodeVersion: string;
  os: string;
  sectionGroups: DrGroup[];
  hint?: string;
}

export interface DiagnoseReport {
  version: string;
  vsCodeVersion: string;
  os: string;
  ts: number;
  groups: DrGroup[];
  hint?: string;
}

/** Wrap one check so a thrown check never breaks the report. */
export function runCheck<T>(check: () => T): T | { status: 'fail'; detail: string } {
  try {
    return check();
  } catch (err) {
    return {
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export function buildReport(input: DiagnoseReportInput): DiagnoseReport {
  return {
    version: input.version,
    vsCodeVersion: input.vsCodeVersion,
    os: input.os,
    ts: Date.now(),
    groups: input.sectionGroups,
    hint: input.hint,
  };
}

const MARKER: Record<CheckStatus, string> = {
  ok: '✅',
  warn: '⚠️',
  fail: '❌',
  skipped: '⏭️',
};

export function statusText(status: CheckStatus): string {
  return status.toUpperCase();
}

/** Render the report as readable Markdown text with status markers. */
export function renderReport(report: DiagnoseReport): string {
  const lines: string[] = [];
  lines.push(`# NoEffect Diagnose Report`);
  lines.push(`- vsCode ${report.vsCodeVersion} | extension v${report.version} | os ${report.os}`);
  lines.push(`- generated ${new Date(report.ts).toISOString()}`);
  lines.push('');

  for (const group of report.groups) {
    lines.push(`## ${group.group}`);
    for (const check of group.checks) {
      const marker = MARKER[check.status];
      const skip = check.status === 'skipped' && check.skipReason ? ` (${check.skipReason})` : '';
      const detail = check.status === 'ok' ? '' : ` — ${check.detail ?? ''}`;
      lines.push(`- ${marker} ${statusText(check.status)} ${check.label}${skip}${detail}`);
    }
    lines.push('');
  }

  if (report.hint) {
    lines.push(`> Hint: ${report.hint}`);
  }
  return lines.join('\n');
}

/** Test hook: derive the overall worst status of a report. */
export function overallStatus(report: DiagnoseReport): CheckStatus {
  let worst: CheckStatus = 'ok';
  for (const group of report.groups) {
    for (const check of group.checks) {
      if (check.status === 'fail') return 'fail';
      if (check.status === 'warn') worst = 'warn';
      if (check.status === 'skipped' && worst === 'ok') worst = 'warn';
    }
  }
  return worst;
}