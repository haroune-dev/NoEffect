/**
 * Workspace environment classification (Phase 2: environment readiness).
 *
 * Local browser-based analysis can only run against real local files. This
 * module turns the folder URI schemes of the current workspace folders into
 * a deterministic classification so the readiness layer can disable analysis
 * safely for virtual/remote workspaces.
 *
 * vscode-free and injectable: the activation layer supplies the schemes.
 */

export type WorkspaceKind = 'local' | 'unsupported' | 'none';

export interface WorkspaceFolderInfo {
  /** URI scheme of the workspace folder (e.g. 'file', 'vscode-vfs'). */
  scheme: string;
}

/**
 * Classify a set of workspace folders.
 *
 *   'local'       – every folder is a real filesystem folder (scheme 'file')
 *   'unsupported' – at least one folder uses a non-local scheme (virtual
 *                   workspaces, remote/SSH, web) where we cannot serve or
 *                   launch a local browser against real files
 *   'none'        – no workspace folder at all (single-file mode); analysis
 *                   of local files is still safe
 */
export function classifyWorkspace(folders: WorkspaceFolderInfo[]): WorkspaceKind {
  if (folders.length === 0) {
    return 'none';
  }
  for (const folder of folders) {
    if (folder.scheme !== 'file') {
      return 'unsupported';
    }
  }
  return 'local';
}

/** Stable description of an unsupported workspace for readiness messages. */
export function unsupportedWorkspaceReason(folders: WorkspaceFolderInfo[]): string {
  const schemes = Array.from(new Set(folders.map((f) => f.scheme)));
  if (schemes.length === 0) {
    return 'no workspace folders';
  }
  return `workspace folder scheme(s): ${schemes.join(', ')}`;
}