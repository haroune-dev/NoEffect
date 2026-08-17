/**
 * Phase 3 (first-run & visibility): readiness controller.
 *
 * The single consumer of the Phase 2 readiness model for UI purposes. It
 * subscribes to the readiness source, guards against stale async results
 * (generation counter), coalesces rapid triggers (debounce), and pushes
 * every meaningful change to exactly three places:
 *
 *   - the status bar controller,
 *   - the VS Code context keys (safe false defaults until known),
 *   - the output channel logger (change-only lines).
 *
 * The vscode surface is abstracted behind `ReadinessHost` and
 * `StatusBarController`, so the whole controller is unit-testable.
 */

import { ReadinessState } from '../environment/readiness';
import { Debouncer } from '../services/debounceService';
import { StatusBarController } from './statusBarController';
import { deriveStatus } from './statusModel';
import { CONTEXT_KEYS } from './constants';

/** The readiness source (implemented by the activation layer). */
export interface ReadinessSource {
  /** Evaluate the current environment (cached detection, fast after first). */
  evaluate(): Promise<ReadinessState>;

  /** Force re-evaluation (invalidate cached detection first). */
  refresh(): Promise<ReadinessState>;
}

/** The vscode surface the controller needs. */
export interface ReadinessHost {
  setContext(key: string, value: boolean): Promise<unknown> | void;
  log(level: 'debug' | 'info' | 'warn', line: string): void;
}

const SETUP_REASONS = new Set<ReadinessState['reason']>([
  'browser_not_found',
  'browser_path_invalid',
  'browser_launch_failed',
]);

const WORKSPACE_REASONS = new Set<ReadinessState['reason']>([
  'untrusted_workspace',
  'unsupported_workspace',
]);

function delayNull(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

export class ReadinessController {
  private generation = 0;
  private last: ReadinessState | null = null;
  private known = false;
  private disposed = false;
  private lastContext: Record<string, boolean> = {};
  private readonly debouncer: Debouncer;

  constructor(
    private readonly source: ReadinessSource,
    private readonly host: ReadinessHost,
    private readonly statusBar: StatusBarController,
    private readonly settingsProvider: () => { enabled: boolean },
    private readonly onSnapshot: (state: ReadinessState | null) => void = () => {},
    options: {
      /** Coalescing delay for settings/trust-triggered refreshes. */
      refreshDebounceMs?: number;
      /** Bound for the first-run snapshot wait (0 = unbounded). */
      initialSnapshotTimeoutMs?: number;
    } = {}
  ) {
    this.debouncer = new Debouncer(options.refreshDebounceMs ?? 300);
    this.initialSnapshotTimeoutMs = options.initialSnapshotTimeoutMs ?? 3000;
  }

  private readonly initialSnapshotTimeoutMs: number;

  /**
   * Initialize context keys to safe values and kick off the first
   * environment check without blocking activation.
   */
  start(): void {
    this.setContextIfChanged(CONTEXT_KEYS.enabled, this.settingsProvider().enabled);
    for (const key of [CONTEXT_KEYS.ready, CONTEXT_KEYS.setupNeeded, CONTEXT_KEYS.workspaceBlocked]) {
      this.setContextIfChanged(key, false);
    }
    this.host.log('debug', '[Readiness] context keys initialized to safe defaults');
    queueMicrotask(() => {
      void this.refreshNow({ timeoutMs: this.initialSnapshotTimeoutMs });
    });
  }

  /** The last known readiness state (null = no snapshot yet). */
  getLast(): ReadinessState | null {
    return this.last;
  }

  /** Whether at least one readiness evaluation has settled. */
  isKnown(): boolean {
    return this.known;
  }

  /**
   * Evaluate now. A bounded `timeoutMs` races the snapshot (used for the
   * first-run decision so a slow environment never blocks it); the eventual
   * result still applies afterwards, so the UI cannot stay stuck.
   * Stale results (a newer refresh started meanwhile) never apply.
   */
  refreshNow(options: { timeoutMs?: number } = {}): Promise<ReadinessState | null> {
    return this.runWith(this.source.evaluate(), options.timeoutMs);
  }

  /**
   * Coalesce rapid triggers (settings changes, workspace trust changes)
   * into a single refresh.
   */
  scheduleRefresh(): void {
    this.debouncer.debounce(() => {
      void this.refreshNow();
    });
  }

  /**
   * Manual refresh for Diagnose Setup: invalidates cached detection so the
   * next evaluation genuinely re-checks the environment.
   */
  async forceRefresh(): Promise<ReadinessState | null> {
    this.debouncer.cancel();
    return this.runWith(this.source.refresh());
  }

  dispose(): void {
    this.disposed = true;
    this.debouncer.dispose();
    this.statusBar.dispose();
  }

  // ── internals ───────────────────────────────────────────────────────────

  private runWith(promise: Promise<ReadinessState>, timeoutMs?: number): Promise<ReadinessState | null> {
    const gen = ++this.generation;

    // The eventual outcome always applies (when still current), even if a
    // bounded wait already returned early.
    promise.then(
      (state) => {
        if (this.isCurrent(gen)) {
          this.apply(state);
        }
      },
      () => {
        if (this.isCurrent(gen)) {
          this.apply(null);
        }
      }
    );

    const snapshot: Promise<ReadinessState | null> =
      timeoutMs !== undefined && timeoutMs > 0
        ? Promise.race([
            promise.then((s) => s as ReadinessState | null, () => null),
            delayNull(timeoutMs),
          ])
        : promise.then((s) => s as ReadinessState | null, () => null);

    // The returned chain only resolves the value — `onSnapshot` fires
    // EXACTLY once, inside `apply` (single-delivery contract, P2-BUG-10).
    // With a bounded timeout the promise may resolve early (null) while the
    // eventual result still applies via `apply` afterwards.
    return snapshot.then((state) => state);
  }

  private apply(state: ReadinessState | null): void {
    const previousReason = this.last?.reason ?? null;
    this.last = state;
    this.known = true;

    const enabled = this.settingsProvider().enabled;
    this.statusBar.update(deriveStatus(enabled, state));

    const ready = state !== null && state.ready && state.reason === 'ready';
    this.setContextIfChanged(CONTEXT_KEYS.ready, ready);
    this.setContextIfChanged(CONTEXT_KEYS.enabled, enabled);
    this.setContextIfChanged(
      CONTEXT_KEYS.setupNeeded,
      state !== null && SETUP_REASONS.has(state.reason)
    );
    this.setContextIfChanged(
      CONTEXT_KEYS.workspaceBlocked,
      state !== null && WORKSPACE_REASONS.has(state.reason)
    );

    if (state !== null && state.reason !== previousReason) {
      const detail = state.message ? ` — ${state.message}` : '';
      this.host.log('info', `[Readiness] ${state.reason}${detail}`);
    }

    this.onSnapshot(state);
  }

  private isCurrent(gen: number): boolean {
    return gen === this.generation && !this.disposed;
  }

  private setContextIfChanged(key: string, value: boolean): void {
    if (this.lastContext[key] === value) {
      return;
    }
    this.lastContext[key] = value;
    this.host.log('debug', `[Readiness] context ${key} = ${value}`);
    const result = this.host.setContext(key, value);
    if (result instanceof Promise) {
      result.catch(() => {
        // setContext failure must never crash or spam - the status bar and
        // commands still carry the state.
      });
    }
  }
}
