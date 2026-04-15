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
  private readonly maxSessions: number;

  constructor(options?: { maxSessions?: number }) {
    this.maxSessions = options?.maxSessions ?? 10_000;
  }

  async acquire(sessionId: string): Promise<() => void> {
    // Refuse new sessions at capacity. Evicting a live chain would break
    // serialization — a subsequent acquire for the evicted session would
    // create a fresh chain that runs concurrently with the previous holder.
    // Live entries self-clean in their release callback, so hitting the cap
    // means there really are that many active sessions.
    if (this.chains.size >= this.maxSessions && !this.chains.has(sessionId)) {
      throw new Error(`SessionMutex at capacity (${this.maxSessions} active sessions)`);
    }

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
