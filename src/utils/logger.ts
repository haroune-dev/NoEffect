import type * as vscode from 'vscode';

/**
 * Centralized logger for the NoEffect extension.
 *
 * All output goes to a dedicated VS Code Output Channel, keeping the
 * editor's Problems panel and notifications clean (per the design goal
 * of zero-noise operation).
 *
 * The `vscode` module is required lazily inside `init()` so that modules
 * importing this logger remain loadable outside the extension host
 * (unit/integration tests) — when `init()` was never called, output falls
 * back to the console.
 */
class Logger {
  private channel: vscode.OutputChannel | null = null;
  private startTime: number = Date.now();

  /**
   * Initialize the logger. Must be called once during extension activation.
   */
  init(): void {
    if (!this.channel) {
      // Lazy require: only valid inside the VS Code extension host.
      const vscodeModule = require('vscode') as typeof import('vscode');
      this.channel = vscodeModule.window.createOutputChannel('NoEffect');
      this.startTime = Date.now();
    }
  }

  /**
   * Log an informational message.
   */
  info(message: string, ...args: unknown[]): void {
    this.write('INFO', message, args);
  }

  /**
   * Log a warning message.
   */
  warn(message: string, ...args: unknown[]): void {
    this.write('WARN', message, args);
  }

  /**
   * Log an error message.
   */
  error(message: string, ...args: unknown[]): void {
    this.write('ERROR', message, args);
  }

  /**
   * Log a debug message. Only shown when the user opens the Output Channel.
   */
  debug(message: string, ...args: unknown[]): void {
    this.write('DEBUG', message, args);
  }

  /**
   * Dispose of the output channel.
   */
  dispose(): void {
    this.channel?.dispose();
    this.channel = null;
  }

  /**
   * Show the output channel in the editor.
   */
  show(): void {
    this.channel?.show(true);
  }

  private write(level: string, message: string, args: unknown[]): void {
    if (!this.channel) {
      // Fallback to console if init() wasn't called yet
      console.log(`[NoEffect] [${level}] ${message}`, ...args);
      return;
    }

    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const timestamp = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS

    let line = `[${timestamp}] [+${elapsed}s] [${level}] ${message}`;

    if (args.length > 0) {
      const serialized = args
        .map((a) => {
          if (a instanceof Error) {
            return a.stack ?? a.message;
          }
          if (typeof a === 'object') {
            try {
              return JSON.stringify(a, null, 2);
            } catch {
              return String(a);
            }
          }
          return String(a);
        })
        .join(' ');
      line += ` ${serialized}`;
    }

    this.channel.appendLine(line);
  }
}

/** Singleton logger instance for the extension */
export const logger = new Logger();
