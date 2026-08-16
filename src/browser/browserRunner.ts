import { logger } from '../utils/logger';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isProcessAlive, killProcessTree, signalProcessGroup } from '../session/processTree';
import { RETRY_POLICY } from '../session/policy';
import { withTimeout } from '../session/timing';
import { removeTempDir } from '../session/tempProfile';
import { redactLine } from '../session/redaction';

/**
 * Flags that disable irrelevant browser features so the headless instance
 * stays quiet, isolated and fast. `--user-data-dir` is added dynamically
 * (a fresh temp profile per launch - never the user's real profile).
 */
const LAUNCH_FLAGS = [
  '--headless',
  '--remote-debugging-port=0',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
  '--disable-translate',
  '--disable-notifications',
  '--disable-popup-blocking',
  '--hide-scrollbars',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-first-run',
  '--no-default-browser-check',
  '--no-service-autorun',
  '--password-store=basic',
  '--safebrowsing-disable-auto-update'
];

/** Bounded, redacted stderr/startup excerpt kept for diagnostics. */
export const STDERR_TAIL_LIMIT = 10;

export interface BrowserRunnerOptions {
  /** Injectable spawn (unit tests never touch a real browser). */
  spawnFn?: typeof spawn;
  /** Injectable temp-dir provider (isolated profile location). */
  tempDirFn?: () => string;
}

interface ManagedProcess {
  child: ChildProcess;
  pid: number;
}

export class BrowserRunner {
  private readonly spawnFn: typeof spawn;
  private readonly tempDirFn: () => string;
  private running: boolean = false;
  private managed: ManagedProcess | null = null;
  private profileDir: string | null = null;
  private readonly exitListeners: Array<(code: number | null, expected: boolean) => void> = [];
  private readonly stderrTailLines: string[] = [];

  constructor(options: BrowserRunnerOptions = {}) {
    this.spawnFn = options.spawnFn ?? spawn;
    this.tempDirFn = options.tempDirFn ?? (() => fs.mkdtempSync(path.join(os.tmpdir(), 'noeffect-')));
  }

  /**
   * Launch a headless Chromium instance with remote debugging enabled.
   * Returns the WebSocket debug URL. The child is detached (its own process
   * group on POSIX) so the whole tree can be killed deterministically.
   */
  async launch(chromiumPath: string = 'google-chrome'): Promise<string> {
    logger.info(`[Browser] Launching ${chromiumPath}...`);

    this.profileDir = this.tempDirFn();
    const detached = process.platform !== 'win32';
    const child = this.spawnFn(chromiumPath, [...LAUNCH_FLAGS, `--user-data-dir=${this.profileDir}`], {
      detached,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const pid = typeof child.pid === 'number' ? child.pid : NaN;
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error('Browser process did not start (no pid assigned)');
    }
    this.managed = { child, pid };
    this.running = true;

    try {
      return await withTimeout(
        this.waitForDebugUrl(pid),
        RETRY_POLICY.browser_launch.timeoutMs,
        `Timed out waiting for Chromium CDP endpoint (${chromiumPath})`
      );
    } catch (err) {
      // A failed launch must not leave a stray browser behind.
      await killProcessTree(pid);
      await this.discardProfile();
      throw err;
    }
  }

  /** Resolve the DevTools WS URL from the child's output (or fail fast). */
  private waitForDebugUrl(pid: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let resolved = false;
      const fail = (err: Error) => {
        if (resolved) return;
        resolved = true;
        reject(err);
      };
      const resolveWith = (url: string) => {
        if (resolved) return;
        resolved = true;
        logger.info(`[Browser] CDP WebSocket URL: ${url}`);
        resolve(url);
      };

      const child = this.managed?.child;
      if (!child) {
        fail(new Error('Browser process not managed'));
        return;
      }

      const onData = (data: Buffer) => {
        const text = data.toString();
        // Bounded, redacted stderr excerpt for diagnostics.
        for (const line of text.split(/\r?\n/)) {
          if (line.length > 0) {
            this.stderrTailLines.push(redactLine(line));
            if (this.stderrTailLines.length > STDERR_TAIL_LIMIT) {
              this.stderrTailLines.shift();
            }
          }
        }
        const match = text.match(/DevTools listening on (ws:\/\/.*)\n/);
        if (match) {
          resolveWith(match[1]);
        }
      };
      child.stderr?.on('data', onData);
      child.stdout?.on('data', onData);

      child.on('error', (err) => {
        logger.error(`[Browser] Failed to launch browser: ${err.message}`);
        fail(err);
      });

      child.on('close', (code) => {
        if (this.managed?.pid !== pid) {
          return; // a replaced process's close never counts as a crash
        }
        this.terminate(pid, code);
        if (!resolved) {
          fail(new Error(`Chromium exited before reporting its CDP endpoint (code ${code})`));
        }
      });
    });
  }

  /** The browser exited. Mark dead, clean profile, notify listeners. */
  private terminate(pid: number, code: number | null): void {
    if (!this.managed || this.managed.pid !== pid) {
      return;
    }
    this.managed = null;
    this.running = false;
    this.discardProfile();
    for (const listener of this.exitListeners) {
      listener(code, false);
    }
  }

  /** Register a callback invoked when the Chromium process exits. */
  onExit(listener: (code: number | null, expected: boolean) => void): void {
    this.exitListeners.push(listener);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** The managed browser pid (null when nothing is running). */
  get pid(): number | null {
    return this.managed?.pid ?? null;
  }

  /** Whether the current browser process is provably alive. */
  isAlive(): boolean {
    return this.pid !== null && isProcessAlive(this.pid);
  }

  /** Bounded, redacted startup/error excerpt for diagnostics. */
  stderrTail(): string[] {
    return this.stderrTailLines.slice();
  }

  /** Whether a Chromium executable can actually launch somewhere handy. */
  static async isAvailable(chromiumPath: string = 'google-chrome'): Promise<boolean> {
    const runner = new BrowserRunner();
    try {
      await runner.launch(chromiumPath);
      return true;
    } catch {
      return false;
    } finally {
      await runner.shutdown();
    }
  }

  /**
   * Deliberate shutdown of the browser and its whole process tree
   * (process group on POSIX, taskkill /T /F on Windows). Listeners see
   * `expected = true` because the managed record is detached first.
   */
  async shutdown(): Promise<void> {
    const managed = this.managed;
    if (managed) {
      logger.info('[Browser] shutdown');
      this.managed = null;
      this.running = false;
      await killProcessTree(managed.pid);
      for (const listener of this.exitListeners) {
        listener(null, true);
      }
    } else {
      this.running = false;
    }
    await this.discardProfile();
  }

  /** Crash the instance WITHOUT detaching listeners (test simulation). */
  kill(): void {
    const managed = this.managed;
    if (managed) {
      logger.info('[Browser] kill (crash simulation)');
      try {
        managed.child.kill('SIGKILL');
      } catch {
        signalProcessGroup(managed.pid, 'SIGKILL');
      }
    }
  }

  private async discardProfile(): Promise<void> {
    const dir = this.profileDir;
    this.profileDir = null;
    if (dir) {
      logger.info(`[Browser] Removing temp profile ${dir}`);
      const removed = await removeTempDir(dir);
      if (!removed) {
        logger.warn('[Browser] Temp profile could not be removed; it will be swept later');
      }
    }
  }

  dispose(): void {
    void this.shutdown();
  }
}