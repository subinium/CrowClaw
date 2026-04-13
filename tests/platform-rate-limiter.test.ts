import { describe, expect, it } from 'vitest';
import { PlatformRateLimiter } from '@crowclaw/gateway/platform-rate-limiter';

describe('PlatformRateLimiter', () => {
  it('allows requests under the limit', () => {
    const limiter = new PlatformRateLimiter();
    // SMS has the lowest limit: 10/min
    for (let i = 0; i < 10; i++) {
      expect(limiter.check('sms')).toBe(true);
    }
  });

  it('blocks requests over the limit', () => {
    const limiter = new PlatformRateLimiter();
    // SMS: 10/min
    for (let i = 0; i < 10; i++) {
      limiter.check('sms');
    }
    expect(limiter.check('sms')).toBe(false);
  });

  it('applies different limits per platform', () => {
    const limiter = new PlatformRateLimiter();
    // Telegram: 20/min, Slack: 50/min
    expect(limiter.getLimit('telegram').maxPerMinute).toBe(20);
    expect(limiter.getLimit('slack').maxPerMinute).toBe(50);
    expect(limiter.getLimit('sms').maxPerMinute).toBe(10);
  });

  it('uses default limit for unknown platforms', () => {
    const limiter = new PlatformRateLimiter();
    expect(limiter.getLimit('custom-platform').maxPerMinute).toBe(30);
  });

  it('tracks remaining quota', () => {
    const limiter = new PlatformRateLimiter();
    expect(limiter.remaining('sms')).toBe(10);

    for (let i = 0; i < 7; i++) {
      limiter.check('sms');
    }
    expect(limiter.remaining('sms')).toBe(3);
  });

  it('isolates platforms from each other', () => {
    const limiter = new PlatformRateLimiter();
    // Exhaust SMS limit
    for (let i = 0; i < 10; i++) {
      limiter.check('sms');
    }
    expect(limiter.check('sms')).toBe(false);
    // Telegram should still be available
    expect(limiter.check('telegram')).toBe(true);
  });
});
