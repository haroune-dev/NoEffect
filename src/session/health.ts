/**
 * Session health model (Phase 5).
 *
 * Pure, UI-free state machine for a browser analysis session. It tracks the
 * session's state, crash/recovery/restart counters and the transition reason
 * codes. UI surfaces (status bar, Show Status, Diagnose Setup) subscribe to
 * transitions and snapshot the state; the lifecycle module drives the
 * machine and owns the actual browser/CDP/dev-server resources.
 *
 * States:
 *   none          – no session has been created yet,
 *   starting      – a cold start / restart is in progress,
 *   ready         – browser + CDP + dev server + page all healthy,
 *   degraded      – something observable is lost but the session lingers,
 *   recovering    – a reattach / relaunch recovery is in flight,
 *   dead          – the session is gone (crash); the next request lazily
 *                   re-initializes,
 *   disposing     – a deliberate dispose / restart / deactivation is running.
 *
 * Transitions only follow the allowed arcs; a stray transition is ignored
 * and reported as a guarded `state.guard` event, so out-of-order async
 * events can never corrupt the machine.
 */

export interface SessionCounters {
  crashes: number;
  recoveries: number;
  restarts: number;
  reconnects: number;
}

export type SessionState =
  | 'none'
  | 'starting'
  | 'ready'
  | 'recovering'
  | 'degraded'
  | 'dead'
  | 'disposing';

export interface SessionHealthSnapshot {
  state: SessionState;
  epoch: number;
  counters: SessionCounters;
  lastChangeTs: number;
  /** Reason code of the most recent transition (e.g. `crash.browser_exit`). */
  lastReasonCode: string;
}

export interface StateChange {
  from: SessionState;
  to: SessionState;
  reasonCode: string;
}

type Listener = (change: StateChange) => void;

/** Allowed transitions per source state (deterministic arc table). */
const ALLOWED_FROM: Record<SessionState, ReadonlySet<SessionState>> = {
  none: new Set(['starting', 'disposing']),
  starting: new Set(['ready', 'recovering', 'degraded', 'dead', 'disposing']),
  ready: new Set(['recovering', 'degraded', 'dead', 'disposing', 'starting']),
  recovering: new Set(['ready', 'degraded', 'dead', 'disposing', 'starting']),
  degraded: new Set(['ready', 'recovering', 'dead', 'disposing']),
  dead: new Set(['starting', 'disposing', 'none']),
  disposing: new Set(['none', 'dead']),
};

export class SessionHealth {
  private current: SessionState = 'none';
  private currentEpoch = 0;
  private changeTs = 0;
  private reason = 'none.constructed';
  private readonly countersValue: SessionCounters = {
    crashes: 0,
    recoveries: 0,
    restarts: 0,
    reconnects: 0,
  };
  private readonly listeners: Listener[] = [];

  get state(): SessionState {
    return this.current;
  }

  get epoch(): number {
    return this.currentEpoch;
  }

  get counters(): SessionCounters {
    return { ...this.countersValue };
  }

  get lastChangeTimestamp(): number {
    return this.changeTs;
  }

  get lastReasonCode(): string {
    return this.reason;
  }

  snapshot(): SessionHealthSnapshot {
    return {
      state: this.current,
      epoch: this.currentEpoch,
      counters: this.counters,
      lastChangeTs: this.changeTs,
      lastReasonCode: this.reason,
    };
  }

  /**
   * Request a transition. When the arc is allowed the state changes,
   * counters/reason update, and listeners fire; otherwise the machine stays
   * put and emits a `StateChange` with `reasonCode = 'state.guard'`.
   */
  markTransition(to: SessionState, reasonCode: string, now: number = Date.now()): void {
    const from = this.current;
    if (!ALLOWED_FROM[from]?.has(to)) {
      this.notify({ from, to: from, reasonCode: 'state.guard' });
      return;
    }
    this.current = to;
    this.reason = reasonCode;
    this.changeTs = now;
    if (to === 'dead') this.countersValue.crashes++;
    if (to === 'recovering') this.countersValue.recoveries++;
    if (to === 'starting' && from !== 'none') this.countersValue.restarts++;
    if (to === 'recovering') this.countersValue.reconnects++;
    this.notify({ from, to, reasonCode });
  }

  /** Bump the epoch (a new physical session identity took over). */
  bumpEpoch(): number {
    this.currentEpoch += 1;
    return this.currentEpoch;
  }

  onTransition(listener: Listener): { dispose(): void } {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(listener);
        if (index >= 0) this.listeners.splice(index, 1);
      },
    };
  }

  private notify(change: StateChange): void {
    for (const listener of this.listeners.slice()) {
      try {
        listener(change);
      } catch {
        // A listener failing must never break the machine.
      }
    }
  }
}