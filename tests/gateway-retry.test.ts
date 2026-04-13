import { describe, expect, it } from 'vitest';
import { executeWithRetry } from '@crowclaw/gateway/retry';

describe('executeWithRetry', () => {
  it('returns immediately on first success', async () => {
    const result = await executeWithRetry(
      async () => 'ok',
      { maxAttempts: 3, baseDelayMs: 10 },
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe('ok');
    expect(result.attempts).toBe(1);
  });

  it('retries on failure and succeeds eventually', async () => {
    let callCount = 0;
    const result = await executeWithRetry(
      async () => {
        callCount++;
        if (callCount < 3) throw new Error(`fail ${callCount}`);
        return 'recovered';
      },
      { maxAttempts: 3, baseDelayMs: 1 },
    );

    expect(result.ok).toBe(true);
    expect(result.value).toBe('recovered');
    expect(result.attempts).toBe(3);
  });

  it('exhausts all attempts and returns failure', async () => {
    const result = await executeWithRetry(
      async () => { throw new Error('always fails'); },
      { maxAttempts: 2, baseDelayMs: 1 },
    );

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.lastError).toBe('always fails');
  });

  it('respects abort signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await executeWithRetry(
      async () => 'should not run',
      { maxAttempts: 3, baseDelayMs: 10 },
      controller.signal,
    );

    expect(result.ok).toBe(false);
    expect(result.lastError).toBe('aborted');
  });

  it('passes through the return type', async () => {
    const result = await executeWithRetry(
      async () => ({ id: 42, name: 'test' }),
      { maxAttempts: 1, baseDelayMs: 1 },
    );

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ id: 42, name: 'test' });
  });

  it('aborts mid-retry when signal fires during backoff', async () => {
    const controller = new AbortController();
    let callCount = 0;

    const resultPromise = executeWithRetry(
      async () => {
        callCount++;
        if (callCount === 1) {
          // Abort during the backoff sleep after first failure
          setTimeout(() => controller.abort(), 5);
          throw new Error('first fail');
        }
        return 'should not reach';
      },
      { maxAttempts: 5, baseDelayMs: 200 },
      controller.signal,
    );

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(callCount).toBe(1); // Only ran once before abort cut the retry
    // After abort during backoff, the next iteration's abort check fires
    expect(result.lastError).toBe('aborted');
  });
});
