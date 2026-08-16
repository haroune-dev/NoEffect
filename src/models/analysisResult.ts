import { CssIssue } from './cssIssue';
import { AnalysisOutcome } from '../failure/model';

/**
 * The ONE namespace a completed run writes (Phase 6 — multi-file
 * orchestration). CSS-file runs write the GLOBAL multi-companion outcome of
 * the stylesheet; HTML-file runs write the PAGE-LOCAL embedded outcome of
 * the document. `completeAnalysis` writes exactly one namespace per run,
 * and every entry is keyed by the fingerprints of the content it judged
 * against.
 */
export type AnalysisNamespace =
  | {
      kind: 'cssGlobal';
      cssPath: string;

      /** Content fingerprint (SHA-256) of the stylesheet at analysis time. */
      contentFingerprint: string;

      /** Analysis-context fingerprint (F1) of the judged resolution. */
      contextFingerprint: string;

      /** Session epoch that produced the outcome. */
      epoch: number;
    }
  | {
      kind: 'htmlEmbedded';
      htmlPath: string;

      /** Content fingerprint (SHA-256) of the HTML document at analysis time. */
      contentFingerprint: string;

      /** Session epoch that produced the outcome. */
      epoch: number;
    };

/**
 * The complete result of an analysis pass.
 */
export interface AnalysisResult {
  /** Whether the analysis completed successfully */
  success: boolean;

  /** List of inactive CSS properties found */
  issues: CssIssue[];

  /** Timestamp of when the analysis was performed */
  timestamp: number;

  /** Total time taken for the analysis, in milliseconds */
  durationMs: number;

  /** The HTML entry point that was analyzed */
  htmlFilePath: string;

  /** All CSS files that were covered by this analysis */
  cssFilePaths: string[];

  /** Optional error message if the analysis failed */
  error?: string;

  /**
   * The unified, machine-readable outcome contract of the run. Downstream
   * layers (status, diagnostics) consume this instead of raw state.
   */
  outcome?: AnalysisOutcome;

  /**
   * The namespace this run's result is stored under (Phase 6). Exactly one
   * namespace is written per `completeAnalysis` call.
   */
  namespace?: AnalysisNamespace;
}