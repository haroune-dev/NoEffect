import type * as vscode from 'vscode';
import { CssIssue } from '../models';
import { CancellationTokenLike } from '../failure/cancellation';
import { RunMetrics } from '../failure/outcome';

export interface IneffectivePropertyAnalyzer {
  analyze(editor: vscode.TextEditor, startTime: number, token?: CancellationTokenLike): Promise<CssIssue[]>;
}

/**
 * The production analysis pipeline as consumed by the orchestration layer.
 * Entry points return raw issue arrays (the decoration payload) and expose
 * the per-run metrics; the `AnalysisRunner` wraps both into the unified
 * `AnalysisOutcome` contract.
 */
export interface AnalysisProvider {
  analyzeCssFile(cssFilePath: string, startTime: number, token?: CancellationTokenLike): Promise<CssIssue[]>;
  analyzeHtmlFile(htmlFilePath: string, startTime: number, token?: CancellationTokenLike): Promise<CssIssue[]>;
  getRunMetrics(): RunMetrics;

  /**
   * Optional (Phase 5): the session epoch the most recent run prepared
   * against. Implemented by the production analyzer; injected fakes simply
   * omit it and the runner falls back to the lifecycle's current epoch.
   */
  getLastSessionEpoch?(): number;

  /**
   * Optional (Phase 6): the EXACT analysis-context fingerprint the most
   * recent CSS run judged against, or null when the run had no companion
   * context. The orchestration layer records results under this identity —
   * never a post-run recomputation — so a result is always registered
   * against the snapshot it was actually analyzed against.
   */
  getLastContextFingerprint?(): string | null;
}