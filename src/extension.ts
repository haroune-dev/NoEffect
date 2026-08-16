import * as vscode from 'vscode';
import { logger } from './utils/logger';
import { activateExtension } from './activation/activate';
import { defaultLifecycle } from './browser/lifecycleManager';

/**
 * Called by VS Code when the extension is activated.
 *
 * Activation triggers are defined in package.json:
 *   - When a CSS file is opened (`onLanguage:css`)
 *   - When an HTML file is opened (`onLanguage:html`)
 */
export function activate(context: vscode.ExtensionContext): void {
  // Initialize the logger first — all other modules depend on it
  logger.init();
  logger.info('─────────────────────────────────────');
  logger.info('NoEffect extension starting...');
  logger.info(`Extension path: ${context.extensionPath}`);
  logger.info(`VS Code version: ${vscode.version}`);
  logger.info('─────────────────────────────────────');

  try {
    const disposables = activateExtension(context);

    // Register all disposables for cleanup on deactivation
    for (const disposable of disposables) {
      context.subscriptions.push(disposable);
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error('Failed to activate NoEffect extension', error);
    vscode.window.showErrorMessage(
      `NoEffect failed to activate: ${error.message}`
    );
  }
}

/**
 * Called by VS Code when the extension is deactivated.
 *
 * All disposables registered via `context.subscriptions` are
 * automatically disposed — this function handles any additional
 * cleanup that goes beyond simple disposal.
 */
export async function deactivate(): Promise<void> {
  logger.info('NoEffect extension deactivating...');

  // The persistent browser/CDP/DevServer/page session is torn down only
  // here (and on workspace close) — never between analyses.
  await defaultLifecycle.dispose();
  logger.dispose();
}
