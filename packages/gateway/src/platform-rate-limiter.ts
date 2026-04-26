// ---------------------------------------------------------------------------
// Per-platform rate limiter for gateway outbound messages
// ---------------------------------------------------------------------------

import type { GatewayPlatform } from './index.js';

interface PlatformLimit {
  maxPerMinute: number;
}

const PLATFORM_LIMITS: Record<string, PlatformLimit> = {
  telegram: { maxPerMinute: 20 },
  slack: { maxPerMinute: 50 },
  discord: { maxPerMinute: 30 },
  whatsapp: { maxPerMinute: 40 },
  matrix: { maxPerMinute: 30 },
  sms: { maxPerMinute: 10 },
  email: { maxPerMinute: 15 },
  signal: { maxPerMinute: 20 },
};

const DEFAULT_LIMIT: PlatformLimit = { maxPerMinute: 30 };

export class PlatformRateLimiter {
  private timestamps = new Map<string, number[]>();

  /**
   * Drop expired timestamps from the front of the deque in-place.
   * Timestamps are kept sorted ascending, so we can locate the first
   * non-expired entry with a single linear scan and splice it off.
   * Allocates only the small array returned by `splice` (and only when
   * something actually expired). In steady state this is O(0) work.
   */
  private pruneExpired(arr: number[], cutoff: number): void {
    let i = 0;
    while (i < arr.length && arr[i] <= cutoff) i++;
    if (i > 0) arr.splice(0, i);
  }

  /** Check if a message can be sent on this platform. Returns true if allowed. */
  check(platform: GatewayPlatform | string): boolean {
    const limit = PLATFORM_LIMITS[platform] ?? DEFAULT_LIMIT;
    const now = Date.now();
    const cutoff = now - 60_000;

    let arr = this.timestamps.get(platform);
    if (!arr) {
      arr = [];
      this.timestamps.set(platform, arr);
    }

    this.pruneExpired(arr, cutoff);

    if (arr.length >= limit.maxPerMinute) {
      return false;
    }

    // Timestamps stay sorted ascending because Date.now() is monotonic-enough
    // for our window math. We append, never insert in the middle.
    arr.push(now);
    return true;
  }

  /** Get rate limit info for a platform. */
  getLimit(platform: GatewayPlatform | string): PlatformLimit {
    return PLATFORM_LIMITS[platform] ?? DEFAULT_LIMIT;
  }

  /** Get remaining quota for a platform in the current window. */
  remaining(platform: GatewayPlatform | string): number {
    const limit = PLATFORM_LIMITS[platform] ?? DEFAULT_LIMIT;
    const now = Date.now();
    const cutoff = now - 60_000;
    const arr = this.timestamps.get(platform);
    if (!arr) return limit.maxPerMinute;
    this.pruneExpired(arr, cutoff);
    return Math.max(limit.maxPerMinute - arr.length, 0);
  }
}
