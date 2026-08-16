import * as vscode from 'vscode';
import { logger } from '../utils/logger';

/**
 * Watches for changes to HTML and CSS files in the workspace.
 *
 * Emits callbacks when relevant files are saved or changed, allowing
 * the extension to trigger re-analysis.
 */
export class WatchService {
  private disposables: vscode.Disposable[] = [];
  private onSaveCallback: ((uri: vscode.Uri) => void) | null = null;
  private onChangeCallback: ((uri: vscode.Uri) => void) | null = null;

  /**
   * Start watching for file save and change events on CSS and HTML files.
   */
  start(): void {
    // Watch for file saves
    const saveWatcher = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (this.isRelevantFile(doc.uri)) {
        logger.debug(`File saved: ${doc.uri.fsPath}`);
        this.onSaveCallback?.(doc.uri);
      }
    });

    // Watch for text changes (for debounced analysis-on-type)
    const changeWatcher = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length > 0 && this.isRelevantFile(event.document.uri)) {
        this.onChangeCallback?.(event.document.uri);
      }
    });

    this.disposables.push(saveWatcher, changeWatcher);
    logger.info('WatchService started — monitoring CSS and HTML files');
  }

  /**
   * Register a callback for file save events.
   */
  onSave(callback: (uri: vscode.Uri) => void): void {
    this.onSaveCallback = callback;
  }

  /**
   * Register a callback for text change events.
   */
  onChange(callback: (uri: vscode.Uri) => void): void {
    this.onChangeCallback = callback;
  }

  /**
   * Check if the file is a CSS or HTML file that should be monitored.
   */
  private isRelevantFile(uri: vscode.Uri): boolean {
    const fsPath = uri.fsPath.toLowerCase();
    return fsPath.endsWith('.css') || fsPath.endsWith('.html') || fsPath.endsWith('.htm');
  }

  /**
   * Stop watching and clean up listeners.
   */
  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.onSaveCallback = null;
    this.onChangeCallback = null;
    logger.info('WatchService stopped');
  }
}
