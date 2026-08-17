/**
 * Temp profile management (Phase 5).
 *
 * The browser runs with an isolated `noeffect-*` temp profile. This module
 * owns creating those dirs, removing them with backoff retries (Windows
 * locks fail transiently), and the best-effort activation sweep of stale
 * profiles older than `STALE_TEMP_MAX_AGE_MS` (24h). All operations are
 * bounded and never throw.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const TEMP_PREFIX = 'noeffect-';
export const STALE_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Retry schedule for temp-dir removal. */
export const TEMP_RETRY_DELAYS_MS = [100, 250, 500] as const;

/** Create a fresh temp dir with the standard prefix. */
export function createTempDir(prefix: string = TEMP_PREFIX): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Force-remove a temp dir with retry delays (Windows lock-persistence).
 * Resolves true on success; false after all retries (caller may log/sweep).
 *
 * Non-blocking: removal runs through `fs.promises.rm` so the extension-host
 * thread is never stalled by a large recursive delete (P3-PERF-36). Paths
 * outside the `noeffect-*` temp namespace are refused outright — this
 * primitive must never be an unguarded rm-rf on an arbitrary path.
 */
export async function removeTempDir(dir: string, maxAttempts: number = 3): Promise<boolean> {
  if (!isContainedTempDir(dir)) {
    return false;
  }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      if (!(await pathExists(dir))) {
        return true;
      }
    } catch {
      // locked dir — retry after backoff
    }
    if (attempt < maxAttempts - 1) {
      await delay(TEMP_RETRY_DELAYS_MS[Math.min(attempt, TEMP_RETRY_DELAYS_MS.length - 1)]);
    }
  }
  return !(await pathExists(dir));
}

/** The target must live under the OS temp root AND carry `noeffect-` in its name. */
function isContainedTempDir(dir: string): boolean {
  const resolved = path.resolve(dir);
  const relative = path.relative(path.resolve(os.tmpdir()), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }
  return path.basename(resolved).startsWith(TEMP_PREFIX);
}

async function pathExists(dir: string): Promise<boolean> {
  try {
    await fs.promises.access(dir);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * List stale `noeffect-*` temp dirs under os.tmpdir() older than
 * `maxAgeMs`. Pure list (the sweep itself calls removeTempDir).
 */
export function listStaleTempDirs(maxAgeMs: number = STALE_TEMP_MAX_AGE_MS): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(os.tmpdir());
  } catch {
    return [];
  }
  const now = Date.now();
  const stale: string[] = [];
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const full = path.join(os.tmpdir(), name);
    let mtime;
    try {
      mtime = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtime > maxAgeMs) {
      stale.push(full);
    }
  }
  return stale;
}

/**
 * Activation sweep: remove every stale `noeffect-*` temp dir, best effort.
 * Returns the number of dirs actually removed.
 */
export async function sweepStaleTempDirs(
  maxAgeMs: number = STALE_TEMP_MAX_AGE_MS
): Promise<number> {
  const stale = listStaleTempDirs(maxAgeMs);
  let removed = 0;
  for (const dir of stale) {
    const ok = await removeTempDir(dir, 2);
    if (ok) removed++;
  }
  return removed;
}