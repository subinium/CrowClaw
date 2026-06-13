/**
 * v0.9.1 "Sentinel" (#365): exec-approval gate fails CLOSED on timeout.
 *
 * The approval gate must DENY when no operator responds within the window, and
 * only auto-approve on timeout under an explicit opt-in. A thrown or aborted
 * decider also fails closed.
 */

import { describe, expect, it } from 'vitest';
import { runApprovalGate, DEFAULT_APPROVAL_TIMEOUT_MS } from '@crowclaw/core';

const never = () => new Promise<boolean>(() => {});

describe('runApprovalGate (#365)', () => {
  it('exposes a 2-minute default window', () => {
    expect(DEFAULT_APPROVAL_TIMEOUT_MS).toBe(120_000);
  });

  it('fails closed (deny) when the decider does not respond in time', async () => {
    const outcome = await runApprovalGate(never, { timeoutMs: 5 });
    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toBe('timeout');
    expect(outcome.timedOut).toBe(true);
  });

  it('auto-approves on timeout only under the explicit opt-in', async () => {
    const outcome = await runApprovalGate(never, { timeoutMs: 5, approvalOnTimeout: 'allow' });
    expect(outcome.approved).toBe(true);
    expect(outcome.reason).toBe('approved');
    expect(outcome.timedOut).toBe(true);
  });

  it('honours an explicit operator approval', async () => {
    const outcome = await runApprovalGate(() => true, { timeoutMs: 1000 });
    expect(outcome.approved).toBe(true);
    expect(outcome.reason).toBe('approved');
    expect(outcome.timedOut).toBe(false);
  });

  it('honours an explicit operator denial (distinct from a timeout)', async () => {
    const outcome = await runApprovalGate(() => false, { timeoutMs: 1000 });
    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toBe('denied');
    expect(outcome.timedOut).toBe(false);
  });

  it('fails closed when the decider throws', async () => {
    const outcome = await runApprovalGate(() => {
      throw new Error('decider blew up');
    }, { timeoutMs: 1000 });
    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toBe('error');
  });

  it('fails closed when the abort signal fires', async () => {
    const controller = new AbortController();
    const promise = runApprovalGate(never, { timeoutMs: 1000, signal: controller.signal });
    controller.abort();
    const outcome = await promise;
    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toBe('aborted');
  });

  it('fails closed immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runApprovalGate(() => true, { signal: controller.signal });
    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toBe('aborted');
  });
});
