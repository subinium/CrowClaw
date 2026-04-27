/**
 * Safe timer helpers that clamp delays to Node's `TIMEOUT_MAX`.
 *
 * Background — OpenClaw v2026.4.24 issue #71414:
 * Passing a delay above `2_147_483_647` ms (~24.85 days) to `setTimeout` /
 * `setInterval` causes Node to silently coerce it to `1` ms, which fires the
 * callback in a tight loop and crashes the scheduler. Anywhere CrowClaw
 * schedules from a user-supplied job schedule, we route the delay through the
 * helpers in this file so the value is bounded and, when it exceeds the cap,
 * chained across multiple sub-timers until the full duration elapses.
 */
//
// `setInterval` / `setTimeout` are intentionally allowed only inside this
// module — every other scheduler file must use the safe helpers below.
//

/**
 * Node's documented `TIMEOUT_MAX` for `setTimeout` / `setInterval`. Values
 * larger than this silently degrade to a 1ms timer, which is the bug we are
 * defending against.
 */
export const TIMEOUT_MAX = 2_147_483_647;

/**
 * Handle returned by `safeSetTimeout` / `safeSetInterval`. Opaque on purpose;
 * use `clearSafeTimer` to cancel.
 */
export interface SafeTimer {
  /** Cancel the timer. Idempotent. */
  cancel(): void;
}

/**
 * `setTimeout` that clamps `ms` to `[0, TIMEOUT_MAX]` and chains sub-timers
 * for delays above the cap so the callback fires once after the full duration.
 *
 * - Negative or non-finite `ms` is treated as `0`.
 * - `ms <= TIMEOUT_MAX` behaves identically to `setTimeout`.
 * - `ms > TIMEOUT_MAX` schedules `TIMEOUT_MAX` segments and a final remainder.
 */
export function safeSetTimeout(ms: number, fn: () => void): SafeTimer {
  const clamped = normalizeDelay(ms);

  let inner: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  let remaining = clamped;

  const tick = (): void => {
    if (cancelled) return;
    if (remaining <= TIMEOUT_MAX) {
      inner = setTimeout(() => {
        inner = null;
        if (cancelled) return;
        fn();
      }, remaining);
      return;
    }
    inner = setTimeout(() => {
      inner = null;
      if (cancelled) return;
      remaining -= TIMEOUT_MAX;
      tick();
    }, TIMEOUT_MAX);
  };

  tick();

  return {
    cancel(): void {
      cancelled = true;
      if (inner !== null) {
        clearTimeout(inner);
        inner = null;
      }
    },
  };
}

/**
 * `setInterval` that clamps the period to `[1, TIMEOUT_MAX]` and chains
 * `safeSetTimeout` for periods above the cap so the callback fires roughly
 * every `ms` even for multi-month intervals.
 *
 * - Periods below 1ms are coerced to 1 (matches Node's effective behaviour).
 * - The callback is invoked sequentially; if one invocation is still running
 *   it will not be re-entered.
 */
export function safeSetInterval(ms: number, fn: () => void): SafeTimer {
  let cancelled = false;
  let current: SafeTimer | null = null;
  const period = Math.max(1, normalizeDelay(ms));

  const schedule = (): void => {
    if (cancelled) return;
    current = safeSetTimeout(period, () => {
      if (cancelled) return;
      try {
        fn();
      } finally {
        if (!cancelled) schedule();
      }
    });
  };

  schedule();

  return {
    cancel(): void {
      cancelled = true;
      if (current !== null) {
        current.cancel();
        current = null;
      }
    },
  };
}

/**
 * Cancel a `SafeTimer`. Equivalent to calling `.cancel()`; provided for
 * symmetry with `clearTimeout` / `clearInterval`.
 */
export function clearSafeTimer(timer: SafeTimer | null | undefined): void {
  if (timer) timer.cancel();
}

function normalizeDelay(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  // Use floor so 1.5 -> 1, matching how Node coerces the delay internally.
  return Math.floor(ms);
}
