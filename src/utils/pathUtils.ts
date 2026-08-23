import * as path from 'path';

/**
 * Normalize filesystem paths consistently across platforms.
 * On Windows, drive letters are normalized to uppercase (e.g. c:\ -> C:\).
 */
export function normalizeFsPath(filePath: string): string {
  if (!filePath) {
    return filePath;
  }
  let normalized = path.normalize(filePath);
  if (process.platform === 'win32') {
    if (/^[a-z]:/i.test(normalized)) {
      normalized = normalized[0].toUpperCase() + normalized.slice(1);
    }
  }
  return normalized;
}

/**
 * Compare two filesystem paths for equality, handling Windows case-insensitivity and drive letter casing.
 */
export function pathEquals(pathA: string | undefined | null, pathB: string | undefined | null): boolean {
  if (!pathA || !pathB) {
    return pathA === pathB;
  }
  const normA = normalizeFsPath(pathA);
  const normB = normalizeFsPath(pathB);
  if (process.platform === 'win32') {
    return normA.toLowerCase() === normB.toLowerCase();
  }
  return normA === normB;
}
