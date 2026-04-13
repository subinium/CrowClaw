// ---------------------------------------------------------------------------
// Per-session mutex — serializes concurrent requests to the same session
// ---------------------------------------------------------------------------

/**
 * Promise-chain mutex keyed by session ID.
 *
 * Each call to `acquire(sessionId)` chains behind the previous holder for
 * that session. Because JS is single-threaded for synchronous operations,
 * the get→set on the internal Map is atomic — no external lock needed.
 *
 * Usage:
 *   const release = await mutex.acquire(sessionId);
 *   try { ... } finally { release(); }
 */
export class SessionMutex {
  private chains = new Map<string, Promise<void>>();

  async acquire(sessionId: string): Promise<() => void> {
    const existing = this.chains.get(sessionId) ?? Promise.resolve();

    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Register this lock in the chain *before* awaiting the previous one.
    // This ensures any subsequent caller sees our promise, not the old one.
    this.chains.set(sessionId, next);

    // Wait for the previous holder to finish
    await existing;

    return () => {
      // Only clean up the map entry if we are still the tail of the chain.
      // If another acquire() already chained after us, leave their promise.
      if (this.chains.get(sessionId) === next) {
        this.chains.delete(sessionId);
      }
      release();
    };
  }

  /** Number of sessions currently locked (useful for shutdown drain). */
  get activeCount(): number {
    return this.chains.size;
  }
}
