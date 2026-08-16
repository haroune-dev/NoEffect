/**
 * A generic debounce utility.
 *
 * Returns a debounced version of the provided function that delays
 * invocation until after `delayMs` milliseconds have elapsed since
 * the last call. If called again before the delay expires, the
 * previous pending invocation is cancelled.
 */
export class Debouncer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private delayMs: number) {}

  /**
   * Schedule `fn` to run after the debounce delay.
   * Cancels any previously scheduled invocation.
   */
  debounce(fn: () => void): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, this.delayMs);
  }

  /**
   * Cancel any pending debounced invocation.
   */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Update the debounce delay.
   * Does not affect any currently pending invocation.
   */
  setDelay(delayMs: number): void {
    this.delayMs = delayMs;
  }

  /**
   * Dispose of the debouncer, cancelling any pending invocation.
   */
  dispose(): void {
    this.cancel();
  }
}
