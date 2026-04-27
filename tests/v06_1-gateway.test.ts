/**
 * v0.6.1 gateway sweep regression tests.
 *
 *   #69   WS auth rate limiting with exponential backoff (CVE-2026-32025 parity)
 *   #78   poison replay-unsafe inbound dedupe after first visible progress
 *   #109  concurrent Telegram update handling with p-limit
 *   #134  scrub bot tokens from error messages and URLs in status
 */

import { describe, expect, it } from 'vitest';
import {
  InMemoryGatewayIdempotencyStore,
  WsAuthRateLimiter,
  scrubBotToken,
  GatewayRunner,
} from '@crowclaw/gateway';

// -----------------------------------------------------------------------------
// #134 — bot token scrubbing
// -----------------------------------------------------------------------------

describe('#134 scrubBotToken', () => {
  it('redacts a single Telegram bot token', () => {
    const input = 'fetch failed: GET https://api.telegram.org/bot1234567890:AAH-AbCDef_GhIjKlMnOpQrStUvWxYz/getMe';
    expect(scrubBotToken(input)).toBe(
      'fetch failed: GET https://api.telegram.org/bot[REDACTED]/getMe',
    );
  });

  it('redacts multiple tokens in the same string', () => {
    const input = 'tried bot111:AAA_aaa-bbb then bot222:BBB-ccc_ddd';
    expect(scrubBotToken(input)).toBe('tried bot[REDACTED] then bot[REDACTED]');
  });

  it('leaves token-free strings untouched', () => {
    expect(scrubBotToken('Network unreachable')).toBe('Network unreachable');
    expect(scrubBotToken('')).toBe('');
  });

  it('does not redact innocuous "bot" prefixes', () => {
    // Looks similar but lacks the digits-then-colon shape — must not match.
    expect(scrubBotToken('robot:hello')).toBe('robot:hello');
    expect(scrubBotToken('bot:no_digits')).toBe('bot:no_digits');
  });
});

// -----------------------------------------------------------------------------
// #69 — WS auth rate limiter with exponential backoff
// -----------------------------------------------------------------------------

describe('#69 WsAuthRateLimiter', () => {
  it('allows the first burst of attempts up to the threshold', () => {
    const limiter = new WsAuthRateLimiter({ maxAttempts: 5, baseBanMs: 60_000 });
    for (let i = 0; i < 4; i += 1) {
      expect(limiter.beforeAuth('1.2.3.4').allowed).toBe(true);
      limiter.recordFailure('1.2.3.4');
    }
    // 5th attempt is still allowed to reach the auth handler — the failure
    // we record below is what crosses the threshold.
    expect(limiter.beforeAuth('1.2.3.4').allowed).toBe(true);
    limiter.recordFailure('1.2.3.4');
  });

  it('bans the IP after maxAttempts failures inside the window', () => {
    const limiter = new WsAuthRateLimiter({ maxAttempts: 5, baseBanMs: 60_000 });
    for (let i = 0; i < 5; i += 1) {
      limiter.beforeAuth('9.9.9.9');
      limiter.recordFailure('9.9.9.9');
    }
    const decision = limiter.beforeAuth('9.9.9.9');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('banned');
    expect(decision.retryAfterSec).toBeGreaterThan(0);
    expect(decision.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it('does not affect other IPs', () => {
    const limiter = new WsAuthRateLimiter({ maxAttempts: 3 });
    for (let i = 0; i < 3; i += 1) {
      limiter.beforeAuth('5.5.5.5');
      limiter.recordFailure('5.5.5.5');
    }
    expect(limiter.beforeAuth('5.5.5.5').allowed).toBe(false);
    expect(limiter.beforeAuth('6.6.6.6').allowed).toBe(true);
  });

  it('escalates ban duration exponentially across consecutive bans', () => {
    // Use a tiny baseBanMs so the test does not need to fast-forward time —
    // we rely on `getBan(...).level` to verify the escalation arithmetic.
    const limiter = new WsAuthRateLimiter({
      maxAttempts: 2,
      baseBanMs: 1_000,
      maxBanMs: 120_000,
    });
    // First ban — level 1.
    for (let i = 0; i < 2; i += 1) {
      limiter.beforeAuth('7.7.7.7');
      limiter.recordFailure('7.7.7.7');
    }
    const ban1 = limiter.getBan('7.7.7.7');
    expect(ban1?.level).toBe(1);

    // Force the entry's `until` into the past so the next `beforeAuth` walks
    // the "ban expired but level survives" branch.
    if (ban1) ban1.until = Date.now() - 1;

    // Trigger another burst — level should escalate to 2.
    for (let i = 0; i < 2; i += 1) {
      limiter.beforeAuth('7.7.7.7');
      limiter.recordFailure('7.7.7.7');
    }
    const ban2 = limiter.getBan('7.7.7.7');
    expect(ban2?.level).toBe(2);
  });

  it('honours 100 rapid bad-token attempts from one IP without all reaching auth', () => {
    // Mirror the issue's acceptance criterion verbatim.
    const limiter = new WsAuthRateLimiter({ maxAttempts: 5 });
    let allowed = 0;
    let denied = 0;
    for (let i = 0; i < 100; i += 1) {
      const decision = limiter.beforeAuth('attacker');
      if (decision.allowed) {
        allowed += 1;
        limiter.recordFailure('attacker');
      } else {
        denied += 1;
      }
    }
    // At most maxAttempts (5) requests should ever reach the auth handler.
    expect(allowed).toBeLessThanOrEqual(5);
    expect(denied).toBeGreaterThanOrEqual(95);
  });

  it('clears the ban level on successful auth', () => {
    const limiter = new WsAuthRateLimiter({ maxAttempts: 3 });
    for (let i = 0; i < 3; i += 1) {
      limiter.beforeAuth('legit');
      limiter.recordFailure('legit');
    }
    expect(limiter.getBan('legit')?.level).toBeGreaterThanOrEqual(1);
    limiter.recordSuccess('legit');
    expect(limiter.getBan('legit')).toBeNull();
    // Subsequent attempts start fresh.
    expect(limiter.beforeAuth('legit').allowed).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// #78 — poison-after-progress idempotency
// -----------------------------------------------------------------------------

describe('#78 InMemoryGatewayIdempotencyStore.poisonAfterProgress', () => {
  it('claim reports fresh on first call', async () => {
    const store = new InMemoryGatewayIdempotencyStore();
    expect(await store.claim('k1')).toBe('fresh');
  });

  it('claim reports duplicate on second call before progress', async () => {
    const store = new InMemoryGatewayIdempotencyStore();
    await store.claim('k1');
    expect(await store.claim('k1')).toBe('duplicate');
  });

  it('claim reports poisoned after poisonAfterProgress', async () => {
    const store = new InMemoryGatewayIdempotencyStore();
    expect(await store.claim('k1')).toBe('fresh');
    await store.poisonAfterProgress('k1');
    expect(await store.claim('k1')).toBe('poisoned');
    // Idempotent — repeated retries keep returning poisoned.
    expect(await store.claim('k1')).toBe('poisoned');
  });

  it('isPoisoned tracks the poison state independently', async () => {
    const store = new InMemoryGatewayIdempotencyStore();
    expect(await store.isPoisoned('k1')).toBe(false);
    await store.claim('k1');
    expect(await store.isPoisoned('k1')).toBe(false);
    await store.poisonAfterProgress('k1');
    expect(await store.isPoisoned('k1')).toBe(true);
  });

  it('markIfAbsent treats a poisoned key as occupied', async () => {
    const store = new InMemoryGatewayIdempotencyStore();
    await store.claim('k1');
    await store.poisonAfterProgress('k1');
    // Backcompat: legacy callers that only know markIfAbsent must still be
    // told the slot is taken (false) so they do not re-run the side-effect.
    expect(await store.markIfAbsent('k1')).toBe(false);
  });

  it('unmark does not clear the poison marker', async () => {
    const store = new InMemoryGatewayIdempotencyStore();
    await store.claim('k1');
    await store.poisonAfterProgress('k1');
    await store.unmark('k1');
    // Replays after explicit unmark must still fail loud.
    expect(await store.claim('k1')).toBe('poisoned');
  });

  it('matches the issue scenario: tool runs, retry must not replay', async () => {
    // Scenario from the issue: "tool runs, halfway through provider drops
    // connection; client retries; second call returns 409 'poisoned' instead
    // of re-running the tool."
    const store = new InMemoryGatewayIdempotencyStore();
    const key = 'telegram:chat-1:update-42';

    // Inbound delivery 1 — claim succeeds, tool starts running.
    expect(await store.claim(key)).toBe('fresh');
    // Tool emits a side-effect (e.g. sends a partial message). Runtime
    // poisons the dedupe entry.
    await store.poisonAfterProgress(key);
    // Provider drops, client retries the same delivery.
    const retryClaim = await store.claim(key);
    expect(retryClaim).toBe('poisoned');
    // The runtime should map this to a 409 response (asserted at the call site).
  });

  it('honours TTL — poison expires after ttlMs', async () => {
    const store = new InMemoryGatewayIdempotencyStore();
    await store.claim('k1', 5);
    await store.poisonAfterProgress('k1', 5);
    expect(await store.isPoisoned('k1')).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(await store.isPoisoned('k1')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// #109 — concurrent Telegram update handling with p-limit
// -----------------------------------------------------------------------------

describe('#109 GatewayRunner concurrent update handling', () => {
  it('updateLimiter caps concurrent in-flight tasks at 3', async () => {
    // The runner installs a private `updateLimiter = createConcurrencyLimiter(3)`.
    // Spinning up the real polling loop hits api.telegram.org, so instead we
    // exercise the limiter directly with synthetic tasks. We assert the
    // observable contract: across a batch of 10 tasks the maximum
    // simultaneously-active count never exceeds 3.
    const runner = new GatewayRunner({ platforms: [] });
    const limiter = (
      runner as unknown as { updateLimiter: <T>(fn: () => Promise<T>) => Promise<T> }
    ).updateLimiter;
    expect(typeof limiter).toBe('function');

    let active = 0;
    let maxActive = 0;
    const tasks = Array.from({ length: 10 }, () =>
      limiter(async () => {
        active += 1;
        if (active > maxActive) maxActive = active;
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
      }),
    );
    await Promise.all(tasks);
    expect(maxActive).toBe(3);
  });

  it('exposes handleTelegramUpdate so the polling loop can dispatch per-update', () => {
    // Issue #109 requirement: per-update handling extracted into a method so
    // the polling loop can call `Promise.all(updates.map(u => limit(() =>
    // handleUpdate(u))))`. Verify the method exists with the expected name.
    const runner = new GatewayRunner({ platforms: [] });
    const handler = (
      runner as unknown as { handleTelegramUpdate?: unknown }
    ).handleTelegramUpdate;
    expect(typeof handler).toBe('function');
  });

  it('a burst of 10 updates does not serialize to 10 sequential awaits', async () => {
    // Stronger acceptance: total wall time for 10 tasks of 20ms each through
    // a 3-wide limiter must be ~80ms (4 waves of 20ms), not ~200ms (sequential).
    const runner = new GatewayRunner({ platforms: [] });
    const limiter = (
      runner as unknown as { updateLimiter: <T>(fn: () => Promise<T>) => Promise<T> }
    ).updateLimiter;

    const start = Date.now();
    await Promise.all(
      Array.from({ length: 10 }, () => limiter(() => new Promise((r) => setTimeout(r, 20)))),
    );
    const elapsed = Date.now() - start;
    // Sequential lower bound: 200ms. With concurrency 3 we expect ~80ms;
    // give ourselves headroom for slow CI but still much less than serial.
    expect(elapsed).toBeLessThan(150);
  });
});
