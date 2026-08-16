/**
 * Analysis-context fingerprinting (Phase 6 — multi-file orchestration).
 *
 * A CSS-file analysis depends on TWO things: the stylesheet's own content
 * (content fingerprint) and the real documents its verdicts are judged
 * against (context fingerprint). The context fingerprint is a pure hash of
 * the ordered SELECTED companions' canonical paths + content hashes, the
 * Top-K evidence budget and a config version constant — computed EXACTLY
 * from the hash-validated companion-cache snapshot, never from a fresh
 * workspace walk. The selection is the shared Level 11 rule (Top-K plus
 * the bounded evidence expansion, see `companionSelection.ts`), derived
 * from the stylesheet's queryable selectors and the validated snapshot —
 * the SAME inputs the analysis run judges against, so the recorded and the
 * re-derived fingerprints always agree. It is the single identity used by
 * the re-analysis skip gate, the multi-pass merged-cache key and the
 * SessionManager result namespaces, so every layer agrees on what "the
 * same analysis context" means.
 */

import * as path from 'path';
import { contentHash } from '../utils/contentHash';
import { CompanionResolution } from '../services/companionResolver';
import { companionCache } from '../cache/companionCache';
import { companionSettings } from '../services/companionSettings';
import { astCache } from '../cache/astCache';
import { extractQueryableSelectors } from '../services/analysisPage';
import {
  COMPANION_EXPANSION_BUDGET,
  cachedPageContainsAnySelector,
  selectCompanionsForAnalysis,
} from './companionSelection';

/**
 * Config version of the resolution/selection semantics that shape the
 * fingerprint. Bump when the ranked order, the selection rule or the key
 * composition changes — every cached fingerprint then differs by
 * construction and every result namespace is re-validated.
 */
export const ANALYSIS_CONTEXT_VERSION = 1;

/**
 * Sentinel returned when NO validated companion snapshot exists for the
 * stylesheet (the resolution cache was reset or its entries went stale).
 * The skip gate must never skip on an unknown context, and a stale
 * fingerprint must never be recorded as the identity of a run.
 */
export const STALE_CONTEXT_FINGERPRINT = 'stale';

/** The resolver result the fingerprint is derived from (F1). */
export interface AnalysisContextInput {
  /** The FINAL selection the analysis judges against (Top-K + expansions), or null when none links the sheet. */
  resolutions: CompanionResolution[] | null;

  /** Content hash per resolution, same order (null when unreadable). */
  companionHashes: (string | null)[];

  /** The Top-K evidence budget (`noEffect.maxCompanions`). */
  maxCompanions: number;
}

/**
 * The canonical analysis-context fingerprint (F1):
 * H(ordered SELECTED companions' canonical paths + content hashes, K,
 * config version). Deterministic and pure — the same selection always
 * hashes identically, and any change to the selected documents, their
 * content, the budget or the config version changes the fingerprint.
 * Selection is the CALLER's job (the shared Level 11 rule): the hash
 * covers the selection exactly as given — it never truncates silently.
 */
export function analysisContextFingerprint(input: AnalysisContextInput): string {
  const selected = input.resolutions ?? [];
  const entries = selected.map((resolution, index) => {
    const canonical = path.resolve(resolution.htmlPath);
    const hash = input.companionHashes[index] ?? '';
    return `${canonical}|${hash}`;
  });
  return contentHash(`v${ANALYSIS_CONTEXT_VERSION}|${input.maxCompanions}|${entries.join(',')}`);
}

/**
 * The context fingerprint of a CSS file from its VALIDATED companion-cache
 * snapshot — the exact source the analysis judged against (F1: "derived
 * from companionCache"). The selection is re-derived with the shared Level
 * 11 rule from the snapshot AND the stylesheet's queryable selectors (via
 * the content-addressed AST cache — the same parse the analysis ran on),
 * and the companion hashes come from the validated entry, so the result is
 * EXACTLY the fingerprint the run recorded. Returns
 * `STALE_CONTEXT_FINGERPRINT` when no validated snapshot exists (reset
 * cache, changed companion) or the stylesheet cannot be parsed: the caller
 * must re-resolve before trusting any fingerprint.
 */
export function companionContextFingerprintFor(cssPath: string): string {
  const cssReal = path.normalize(path.resolve(cssPath));
  const primaryRoot =
    companionSettings.workspaceFolderProvider?.(cssPath) ?? path.dirname(cssReal);
  const entry = companionCache.getValidatedEntry(`${primaryRoot}|${cssReal}`);
  if (!entry) {
    return STALE_CONTEXT_FINGERPRINT;
  }

  let selectors: string[];
  let cssHash: string;
  try {
    const parsed = astCache.getOrParse(cssReal);
    selectors = extractQueryableSelectors(parsed.rules);
    cssHash = parsed.hash;
  } catch {
    return STALE_CONTEXT_FINGERPRINT;
  }

  const ranked = entry.resolutions ?? [];
  const hashByPath = new Map<string, string | null>();
  entry.resolutions?.forEach((resolution, index) => {
    hashByPath.set(resolution.htmlPath, entry.companionHashes[index] ?? null);
  });

  const selected = selectCompanionsForAnalysis(
    ranked,
    selectors,
    companionSettings.maxCompanions,
    COMPANION_EXPANSION_BUDGET,
    (companion) => cachedPageContainsAnySelector(companion.htmlPath, selectors, cssHash)
  );

  return analysisContextFingerprint({
    resolutions: selected,
    companionHashes: selected.map((companion) => hashByPath.get(companion.htmlPath) ?? ''),
    maxCompanions: companionSettings.maxCompanions,
  });
}
