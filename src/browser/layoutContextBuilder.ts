/**
 * PR6 Phase 1 — Layout Context Builder.
 *
 * The ONLY component allowed to understand CDP layout information. It
 * collects all required computed styles in ONE protocol pass per node,
 * resolves the parent element, and produces the immutable LayoutContext
 * that every inactive-property rule consumes.
 *
 * Protocol round trips are minimized:
 *   - element computed styles: one `CSS.getComputedStyleForNode` call
 *     (Chromium returns the full style map in a single response),
 *   - parent detection: the already-fetched DOM tree (or one
 *     `DOM.getDocument` call per run), never a per-node call,
 *   - parent computed styles: one call per distinct parent node, cached.
 *
 * Graceful degradation: when CDP fails to provide the element's styles or
 * its parent (e.g. the `<html>` element or the document root), safe
 * defaults are returned (`parentDisplay: 'none'`, item flags false) —
 * the builder NEVER throws.
 */

import {
  LayoutContext,
  PseudoBoxFacts,
  createLayoutContext,
  NO_PARENT_DISPLAY,
  isScrollableOverflowValue,
} from '../engine/layoutContext';
import { logger } from '../utils/logger';

/** Minimal shape of the CDP session the builder talks to. */
export interface CdpSession {
  send(method: string, params?: unknown): Promise<any>;
}

/**
 * Extra, pre-collected facts for one node. All of them are browser facts
 * the analyzer already holds (no extra protocol round trips).
 */
export interface BuildOptions {
  /**
   * Cascade-winning authored `display` declaration of the element
   * (PR context hardening — see {@link LayoutContext.declaredDisplay}).
   */
  declaredDisplay?: string;

  /**
   * True when the node's parent context cannot be trusted: the element
   * was placed by a synthetic analysis wrapper page as a top-level
   * element, so its `<body>` parent is an artifact, not the node's real
   * document parent. The parent display is then reported as unknown
   * ('none') so item-dependent rules take the conservative no-decision
   * path instead of flagging against a fabricated parent.
   */
  parentIsSynthetic?: boolean;

  /**
   * True when the node's element TYPE is a synthetic artifact of the
   * analysis wrapper page (see {@link LayoutContext.typeIsSynthetic}): the
   * CSS-file flow fabricates a `<div>` stand-in for bare class/id
   * selectors, so `nodeName` is not a fact from the user's real document.
   * Type-dependent rules (object-fit/object-position) abstain on such
   * nodes instead of treating the fabricated type as proof of
   * replaced-ness.
   */
  syntheticElementType?: boolean;

  /**
   * COMPUTED box-model styles per pseudo-element of the node (see
   * {@link PseudoBoxFacts}). When present, the builder derives each pseudo
   * BOX's own LayoutContext (display from the computed value, defaulting to
   * inline; blockified by float; parent = the origin element) and stores it
   * on the node's context so pseudo declarations can be evaluated against
   * the box they actually generate.
   */
  pseudoBoxFacts?: ReadonlyMap<string, PseudoBoxFacts>;
}

/**
 * Builds one LayoutContext per DOM node and reuses it while nothing
 * changed. Reset between analysis runs so a freshly loaded page (or a
 * recovered session) never reuses stale node state.
 */
export class LayoutContextBuilder {
  /** nodeId → parent nodeId, built once from the DOM tree. */
  private parentMap: Map<number, number> | null = null;

  /** nodeId → LayoutContext (identical node state never rebuilt). */
  private readonly contextCache = new Map<number, LayoutContext>();

  /** nodeId → computed styles (parent styles fetched once per node). */
  private readonly stylesCache = new Map<number, ReadonlyMap<string, string>>();

  /**
   * nodeId → normalized tag name, captured while walking the DOM tree.
   * Zero extra protocol round trips — CDP reports `nodeName` on every
   * DOM tree node. Empty for nodes outside the known tree (detached).
   */
  private readonly nodeNameMap = new Map<number, string>();

  /**
   * nodeId → whether an ancestor is a scroll-snap container. Resolved once
   * per node via a memoized walk up the parent map (styles cached by
   * `stylesCache`); `undefined` means the chain could not be resolved.
   */
  private readonly snapAncestorCache = new Map<number, boolean | undefined>();

  /**
   * nodeId → whether an ancestor is a table box. Resolved once per node via
   * a memoized walk up the parent map (styles cached by `stylesCache`);
   * `undefined` means the chain could not be resolved.
   */
  private readonly tableBoxAncestorCache = new Map<number, boolean | undefined>();

  /** Pre-fetched DOM tree root, avoiding a second `DOM.getDocument` call. */
  private domRoot: unknown = null;

  /**
   * Provide the DOM tree already fetched by the caller. The parent map is
   * built from this tree, so no extra protocol round trip is needed.
   */
  setDomRoot(root: unknown): void {
    this.domRoot = root;
    this.parentMap = null;
  }

  /** Clear every cache. Call once per analysis run (fresh document). */
  reset(): void {
    this.parentMap = null;
    this.domRoot = null;
    this.contextCache.clear();
    this.stylesCache.clear();
    this.nodeNameMap.clear();
    this.snapAncestorCache.clear();
    this.tableBoxAncestorCache.clear();
  }

  /**
   * Build (or reuse) the immutable LayoutContext for a DOM node.
   *
   * `pseudoContent` (PR Level 3) is the cascade-winning declared `content`
   * per pseudo-element, collected by the matched-styles collector from the
   * SAME `CSS.getMatchedStylesForNode` pass the analyzer already performs —
   * the builder stores it in the context without any extra protocol call.
   *
   * `options` carries the remaining pre-collected browser facts and the
   * synthetic-parent hint (see {@link BuildOptions}).
   *
   * Never throws: any CDP failure degrades to safe defaults.
   */
  async build(
    cdp: CdpSession,
    nodeId: number,
    pseudoContent?: ReadonlyMap<string, string>,
    options: BuildOptions = {}
  ): Promise<LayoutContext> {
    const cached = this.contextCache.get(nodeId);
    if (cached) {
      return cached;
    }

    // The parent map and the node-name map are filled by the SAME tree
    // walk. Build it eagerly: the context reads `nodeName` below, and the
    // first node must not see an empty map just because no parent lookup
    // ran before it (the synthetic-parent flow skips parent resolution).
    await this.getParentMap(cdp);

    const computedStyles = await this.fetchComputedStyles(cdp, nodeId);
    const display = computedStyles.get('display') ?? '';
    // Collected in the SAME protocol pass — no extra round trip.
    const position = computedStyles.get('position') ?? '';

    let parentDisplay = NO_PARENT_DISPLAY;
    if (!options.parentIsSynthetic) {
      const parentNodeId = await this.findParentNodeId(cdp, nodeId);
      if (parentNodeId !== null) {
        const parentStyles = await this.fetchComputedStyles(cdp, parentNodeId);
        parentDisplay = parentStyles.get('display') ?? NO_PARENT_DISPLAY;
      }
    }

    const context = createLayoutContext({
      display,
      position,
      parentDisplay,
      nodeName: this.nodeNameMap.get(nodeId) ?? '',
      hasScrollSnapAncestor: await this.resolveSnapAncestor(cdp, nodeId),
      hasTableBoxAncestor: await this.resolveTableBoxAncestor(cdp, nodeId),
      pseudoContent,
      declaredDisplay: options.declaredDisplay,
      parentIsSynthetic: options.parentIsSynthetic,
      typeIsSynthetic: options.syntheticElementType,
      pseudoBoxFacts: options.pseudoBoxFacts,
      computedStyles,
    });
    this.contextCache.set(nodeId, context);
    return context;
  }

  /**
   * Walk the ancestor chain (parent, grandparent, ... to the root) and
   * report whether any ancestor is a scroll-snap container — a scrollable
   * box (overflow hidden/auto/scroll) whose computed `scroll-snap-type`
   * is not 'none'. Results are memoized per node so overlapping chains
   * cost one styles fetch per distinct ancestor at most.
   *
   * Conservative: an unresolved link in the chain (CDP failure) yields
   * `undefined`, which rules must treat as "cannot judge" — never a flag.
   */
  private async resolveSnapAncestor(
    cdp: CdpSession,
    nodeId: number
  ): Promise<boolean | undefined> {
    const cached = this.snapAncestorCache.get(nodeId);
    if (cached !== undefined || this.snapAncestorCache.has(nodeId)) {
      return cached;
    }

    const parentNodeId = await this.findParentNodeId(cdp, nodeId);
    if (parentNodeId === null) {
      this.snapAncestorCache.set(nodeId, false);
      return false;
    }

    const parentStyles = await this.fetchComputedStyles(cdp, parentNodeId);
    if (parentStyles.size === 0) {
      // An unreadable parent ends the chain only when it is the root —
      // nothing above it can be a snap container. An interior unreadable
      // ancestor keeps the chain un-judgeable.
      const grandparentNodeId = await this.findParentNodeId(cdp, parentNodeId);
      if (grandparentNodeId === null) {
        this.snapAncestorCache.set(nodeId, false);
        return false;
      }
      this.snapAncestorCache.set(nodeId, undefined);
      return undefined;
    }

    if (this.isSnapContainer(parentStyles)) {
      this.snapAncestorCache.set(nodeId, true);
      return true;
    }

    const rest = await this.resolveSnapAncestor(cdp, parentNodeId);
    this.snapAncestorCache.set(nodeId, rest);
    return rest;
  }

  /** Whether a computed-style map describes a scroll-snap container. */
  private isSnapContainer(styles: ReadonlyMap<string, string>): boolean {
    if (this.isScrollContainer(styles)) {
      const snapType = styles.get('scroll-snap-type');
      return snapType !== undefined && snapType !== 'none';
    }
    return false;
  }

    /** Computed `display` values that produce a real table box. */
  private static readonly TABLE_BOX_DISPLAYS: ReadonlySet<string> = new Set([
    'table',
    'inline-table',
  ]);

  /**
   * Walk the ancestor chain (parent, grandparent, ... to the root) and
   * report whether any ancestor is a table box (computed `display` table
   * or inline-table). Results are memoized per node so overlapping chains
   * cost one styles fetch per distinct ancestor at most.
   *
   * Conservative: an unresolved link in the chain (CDP failure) yields
   * `undefined`, which rules must treat as "cannot judge" — never a flag.
   */
  private async resolveTableBoxAncestor(
    cdp: CdpSession,
    nodeId: number
  ): Promise<boolean | undefined> {
    const cached = this.tableBoxAncestorCache.get(nodeId);
    if (cached !== undefined || this.tableBoxAncestorCache.has(nodeId)) {
      return cached;
    }

    const parentNodeId = await this.findParentNodeId(cdp, nodeId);
    if (parentNodeId === null) {
      this.tableBoxAncestorCache.set(nodeId, false);
      return false;
    }

    const parentStyles = await this.fetchComputedStyles(cdp, parentNodeId);
    if (parentStyles.size === 0) {
      // An unreadable parent ends the chain only when it is the root —
      // nothing above it can be a table box. An interior unreadable
      // ancestor keeps the chain un-judgeable.
      const grandparentNodeId = await this.findParentNodeId(cdp, parentNodeId);
      if (grandparentNodeId === null) {
        this.tableBoxAncestorCache.set(nodeId, false);
        return false;
      }
      this.tableBoxAncestorCache.set(nodeId, undefined);
      return undefined;
    }

    if (LayoutContextBuilder.TABLE_BOX_DISPLAYS.has(parentStyles.get('display') ?? '')) {
      this.tableBoxAncestorCache.set(nodeId, true);
      return true;
    }

    const rest = await this.resolveTableBoxAncestor(cdp, parentNodeId);
    this.tableBoxAncestorCache.set(nodeId, rest);
    return rest;
  }

  /** Whether a computed-style map describes a scroll container. */
  private isScrollContainer(styles: ReadonlyMap<string, string>): boolean {
    const overflow = styles.get('overflow');
    if (overflow !== undefined) {
      return isScrollableOverflowValue(overflow);
    }
    const overflowX = styles.get('overflow-x');
    const overflowY = styles.get('overflow-y');
    if (overflowX === undefined && overflowY === undefined) {
      return false;
    }
    return (
      (overflowX !== undefined && isScrollableOverflowValue(overflowX)) ||
      (overflowY !== undefined && isScrollableOverflowValue(overflowY))
    );
  }

  /**
   * Fetch (or reuse) the full computed-style map of a node in ONE protocol
   * call. A failed call yields an empty map — never an exception.
   */
  private async fetchComputedStyles(
    cdp: CdpSession,
    nodeId: number
  ): Promise<ReadonlyMap<string, string>> {
    const cached = this.stylesCache.get(nodeId);
    if (cached) {
      return cached;
    }

    let styles = new Map<string, string>();
    try {
      const response = await cdp.send('CSS.getComputedStyleForNode', { nodeId });
      const entries = response?.computedStyle;
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (entry && typeof entry.name === 'string') {
            styles.set(entry.name, entry.value);
          }
        }
      }
    } catch (err) {
      logger.debug(
        `[LayoutContext] Could not fetch computed styles for node ${nodeId}: ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
    }

    this.stylesCache.set(nodeId, styles);
    return styles;
  }

  /**
   * Resolve the parent node of a DOM node. Returns null (no parent) when
   * the node is a root (e.g. `<html>`) or when the parent cannot be
   * determined — never throws.
   */
  private async findParentNodeId(cdp: CdpSession, nodeId: number): Promise<number | null> {
    const parentMap = await this.getParentMap(cdp);
    const fromTree = parentMap.get(nodeId);
    if (fromTree !== undefined) {
      return fromTree;
    }

    // The node is not in the known tree (e.g. a detached node) — ask CDP
    // directly. A null parentId means the node has no parent (document root).
    try {
      const response = await cdp.send('DOM.getParentNode', { nodeId });
      return response?.parentId ?? null;
    } catch (err) {
      logger.debug(
        `[LayoutContext] Could not resolve parent of node ${nodeId}: ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  /** Build the nodeId → parentId map from the DOM tree, once per run. */
  private async getParentMap(cdp: CdpSession): Promise<Map<number, number>> {
    if (this.parentMap) {
      return this.parentMap;
    }

    const map = new Map<number, number>();
    let root: unknown = this.domRoot;

    if (!root) {
      try {
        const response = await cdp.send('DOM.getDocument', { depth: -1 });
        root = response?.root;
      } catch (err) {
        logger.debug(
          `[LayoutContext] Could not fetch DOM tree: ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (root) {
      this.walkDomTree(root, map);
    }
    this.parentMap = map;
    return map;
  }

  /** Depth-first walk building child → parent links and node names. */
  private walkDomTree(node: unknown, map: Map<number, number>): void {
    if (!node || typeof node !== 'object') {
      return;
    }
    const typed = node as { nodeId?: number; nodeName?: string; children?: unknown[] };
    if (typeof typed.nodeId !== 'number') {
      return;
    }
    if (typeof typed.nodeName === 'string' && typed.nodeName.length > 0) {
      this.nodeNameMap.set(typed.nodeId, typed.nodeName);
    }
    for (const child of typed.children ?? []) {
      const childNode = child as { nodeId?: number };
      if (typeof childNode.nodeId === 'number') {
        map.set(childNode.nodeId, typed.nodeId);
      }
      this.walkDomTree(child, map);
    }
  }
}
