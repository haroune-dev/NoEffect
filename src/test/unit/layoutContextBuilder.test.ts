import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LayoutContextBuilder } from '../../browser/layoutContextBuilder';
import { NO_PARENT_DISPLAY } from '../../engine/layoutContext';

/**
 * PR6 Phase 1 — unit tests for the LayoutContextBuilder against a mock CDP
 * session: single-pass style collection, parent detection, caching, reuse
 * and graceful degradation.
 */

interface MockStyleEntry {
  name: string;
  value: string;
}

/** A scriptable CDP double that counts protocol calls per method. */
function mockCdp(
  opts: {
    styles?: (nodeId: number) => MockStyleEntry[];
    tree?: { nodeId: number; children: unknown[] } | null;
    parentOf?: (nodeId: number) => number | null;
    failComputed?: boolean;
  } = {}
): {
  cdp: { send(method: string, params: any): Promise<any> };
  calls: Map<string, number>;
  stylesCalls: number[];
} {
  const calls = new Map<string, number>();
  const stylesCalls: number[] = [];
  const bump = (method: string) => calls.set(method, (calls.get(method) ?? 0) + 1);

  return {
    cdp: {
      async send(method: string, params: any) {
        bump(method);
        if (method === 'CSS.getComputedStyleForNode') {
          stylesCalls.push(params.nodeId);
          if (opts.failComputed) {
            throw new Error('computed styles unavailable');
          }
          return { computedStyle: opts.styles?.(params.nodeId) ?? [] };
        }
        if (method === 'DOM.getDocument') {
          return { root: opts.tree ?? null };
        }
        if (method === 'DOM.getParentNode') {
          const parentId = opts.parentOf?.(params.nodeId) ?? null;
          return parentId === null ? {} : { parentId };
        }
        throw new Error(`unexpected CDP call: ${method}`);
      },
    },
    calls,
    stylesCalls,
  };
}

function style(display: string): MockStyleEntry[] {
  return [
    { name: 'display', value: display },
    { name: 'position', value: 'static' },
    { name: 'overflow', value: 'visible' },
    { name: 'scroll-snap-type', value: 'none' },
  ];
}

function withSnapAncestor(): MockStyleEntry[] {
  return [
    { name: 'display', value: 'block' },
    { name: 'position', value: 'static' },
    { name: 'overflow', value: 'auto' },
    { name: 'scroll-snap-type', value: 'x mandatory' },
  ];
}

function withParent(childNodeId: number, parentNodeId: number) {
  return {
    nodeId: 1,
    children: [
      { nodeId: parentNodeId, children: [{ nodeId: childNodeId, children: [] }] },
    ],
  };
}

test('block container: display block, block parent', async () => {
  const builder = new LayoutContextBuilder();
  const { cdp } = mockCdp({ styles: () => style('block') });

  const context = await builder.build(cdp, 10);

  assert.equal(context.display, 'block');
  assert.equal(context.isFlexContainer, false);
  assert.equal(context.isGridContainer, false);
  assert.equal(context.parentDisplay, NO_PARENT_DISPLAY, 'no parent known — safe default');
  assert.equal(context.isFlexItem, false);
  assert.equal(context.isGridItem, false);
});

test('pseudo content facts flow through to the context', async () => {
  const builder = new LayoutContextBuilder();
  const { cdp } = mockCdp({ styles: () => style('block') });

  const pseudoContent = new Map([
    ['before', '"hi"'],
    ['after', 'none'],
  ]);
  const context = await builder.build(cdp, 10, pseudoContent);

  assert.equal(context.pseudoContent?.get('before'), '"hi"');
  assert.equal(context.pseudoContent?.get('after'), 'none');
  assert.equal(context.pseudoContent?.has('first-letter'), false);
});

test('pseudo content is undefined when not supplied', async () => {
  const builder = new LayoutContextBuilder();
  const { cdp } = mockCdp({ styles: () => style('block') });

  const context = await builder.build(cdp, 10);
  assert.equal(context.pseudoContent, undefined);
});

test('flex container via the DOM tree (display flex)', async () => {
  const builder = new LayoutContextBuilder();
  const tree = { nodeId: 1, children: [{ nodeId: 20, children: [] }] };
  const { cdp } = mockCdp({
    styles: (nodeId) => (nodeId === 20 ? style('flex') : style('block')),
    tree,
  });
  builder.setDomRoot(tree);

  const context = await builder.build(cdp, 20);

  assert.equal(context.display, 'flex');
  assert.equal(context.isFlexContainer, true);
  assert.equal(context.isGridContainer, false);
  assert.equal(context.parentDisplay, 'block');
  assert.equal(context.isFlexItem, false);
});

test('inline-flex is recognized as a flex container', async () => {
  const builder = new LayoutContextBuilder();
  const { cdp } = mockCdp({ styles: () => style('inline-flex') });

  const context = await builder.build(cdp, 10);
  assert.equal(context.isFlexContainer, true);
});

test('grid container via inline-grid', async () => {
  const builder = new LayoutContextBuilder();
  const { cdp } = mockCdp({ styles: () => style('inline-grid') });

  const context = await builder.build(cdp, 10);
  assert.equal(context.isGridContainer, true);
  assert.equal(context.isFlexContainer, false);
});

test('flex item: parent computed display flex', async () => {
  const builder = new LayoutContextBuilder();
  const tree = { nodeId: 1, children: [{ nodeId: 20, children: [{ nodeId: 21, children: [] }] }] };
  const { cdp } = mockCdp({
    styles: (nodeId) => (nodeId === 20 ? style('flex') : style('block')),
    tree,
  });
  builder.setDomRoot(tree);

  const context = await builder.build(cdp, 21);

  assert.equal(context.isFlexItem, true);
  assert.equal(context.parentDisplay, 'flex');
  assert.equal(context.isGridItem, false);
});

test('grid item: parent computed display grid', async () => {
  const builder = new LayoutContextBuilder();
  const tree = { nodeId: 1, children: [{ nodeId: 20, children: [{ nodeId: 21, children: [] }] }] };
  const { cdp } = mockCdp({
    styles: (nodeId) => (nodeId === 20 ? style('grid') : style('block')),
    tree,
  });
  builder.setDomRoot(tree);

  const context = await builder.build(cdp, 21);
  assert.equal(context.isGridItem, true);
  assert.equal(context.isFlexItem, false);
});

test('missing parent (root element): safe defaults, never throws', async () => {
  const builder = new LayoutContextBuilder();
  // No tree at all and DOM.getParentNode returns no parent.
  const { cdp } = mockCdp({
    styles: () => style('block'),
    tree: null,
    parentOf: () => null,
  });

  const context = await builder.build(cdp, 10);

  assert.equal(context.parentDisplay, NO_PARENT_DISPLAY);
  assert.equal(context.isFlexItem, false);
  assert.equal(context.isGridItem, false);
  assert.equal(context.display, 'block');
});

test('missing parent when CDP fails: safe defaults instead of a crash', async () => {
  const builder = new LayoutContextBuilder();
  const { cdp } = mockCdp({
    styles: () => style('block'),
    tree: null,
    parentOf: () => null,
    failComputed: false,
  });
  // Force the parent lookup to blow up as well.
  const failingCdp = {
    send: async (method: string, params: any) => {
      if (method === 'DOM.getDocument' || method === 'DOM.getParentNode') {
        throw new Error('CDP went away');
      }
      return cdp.send(method, params);
    },
  };

  const context = await builder.build(failingCdp, 10);
  assert.equal(context.parentDisplay, NO_PARENT_DISPLAY);
  assert.equal(context.isFlexItem, false);
  assert.equal(context.isGridItem, false);
});

test('missing computed styles: empty map and safe flags', async () => {
  const builder = new LayoutContextBuilder();
  const { cdp } = mockCdp({ styles: () => [] });

  const context = await builder.build(cdp, 10);

  assert.equal(context.display, '');
  assert.equal(context.getComputedStyle('display'), undefined);
  assert.equal(context.isFlexContainer, false);
  assert.equal(context.isGridContainer, false);
});

test('computed-style failure degrades to an empty map', async () => {
  const builder = new LayoutContextBuilder();
  const { cdp } = mockCdp({ failComputed: true });

  const context = await builder.build(cdp, 10);
  assert.equal(context.display, '');
  assert.equal(context.isFlexContainer, false);
});

test('malformed display values are normalized before use', async () => {
  const builder = new LayoutContextBuilder();
  const { cdp } = mockCdp({ styles: () => style(' FLEX ') });

  const context = await builder.build(cdp, 10);
  assert.equal(context.display, 'flex');
  assert.equal(context.isFlexContainer, true);
});

test('position: extracted from the same style pass and normalized', async () => {
  const builder = new LayoutContextBuilder();
  const { cdp, calls } = mockCdp({
    styles: () => [
      { name: 'display', value: 'block' },
      { name: 'position', value: 'Absolute' },
    ],
  });

  const context = await builder.build(cdp, 10);
  assert.equal(context.position, 'absolute');
  assert.equal(context.isPositioned, true);
  assert.equal(
    calls.get('CSS.getComputedStyleForNode'),
    1,
    'position must come from the existing single pass — no extra round trip'
  );
});

test('position: missing computed data degrades to empty', async () => {
  const builder = new LayoutContextBuilder();
  const { cdp } = mockCdp({ styles: () => [{ name: 'display', value: 'block' }] });

  const context = await builder.build(cdp, 10);
  assert.equal(context.position, '');
  assert.equal(context.isPositioned, false);
});

test('cache: same node yields the identical context instance', async () => {
  const builder = new LayoutContextBuilder();
  const { cdp } = mockCdp({ styles: () => style('flex') });

  const first = await builder.build(cdp, 10);
  const second = await builder.build(cdp, 10);

  assert.equal(second, first, 'an already-built context must be reused, not rebuilt');
});

test('single pass: one computed-style call per distinct node', async () => {
  const builder = new LayoutContextBuilder();
  const tree = {
    nodeId: 1,
    children: [
      { nodeId: 20, children: [{ nodeId: 21, children: [] }, { nodeId: 22, children: [] }] },
    ],
  };
  const { cdp, calls, stylesCalls } = mockCdp({
    styles: (nodeId) => (nodeId === 20 ? style('flex') : style('block')),
    tree,
  });
  builder.setDomRoot(tree);

  await builder.build(cdp, 21);
  await builder.build(cdp, 22);

  // Element styles: 2 nodes. Parent (20) styles: fetched once, shared.
  // The scroll-snap ancestor walk also fetches the chain root (1) once —
  // every fetch is still cached per distinct node.
  assert.equal(calls.get('CSS.getComputedStyleForNode'), 4);
  assert.equal(calls.get('DOM.getDocument') ?? 0, 0, 'the provided DOM tree must be reused');
  assert.deepEqual(stylesCalls.sort(), [1, 20, 21, 22], 'each distinct node is fetched exactly once');
});

test('nodeName: captured from the DOM tree without extra round trips', async () => {
  const builder = new LayoutContextBuilder();
  const tree = { nodeId: 1, nodeName: 'BODY', children: [{ nodeId: 20, nodeName: 'SPAN', children: [] }] };
  const { cdp, calls } = mockCdp({ styles: (nodeId) => (nodeId === 20 ? style('inline') : style('block')), tree });
  builder.setDomRoot(tree);

  const context = await builder.build(cdp, 20);

  assert.equal(context.nodeName, 'span', 'the tag name is normalized to lowercase');
  assert.equal(
    calls.get('DOM.getDocument') ?? 0,
    0,
    'the node name comes from the already-fetched DOM tree — no extra protocol call'
  );
});

test('nodeName: empty when the node is outside the known tree', async () => {
  const builder = new LayoutContextBuilder();
  const { cdp } = mockCdp({ styles: () => style('inline'), tree: null, parentOf: () => null });

  const context = await builder.build(cdp, 10);
  assert.equal(context.nodeName, '');
});

test('nodeName: cleared by reset along with every other cache', async () => {
  const builder = new LayoutContextBuilder();
  const tree = { nodeId: 1, nodeName: 'BODY', children: [{ nodeId: 20, nodeName: 'SPAN', children: [] }] };
  const { cdp } = mockCdp({ styles: (nodeId) => (nodeId === 20 ? style('inline') : style('block')), tree });
  builder.setDomRoot(tree);

  const before = await builder.build(cdp, 20);
  assert.equal(before.nodeName, 'span');

  builder.reset();
  const after = await builder.build(cdp, 20);
  assert.equal(after.nodeName, 'span', 'a rebuilt context re-captures the node name');
});

test('hasScrollSnapAncestor: false when no ancestor is a scroll-snap container', async () => {
  const builder = new LayoutContextBuilder();
  const tree = {
    nodeId: 1,
    children: [
      { nodeId: 20, children: [{ nodeId: 21, children: [] }] },
    ],
  };
  // Every ancestor has overflow: visible and scroll-snap-type: none.
  const { cdp } = mockCdp({ styles: (nodeId) => style('block'), tree });
  builder.setDomRoot(tree);

  const context = await builder.build(cdp, 21);
  assert.equal(context.hasScrollSnapAncestor, false);
});

test('hasScrollSnapAncestor: true when a parent is a scroll-snap container', async () => {
  const builder = new LayoutContextBuilder();
  const tree = {
    nodeId: 1,
    children: [
      { nodeId: 20, children: [{ nodeId: 21, children: [] }] },
    ],
  };
  const { cdp } = mockCdp({
    styles: (nodeId) => (nodeId === 20 ? withSnapAncestor() : style('block')),
    tree,
  });
  builder.setDomRoot(tree);

  const context = await builder.build(cdp, 21);
  assert.equal(context.hasScrollSnapAncestor, true);
});

test('hasScrollSnapAncestor: true when a grandparent is a scroll-snap container', async () => {
  const builder = new LayoutContextBuilder();
  const tree = {
    nodeId: 1,
    children: [
      { nodeId: 20, children: [{ nodeId: 30, children: [{ nodeId: 31, children: [] }] }] },
    ],
  };
  const { cdp } = mockCdp({
    styles: (nodeId) => (nodeId === 20 ? withSnapAncestor() : style('block')),
    tree,
  });
  builder.setDomRoot(tree);

  const context = await builder.build(cdp, 31);
  assert.equal(context.hasScrollSnapAncestor, true);
});

test('hasScrollSnapAncestor: a scrollable ancestor without snap-type is not a snap container', async () => {
  const builder = new LayoutContextBuilder();
  const tree = { nodeId: 1, children: [{ nodeId: 20, children: [{ nodeId: 21, children: [] }] }] };
  const scrollableNoSnap: MockStyleEntry[] = [
    { name: 'display', value: 'block' },
    { name: 'overflow', value: 'auto' },
    { name: 'scroll-snap-type', value: 'none' },
  ];
  const { cdp } = mockCdp({
    styles: (nodeId) => (nodeId === 20 ? scrollableNoSnap : style('block')),
    tree,
  });
  builder.setDomRoot(tree);

  const context = await builder.build(cdp, 21);
  assert.equal(context.hasScrollSnapAncestor, false);
});

test('hasScrollSnapAncestor: false when only the chain root has unknown styles', async () => {
  const builder = new LayoutContextBuilder();
  const tree = { nodeId: 1, children: [{ nodeId: 20, children: [{ nodeId: 21, children: [] }] }] };
  // The root (1) is unreadable but is a dead-end — the chain resolves to
  // false, not undefined (nothing above the root can be a snap container).
  const { cdp } = mockCdp({
    styles: (nodeId) => (nodeId === 1 ? [] : style('block')),
    tree,
  });
  builder.setDomRoot(tree);

  const context = await builder.build(cdp, 21);
  assert.equal(context.hasScrollSnapAncestor, false);
});

test('hasScrollSnapAncestor: undefined (no decision) when ancestor styles are unknown', async () => {
  const builder = new LayoutContextBuilder();
  const tree = { nodeId: 1, children: [{ nodeId: 20, children: [{ nodeId: 21, children: [] }] }] };
  // The parent (20) returns no styles — the chain cannot be judged.
  const { cdp } = mockCdp({
    styles: (nodeId) => (nodeId === 20 ? [] : style('block')),
    tree,
  });
  builder.setDomRoot(tree);

  const context = await builder.build(cdp, 21);
  assert.equal(context.hasScrollSnapAncestor, undefined);
});

test('hasScrollSnapAncestor: false for a parentless node', async () => {
  const builder = new LayoutContextBuilder();
  const { cdp } = mockCdp({ styles: () => style('block'), tree: null, parentOf: () => null });

  const context = await builder.build(cdp, 10);
  assert.equal(context.hasScrollSnapAncestor, false, 'a parentless node provably has no snap ancestor');
});

test('hasScrollSnapAncestor: cleared by reset', async () => {
  const builder = new LayoutContextBuilder();
  const tree = { nodeId: 1, children: [{ nodeId: 20, children: [{ nodeId: 21, children: [] }] }] };
  const { cdp } = mockCdp({
    styles: (nodeId) => (nodeId === 20 ? withSnapAncestor() : style('block')),
    tree,
  });
  builder.setDomRoot(tree);

  const before = await builder.build(cdp, 21);
  assert.equal(before.hasScrollSnapAncestor, true);

  builder.reset();
  const after = await builder.build(cdp, 21);
  assert.equal(after.hasScrollSnapAncestor, true, 'a rebuilt builder re-resolves the ancestor chain');
});

test('reset: drops the context, styles and parent caches', async () => {
  const builder = new LayoutContextBuilder();
  const tree = { nodeId: 1, children: [{ nodeId: 20, children: [] }] };
  const { cdp } = mockCdp({ styles: (nodeId) => (nodeId === 20 ? style('flex') : style('block')), tree });
  builder.setDomRoot(tree);

  const before = await builder.build(cdp, 20);
  builder.reset();

  const after = await builder.build(cdp, 20);
  assert.notEqual(after, before, 'a reset builder must rebuild contexts');
  assert.equal(after.display, 'flex');
});

// ── table-box ancestor walk (PR context hardening) ──────────────────────

function withTableBox(): MockStyleEntry[] {
  return [
    { name: 'display', value: 'table' },
    { name: 'position', value: 'static' },
    { name: 'overflow', value: 'visible' },
    { name: 'scroll-snap-type', value: 'none' },
  ];
}

test('hasTableBoxAncestor: false when no ancestor is a table box', async () => {
  const builder = new LayoutContextBuilder();
  const tree = { nodeId: 1, children: [{ nodeId: 20, children: [{ nodeId: 21, children: [] }] }] };
  const { cdp } = mockCdp({ styles: () => style('block'), tree });
  builder.setDomRoot(tree);

  const context = await builder.build(cdp, 21);
  assert.equal(context.hasTableBoxAncestor, false);
});

test('hasTableBoxAncestor: true when the parent is a table box', async () => {
  const builder = new LayoutContextBuilder();
  const tree = { nodeId: 1, children: [{ nodeId: 20, children: [{ nodeId: 21, children: [] }] }] };
  const { cdp } = mockCdp({
    styles: (nodeId) => (nodeId === 20 ? withTableBox() : style('block')),
    tree,
  });
  builder.setDomRoot(tree);

  const context = await builder.build(cdp, 21);
  assert.equal(context.hasTableBoxAncestor, true);
});

test('hasTableBoxAncestor: true when a grandparent is a table box', async () => {
  const builder = new LayoutContextBuilder();
  const tree = {
    nodeId: 1,
    children: [
      { nodeId: 20, children: [{ nodeId: 30, children: [{ nodeId: 31, children: [] }] }] },
    ],
  };
  const { cdp } = mockCdp({
    styles: (nodeId) => (nodeId === 20 ? withTableBox() : style('block')),
    tree,
  });
  builder.setDomRoot(tree);

  const context = await builder.build(cdp, 31);
  assert.equal(context.hasTableBoxAncestor, true);
});

test('hasTableBoxAncestor: false for a parentless node', async () => {
  const builder = new LayoutContextBuilder();
  const { cdp } = mockCdp({ styles: () => style('block'), tree: null, parentOf: () => null });

  const context = await builder.build(cdp, 10);
  assert.equal(context.hasTableBoxAncestor, false);
});

test('hasTableBoxAncestor: undefined (no decision) when ancestor styles are unknown', async () => {
  const builder = new LayoutContextBuilder();
  const tree = { nodeId: 1, children: [{ nodeId: 20, children: [{ nodeId: 21, children: [] }] }] };
  // The parent (20) returns no styles — the chain cannot be judged.
  const { cdp } = mockCdp({
    styles: (nodeId) => (nodeId === 20 ? [] : style('block')),
    tree,
  });
  builder.setDomRoot(tree);

  const context = await builder.build(cdp, 21);
  assert.equal(context.hasTableBoxAncestor, undefined);
});

test('hasTableBoxAncestor: false when only the chain root has unknown styles', async () => {
  const builder = new LayoutContextBuilder();
  const tree = { nodeId: 1, children: [{ nodeId: 20, children: [{ nodeId: 21, children: [] }] }] };
  // The root (1) is unreadable but is a dead-end — the chain resolves to
  // false, not undefined (nothing above the root can be a table box).
  const { cdp } = mockCdp({
    styles: (nodeId) => (nodeId === 1 ? [] : style('block')),
    tree,
  });
  builder.setDomRoot(tree);

  const context = await builder.build(cdp, 21);
  assert.equal(context.hasTableBoxAncestor, false);
});

test('hasTableBoxAncestor: cleared by reset', async () => {
  const builder = new LayoutContextBuilder();
  const tree = { nodeId: 1, children: [{ nodeId: 20, children: [{ nodeId: 21, children: [] }] }] };
  const { cdp } = mockCdp({
    styles: (nodeId) => (nodeId === 20 ? withTableBox() : style('block')),
    tree,
  });
  builder.setDomRoot(tree);

  const before = await builder.build(cdp, 21);
  assert.equal(before.hasTableBoxAncestor, true);

  builder.reset();
  const after = await builder.build(cdp, 21);
  assert.equal(after.hasTableBoxAncestor, true);
});

// ── synthetic parent + declared display passthrough ───────────────────

test('synthetic parent: parent display reported as unknown', async () => {
  const builder = new LayoutContextBuilder();
  const tree = { nodeId: 1, children: [{ nodeId: 20, children: [] }] };
  const { cdp } = mockCdp({ styles: () => style('flex'), tree });
  builder.setDomRoot(tree);

  const context = await builder.build(cdp, 20, undefined, { parentIsSynthetic: true });

  assert.equal(context.parentDisplay, NO_PARENT_DISPLAY);
  assert.equal(context.isFlexItem, false, 'a fabricated parent must not produce an item flag');
  assert.equal(context.isGridItem, false);
});

test('declared display: flows from build options into the context', async () => {
  const builder = new LayoutContextBuilder();
  const { cdp } = mockCdp({ styles: () => style('block') });

  const context = await builder.build(cdp, 10, undefined, { declaredDisplay: 'block' });

  assert.equal(context.declaredDisplay, 'block');
});

test('declared display: undefined when not supplied', async () => {
  const builder = new LayoutContextBuilder();
  const { cdp } = mockCdp({ styles: () => style('block') });

  const context = await builder.build(cdp, 10);
  assert.equal(context.declaredDisplay, undefined);
});

test('parentIsSynthetic: flows from build options and defaults to false', async () => {
  const builder = new LayoutContextBuilder();
  const { cdp } = mockCdp({ styles: () => style('block') });

  const synthetic = await builder.build(cdp, 10, undefined, { parentIsSynthetic: true });
  assert.equal(synthetic.parentIsSynthetic, true, 'synthetic-parent hint is surfaced');

  const real = await builder.build(cdp, 11);
  assert.equal(real.parentIsSynthetic, false, 'defaults to a real parent');
});
