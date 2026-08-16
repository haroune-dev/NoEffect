/**
 * Bounded session event log (Phase 5).
 *
 * A fixed-capacity ring buffer of `SessionEvent`s (timestamped, reason-
 * coded, redacted detail). Diagnose Setup and Show Status consume a
 * snapshot; the buffer never grows unbounded.
 */

export interface SessionEvent {
  ts: number;
  /** Stable reason code (e.g. `browser.exit.unexpected`, `cdp.reattached`). */
  code: string;
  /** Redacted, short description. */
  detail: string;
}

export class EventLog {
  private readonly buffer: SessionEvent[] = [];
  private readonly capacity: number;

  constructor(capacity: number = 50) {
    this.capacity = capacity;
  }

  push(event: SessionEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
  }

  /** Snapshot of all retained events, oldest first. */
  snapshot(): readonly SessionEvent[] {
    return this.buffer.slice();
  }

  get size(): number {
    return this.buffer.length;
  }

  clear(): void {
    this.buffer.length = 0;
  }
}