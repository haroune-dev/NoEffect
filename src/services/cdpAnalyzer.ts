import type * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CssIssue, CssLocation } from '../models';
import { IneffectivePropertyAnalyzer, AnalysisProvider } from './analyzer';
import { logger } from '../utils/logger';
import { collectMatchedDeclarations, collectPseudoContent, collectDeclaredDisplay, collectPseudoTypes } from '../browser/matchedStylesCollector';
import { PseudoBoxFacts } from '../engine/layoutContext';
import { normalizeAndDeduplicate, markOverriddenDeclarations } from '../engine/declarationNormalizer';
import { InactiveRuleEngine } from '../inactive/inactiveRuleEngine';
import { createDefaultRuleRegistry } from '../inactive/ruleRegistry';
import { InactivePropertyResult, MatchedCssDeclaration } from '../engine/inactivePropertyEngine';
import { CssRule, CssSourceRange } from '../parser/cssAst';
import { HtmlCssFragments } from '../parser/htmlScanner';
import { LocalDeclarationMatch, matchInlineDeclaration } from '../matcher/declarationMapper';
import { astCache } from '../cache/astCache';
import { fileHashCache } from '../cache/fileHashCache';
import { companionCache } from '../cache/companionCache';
import { multiPassCache } from '../cache/multiPassCache';
import { CompanionResolution, extractLinkedHrefs, resolveCompanionsAll } from './companionResolver';
import {
  declarationKeyFor,
  mergePassOutcomes,
  MergedResult,
  PassOutcome,
  PassVerdict,
} from '../engine/verdictMerge';
import { resolveLocalPath, toServedPath } from './companionUrl';
import { companionSettings } from './companionSettings';
import {
  analysisContextFingerprint,
  companionContextFingerprintFor,
  STALE_CONTEXT_FINGERPRINT,
} from '../engine/analysisContext';
import {
  COMPANION_EXPANSION_BUDGET,
  cachedPageContainsAnySelector,
  selectCompanionsForAnalysis,
} from '../engine/companionSelection';
import { CssGlobalOutcomeStore } from './sessionManager';
import { mappingCache, mappingKeyFor, batchKeys } from '../cache/mappingCache';
import {
  htmlFragmentCache,
  embeddedParseCache,
  embeddedMappingCache,
  inlineMappingKey,
  EmbeddedCssParse,
} from '../cache/embeddedCssCache';
import { defaultLifecycle } from '../browser/lifecycleManager';
import { sleep } from '../session/timing';
import { LayoutContextBuilder } from '../browser/layoutContextBuilder';
import {
  extractQueryableSelectorsDetailed,
  buildWrapperPage,
  isStandaloneSelector,
  hasExplicitTag,
  DroppedSelector,
} from './analysisPage';
import { RunMetrics } from '../failure/outcome';
import { throwIfCancelled, CancellationTokenLike } from '../failure/cancellation';
import { AnalysisCancelledError } from '../failure/errors';
import {
  annotateFailureSource,
  analysisContextMissingFailure,
  companionPassFailedFailure,
  noCompanionHtmlFailure,
  pageLoadTimeoutFailure,
  selectorNotQueryableFailure,
  selectorsUnqueryableFailure,
} from '../failure/classifier';

/**
 * Root directory of the test fixtures served during analysis.
 *
 * Resolved relative to the analyzer's own compiled output so that it is
 * correct regardless of who calls it (extension host or integration tests).
 * From `out/services/cdpAnalyzer.js`:
 *   __dirname = <project>/out/services/
 *   ../../src/test/fixtures = <project>/src/test/fixtures
 */
export const DEFAULT_FIXTURES_ROOT = path.resolve(
  __dirname,
  '..',
  '..',
  'src',
  'test',
  'fixtures'
);

/** A stylesheet the analysis maps its issues against. */
interface LocalStylesheet {
  /** Absolute path of the local CSS file. */
  path: string;

  /** Content hash of the file (AST-cache key). */
  hash: string;

  /** Whether the stylesheet was re-parsed on this run (content changed). */
  changed: boolean;

  /** Parsed rules (from the AST cache). */
  rules: CssRule[];

  /**
   * Document position of this stylesheet's text when it is an embedded
   * `<style>` block (the block's start in the HTML); files have no origin
   * (their text starts at line 0, column 0). CDP reports embedded-rules
   * ranges relative to the block's own text, so shifting by the origin
   * puts them in document coordinates — comparable to the shifted rules
   * above.
   */
  origin?: { line: number; column: number };
}

/** The result of one inspection phase (one node loop over one page). */
interface PassInspectionResult {
  /** Materialized rule-declaration issues (issue-flow consumers; companion flow discards). */
  issues: CssIssue[];

  /**
   * Issues of the embedded inline flow (`style=""` attributes) of the page.
   * They have NO stylesheet-owning verdict key (they map into the HTML
   * attribute text), so the multi-page flow appends them to the merged
   * rule-declaration issues instead of merging them.
   */
  inlineIssues: CssIssue[];

  /** Per-declaration semantic verdicts (companion flow merges these). */
  verdicts: Map<string, PassVerdict>;

  /** Selectors that located a node in this page (companion bookkeeping). */
  locatedSelectors: string[];
}

/**
 * Embedded-CSS context of an HTML analysis: the scanned fragments and the
 * parsed (document-relative) declarations of every `style=""` attribute.
 * Drives the inline-style flow of `inspectSelectors`.
 */
interface InlineAnalysis {
  /** Absolute path of the analyzed HTML file. */
  htmlPath: string;

  /** Content hash of the HTML file (embedded-cache key). */
  htmlHash: string;

  /** Scanned embedded fragments (block + attribute list). */
  fragments: HtmlCssFragments;

  /** Parsed attribute fragments, same order as `fragments.styleAttributes`. */
  embedded: EmbeddedCssParse;
}

/** Location key for the per-run duplicate suppression. */
function locationKey(location: CssLocation): string {
  return [
    location.filePath,
    location.startLine,
    location.startColumn,
    location.endLine,
    location.endColumn,
  ].join('|');
}

/**
 * Production analyzer.
 *
 * Real flow:
 *
 *   Read/parse the local stylesheet (content-addressed AST cache)
 *   → Prepare the persistent session (reuse browser/CDP/DevServer/page)
 *   → For each target selector: find node, read matched declarations and
 *     computed styles (CDP facts)
 *   → Inspect every declaration through the inactive engine
 *   → Map each confirmed inactive result (deterministic mapping cache)
 *   → Convert confirmed inactive results into CssIssue[] with real ranges
 *
 * The extension command analyzes the ACTIVE EDITOR's file:
 *   - a CSS file is served through an in-memory wrapper page that links the
 *     stylesheet and contains one element per queryable rule selector;
 *   - an HTML file is served as-is and the selectors come from the
 *     stylesheets it links.
 * `analyzeFixture` keeps the fixture-driven pipeline used by tests and the
 * benchmark.
 *
 * Session management (performance PR): the browser, the CDP WebSocket, the
 * DevServer and the analysis page are owned by the shared LifecycleManager
 * and survive across analyses. Identical inputs hit the AST/mapping caches;
 * a lost session is transparently recovered and the analysis retried once.
 *
 * The analysis result never depends on file comments such as
 * `noeffect-test` markers — all data comes from the browser engine.
 * Every emitted issue carries a valid local source range
 * (declarationRange / propertyNameRange / iconAnchorRange); inactive
 * declarations that cannot be mapped locally are skipped, never reported
*  with a placeholder or empty range.
 */

/**
 * Whether a merged result may be cached: EVERY selected companion pass
 * succeeded. A partial run (any failed pass) is never cached — the merged
 * cache key does not encode evidence completeness, so caching the partial
 * result would poison the warm path (every later run re-echoes the partial
 * evidence). Failed passes are never cached per-pass, so the next run
 * re-attempts exactly the failed companion(s) and only then caches.
 */
export function mergedResultIsCacheable(passOutcomes: readonly PassOutcome[]): boolean {
  return passOutcomes.every((outcome) => outcome.success);
}

export class CdpAnalyzer implements IneffectivePropertyAnalyzer, AnalysisProvider {
  /**
   * PR6 Phase 1: builds one immutable LayoutContext per DOM node (single
   * protocol pass) — the single source of truth every rule consumes.
   */
  private readonly layoutContextBuilder = new LayoutContextBuilder();

  /**
   * PR6 Phase 2: the rule engine dispatches every declaration to the
   * single rule owning its property. The registry holds the full default
   * rule set — the analyzer never knows any property name itself.
   */
  private readonly inactiveEngine = new InactiveRuleEngine(createDefaultRuleRegistry());

  /**
   * The single writer of global CSS outcomes (F4 single-writer), injected
   * by the command layer. The HTML flow uses it to REUSE a fresh global
   * outcome or RECORD the one it computed — it never emits single-page
   * external-stylesheet issues of its own. Null (tests, standalone use)
   * disables the linked-sheet orchestration entirely: an HTML run then
   * judges only the page's embedded CSS.
   */
  private readonly globalOutcomeStore: CssGlobalOutcomeStore | null;

  constructor(options: { globalOutcomeStore?: CssGlobalOutcomeStore | null } = {}) {
    this.globalOutcomeStore = options.globalOutcomeStore ?? null;
  }

  /**
   * Per-run bookkeeping (selectors analyzed/skipped + non-fatal warnings),
   * replaced at the start of every public entry point and consumed by the
   * AnalysisRunner to build the outcome contract.
   */
  private runMetrics: RunMetrics = new RunMetrics();

  /**
   * Session epoch of the most recent prepared run (Phase 5). The runner
   * stamps every outcome with it; outcomes produced against a session that
   * was since rebuilt are dropped by the command layer. 0 when no run has
   * prepared a session yet.
   */
  private lastSessionEpoch: number = 0;

  /**
   * The EXACT analysis-context fingerprint the most recent CSS run judged
   * against — the fingerprint computed from the resolved snapshot at run
   * time (F1), never recomputed after the run. The store records results
   * under this identity, so a mid-run companion change can never register
   * a result under a context that was not the one analyzed against
   * (transactional recording). Null for runs without a companion context
   * (wrapper flow, HTML runs).
   */
  private lastContextFingerprint: string | null = null;

  /** The context fingerprint the last CSS run actually analyzed against. */
  getLastContextFingerprint(): string | null {
    return this.lastContextFingerprint;
  }

  /**
   * The metrics of the most recent run. The orchestration layer reads them
   * right after the entry point resolves.
   */
  getRunMetrics(): RunMetrics {
    return this.runMetrics;
  }

  /**
   * The session epoch the most recent run prepared against (Phase 5).
   *
   * A WARM run (every pass resolved from the content-addressed multi-pass
   * cache) prepares no session — `lastSessionEpoch` would stay 0 and the
   * command layer would read that as "superseded by the live session",
   * dropping the result and recording the namespace under epoch 0, which
   * then never matches a fresh (content, context, live-epoch) probe and
   * CLEARS the decorations of a perfectly valid run. A warm hit derives
   * from the same resolved companion snapshot (content + context
   * fingerprint) as any current-world determination, so it must be stamped
   * with the live epoch — never 0.
   */
  getLastSessionEpoch(): number {
    if (this.lastSessionEpoch === 0) {
      return defaultLifecycle.epoch;
    }
    return this.lastSessionEpoch;
  }

  /**
   * Record every selector the static wrapper could not query as a classified
   * `SELECTOR_NOT_QUERYABLE` warning (degraded analysis quality — the run
   * continues with the selectors that ARE inspectable).
   */
  private recordDroppedSelectors(dropped: DroppedSelector[]): void {
    for (const drop of dropped) {
      this.runMetrics.addWarning(selectorNotQueryableFailure(drop.selector, drop.reason));
    }
  }

  /**
   * Mark a run where nothing was inspectable. When selector parts were
   * actually dropped (not an empty file), classify that as
   * `SELECTORS_UNQUERYABLE`; an empty stylesheet is not a failure at all.
   */
  private markNoQueryableSelectors(droppedCount: number, message: string): void {
    this.runMetrics.markSkippedAll(message);
    if (droppedCount > 0) {
      this.runMetrics.addWarning(selectorsUnqueryableFailure(droppedCount));
    }
  }

  /**
   * Editor-driven entry point used by the extension commands: analyze the
   * file the user actually has open.
   */
  async analyze(editor: vscode.TextEditor, startTime: number, token?: CancellationTokenLike): Promise<CssIssue[]> {
    const filePath = editor.document.uri.fsPath;
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.css') {
      return this.analyzeCssFile(filePath, startTime, token);
    }
    if (ext === '.html') {
      return this.analyzeHtmlFile(filePath, startTime, token);
    }

    logger.warn(
      `[Analyzer] Unsupported file type '${ext || '(none)'}' — only .css and .html can be analyzed`
    );
    return [];
  }

  /**
   * Analyze a standalone CSS file and map the issues back to this exact
   * file. When an HTML document in the same directory links this stylesheet,
   * the analysis runs against that REAL document (element types and parents
   * come from the user's DOM); otherwise an in-memory wrapper page with one
   * element per queryable selector is built. Public so integration tests
   * can drive the production pipeline.
   */
  async analyzeCssFile(cssFilePath: string, _startTime: number, token?: CancellationTokenLike): Promise<CssIssue[]> {
    this.runMetrics = new RunMetrics();
    this.lastContextFingerprint = null;
    throwIfCancelled(token);
    logger.info(`Running CDP Analyzer on CSS file: ${cssFilePath}`);

    const parsed = astCache.getOrParse(cssFilePath);
    if (!parsed.hit) {
      const declarationCount = parsed.rules.reduce((n, r) => n + r.declarations.length, 0);
      logger.info(
        `[AST] Parsed CSS declarations: ${declarationCount} declaration(s) ` +
        `across ${parsed.rules.length} rule(s)`
      );
    }

    const { queryable: selectors, dropped } = extractQueryableSelectorsDetailed(parsed.rules);
    this.recordDroppedSelectors(dropped);
    logger.info(`[Analyzer] ${selectors.length} queryable selector(s) in ${cssFilePath}`);
    if (selectors.length === 0) {
      logger.warn('[Analyzer] No queryable selectors — nothing to inspect');
      this.markNoQueryableSelectors(dropped.length, 'No queryable selectors in the stylesheet');
      return [];
    }

    const directory = path.dirname(cssFilePath);
    const fileName = path.basename(cssFilePath);

    // Serve-boundary encoding (P2-SEC-05): the filename is percent-encoded
    // so `#`, `?`, spaces or quotes can neither break the URL semantics the
    // browser/dev-server round-trip depends on nor leak raw HTML into the
    // served page (the interpolation site in `buildWrapperPage` HTML-escapes
    // separately). The virtual-file registry key and the navigation URL
    // share the same encoding, so the lookup stays consistent. Plain names
    // encode to themselves — zero behavior change on the common path.
    const encodedFileName = encodeURIComponent(fileName);

    // The wrapper page is served from memory; the stylesheet itself comes
    // from disk. It must be registered before the page is navigated to.
    const wrapperName = `analysis-${encodedFileName}.html`;
    defaultLifecycle.setVirtualFile(wrapperName, buildWrapperPage(selectors, `/${encodedFileName}`));

    const stylesheets: LocalStylesheet[] = [
      { path: cssFilePath, hash: parsed.hash, changed: !parsed.hit, rules: parsed.rules },
    ];

    // A real document linking this EXACT stylesheet gives the analysis
    // actual element types and parents — e.g. a bare `.object-fit-box` on a
    // real `<div>` is dimmed while `.object-fit-img` on a real `<img>` stays
    // active. Level 11: EVERY selected companion (the Top-K evidence budget
    // PLUS the small deterministic evidence-expansion tail — candidates
    // beyond the budget whose documents contain the stylesheet's selector
    // tokens) is evaluated in its own pass and the semantic verdicts are
    // merged algebraically (⊥ ≤ I ≤ A, JOIN = max): a declaration is dimmed
    // only when no observed real context gives it effect. Companions are
    // resolved across directories through the shared URL model (the same
    // resolution the DevServer serves with), canonically deduplicated and
    // ranked (distance → index.html → alphabetical); the ranked list is
    // cached. WITHOUT any companion, the wrapper flow below (one element
    // per selector) is the fallback — and with companions, the wrapper is
    // NEVER mixed in, including when every companion pass fails (synthetic
    // evidence never mixes with real evidence).
    const rankedCompanions = await this.resolveCompanionsFor(cssFilePath);
    if (rankedCompanions && rankedCompanions.length > 0) {
      return this.analyzeWithCompanions({
        cssFilePath,
        parsed,
        selectors,
        stylesheets,
        rankedCompanions,
        token,
      });
    }

    // No companion document: the wrapper-page fallback runs the analysis
    // against a synthetic DOM. This is a real capability limitation of the
    // analysis context (recorded as a classified warning), not a failure.
    this.runMetrics.addWarning(noCompanionHtmlFailure(cssFilePath));

    return this.withSession(
      directory,
      `/__noeffect__/${wrapperName}`,
      !parsed.hit,
      (cdp, runToken) =>
        this.inspectSelectors(
          cdp,
          selectors,
          stylesheets,
          {
            // The wrapper page fabricates a top-level `<body>` parent for
            // every standalone selector — the real document parent is
            // unknowable from a CSS file alone. Marking those nodes'
            // parents as unknown keeps item-dependent rules conservative.
            syntheticParents: true,
            // Same reason, cascade side: fabricated elements can match
            // selector pairs no real document co-locates (`.x` and
            // `img.x` both match the wrapper's `<img class="x">`), so a
            // cross-rule loss observed on the wrapper is not provable.
            crossRuleCascade: false,
          },
          runToken
        ),
      token
    );
  }

  /**
   * The multi-companion flow (Level 11): run one sequential pass per
   * selected companion — the Top-K evidence budget plus the bounded
   * evidence-expansion tail (candidates beyond the budget whose documents
   * contain the stylesheet's selector tokens) — (the persistent session
   * owns ONE page, so passes never interleave), merge the semantic
   * verdicts, and materialize the merged `I` results into issues. One
   * logical multi-pass run = one epoch inside the runner; every pass
   * checks the run token before navigating and before applying anything;
   * supersede drops the merged outcome with the run.
   *
   * Warm path: the merged cache key (css hash + ordered tuple of the
   * SELECTED companions' hashes + K) turns a warm run into K lookups + one
   * pure merge — no navigation, no rescan.
   */
  private async analyzeWithCompanions(args: {
    cssFilePath: string;
    parsed: { hash: string; rules: CssRule[]; hit: boolean };
    selectors: string[];
    stylesheets: LocalStylesheet[];
    rankedCompanions: CompanionResolution[];
    token?: CancellationTokenLike;
  }): Promise<CssIssue[]> {
    const { cssFilePath, parsed, selectors, stylesheets, rankedCompanions, token } = args;
    const cssHash = parsed.hash;

    // The selection is the shared Level 11 rule (Top-K + the bounded
    // evidence-expansion tail of candidates whose documents contain the
    // stylesheet's selector tokens) — the EXACT rule the post-run freshness
    // probes re-derive from the validated snapshot, so the recorded
    // context fingerprint and every probe agree by construction.
    const selected = selectCompanionsForAnalysis(
      rankedCompanions,
      selectors,
      companionSettings.maxCompanions,
      COMPANION_EXPANSION_BUDGET,
      (companion) => cachedPageContainsAnySelector(companion.htmlPath, selectors, cssHash)
    );
    if (selected.length > companionSettings.maxCompanions) {
      logger.info(
        `[MultiCompanion] Evidence expansion: ` +
          `${selected.length - companionSettings.maxCompanions} companion(s) beyond the ` +
          `Top-${companionSettings.maxCompanions} budget matched the stylesheet selectors`
      );
    }
    const companionHashes = selected.map((companion) => this.companionHashOf(companion.htmlPath));

    // Phase 6 (F1): the merged-cache key is derived from the canonical
    // analysis-context fingerprint — H(ordered selected companions'
    // canonical paths + content hashes, K, config version) — not from an
    // ad-hoc tuple composition. The fingerprint comes from the SAME
    // resolved snapshot this run judges against, so the skip gate, the
    // multi-pass cache and the SessionManager namespaces all agree on what
    // "the same analysis context" means.
    const contextFingerprint = analysisContextFingerprint({
      resolutions: selected,
      companionHashes,
      maxCompanions: companionSettings.maxCompanions,
    });
    // Transactional identity: the fingerprint of the snapshot THIS run
    // judges against is what the store records the result under — never a
    // post-run recomputation (the world may have changed mid-run).
    this.lastContextFingerprint = contextFingerprint;
    const mergedKey = multiPassCache.mergedKeyFor(cssHash, contextFingerprint);

    const cachedMerged = multiPassCache.getMerged(mergedKey);
    if (cachedMerged) {
      logger.info(
        `[MultiCompanion] Merged-cache hit for ${cssFilePath} — ` +
        `${selected.length} companion pass(es) reused, no navigation`
      );
      this.runMetrics.setCompanionCoverage(this.companionCoverageOf(selected, rankedCompanions));
      return this.materializeMerged(cachedMerged, cssFilePath, selected.length, true);
    }

    logger.info(
      `[MultiCompanion] ${selected.length} companion document(s) selected for ${cssFilePath}`
    );
    const passOutcomes: PassOutcome[] = [];
    const locatedSelectors: string[] = [];
    const failedCompanions: string[] = [];

    for (let rank = 0; rank < selected.length; rank++) {
      throwIfCancelled(token);
      const companion = selected[rank];
      const passKey = multiPassCache.passKeyFor(cssHash, companionHashes[rank]);

      let pass: { outcome: PassOutcome; locatedSelectors: string[] } | undefined =
        multiPassCache.getPass(passKey);
      if (!pass) {
        const started = Date.now();
        pass = await this.runCompanionPass(companion, rank, selectors, stylesheets, !parsed.hit, token);
        logger.info(
          `[MultiCompanion] Companion pass ${rank + 1}/${selected.length} for ` +
          `${companion.htmlPath} ${pass.outcome.success ? 'succeeded' : 'failed'} in ` +
          `${Date.now() - started}ms`
        );
        if (pass.outcome.success) {
          multiPassCache.setPass(passKey, pass);
        }
      } else {
        logger.debug(
          `[MultiCompanion] Per-pass cache hit for ${companion.htmlPath} (rank ${rank})`
        );
      }

      if (pass.outcome.success) {
        locatedSelectors.push(...pass.locatedSelectors);
      } else {
        failedCompanions.push(companion.htmlPath);
        this.runMetrics.addWarning(
          companionPassFailedFailure(companion.htmlPath, pass.outcome.error ?? 'companion pass failed')
        );
      }
      passOutcomes.push(pass.outcome);
    }

    const merged = mergePassOutcomes(passOutcomes);
    // A partial run (ANY failed companion pass) is NEVER cached: the merged
    // key does not know which passes contributed, so caching the partial
    // result would poison the warm path — every later run would keep
    // echoing evidence gathered without the failed companion (its verdicts
    // stay ⊥ forever until the CSS hash changes or a manual cache reset).
    // Failed passes are never cached per-pass either, so the next run
    // re-attempts exactly the failed companion(s) and only then caches a
    // complete merge.
    if (mergedResultIsCacheable(passOutcomes)) {
      multiPassCache.setMerged(mergedKey, merged);
    } else {
      const failedCount = passOutcomes.filter((outcome) => !outcome.success).length;
      logger.warn(
        `[MultiCompanion] ${failedCount} companion pass(es) failed — partial merge NOT cached; ` +
        `the failed companion(s) will be retried on the next run`
      );
      // INCOMPLETE EVIDENCE MUST NEVER DIM: a failed pass leaves its
      // declarations ⊥, which the lattice cannot distinguish from "selector
      // genuinely absent on that page" — so a merged I could be masking an
      // A on the failed page (exactly the `.active-somewhere` first-run
      // case). Emit NO issues: the run reports the failure (coverage/
      // warnings → 'partial'), the skip identity is never recorded, and the
      // next trigger genuinely re-attempts the failed companion(s).
      // Cancellation is never swallowed here: a cancelled pass rethrows
      // above, so the whole run resolves cleanly.
      this.runMetrics.setCompanionCoverage(this.companionCoverageOf(selected, rankedCompanions, passOutcomes));
      return [];
    }

    // Merged-semantics run metrics: a selector analyzed when at least ONE
    // companion located it; skipped only when NO companion could judge it.
    const located = new Set(locatedSelectors);
    for (const selector of selectors) {
      if (located.has(selector)) {
        this.runMetrics.markAnalyzed();
      } else {
        this.runMetrics.markSkipped(
          selector,
          'matched no element in any of the analyzed companion documents'
        );
      }
    }

    this.runMetrics.setCompanionCoverage(this.companionCoverageOf(selected, rankedCompanions));
    return this.materializeMerged(merged, cssFilePath, selected.length, false);
  }

  /** The content hash of a companion document, '' when unreadable. */
  private companionHashOf(htmlPath: string): string {
    try {
      return fileHashCache.getOrRead(htmlPath).hash;
    } catch {
      return '';
    }
  }

  /** Companion coverage from the selected list and the full ranked list. */
  private companionCoverageOf(
    selected: CompanionResolution[],
    ranked: CompanionResolution[],
    passOutcomes?: PassOutcome[]
  ): {
    analyzed: string[];
    failed: string[];
    skipped: string[];
    total: number;
    selected: number;
  } {
    const failed = new Set(
      (passOutcomes ?? []).filter((outcome) => !outcome.success).map((outcome) => outcome.companionPath)
    );
    return {
      analyzed: selected.filter((c) => !failed.has(c.htmlPath)).map((c) => c.htmlPath),
      failed: selected.filter((c) => failed.has(c.htmlPath)).map((c) => c.htmlPath),
      skipped: ranked.slice(selected.length).map((c) => c.htmlPath),
      total: ranked.length,
      selected: selected.length,
    };
  }

  /**
   * Run ONE companion pass: navigate the persistent session to the
   * companion's page and inspect every selector for semantic verdicts.
   * The page load is ALWAYS forced: the shared fileHashCache may have
   * already re-read the companion's new content during the freshness
   * validation (companionCache.getValidatedEntry) BEFORE this pass runs,
   * so the hit-flag-based change detection would wrongly report
   * "unchanged" — and the persistent session, still parked on that page's
   * previous load, would judge the STALE DOM (computed display of the
   * OLD markup) until the session died. A same-URL forced refresh is the
   * only way a per-pass cache miss can ever see the current document.
   * Every execution failure is caught and converted into a failed
   * `PassOutcome` — a failed pass contributes NO lattice element (it is
   * recorded in coverage and makes the run partial). Cancellation is never
   * swallowed: a cancelled pass rethrows so the whole run resolves cleanly.
   *
   * `baseRefresh` is the caller's evidence change signal (for a CSS file:
   * whether the stylesheet was re-parsed; for an HTML file: whether the
   * analyzed document or any shared stylesheet changed). The pass forces a
   * page refresh when that signal fires OR unconditionally as above.
   */
  private async runCompanionPass(
    companion: CompanionResolution,
    rank: number,
    selectors: string[],
    stylesheets: LocalStylesheet[],
    baseRefresh: boolean,
    token?: CancellationTokenLike
  ): Promise<{ outcome: PassOutcome; locatedSelectors: string[] }> {
    const pagePath = toServedPath(companion.serverRoot, companion.htmlPath);
    if (pagePath === null) {
      return {
        outcome: {
          companionPath: companion.htmlPath,
          companionRank: rank,
          verdicts: new Map(),
          success: false,
          error: `companion ${companion.htmlPath} cannot be served from ${companion.serverRoot}`,
        },
        locatedSelectors: [],
      };
    }

    logger.info(
      `[Analyzer] Analyzing CSS against its real document ${companion.htmlPath} ` +
      `(href '${companion.href}', ${companion.kind}, distance ${companion.distance}, rank ${rank})`
    );

    try {
      const pass = await this.withSessionPass(
        companion.serverRoot,
        pagePath,
        true,
        (cdp, runToken) =>
          this.inspectSelectorsForVerdicts(cdp, selectors, stylesheets, {}, runToken),
        token
      );
      return {
        outcome: {
          companionPath: companion.htmlPath,
          companionRank: rank,
          verdicts: pass.verdicts,
          success: true,
        },
        locatedSelectors: pass.locatedSelectors,
      };
    } catch (err) {
      if (token?.isCancellationRequested || err instanceof AnalysisCancelledError) {
        throw err;
      }

      // Transient first-run failures (cold browser start-up, first
      // navigation racing the session teardown of a prior run) fail the
      // pass at the set-up/navigation stage — not in the inspection. Retry
      // ONCE with a short bounded backoff and a forced refresh: a failed
      // pass leaves its declarations ⊥ in the merge, and a partial run is
      // never cached, so without this retry a flaky first navigation would
      // leave the whole run incomplete until the next user-triggered
      // analysis (identical content is not re-analyzed — the open/switch
      // trigger skips hash-identical content).
      await sleep(250);
      try {
        const retried = await this.withSessionPass(
          companion.serverRoot,
          pagePath,
          true,
          (cdp, runToken) =>
            this.inspectSelectorsForVerdicts(cdp, selectors, stylesheets, {}, runToken),
          token
        );
        logger.info(
          `[MultiCompanion] Companion pass retried successfully for ${companion.htmlPath} (rank ${rank})`
        );
        return {
          outcome: {
            companionPath: companion.htmlPath,
            companionRank: rank,
            verdicts: retried.verdicts,
            success: true,
          },
          locatedSelectors: retried.locatedSelectors,
        };
      } catch (retryErr) {
        if (token?.isCancellationRequested || retryErr instanceof AnalysisCancelledError) {
          throw retryErr;
        }
        return {
          outcome: {
            companionPath: companion.htmlPath,
            companionRank: rank,
            verdicts: new Map(),
            success: false,
            error: retryErr instanceof Error ? retryErr.message : String(retryErr),
          },
          locatedSelectors: [],
        };
      }
    }
  }

  /**
   * Convert a merged verdict map into the final issue list: ONLY merged
   * `I` results (with their highest-ranked pass issue) are emitted, each
   * carrying the bounded-evidence metadata (evaluatedCount, inactiveCount,
   * analyzedCompanions). A merged `A` suppresses the declaration entirely.
   */
  private materializeMerged(
    merged: Map<string, MergedResult>,
    cssFilePath: string,
    analyzedCompanions: number,
    warm: boolean
  ): CssIssue[] {
    const issues: CssIssue[] = [];
    for (const result of merged.values()) {
      if (result.verdict !== 'I' || !result.issue) {
        continue;
      }
      // Shallow copy: warm runs reuse cached issue objects, so the
      // per-run evidence metadata must never mutate a cached object.
      issues.push({
        ...result.issue,
        evaluatedCount: result.evaluatedCount,
        inactiveCount: result.inactiveCount,
        analyzedCompanions,
      });
    }
    if (warm) {
      this.runMetrics.analyzedSelectorCount = Array.from(merged.values()).filter(
        (result) => result.evaluatedCount > 0
      ).length;
    }
    logger.info(
      `[MultiCompanion] Merged ${merged.size} declaration verdict(s) → ` +
      `${issues.length} issue(s) for ${cssFilePath}`
    );
    return issues;
  }

  /**
   * Analyze an HTML file: serve the file's directory, derive the target
   * selectors from its embedded CSS (`<style>` blocks and `style=""`
   * attributes), then inspect every matching element in the real page.
   *
   * Phase 6 single-writer (F4): this flow owns ONLY the PAGE-LOCAL embedded
   * outcome. The issues of the linked EXTERNAL stylesheets are owned by the
   * GLOBAL multi-companion outcome — every linked sheet is ensured fresh in
   * the cssGlobal namespace (reused when its (content, context, epoch)
   * identity matches, computed otherwise), and no single-page external-sheet
   * verdict is ever emitted or applied here. Public so integration tests can
   * drive the production pipeline.
   */
  async analyzeHtmlFile(htmlFilePath: string, _startTime: number, token?: CancellationTokenLike): Promise<CssIssue[]> {
    this.runMetrics = new RunMetrics();
    this.lastContextFingerprint = null;
    throwIfCancelled(token);
    logger.info(`Running CDP Analyzer on HTML file: ${htmlFilePath}`);

    // ── Step: scan the document for embedded CSS through the HTML cache ──
    // The cache is content-addressed: a hit means nothing changed since the
    // last read, which drives the page refresh decision below.
    let htmlChanged = true;
    let content = '';
    let fragments: HtmlCssFragments | null = null;
    let htmlHash = '';
    try {
      const parsed = htmlFragmentCache.getOrParse(htmlFilePath);
      htmlChanged = !parsed.hit;
      content = parsed.content;
      fragments = parsed.fragments;
      htmlHash = parsed.hash;
    } catch (err) {
      logger.debug(
        `[Analyzer] Could not read HTML file ${htmlFilePath}: ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
      this.runMetrics.markSkippedAll(`Could not read the HTML file: ${htmlFilePath}`);
      return [];
    }

    const serverRoot = this.serverRootFor(htmlFilePath);
    const externalSheets = this.findLinkedStylesheets(htmlFilePath, serverRoot, content);
    const embedded = embeddedParseCache.getOrParse(htmlFilePath, htmlHash, fragments);

    if (externalSheets.length === 0 && fragments.styleBlocks.length === 0 && fragments.styleAttributes.length === 0) {
      logger.warn('[Analyzer] No linked stylesheets or embedded CSS found — nothing to analyze');
      this.runMetrics.markSkippedAll('No linked stylesheets or embedded CSS found in the document');
      return [];
    }

    // Embedded `<style>` blocks are mapping targets just like stylesheets:
    // each block is one target whose rules carry document-relative ranges,
    // and the block content hash distinguishes identical block texts at
    // different document offsets inside the mapping cache.
    const blockTargets: LocalStylesheet[] = embedded.blocks.map((block, blockIndex) => ({
      path: htmlFilePath,
      hash: block.contentHash,
      changed: htmlChanged,
      rules: block.rules,
      origin: {
        line: fragments.styleBlocks[blockIndex].position.startLine,
        column: fragments.styleBlocks[blockIndex].position.startColumn,
      },
    }));

    // ── F4: ensure the GLOBAL multi-companion outcome of every linked ──
    // ── external stylesheet (reused when fresh, computed otherwise).   ──
    // The global analysis may navigate the shared session; its run metrics
    // belong to the cssGlobal namespace, so the outer HTML run's metrics
    // are restored afterwards.
    if (this.globalOutcomeStore) {
      const savedMetrics = this.runMetrics;
      try {
        for (const sheet of externalSheets) {
          await this.ensureCssGlobalOutcome(sheet, token);
        }
      } finally {
        this.runMetrics = savedMetrics;
      }
    }

    // ── Step: the page-local judgment targets ONLY the embedded CSS ──
    // (the `<style>` blocks of this page, plus its `style=""` attributes).
    // The linked sheets' selectors were judged by the global flow; judging
    // them here too would re-emit single-page external-sheet verdicts.
    const selectors: string[] = [];
    const dropped: DroppedSelector[] = [];
    for (const target of blockTargets) {
      const extracted = extractQueryableSelectorsDetailed(target.rules);
      selectors.push(...extracted.queryable);
      dropped.push(...extracted.dropped);
    }
    this.recordDroppedSelectors(dropped);

    logger.info(
      `[Analyzer] ${selectors.length} queryable selector(s), ` +
      `${fragments.styleBlocks.length} <style> block(s), ` +
      `${fragments.styleAttributes.length} style attribute(s)`
    );
    if (selectors.length === 0 && fragments.styleAttributes.length === 0) {
      logger.warn('[Analyzer] No queryable selectors — nothing to inspect');
      this.markNoQueryableSelectors(dropped.length, 'No queryable selectors in the embedded stylesheets');
      return [];
    }

    // A refresh is needed when the HTML changed or when any linked
    // stylesheet was re-parsed (its content changed): the external rules
    // still shape the computed layout the embedded declarations are judged
    // against.
    const refresh = htmlChanged || externalSheets.some((sheet) => sheet.changed);

    return this.withSession(
      serverRoot,
      toServedPath(serverRoot, htmlFilePath) ?? `/${path.basename(htmlFilePath)}`,
      refresh,
      (cdp, runToken) =>
        this.inspectSelectors(
          cdp,
          selectors,
          blockTargets,
          {
            inline: {
              htmlPath: htmlFilePath,
              htmlHash,
              fragments,
              embedded,
            },
          },
          runToken
        ),
      token
    );
  }

  /**
   * F4 single-writer: ensure the GLOBAL multi-companion outcome of one
   * linked stylesheet is fresh in the cssGlobal namespace.
   *
   * The outcome is REUSED when the recorded (content fingerprint, context
   * fingerprint, session epoch) identity matches the current world; the
   * context fingerprint is derived from the validated companion-cache
   * snapshot (F1), re-resolving first when the snapshot is stale. Otherwise
   * the global flow runs (the same production path as `analyzeCssFile`,
   * including its merged-cache warm path) and its outcome is recorded under
   * the identity it was judged against.
   *
   * The caller restores the outer run's metrics: the global outcome's
   * coverage belongs to the store, never to the page-local HTML run.
   */
  private async ensureCssGlobalOutcome(sheet: LocalStylesheet, token?: CancellationTokenLike): Promise<void> {
    let contextFingerprint = companionContextFingerprintFor(sheet.path);
    if (contextFingerprint === STALE_CONTEXT_FINGERPRINT) {
      // No validated snapshot (reset cache, changed companion): resolve now
      // — this run's resolution populates the very snapshot it judges
      // against, so the recorded fingerprint always matches the evidence.
      await this.resolveCompanionsFor(sheet.path);
      contextFingerprint = companionContextFingerprintFor(sheet.path);
      if (contextFingerprint === STALE_CONTEXT_FINGERPRINT) {
        logger.warn(
          `[Orchestration] No validated companion snapshot for ${sheet.path} — ` +
          `skipping the global outcome this run`
        );
        return;
      }
    }

    const epoch = defaultLifecycle.epoch;
    if (
      this.globalOutcomeStore!.getFresh(sheet.path, sheet.hash, contextFingerprint, epoch) !== undefined
    ) {
      logger.debug(
        `[Orchestration] Global outcome reused for ${sheet.path} (content+context fingerprint unchanged)`
      );
      return;
    }

    logger.info(`[Orchestration] Computing the global outcome of ${sheet.path}`);
    const issues = await this.analyzeCssFile(sheet.path, Date.now(), token);
    this.globalOutcomeStore!.record(sheet.path, sheet.hash, contextFingerprint, epoch, issues);
  }

  /**
   * Run the full CDP pipeline against a fixture directory and return the
   * confirmed inactive issues. Public so integration tests can drive the
   * production pipeline against real Chromium without an editor.
   */
  async analyzeFixture(
    fixturePath: string,
    selector: string,
    _startTime: number,
    token?: CancellationTokenLike
  ): Promise<CssIssue[]> {
    this.runMetrics = new RunMetrics();
    throwIfCancelled(token);
    logger.info('Running CDP Analyzer...');

    // ── Step: read/parse the local stylesheet through the AST cache ──
    const cssFilePath = path.join(fixturePath, 'styles.css');
    let cssHash = '';
    let rules: CssRule[] | null = null;
    let cssChanged = false;

    try {
      const parsed = astCache.getOrParse(cssFilePath);
      cssHash = parsed.hash;
      rules = parsed.rules;
      cssChanged = !parsed.hit;
      if (!parsed.hit) {
        const declarationCount = rules.reduce((n, r) => n + r.declarations.length, 0);
        logger.info(
          `[AST] Parsed CSS declarations: ${declarationCount} declaration(s) ` +
          `across ${rules.length} rule(s)`
        );
      }
    } catch (err) {
      logger.debug(
        `[Mapper] Could not parse local stylesheet ${cssFilePath}: ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!rules) {
      this.runMetrics.markSkippedAll(`Could not parse the local stylesheet: ${cssFilePath}`);
      return [];
    }

    return this.withSession(
      fixturePath,
      null,
      cssChanged,
      (cdp, runToken) =>
        this.inspectSelectors(
          cdp,
          [selector],
          [{ path: cssFilePath, hash: cssHash, changed: cssChanged, rules }],
          {},
          runToken
        ),
      token
    );
  }

  /**
   * Run the CDP interaction phase within the persistent session, retrying
   * once after a session recovery. A failure is never swallowed: prepare
   * failures and final run failures propagate (annotated with their
   * originating subsystem) so the orchestration layer can classify them
   * centrally. Cancellation is honoured between phases.
   */
  private async withSession(
    fixturePath: string,
    targetUrl: string | null,
    forceRefresh: boolean,
    run: (cdp: any, token?: CancellationTokenLike) => Promise<CssIssue[]>,
    token?: CancellationTokenLike
  ): Promise<CssIssue[]> {
    return this.withSessionPass(fixturePath, targetUrl, forceRefresh, run, token);
  }

  /**
   * Generic form of {@link withSession}: the session plumbing (prepare,
   * recovery retry, cancellation, failure annotation) around a phase of
   * arbitrary result type. One pass = one epoch of the persistent session;
   * companion passes run sequentially through the SAME plumbing, so the
   * run token is checked before every navigation and every application.
   */
  private async withSessionPass<T>(
    fixturePath: string,
    targetUrl: string | null,
    forceRefresh: boolean,
    run: (cdp: any, token?: CancellationTokenLike) => Promise<T>,
    token?: CancellationTokenLike
  ): Promise<T> {
    throwIfCancelled(token);

    let cdp;
    try {
      const prepared = await defaultLifecycle.prepare(fixturePath, targetUrl, forceRefresh);
      cdp = prepared.cdp;
      this.lastSessionEpoch = prepared.epoch;
      if (prepared.pageLoadTimedOut) {
        this.runMetrics.addWarning(pageLoadTimeoutFailure());
      }
    } catch (err) {
      // Setup failures (browser launch, DevServer, CDP connect, page load)
      // all surface from the lifecycle — annotate for central classification.
      throw annotateFailureSource(err, 'browser');
    }

    throwIfCancelled(token);

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await run(cdp, token);
      } catch (e) {
        if (token?.isCancellationRequested || e instanceof AnalysisCancelledError) {
          throw e;
        }
        lastError = e;

        if (attempt === 1) {
          logger.warn('[Lifecycle] Analysis failed mid-session — recovering and retrying once');
          try {
            await defaultLifecycle.recover();
            // The recovery replaced the browser, so the analysis page must be
            // (re)prepared: the fresh tab is navigated to the fixture before
            // the retry touches the DOM.
            const prepared = await defaultLifecycle.prepare(fixturePath, targetUrl, true);
            cdp = prepared.cdp;
            this.lastSessionEpoch = prepared.epoch;
            continue;
          } catch (recErr) {
            throw annotateFailureSource(recErr, 'browser');
          }
        }
        break;
      }
    }

    // The retry did not help: propagate the original (annotated) failure —
    // never a silent empty result.
    throw annotateFailureSource(lastError, 'cdp');
  }

  /**
   * Convenience wrapper over {@link inspectSelectorsCore} returning the
   * materialized issue list (single-page/wrapper/fixture flows).
   *
   * `options.syntheticParents` marks the CSS-file flow: standalone
   * selectors are top-level wrapper elements whose `<body>` parent is an
   * artifact, so their parent context must be treated as unknown.
   *
   * `options.inline` enables the embedded-CSS flow: every element carrying
   * a `style=""` attribute is inspected for its inline declarations (the
   * element's rule declarations are already covered by the selector loop),
   * and each confirmed inactive inline declaration is mapped back into the
   * attribute's source text. Inline declarations are never added to the
   * stylesheet batch — they have no owning stylesheet and would otherwise
   * be mis-mapped to a same-named stylesheet declaration.
   */
  private async inspectSelectors(
    cdp: any,
    selectors: string[],
    stylesheets: LocalStylesheet[],
    options: { syntheticParents?: boolean; inline?: InlineAnalysis; crossRuleCascade?: boolean } = {},
    token?: CancellationTokenLike
  ): Promise<CssIssue[]> {
    const result = await this.inspectSelectorsCore(cdp, selectors, stylesheets, options, token);
    return [...result.issues, ...result.inlineIssues];
  }

  /**
   * Companion-pass form of the inspection: SAME node loop, SAME mapping —
   * but the result is the per-declaration semantic verdict map and the
   * located selectors instead of just the issue list, so every successful
   * companion pass can join its verdicts into the merge. Selector
   * bookkeeping (analyzed/skipped run metrics) is deferred to the
   * merged-semantics step after all passes.
   */
  private async inspectSelectorsForVerdicts(
    cdp: any,
    selectors: string[],
    stylesheets: LocalStylesheet[],
    options: { syntheticParents?: boolean; inline?: InlineAnalysis; crossRuleCascade?: boolean } = {},
    token?: CancellationTokenLike
  ): Promise<PassInspectionResult> {
    return this.inspectSelectorsCore(
      cdp,
      selectors,
      stylesheets,
      { ...options, deferSelectorBookkeeping: true },
      token
    );
  }

  /**
   * Inspect every target selector in the loaded page: locate the node,
   * collect the browser facts, run the inactive engine and map the
   * confirmed results back to their local declarations.
   *
   * All declarations of all nodes form a single batch so the deterministic
   * mapping cache sees the exact same input a fresh run would.
   *
   * `options.deferSelectorBookkeeping` (companion passes only) skips the
   * per-selector analyzed/skipped run metrics — the merged-semantics step
   * bookkeeps each selector exactly once after all passes.
   */
  private async inspectSelectorsCore(
    cdp: any,
    selectors: string[],
    stylesheets: LocalStylesheet[],
    options: { syntheticParents?: boolean; inline?: InlineAnalysis; deferSelectorBookkeeping?: boolean; crossRuleCascade?: boolean } = {},
    token?: CancellationTokenLike
  ): Promise<PassInspectionResult> {
    const issues: CssIssue[] = [];
    const inlineIssues: CssIssue[] = [];
    const verdicts = new Map<string, PassVerdict>();
    const locatedSelectors: string[] = [];
    throwIfCancelled(token);

    // The layout context cache is per-analysis-run: the document (and its
    // node ids) may change between runs, so stale state is never reused.
    this.layoutContextBuilder.reset();

    const domTree = await cdp.send('DOM.getDocument', { depth: -1 });
    throwIfCancelled(token);
    logger.info('[CDP] DOM frontend tree initialized for the loaded document');
    // Hand the already-fetched tree to the builder so parent detection
    // costs zero extra protocol round trips.
    this.layoutContextBuilder.setDomRoot(domTree?.root);

    const allDeclarations: MatchedCssDeclaration[] = [];
    const inactive: Array<{ declaration: MatchedCssDeclaration; result: InactivePropertyResult }> = [];
    const active: MatchedCssDeclaration[] = [];
    const engine = this.inactiveEngine;

    for (const selector of selectors) {
      throwIfCancelled(token);

      const node = await this.locateNode(cdp, selector);
      if (!node) {
        if (!options.deferSelectorBookkeeping) {
          this.runMetrics.markSkipped(selector, 'selector matched no element in the analyzed page');
        }
        continue;
      }
      if (!options.deferSelectorBookkeeping) {
        this.runMetrics.markAnalyzed();
      }
      locatedSelectors.push(selector);

      // PR Level 3: the matched styles are collected FIRST so the pseudo
      // content facts (cascade-winning `content` per pseudo-element) can
      // be handed to the LayoutContextBuilder — pseudo rules read them
      // through the context, with zero extra protocol round trips.
      const facts = await this.gatherNodeFacts(cdp, selector, node, options.crossRuleCascade !== false);

      // PR6 Phase 1: collect ALL computed styles in one protocol pass and
      // build the immutable LayoutContext consumed by every rule. The
      // declared display and the synthetic-parent hint (CSS-file flow)
      // travel through the options bag so the builder stays the only
      // component understanding layout.
      const layout = await this.layoutContextBuilder.build(
        cdp,
        node.nodeId,
        facts.pseudoContent,
        {
          declaredDisplay: facts.declaredDisplay,
          parentIsSynthetic: options.syntheticParents && isStandaloneSelector(selector),
          syntheticElementType: options.syntheticParents && !hasExplicitTag(selector),
          pseudoBoxFacts: facts.pseudoBoxFacts,
        }
      );
      logger.info(`[CDP] Computed display for ${selector}: ${layout.display}`);

      // Inline `style=""` declarations of selector-matched elements are
      // inspected in the dedicated inline flow below (they map back into
      // the HTML attribute, not into any stylesheet). Rule declarations
      // stay in the stylesheet batch.
      const ruleDeclarations = facts.declarations.filter((d) => !d.isInlineStyle);
      allDeclarations.push(...ruleDeclarations);

      for (const declaration of ruleDeclarations) {
        logger.info(
          `[InactiveEngine] Inspecting ${declaration.propertyName} ` +
          `with display=${layout.display}, parent=${layout.parentDisplay}`
        );

        const result = engine.inspect({
          declaration,
          computedStyles: layout.computedStyles,
          layout,
        });

        if (result) {
          logger.info(`[InactiveEngine] Inactive (${selector}): ${result.reasonCode}`);
          inactive.push({ declaration, result });
        } else {
          logger.info(
            `[InactiveEngine] Active: ${declaration.propertyName} is valid in display=${layout.display}`
          );
          // The declaration is provably effective for THIS node — its
          // per-pass verdict must be `A`, the absorbing element.
          active.push(declaration);
        }
      }
    }

    // ── Step: map the CDP declarations to their local declarations ──
    // Deterministic mapping cache: identical CSS content + identical CDP
    // declaration batch never re-run the mapper.
    //
    // Each declaration is mapped against the ONE sheet that owns it — the
    // sheet whose parsed rules contain the declaration's source range
    // (CDP ranges shifted into the sheet's coordinate space). Scope is
    // exclusive: a declaration is never mapped against a foreign sheet,
    // so two sheets defining the same selector/property text can never
    // steal each other's declarations during the claim pass.
    //
    // Occurrence-scoped keys (`batchKeys`) rank equal reports within the
    // OWNER partition, in inspection (source) order: the k-th report of a
    // property claims the k-th local declaration, while equal reports of
    // ONE authored declaration (a rule matching several nodes) share one
    // key and collapse onto the same local range.
    //
    // The mapping maps are keyed by sheet INDEX, not path: embedded
    // `<style>` block targets all share the HTML file path, and their
    // distinct rule sets must stay distinct in the lookup.
    const { mappings, occurrenceKeysBySheet } = this.buildMappingTables(
      stylesheets,
      allDeclarations
    );

    // One issue per LOCAL DECLARATION: duplicate CDP reports (the same
    // rule matching several nodes) collapse onto their shared source
    // range, while two nodes with identical inline declarations stay
    // distinct (different attribute ranges).
    const emittedLocations = new Set<string>();
    const emit = (
      declaration: MatchedCssDeclaration,
      result: InactivePropertyResult,
      mapped: LocalDeclarationMatch,
      target: CssIssue[],
      overrideTarget?: CssLocation
    ): CssIssue | null => {
      const key = locationKey(mapped.declarationRange);
      if (emittedLocations.has(key)) {
        logger.debug(
          `[Mapper] Inactive ${declaration.propertyName} already reported for ` +
          `'${declaration.selectorText}' — duplicate skipped`
        );
        return null;
      }
      emittedLocations.add(key);
      const issue = this.createIssue(declaration, result, mapped, overrideTarget);
      target.push(issue);
      return issue;
    };

    // The owner sheet of a matched declaration (or null): the first sheet
    // whose parsed rules contain the declaration, found through the
    // occurrence-scoped lookup. The merge key of every verdict derives from
    // the OWNER sheet's identity and the PARSED LOCAL declaration range —
    // never from CDP ranges, node ids or companion paths — so two passes
    // over different companions always key the same authored declaration
    // identically.
    const findOwner = (
      declaration: MatchedCssDeclaration
    ): { sheetIndex: number; mapped: LocalDeclarationMatch } | null => {
      for (let sheetIndex = 0; sheetIndex < stylesheets.length; sheetIndex++) {
        const occurrenceKey = occurrenceKeysBySheet.get(sheetIndex)?.get(declaration);
        const mapped = occurrenceKey
          ? (mappings.get(sheetIndex)?.get(occurrenceKey) ?? null)
          : null;
        if (mapped) {
          return { sheetIndex, mapped };
        }
      }
      return null;
    };

    const verdictKey = (
      sheetIndex: number,
      mapped: LocalDeclarationMatch,
      propertyName: string
    ): string =>
      declarationKeyFor(
        stylesheets[sheetIndex].path,
        `${stylesheets[sheetIndex].path}|${stylesheets[sheetIndex].hash}`,
        mapped.declarationRange,
        propertyName
      );

    // The local source position of the declaration that OVERRIDES this one
    // (its `overriddenBy` pointer, materialized through the owner-sheet
    // mapping). The winner lives in the same batch, so the occurrence
    // lookup resolves it exactly like the overridden declaration itself;
    // unmappable winners yield no target (the hover shows no link).
    const overrideTargetFor = (declaration: MatchedCssDeclaration): CssLocation | undefined => {
      const winner = declaration.overriddenBy;
      if (!winner) {
        return undefined;
      }
      const owner = findOwner(winner);
      return owner?.mapped.propertyNameRange;
    };

    for (const { declaration, result } of inactive) {
      const owner = findOwner(declaration);
      if (!owner) {
        logger.debug(
          `[Mapper] No local declaration for inactive ${declaration.propertyName} ` +
          `— issue skipped (no valid source range)`
        );
        continue;
      }

      const issue = emit(declaration, result, owner.mapped, issues, overrideTargetFor(declaration));
      if (!issue) {
        // Already reported for an earlier instance of the same authored
        // declaration (the rule matched several nodes) — its verdict was
        // already recorded.
        continue;
      }
      const key = verdictKey(owner.sheetIndex, owner.mapped, declaration.propertyName);
      if (!verdicts.has(key)) {
        verdicts.set(key, {
          key,
          verdict: 'I',
          reasonCode: result.reasonCode,
          reasonText: result.reasonText,
          issue,
        });
      }
    }

    // Fold `A` verdicts: a declaration provably effective for ANY inspected
    // node of this pass is effective in this pass (the absorbing element) —
    // it overwrites the `I` issued by other instances of the same authored
    // declaration in this same pass.
    for (const declaration of active) {
      const owner = findOwner(declaration);
      if (!owner) {
        continue;
      }
      const key = verdictKey(owner.sheetIndex, owner.mapped, declaration.propertyName);
      verdicts.set(key, { key, verdict: 'A' });
    }

    // ── Step: embedded inline styles (`style=""` attributes) ──
    if (options.inline) {
      const inlineConfig = options.inline;
      const inlineTargets = this.collectInlineTargets(domTree?.root, inlineConfig.fragments);

      for (const target of inlineTargets) {
        throwIfCancelled(token);
        const facts = await this.gatherInlineFacts(cdp, target.nodeId);
        const layout = await this.layoutContextBuilder.build(cdp, target.nodeId, undefined, {
          declaredDisplay: facts.declaredDisplay,
        });

        // Occurrence rank per equal inline report: CDP reports authored
        // duplicates in source order, and the fragment's parsed
        // declarations are in source order too, so the k-th report pairs
        // with the k-th candidate (see matchInlineDeclaration).
        const occurrences = new Map<string, number>();

        // Total occurrence counts (per name|value) of THIS attribute —
        // needed to locate the cascade winner of an overridden inline
        // declaration: the winner is the LAST declaration of its own
        // name|value pair in source order, i.e. rank total − 1.
        const totalOccurrences = new Map<string, number>();
        for (const declaration of facts.declarations) {
          const occurrenceKey = `${declaration.propertyName}|${declaration.propertyValue}`;
          totalOccurrences.set(occurrenceKey, (totalOccurrences.get(occurrenceKey) ?? 0) + 1);
        }

        // The local source position of the inline declaration that
        // overrides this one, resolved through the same fragment mapping
        // used for the overridden declaration itself.
        const inlineOverrideTargetFor = (
          declaration: MatchedCssDeclaration
        ): CssLocation | undefined => {
          const winner = declaration.overriddenBy;
          if (!winner) {
            return undefined;
          }
          const occurrenceKey = `${winner.propertyName}|${winner.propertyValue}`;
          const lastOccurrence = (totalOccurrences.get(occurrenceKey) ?? 1) - 1;
          const match = this.mapInlineDeclaration(
            winner,
            target.fragmentIndex,
            inlineConfig,
            lastOccurrence
          );
          return match?.propertyNameRange;
        };

        for (const declaration of facts.declarations) {
          logger.info(
            `[InactiveEngine] Inspecting inline ${declaration.propertyName} ` +
            `with display=${layout.display}, parent=${layout.parentDisplay}`
          );
          const result = engine.inspect({
            declaration,
            computedStyles: layout.computedStyles,
            layout,
          });
          if (!result) {
            logger.info(
              `[InactiveEngine] Active: inline ${declaration.propertyName} is valid in display=${layout.display}`
            );
            continue;
          }

          logger.info(`[InactiveEngine] Inactive: ${result.reasonCode}`);
          const occurrenceKey = `${declaration.propertyName}|${declaration.propertyValue}`;
          const occurrence = occurrences.get(occurrenceKey) ?? 0;
          occurrences.set(occurrenceKey, occurrence + 1);

          const mapped = this.mapInlineDeclaration(
            declaration,
            target.fragmentIndex,
            options.inline,
            occurrence
          );
          if (!mapped) {
            logger.debug(
              `[Mapper] No local attribute declaration for inactive inline ` +
              `${declaration.propertyName} — issue skipped (no valid source range)`
            );
            continue;
          }
          emit(declaration, result, mapped, inlineIssues, inlineOverrideTargetFor(declaration));
        }
      }
    }

    // A run that handed the browser a list of selectors but found no element
    // to inspect has no analysis context — recorded as a classified warning,
    // never pretended to have succeeded. Companion passes defer this to the
    // merged-semantics step, where the located selectors of ALL passes are
    // known.
    if (
      !options.deferSelectorBookkeeping &&
      this.runMetrics.analyzedSelectorCount === 0 &&
      selectors.length > 0
    ) {
      this.runMetrics.addWarning(
        analysisContextMissingFailure(
          'The analyzed page contains no element matching any inspected selector'
        )
      );
    }

    logger.info(
      `[CDP Analyzer] Produced ${issues.length} real issue${issues.length === 1 ? '' : 's'}`
    );
    return { issues, inlineIssues, verdicts, locatedSelectors };
  }

  /**
   * Build the per-sheet mapping lookup for ALL matched declarations of one
   * inspection pass, partitioned by sheet ownership (see the caller's
   * comment on scope exclusivity). Occurrence-scoped keys rank equal
   * reports within each owner partition, in inspection (source) order.
   */
  private buildMappingTables(
    stylesheets: LocalStylesheet[],
    allDeclarations: MatchedCssDeclaration[]
  ): {
    mappings: Map<number, Map<string, LocalDeclarationMatch | null>>;
    occurrenceKeysBySheet: Map<number, Map<MatchedCssDeclaration, string>>;
  } {
    const mappings = new Map<number, Map<string, LocalDeclarationMatch | null>>();
    const occurrenceKeysBySheet = new Map<number, Map<MatchedCssDeclaration, string>>();
    for (let sheetIndex = 0; sheetIndex < stylesheets.length; sheetIndex++) {
      const partition = allDeclarations.filter((declaration) =>
        this.declarationBelongsToSheet(declaration, stylesheets[sheetIndex])
      );
      occurrenceKeysBySheet.set(sheetIndex, batchKeys(partition));
      mappings.set(
        sheetIndex,
        mappingCache.matchAll(
          stylesheets[sheetIndex].hash,
          stylesheets[sheetIndex].path,
          stylesheets[sheetIndex].rules,
          partition
        )
      );
    }
    return { mappings, occurrenceKeysBySheet };
  }

  /**
   * Find the document elements that carry a `style=""` attribute and pair
   * each with its SOURCE fragment.
   *
   * The browser's DOM tree (already fetched once per run) and the source
   * fragment list are both in document order, and both count exactly the
   * elements whose `style` attribute is written in the HTML — so a node
   * and a fragment correspond 1:1 when the lists agree in length and in
   * attribute-value content. Any disagreement (runtime-added attributes,
   * entity decoding differences, template/svg quirks) aborts the whole
   * inline flow: declarations that cannot be attributed confidently are
   * never reported (conservative abstain).
   */
  private collectInlineTargets(
    domRoot: unknown,
    fragments: HtmlCssFragments
  ): Array<{ nodeId: number; fragmentIndex: number }> {
    const found: Array<{ nodeId: number; value: string }> = [];

    const walk = (node: any): void => {
      if (!node || typeof node !== 'object') {
        return;
      }
      if (typeof node.nodeId === 'number' && Array.isArray(node.attributes)) {
        for (let i = 0; i + 1 < node.attributes.length; i += 2) {
          const name = node.attributes[i];
          if (typeof name === 'string' && name.toLowerCase() === 'style') {
            const value = node.attributes[i + 1];
            found.push({ nodeId: node.nodeId, value: typeof value === 'string' ? value : '' });
            break;
          }
        }
      }
      for (const child of node.children ?? []) {
        walk(child);
      }
    };
    walk(domRoot);

    const source = fragments.styleAttributes;
    if (found.length !== source.length) {
      logger.warn(
        `[Analyzer] Skipping inline styles: DOM reports ${found.length} style attribute(s) ` +
        `but the source has ${source.length} (runtime mutations?) — conservative abstain`
      );
      return [];
    }
    for (let i = 0; i < found.length; i++) {
      if (found[i].value.trim() !== source[i].value.trim()) {
        logger.warn(
          `[Analyzer] Skipping inline styles: style attribute #${i} differs ` +
          `between DOM and source — conservative abstain`
        );
        return [];
      }
    }

    return found.map((f, i) => ({ nodeId: f.nodeId, fragmentIndex: i }));
  }

  /**
   * Collect the INLINE `style=""` declarations of one node (the CDP
   * `inlineStyle` section, normalized like every other declaration). Only
   * the inline declarations are returned: the node's rule declarations are
   * already inspected through the selector flow.
   */
  private async gatherInlineFacts(
    cdp: any,
    nodeId: number
  ): Promise<{ declarations: MatchedCssDeclaration[]; declaredDisplay?: string }> {
    const rawMatched = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
    const declarations = normalizeAndDeduplicate(
      collectMatchedDeclarations(nodeId, rawMatched).filter((d) => d.isInlineStyle)
    );
    markOverriddenDeclarations(declarations);
    const declaredDisplay = collectDeclaredDisplay(rawMatched);
    return { declarations, declaredDisplay };
  }

  /**
   * Whether a declaration was reported from `sheet`'s OWN text.
   *
   * CDP reports a property's source range in the range space of the
   * stylesheet that owns it: relative to a file's text for linked sheets,
   * relative to the `<style>` block's text for embedded blocks. Shifted
   * by the sheet's `origin` (identity for files), it is in the same
   * coordinate space as the sheet's parsed, document-shifted rules — the
   * declaration belongs to the sheet exactly when one of its rules has an
   * authored declaration containing that (property-level) range.
   *
   * Declaration-level ranges are used rather than rule ranges: a whole
   * rule's range from another file can numerically coincide with a block's
   * rule range after the shift, but a specific `property: value;` slice
   * lands inside a foreign sheet's declarations only by a near-impossible
   * accident. Assignment is first-wins in sheet order, so every
   * declaration is scoped to at most one sheet.
   */
  private declarationBelongsToSheet(
    declaration: MatchedCssDeclaration,
    sheet: LocalStylesheet
  ): boolean {
    if (!declaration.propertyRange || sheet.rules.length === 0) {
      return false;
    }
    const origin = sheet.origin ?? { line: 0, column: 0 };
    const shifted: CssSourceRange = {
      startLine: declaration.propertyRange.startLine + origin.line,
      startColumn:
        declaration.propertyRange.startLine === 0
          ? declaration.propertyRange.startColumn + origin.column
          : declaration.propertyRange.startColumn,
      endLine: declaration.propertyRange.endLine + origin.line,
      endColumn:
        declaration.propertyRange.endLine === 0
          ? declaration.propertyRange.endColumn + origin.column
          : declaration.propertyRange.endColumn,
    };
    return sheet.rules.some((rule) =>
      rule.declarations.some((local) => this.rangeContains(local.range, shifted))
    );
  }

  /** True when `outer` spans the full extent of `inner` (line-major). */
  private rangeContains(outer: CssSourceRange, inner: CssSourceRange): boolean {
    const beforeOrEqual = (aStart: number, aCol: number, bStart: number, bCol: number): boolean =>
      aStart < bStart || (aStart === bStart && aCol <= bCol);
    const afterOrEqual = (aEnd: number, aCol: number, bEnd: number, bCol: number): boolean =>
      aEnd > bEnd || (aEnd === bEnd && aCol >= bCol);
    return (
      beforeOrEqual(outer.startLine, outer.startColumn, inner.startLine, inner.startColumn) &&
      afterOrEqual(outer.endLine, outer.endColumn, inner.endLine, inner.endColumn)
    );
  }

  /**
   * Map an inline declaration back into its attribute fragment's source
   * text. The match is content-based (name/value, unique candidate only)
   * and cached deterministically per (HTML path, HTML hash, fragment,
   * name, value); an unmappable declaration returns null (conservative).
   */
  private mapInlineDeclaration(
    declaration: MatchedCssDeclaration,
    fragmentIndex: number,
    inline: InlineAnalysis,
    occurrenceIndex: number = 0
  ): LocalDeclarationMatch | null {
    const attributes = inline.embedded.attributes;
    if (fragmentIndex < 0 || fragmentIndex >= attributes.length) {
      return null;
    }

    const key = inlineMappingKey(
      inline.htmlPath,
      inline.htmlHash,
      fragmentIndex,
      declaration.propertyName,
      declaration.propertyValue,
      occurrenceIndex
    );
    const cached = embeddedMappingCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const match = matchInlineDeclaration(
      declaration,
      inline.htmlPath,
      attributes[fragmentIndex].declarations,
      occurrenceIndex
    );
    embeddedMappingCache.set(key, match);
    return match;
  }

  /**
   * Locate a DOM node for a selector via Runtime.evaluate + DOM.requestNode.
   * Returns null (with a diagnostic) when the selector matches nothing.
   */
  private async locateNode(cdp: any, selector: string): Promise<{ nodeId: number } | null> {
    logger.info(`[CDP] Locating ${selector} via Runtime.evaluate...`);

    const findResult = await cdp.send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      // Return a reference (objectId) to the DOM node, not a JSON value
      returnByValue: false,
    });

    const remoteObject = findResult.result;
    const hasNode = remoteObject && remoteObject.type === 'object' && remoteObject.subtype === 'node' && remoteObject.objectId;

    if (!hasNode) {
      logger.warn(`[CDP] Could not find ${selector} in DOM`);
      logger.debug(
        `[CDP] Locate response: type=${remoteObject?.type ?? 'n/a'} ` +
          `subtype=${remoteObject?.subtype ?? 'n/a'}`
      );
      return null;
    }

    logger.info(`[CDP] Runtime.evaluate found ${selector} element`);

    // Bridge the JS object to a CDP nodeId
    const { nodeId } = await cdp.send('DOM.requestNode', {
      objectId: remoteObject.objectId,
    });

    logger.info(`[CDP] Mapped ${selector} to nodeId: ${nodeId}`);
    return { nodeId };
  }

  /**
   * Collect the browser facts for one node: matched declarations (normalized
   * and deduplicated), the pseudo content facts, and the cascade-winning
   * authored `display` declaration. Computed styles are NOT queried here
   * anymore — the LayoutContextBuilder is the only component allowed to
   * understand CDP layout information (PR6 Phase 1).
   */
  private async gatherNodeFacts(
    cdp: any,
    selector: string,
    node: { nodeId: number },
    crossRuleCascade: boolean = true
  ): Promise<{
    declarations: MatchedCssDeclaration[];
    pseudoContent: ReadonlyMap<string, string>;
    pseudoBoxFacts: ReadonlyMap<string, PseudoBoxFacts>;
    declaredDisplay?: string;
  }> {
    // ── Step: collect matched declarations (browser facts only) ──
    const rawMatched = await cdp.send('CSS.getMatchedStylesForNode', { nodeId: node.nodeId });
    // Bounded debug record — NEVER the raw CDP payload: `getMatchedStylesForNode`
    // returns every matching rule across stylesheets + UA defaults, and
    // writing a multi-hundred-KB object to the output channel stalls the
    // extension host mid-pass (the single largest hazard on the first run).
    const rawRuleCount = rawMatched?.matchedCSSRules?.length ?? 0;
    const rawPropertyCount = rawMatched?.matchedCSSRules?.reduce(
      (n: number, r: { declaration?: unknown[] }) => n + (r.declaration?.length ?? 0),
      0
    ) ?? 0;
    logger.debug(
      `[CDP] Matched styles response for ${selector}: ${rawRuleCount} rule(s), ` +
        `${rawPropertyCount} declaration(s)`
    );
    const declarations = normalizeAndDeduplicate(collectMatchedDeclarations(node.nodeId, rawMatched));
    // Earlier duplicates of a property inside one declaration block have no
    // effect by CSS semantics — the engine answers them with a fixed
    // override verdict instead of a context rule. The cross-rule cascade
    // pass additionally flags declarations that lose to another rule on
    // this node — but only for REAL documents (see the wrapper-flow gate).
    markOverriddenDeclarations(declarations, { crossRule: crossRuleCascade });
    const pseudoContent = collectPseudoContent(rawMatched);
    const pseudoBoxFacts = await this.fetchPseudoBoxStyles(cdp, selector, collectPseudoTypes(rawMatched));
    const declaredDisplay = collectDeclaredDisplay(rawMatched);

    for (const declaration of declarations) {
      logger.info(
        `[CDP] Matched authored declaration: ${declaration.propertyName} = ` +
        `${declaration.propertyValue}${declaration.pseudoElement ? ` (${declaration.pseudoElement})` : ''}`
      );
    }

    return { declarations, pseudoContent, pseudoBoxFacts, declaredDisplay };
  }

  /**
   * Fetch the COMPUTED box-model styles of each present pseudo-element of a
   * node in ONE evaluate call. The browser is the only truthful source for
   * the pseudo box's formatting context: it ignores authored `display` and
   * `position` on a `::first-letter` box (the box stays inline unless
   * floated), while it honors them on `::before`/`::after` — the computed
   * styles reflect exactly that.
   *
   * `CSS.getComputedStyleForNode` (forPseudo) is not used: Chromium answers
   * it with the ORIGIN element's styles, so `getComputedStyle(el, pseudo)`
   * inside the page is the reliable channel.
   *
   * Returns a plain browser fact per pseudo type; an empty map when the
   * pseudo styles cannot be fetched (conservative — the engine then judges
   * against the origin element's context).
   */
  private async fetchPseudoBoxStyles(
    cdp: any,
    selector: string,
    pseudoTypes: readonly string[]
  ): Promise<ReadonlyMap<string, PseudoBoxFacts>> {
    const factsByPseudo = new Map<string, PseudoBoxFacts>();
    if (pseudoTypes.length === 0) {
      return factsByPseudo;
    }

    const expression = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const out = {};
      for (const p of ${JSON.stringify(pseudoTypes)}) {
        const pseudo = '::' + p.replace(/^::/, '');
        const cs = getComputedStyle(el, pseudo);
        out[p] = {
          display: cs.display,
          float: cs.float,
          position: cs.position,
          computedContent: cs.content,
        };
      }
      return out;
    })()`;

    try {
      const response = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
      });
      const value = response?.result?.value;
      if (value && typeof value === 'object') {
        for (const [type, styles] of Object.entries(value as Record<string, any>)) {
          if (styles && typeof styles === 'object') {
            factsByPseudo.set(type, {
              display: String(styles.display ?? ''),
              float: String(styles.float ?? ''),
              position: String(styles.position ?? ''),
              computedContent:
                typeof styles.computedContent === 'string' ? styles.computedContent : undefined,
            });
          }
        }
      }
    } catch (err) {
      logger.debug(
        `[CDP] Could not fetch pseudo box styles for ${selector}: ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
    }

    return factsByPseudo;
  }

  /**
   * Find the local stylesheets an HTML file links, parse them through the
   * AST cache and return the mapping targets. Hrefs are resolved through
   * the shared URL model against the page's served root (`serverRoot`), so
   * the matcher and the browser always agree. The path extraction itself
   * lives in `collectStylesheetPaths`; `htmlContent` avoids a second file
   * read when the caller already holds the (cached) document text.
   */
  private findLinkedStylesheets(htmlFilePath: string, serverRoot: string, htmlContent?: string): LocalStylesheet[] {
    const stylesheets: LocalStylesheet[] = [];

    for (const cssPath of this.collectStylesheetPaths(htmlFilePath, serverRoot, htmlContent)) {
      if (!fs.existsSync(cssPath)) {
        logger.debug(`[Analyzer] Skipping missing stylesheet ${cssPath}`);
        continue;
      }

      try {
        const parsed = astCache.getOrParse(cssPath);
        if (!parsed.hit) {
          const declarationCount = parsed.rules.reduce((n, r) => n + r.declarations.length, 0);
          logger.info(
            `[AST] Parsed CSS declarations: ${declarationCount} declaration(s) ` +
            `across ${parsed.rules.length} rule(s)`
          );
        }
        stylesheets.push({ path: cssPath, hash: parsed.hash, changed: !parsed.hit, rules: parsed.rules });
      } catch (err) {
        logger.debug(
          `[Mapper] Could not parse local stylesheet ${cssPath}: ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return stylesheets;
  }

  /**
   * Absolute, on-disk paths of the local stylesheets an HTML file links.
   * Every authored href is resolved exactly like the browser loading the
   * page at `/{page path under serverRoot}` resolves it: same-origin links
   * only (`https:`/`data:`/`blob:`/protocol-relative URLs never resolve
   * locally), honoring `<base href>` and root-relative paths. The returned
   * paths are not checked for existence; callers decide.
   */
  private collectStylesheetPaths(htmlFilePath: string, serverRoot: string, htmlContent?: string): string[] {
    const paths: string[] = [];
    let html: string;

    try {
      html = htmlContent ?? fs.readFileSync(htmlFilePath, 'utf-8');
    } catch (err) {
      logger.debug(
        `[Analyzer] Could not read HTML file ${htmlFilePath}: ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
      return paths;
    }

    const pagePath = toServedPath(serverRoot, htmlFilePath);
    if (pagePath === null) {
      return paths;
    }

    const { baseHref, hrefs } = extractLinkedHrefs(html);
    for (const href of hrefs) {
      let resolved: string | null = null;
      try {
        resolved = resolveLocalPath({ serverRoot, pagePath, baseHref, href });
      } catch {
        continue;
      }
      if (resolved !== null) {
        paths.push(resolved);
      }
    }

    return paths;
  }

  /**
   * The root a document is served from: the workspace folder containing it
   * when one is known (making root-relative and cross-directory links work
   * exactly as authored), else the document's own directory (the legacy
   * behavior, bit-identical for same-directory relative links).
   */
  private serverRootFor(filePath: string): string {
    const providerRoot = companionSettings.workspaceFolderProvider?.(filePath);
    if (providerRoot && toServedPath(providerRoot, filePath) !== null) {
      return providerRoot;
    }
    return path.dirname(filePath);
  }

  /**
   * Resolve (with caching) the ranked list of companion documents of a CSS
   * file: every real HTML document, anywhere under the search root, that
   * links this EXACT stylesheet — canonically deduplicated, then ranked
   * deterministically (directory distance, then `index.html` first, then
   * alphabetical). Returns null when no document links the stylesheet —
   * the caller then falls back to the synthetic wrapper page. The cached
   * value is the FULL ranked list (pre-truncation), so coverage `total` /
   * `skipped` stay consistent between warm and cold runs.
   */
  private async resolveCompanionsFor(cssFilePath: string): Promise<CompanionResolution[] | null> {
    const cssReal = path.normalize(path.resolve(cssFilePath));
    const primaryRoot =
      companionSettings.workspaceFolderProvider?.(cssFilePath) ?? path.dirname(cssReal);
    const cacheKey = `${primaryRoot}|${cssReal}`;

    const cached = companionCache.getValidated(cacheKey);
    if (cached !== undefined) {
      logger.debug(`[Companion] Resolution cache hit for ${cssFilePath}`);
      return cached;
    }

    const ranked = await resolveCompanionsAll({ cssFilePath });
    companionCache.set(cacheKey, ranked);
    if (ranked.length > 0) {
      logger.info(
        `[Companion] Resolved ${ranked.length} companion document(s) for ${cssFilePath}`
      );
      for (const resolution of ranked) {
        logger.info(
          `[Companion]   → ${resolution.htmlPath} ` +
          `(href '${resolution.href}', ${resolution.kind}, distance ${resolution.distance}, ` +
          `serverRoot ${resolution.serverRoot})`
        );
      }
    } else {
      logger.debug(`[Companion] No companion document links ${cssFilePath}`);
    }
    return ranked;
  }

  /**
   * Convert a confirmed inactive result into a CssIssue carrying both the
   * CDP source information and the valid local source range produced by the
   * DeclarationMapper.
   *
   * `location` is always the non-empty local declaration range, so the
   * decoration pipeline dims the authored declaration and anchors the
   * inline icon at its end — it is never skipped for an empty range.
   */
  private createIssue(
    declaration: MatchedCssDeclaration,
    result: InactivePropertyResult,
    mapped: LocalDeclarationMatch,
    overrideTarget?: CssLocation
  ): CssIssue {
    return {
      propertyName: result.propertyName,
      propertyValue: declaration.propertyValue,
      selector: declaration.selectorText,
      selectorText: declaration.selectorText,
      styleSheetId: declaration.styleSheetId ?? '',
      cdpRange: declaration.propertyRange ?? declaration.ruleRange,
      reasonCode: result.reasonCode,
      reasonText: result.reasonText,
      reason: result.reasonText,
      location: mapped.declarationRange,
      declarationRange: mapped.declarationRange,
      propertyNameRange: mapped.propertyNameRange,
      iconAnchorRange: mapped.iconAnchorRange,
      overrideTarget,
    };
  }
}
