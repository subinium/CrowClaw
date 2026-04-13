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

  /** Check if a message can be sent on this platform. Returns true if allowed. */
  check(platform: GatewayPlatform | string): boolean {
    const limit = PLATFORM_LIMITS[platform] ?? DEFAULT_LIMIT;
    const now = Date.now();
    const windowMs = 60_000;
    const windowStart = now - windowMs;

    const existing = this.timestamps.get(platform) ?? [];
    const recent = existing.filter((t) => t > windowStart);

    if (recent.length >= limit.maxPerMinute) {
      this.timestamps.set(platform, recent);
      return false;
    }

    recent.push(now);
    this.timestamps.set(platform, recent);
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
    const windowStart = now - 60_000;
    const existing = this.timestamps.get(platform) ?? [];
    const recent = existing.filter((t) => t > windowStart);
    return Math.max(limit.maxPerMinute - recent.length, 0);
  }
}
