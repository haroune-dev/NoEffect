/**
 * Browser environment detection and validation (Phase 2: environment
 * readiness).
 *
 * NoEffect requires a local Chromium-based browser (Chrome, Chromium, Edge,
 * Brave, ...). This module answers the question "is a usable browser
 * available?" WITHOUT launching a full browser session:
 *
 *   - the user-configured `noEffect.chromiumPath` override is checked first,
 *     validated (exists + executable), then confirmed with a lightweight
 *     `--version` probe (bounded by a timeout; on Windows an existence
 *     check replaces the probe — desktop chrome.exe/msedge.exe do not
 *     answer `--version` usefully),
 *   - otherwise platform-appropriate common install locations and PATH
 *     executables are probed in a deterministic order,
 *   - results are cached until `invalidate()` (settings change) or an
 *     explicit re-check, so the probe cost is paid once,
 *   - nothing is ever executed through a shell: `spawn` with an argument
 *     array only, and workspace-provided strings are never used as browser
 *     paths in untrusted workspaces (the caller drops `allowOverride`).
 *
 * The module is vscode-free and fully injectable (platform, fs, spawn, env)
 * so it stays unit-testable without a real browser installed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { logger } from '../utils/logger';
import { CancellationTokenLike } from '../failure/cancellation';

export type BrowserDetectionStatus =
  | 'not_attempted'
  | 'found'
  | 'not_found'
  | 'path_invalid'
  | 'launch_failed';

export interface BrowserDetectionResult {
  status: BrowserDetectionStatus;

  /** Absolute path of the usable browser executable (only when `found`). */
  executablePath?: string;

  /** How the executable was located (only when `found`). */
  detectedVia?: 'configured_override' | 'auto_detect';

  /** Stable, human-readable detail for readiness/output-channel use. */
  message: string;

  /** Epoch ms of the last detection (0 = never checked). */
  checkedAt: number;
}

export interface DetectOptions {
  /** The effective `noEffect.chromiumPath` ('' = auto-detect). */
  overridePath?: string;

  /**
   * Whether the override may be executed. False in untrusted workspaces —
   * workspace-provided strings must never run as browser paths there.
   */
  allowOverride?: boolean;

  /** Cancels an in-flight detection (resolves as `not_attempted`). */
  token?: CancellationTokenLike;
}

export interface BrowserDetectorOptions {
  platform?: NodeJS.Platform;
  existsSync?: (p: string) => boolean;
  spawnFn?: typeof spawn;
  env?: NodeJS.ProcessEnv;
  /** Timeout for each `--version` probe. */
  versionTimeoutMs?: number;
}

/** Default `--version` probe timeout: fast, isolated, bounded. */
export const DEFAULT_VERSION_TIMEOUT_MS = 5000;

/** Well-known Chromium-based executable names for PATH lookup. */
const PATH_CANDIDATES: string[] = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'microsoft-edge-stable',
  'brave-browser',
  'vivaldi',
  'opera',
];

/** macOS application bundle executables (deterministic order). */
const MACOS_APP_CANDIDATES: string[] = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
  '/Applications/Opera.app/Contents/MacOS/Opera',
];

/** Windows install locations derived from the process environment. */
function windowsCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(
    (root): root is string => Boolean(root)
  );
  for (const root of roots) {
    candidates.push(
      path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(root, 'Chromium', 'Application', 'chrome.exe')
    );
  }
  return candidates;
}

export class BrowserDetector {
  private readonly platform: NodeJS.Platform;
  private readonly existsSync: (p: string) => boolean;
  private readonly spawnFn: typeof spawn;
  private readonly env: NodeJS.ProcessEnv;
  private readonly versionTimeoutMs: number;

  private cached: BrowserDetectionResult | null = null;

  constructor(options: BrowserDetectorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.existsSync = options.existsSync ?? fs.existsSync;
    this.spawnFn = options.spawnFn ?? spawn;
    this.env = options.env ?? process.env;
    this.versionTimeoutMs = options.versionTimeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;
  }

  /**
   * The cached result without re-running detection. `not_attempted` until
   * the first `detect()` call.
   */
  getCachedResult(): BrowserDetectionResult {
    return (
      this.cached ?? {
        status: 'not_attempted',
        message: 'Browser detection has not run yet',
        checkedAt: 0,
      }
    );
  }

  /**
   * Drop the cached result so the next `detect()` re-checks the
   * environment (settings change, diagnostics/retry flow).
   */
  invalidate(): void {
    this.cached = null;
  }

  /**
   * Record that a browser executable was successfully launched (used by
   * the lifecycle after a real launch) so future detection skips the probe.
   */
  recordFound(executablePath: string, detectedVia: 'configured_override' | 'auto_detect'): void {
    this.cached = {
      status: 'found',
      executablePath,
      detectedVia,
      message: `Browser confirmed by launch: ${executablePath}`,
      checkedAt: Date.now(),
    };
  }

  /**
   * Detect a usable Chromium-based browser. Deterministic, cached, and
   * never executed through a shell. Resolves a result — never throws.
   */
  async detect(options: DetectOptions = {}): Promise<BrowserDetectionResult> {
    if (this.cached) {
      return this.cached;
    }

    const overridePath = (options.overridePath ?? '').trim();

    // Configured override: validated first, wins when usable.
    if (overridePath && options.allowOverride !== false) {
      const result = await this.detectOverride(overridePath, options.token);
      if (result) {
        this.cached = result;
        return result;
      }
    }

    // Auto-detection: platform-appropriate candidates in deterministic order.
    const candidates = this.candidateList();
    let firstFailure: { executablePath: string } | null = null;

    for (const candidate of candidates) {
      const absolute = path.isAbsolute(candidate);
      if (absolute && !this.existsSync(candidate)) {
        continue;
      }
      if (await this.isUsable(candidate, options.token)) {
        const result: BrowserDetectionResult = {
          status: 'found',
          executablePath: candidate,
          detectedVia: 'auto_detect',
          message: `Found browser: ${candidate}`,
          checkedAt: Date.now(),
        };
        this.cached = result;
        logger.debug(`[Environment] Browser found: ${candidate}`);
        return result;
      }
      if (options.token?.isCancellationRequested) {
        return this.cancelledResult();
      }
      firstFailure ??= { executablePath: candidate };
    }

    const result: BrowserDetectionResult =
      firstFailure === null
        ? {
            status: 'not_found',
            message: 'No Chromium-based browser was found on this system',
            checkedAt: Date.now(),
          }
        : {
            status: 'launch_failed',
            message: `Browser executable exists but could not be launched: ${firstFailure.executablePath}`,
            checkedAt: Date.now(),
          };
    this.cached = result;
    return result;
  }

  /** Validate + probe the user-configured override. Null = unusable. */
  private async detectOverride(
    overridePath: string,
    token?: CancellationTokenLike
  ): Promise<BrowserDetectionResult | null> {
    if (!this.existsSync(overridePath)) {
      return {
        status: 'path_invalid',
        message: `Configured browser path does not exist: ${overridePath}`,
        checkedAt: Date.now(),
      };
    }

    if (await this.isUsable(overridePath, token)) {
      return {
        status: 'found',
        executablePath: overridePath,
        detectedVia: 'configured_override',
        message: `Found browser: ${overridePath}`,
        checkedAt: Date.now(),
      };
    }
    if (token?.isCancellationRequested) {
      return null;
    }
    return {
      status: 'path_invalid',
      message: `Configured browser path is not a usable browser executable: ${overridePath}`,
      checkedAt: Date.now(),
    };
  }

  /**
   * Usability check for one candidate executable.
   *
   * On Windows the classic `--version` probe is useless: desktop
   * chrome.exe/msedge.exe print nothing for `--version`, may stay alive
   * forwarding to an existing instance, and — run headed with no profile
   * isolation — can open a visible browser window while it hangs. The
   * bounded probe then times out and a working install is reported as
   * missing. Windows therefore validates by file existence (the real
   * launch surfaces any deeper problem, with diagnosable output);
   * POSIX keeps the live `--version` probe.
   */
  private async isUsable(executablePath: string, token?: CancellationTokenLike): Promise<boolean> {
    if (this.platform === 'win32') {
      return this.existsSync(executablePath);
    }
    return this.probeVersion(executablePath, token);
  }

  /**
   * Lightweight `--version` probe: spawn with an argument array (never a
   * shell), bounded by a timeout, then kill. Exit code 0 = usable.
   */
  private probeVersion(executablePath: string, token?: CancellationTokenLike): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      let child: ChildProcess | null = null;
      const cancelSub: { dispose(): void } | undefined =
        token?.onCancellationRequested(() => finish(false));

      const finish = (usable: boolean) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          cancelSub?.dispose();
          child?.kill();
          resolve(usable);
        }
      };

      const timer = setTimeout(() => finish(false), this.versionTimeoutMs);

      try {
        child = this.spawnFn(executablePath, ['--version'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch {
        finish(false);
        return;
      }

      child.once('error', () => finish(false));
      child.once('exit', (code) => finish(code === 0));
      child.once('close', (code) => finish(code === 0));
    });
  }

  private candidateList(): string[] {
    switch (this.platform) {
      case 'darwin':
        return [...MACOS_APP_CANDIDATES, ...PATH_CANDIDATES];
      case 'win32':
        return [...windowsCandidates(this.env), ...PATH_CANDIDATES];
      case 'linux':
        return [...PATH_CANDIDATES];
      default:
        return [];
    }
  }

  private cancelledResult(): BrowserDetectionResult {
    return {
      status: 'not_attempted',
      message: 'Browser detection was cancelled',
      checkedAt: Date.now(),
    };
  }
}

/** Shared detector instance used by the extension and the runner. */
export const browserDetector = new BrowserDetector();
