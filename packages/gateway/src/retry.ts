// ---------------------------------------------------------------------------
// Gateway retry executor — exponential backoff using GatewayRetryPolicy
// ---------------------------------------------------------------------------

import type { GatewayRetryPolicy } from './index.js';

export interface RetryResult<T> {
  ok: boolean;
  value?: T;
  attempts: number;
  lastError?: string;
}

/**
 * Execute an async operation with retry using a GatewayRetryPolicy.
 *
 * Uses exponential backoff: delay = baseDelayMs * 2^(attempt-1)
 * Jitter: +/- 20% to avoid thundering herd.
 */
export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  policy: GatewayRetryPolicy,
  signal?: AbortSignal,
): Promise<RetryResult<T>> {
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    if (signal?.aborted) {
      return { ok: false, attempts: attempt, lastError: 'aborted' };
    }

    try {
      const value = await fn();
      return { ok: true, value, attempts: attempt };
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);

      // Don't sleep after the last attempt
      if (attempt < policy.maxAttempts) {
        const baseDelay = policy.baseDelayMs * Math.pow(2, attempt - 1);
        const jitter = baseDelay * (0.8 + Math.random() * 0.4); // +/- 20%
        await sleep(jitter, signal);
      }
    }
  }

  return { ok: false, attempts: policy.maxAttempts, lastError };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
