import * as fs from 'fs';
import * as path from 'path';

/**
 * Read a file's contents as a UTF-8 string.
 * Returns `null` if the file does not exist or cannot be read.
 */
export async function readFile(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Check if a file exists at the given path.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * List all files matching a given extension in a directory (non-recursive).
 */
export async function listFilesWithExtension(
  dirPath: string,
  extension: string
): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(extension))
      .map((e) => path.join(dirPath, e.name));
  } catch {
    return [];
  }
}
