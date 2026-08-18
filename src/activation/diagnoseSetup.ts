/**
 * Phase 3 (first-run & visibility) + Phase 5: Diagnose Setup diagnostics.
 *
 * Deterministic, safe collection of an environment report:
 *   - `collectDiagnostics` — legacy flat lines (output channel + Quick Pick);
 *   - `collectDiagnoseReport` — the Phase 5 structured per-check report
 *     (isolated checks, redacted, session-aware).
 *
 * Lines are readable and non-technical where possible, include actionable
 * hints, never expose secrets or environment variables, and mark stale
 * detection explicitly. The presentation (output channel + Quick Pick) lives
 * in the activation layer.
 */

import { ReadinessFacts } from './statusViewModel';
import { SessionHealthSnapshot } from '../session/health';
import { DiagnoseCheckResult, DrGroup } from '../session/report';

/** Validity of the configured browser path, derived from detection. */
export type ConfiguredPathValidity = 'valid' | 'invalid' | 'not_set' | 'unknown';

export function configuredPathValidity(facts: ReadinessFacts): ConfiguredPathValidity {
  const { settings, detection } = facts;
  if (!settings.chromiumPath) {
    return 'not_set';
  }
  switch (detection.status) {
    case 'found':
      return detection.detectedVia === 'configured_override' ? 'valid' : 'unknown';
    case 'path_invalid':
      return 'invalid';
    default:
      return 'unknown';
  }
}

/** The next action hint for the current readiness reason. */
export function setupHint(facts: ReadinessFacts): string {
  const { settings, readiness } = facts;
  if (!settings.enabled) {
    return 'Enable the noEffect.enabled setting to analyze CSS.';
  }
  if (readiness === null) {
    return 'Run Diagnose Setup again once the environment has been checked.';
  }
  switch (readiness.reason) {
    case 'ready':
      return 'No action needed - NoEffect is ready to analyze CSS.';
    case 'browser_not_found':
      return 'Install Chrome, Chromium or Edge, or set noEffect.chromiumPath to a browser executable.';
    case 'browser_path_invalid':
      return 'Open Settings and fix noEffect.chromiumPath - it does not point to a usable browser.';
    case 'browser_launch_failed':
      return 'The detected browser could not be launched; run Diagnose Setup again to retry.';
    case 'untrusted_workspace':
      return 'Trust this workspace to allow local browser analysis.';
    case 'unsupported_workspace':
      return 'Open the files from a local folder - this workspace type cannot run a local browser analysis.';
    case 'disabled':
      return 'Enable the noEffect.enabled setting to analyze CSS.';
    default:
      return 'Run Show Status for a shorter summary of the current state.';
  }
}

/** One deterministic check cell with a stable status. */
function check(
  result: Partial<DiagnoseCheckResult> & { id: string; label: string }
): DiagnoseCheckResult {
  return { status: 'ok', ...result };
}

/**
 * Phase 5: the structured, per-check report from the readiness facts and the
 * live session-health snapshot. Each check is isolated upstream (a thrown
 * check never breaks the report) and the content is redacted at render time.
 */
export function collectDiagnoseReport(
  facts: ReadinessFacts,
  session?: SessionHealthSnapshot | null,
  probe?: { ok: boolean; detail?: string } | null
): { hint: string; groups: DrGroup[] } {
  const environmentGroup: DrGroup = {
    group: 'environment',
    checks: [
      check({
        id: 'extension.enabled',
        label: 'Extension enabled',
        status: facts.settings.enabled ? 'ok' : 'fail',
        detail: facts.settings.enabled ? undefined : 'the noEffect.enabled setting is off',
      }),
      check({
        id: 'workspace.trust',
        label: 'Workspace trusted',
        status: facts.workspace.isTrusted ? 'ok' : 'fail',
        detail: facts.workspace.isTrusted ? undefined : 'analyses are skipped until the workspace is trusted',
      }),
      check({
        id: 'workspace.support',
        label: 'Workspace supports local browser analysis',
        status: facts.workspace.kind === 'local' ? 'ok' : 'fail',
        detail: facts.workspace.kind === 'local' ? undefined : `workspace kind is '${facts.workspace.kind}'`,
      }),
    ],
  };

  const detection = facts.detection;
  const browserGroup: DrGroup = {
    group: 'browser',
    checks: [
      check({
        id: 'browser.detection',
        label: 'Browser found',
        status:
          detection.status === 'found'
            ? 'ok'
            : detection.status === 'path_invalid' || detection.status === 'launch_failed'
              ? 'fail'
              : 'warn',
        detail: detection.message || undefined,
      }),
      check({
        id: 'browser.path',
        label: 'Configured browser path',
        status: (() => {
          const validity = configuredPathValidity(facts);
          return validity === 'valid' ? 'ok' : validity === 'invalid' ? 'fail' : 'warn';
        })(),
        detail:
          facts.settings.chromiumPath === ''
            ? 'auto-detect (no path configured)'
            : (() => {
                const validity = configuredPathValidity(facts);
                return `configured path is ${
                  validity === 'valid'
                    ? 'usable'
                    : validity === 'invalid'
                      ? 'not usable'
                      : 'unverified'
                }`;
              })(),
      }),
      check({
        id: 'browser.stale',
        label: 'Browser detection is fresh',
        status: detection.checkedAt > 0 ? 'ok' : 'warn',
        detail: detection.checkedAt > 0 ? undefined : 'detection has not run yet (stale)',
      }),
    ],
  };

  const sessionGroup: DrGroup = {
    group: 'session',
    checks: !session
      ? [
          check({
            id: 'session.health',
            label: 'Analysis session',
            status: 'skipped',
            skipReason: 'no session snapshot available',
          }),
        ]
      : [
          check({
            id: 'session.health',
            label: `Session state=${session.state.replace(/_/g, ' ')}`,
            status:
              session.state === 'ready'
                ? 'ok'
                : session.state === 'none'
                  ? 'warn'
                  : session.state === 'dead'
                    ? 'fail'
                    : 'warn',
            detail: `epoch ${session.epoch}`,
          }),
          check({
            id: 'session.counters',
            label: 'Session counters',
            status: 'ok',
            detail: `${session.counters.crashes} crash(es), ${session.counters.recoveries} recovery(ies), ${session.counters.restarts} restart(s)`,
          }),
        ],
  };

  const fileGroup: DrGroup = {
    group: 'file',
    checks: facts.currentFile
      ? [
          check({
            id: 'file.eligibility',
            label: 'Active file is analyzable',
            status: facts.currentFile.eligible ? 'ok' : 'warn',
            detail: facts.currentFile.eligible ? undefined : facts.currentFile.reasonText,
          }),
        ]
      : [
          check({
            id: 'file.eligibility',
            label: 'Active file',
            status: 'skipped',
            skipReason: 'no CSS/HTML file is open',
          }),
        ],
  };

  const groups: DrGroup[] = [environmentGroup, browserGroup, sessionGroup, fileGroup];

  if (probe) {
    groups.push({
      group: 'probe',
      checks: [
        check({
          id: 'probe.live',
          label: 'Live browser probe',
          status: probe.ok ? 'ok' : 'fail',
          detail: probe.detail,
        }),
      ],
    });
  }

  return { hint: setupHint(facts), groups };
}

/**
 * Collect the legacy flat diagnostics lines. Deterministic, sanitized (no
 * secrets, no environment variables, no stack traces), stale-aware.
 */
export function collectDiagnostics(facts: ReadinessFacts): string[] {
  const { settings, readiness, workspace, detection } = facts;
  const lines: string[] = [];

  lines.push(
    `NoEffect setup diagnostics${facts.extensionVersion ? ` (v${facts.extensionVersion})` : ''}`
  );
  lines.push(`Extension enabled: ${settings.enabled ? 'yes' : 'no'}`);
  lines.push(`Workspace trust: ${workspace.isTrusted ? 'trusted' : 'untrusted'}`);
  lines.push(`Workspace support: ${workspace.kind}`);

  const checked =
    detection.checkedAt > 0
      ? new Date(detection.checkedAt).toISOString()
      : 'never (stale - detection has not run yet)';
  const detectedVia =
    detection.detectedVia === 'configured_override'
      ? 'configured browser path'
      : detection.detectedVia === 'auto_detect'
        ? 'auto-detected'
        : '';
  lines.push(
    `Browser detection: ${detection.status.replace(/_/g, ' ')}${detectedVia ? ` (${detectedVia})` : ''}`
  );
  lines.push(`Browser detection checked: ${checked}`);

  if (settings.chromiumPath) {
    lines.push(`Configured browser path: ${settings.chromiumPath}`);
    lines.push(`Configured path usable: ${configuredPathValidity(facts)}`);
  } else {
    lines.push('Configured browser path: not set (auto-detect)');
  }

  if (facts.currentFile) {
    const file = facts.currentFile;
    lines.push(
      `Current file: ${file.fileName} - ${file.eligible ? 'eligible for analysis' : file.reasonText}`
    );
  } else {
    lines.push('Current file: none open');
  }

  lines.push(
    `Settings: analyzeOnSave=${settings.analyzeOnSave ? 'on' : 'off'}, ` +
      `analyzeOnType=${settings.analyzeOnType ? 'on' : 'off'}, ` +
      `ignoredFiles=${settings.ignoredFiles.length}, ` +
      `maxFileSizeKb=${settings.maxFileSizeKb}`
  );

  if (readiness !== null) {
    lines.push(`Readiness: ${readiness.reason} (${readiness.severity}) - ${readiness.message}`);
    for (const warning of readiness.warnings) {
      lines.push(`Warning [${warning.code}]: ${warning.message}`);
    }
  } else {
    lines.push('Readiness: unknown (environment check has not completed)');
  }

  lines.push(`First-run welcome: ${facts.firstRunCompleted ? 'shown' : 'not shown yet'}`);
  lines.push(`Hint: ${setupHint(facts)}`);

  return lines;
}