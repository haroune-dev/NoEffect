/**
 * Process-tree hygiene (Phase 5) — vendored, no runtime dependency.
 *
 * The browser is spawned detached (its own process group on POSIX) and the
 * leader's pid is tracked in a managed record. When a session dies we must
 * ensure NO child of the browser survives us, so we kill the whole group:
 *
 *  POSIX:  `process.kill(-pid, 'SIGTERM')` → wait 1250ms → `SIGKILL`,
 *          then poll `isProcessAlive(pid)` until it is gone (bounded).
 *  Windows: `taskkill /pid <pid> /T /F` (tree + force) via spawn.
 *
 * The argument construction for both platforms is a pure function so it is
 * unit-testable without touching the OS; `killProcessTree` is the timed,
 * bounded orchestrator.
 */

import { spawn } from 'child_process';
import { logger } from '../utils/logger';
import { sleep } from './timing';
import { RETRY_POLICY } from './policy';

export const GRACEFUL_KILL_DELAY_MS = 1250;

export interface KillPlan {
  /** Signalling-style kill to attempt first (POSIX only). */
  signal?: NodeJS.Signals | 'SIGTERM' | 'SIGKILL';
  /** Windows command + arguments (taskkill). */
  taskkill?: string[];
}

/**
 * Build the kill plan for a pid on a given platform. Pure and assertable.
 */
export function buildKillPlan(pid: number, platform: NodeJS.Platform = process.platform): KillPlan {
  if (platform === 'win32') {
    return { taskkill: ['/pid', String(pid), '/T', '/F'] };
  }
  return { signal: 'SIGTERM' };
}

/** Whether a pid is currently alive (SIG 0 probe, safe on POSIX). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      return true;
    }
    return false;
  }
}

/** Send a signal to the whole process group (POSIX detached spawn). */
export function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') {
      logger.warn(`[ProcessTree] Could not signal group -${pid}: ${code ?? String(err)}`);
    }
  }
}

/** Run `taskkill /pid /T /F` and resolve when it spawned (bounded). */
export function runTaskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } catch {
      resolve();
      return;
    }
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}

/**
 * Kill a browser process tree deterministically and confirm the leader is
 * gone (bounded). Returns `true` when the pid confirmed dead.
 */
export async function killProcessTree(pid: number): Promise<boolean> {
  const plan = buildKillPlan(pid);
  const cleanupTimeout = RETRY_POLICY.restart_cleanup.timeoutMs;

  if (plan.taskkill) {
    await runTaskkill(pid);
    await sleep(250);
    return !isProcessAlive(pid);
  }

  signalProcessGroup(pid, 'SIGTERM');
  await sleep(GRACEFUL_KILL_DELAY_MS);
  if (isProcessAlive(pid)) {
    signalProcessGroup(pid, 'SIGKILL');
  }

  const deadline = Date.now() + cleanupTimeout;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(100);
  }
  return !isProcessAlive(pid);
}