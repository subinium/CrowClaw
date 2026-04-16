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
 *
 * Gateway send helpers (e.g. `sendTelegramMessage`) report API failures as
 * `{ ok: false, error }` instead of throwing. We detect that shape and treat
 * it as a retryable failure so callers don't silently drop messages.
 */
export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  policy: GatewayRetryPolicy,
  signal?: AbortSignal,
): Promise<RetryResult<T>> {
  let lastError: string | undefined;
  let lastValue: T | undefined;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    if (signal?.aborted) {
      return { ok: false, attempts: attempt, lastError: 'aborted' };
    }

    try {
      const value = await fn();
      if (isGatewayFailure(value)) {
        lastValue = value;
        lastError = extractErrorMessage(value) ?? 'operation returned ok:false';
      } else {
        return { ok: true, value, attempts: attempt };
      }
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    // Don't sleep after the last attempt
    if (attempt < policy.maxAttempts) {
      const baseDelay = policy.baseDelayMs * Math.pow(2, attempt - 1);
      const jitter = baseDelay * (0.8 + Math.random() * 0.4); // +/- 20%
      await sleep(jitter, signal);
    }
  }

  return { ok: false, value: lastValue, attempts: policy.maxAttempts, lastError };
}

function isGatewayFailure(value: unknown): boolean {
  return (
    typeof value === 'object'
    && value !== null
    && 'ok' in value
    && (value as { ok: unknown }).ok === false
  );
}

function extractErrorMessage(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const err = (value as { error?: unknown }).error;
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let onAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
