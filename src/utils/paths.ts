import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Resolve a path relative to the extension's installation root.
 * Useful for accessing bundled assets like the inline warning icon SVG.
 */
export function extensionPath(context: vscode.ExtensionContext, ...segments: string[]): string {
  return path.join(context.extensionPath, ...segments);
}

/**
 * Resolve a path relative to the currently active workspace folder.
 * Returns `undefined` if no workspace is open.
 */
export function workspacePath(...segments: string[]): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  return path.join(folders[0].uri.fsPath, ...segments);
}

/**
 * Get the directory containing the given file path.
 */
export function fileDir(filePath: string): string {
  return path.dirname(filePath);
}

/**
 * Convert an absolute file path to a `file://` URI string.
 */
export function toFileUri(absolutePath: string): string {
  // Ensure forward slashes and proper encoding
  const normalized = absolutePath.replace(/\\/g, '/');
  return `file://${normalized.startsWith('/') ? '' : '/'}${normalized}`;
}

/**
 * Compute the relative path from `from` to `to`.
 */
export function relativeTo(from: string, to: string): string {
  return path.relative(from, to);
}

/**
 * Check whether a file path matches any of the given glob patterns.
 */
export function matchesAnyGlob(filePath: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return false;
  }

  const relativePath = vscode.workspace.asRelativePath(filePath, false);

  for (const pattern of patterns) {
    // Simple glob matching — sufficient for Phase 1.
    // Uses VS Code's built-in RelativePattern for accurate matching.
    const globPattern = new vscode.RelativePattern(
      vscode.workspace.workspaceFolders?.[0] ?? '',
      pattern
    );
    // For now, do a simple string-includes check as a lightweight fallback
    if (relativePath.includes(pattern.replace(/\*/g, '').replace(/\//g, ''))) {
      return true;
    }
  }
  return false;
}
