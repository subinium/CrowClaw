import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GatewayDebouncer } from '../packages/runtime-node/src/index.js';

describe('GatewayDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers a single message after the debounce window', async () => {
    const debouncer = new GatewayDebouncer(500);
    const promise = debouncer.debounce('discord', 'user1', 'chan1', 'hello');
    expect(debouncer.pendingCount).toBe(1);

    vi.advanceTimersByTime(500);
    const result = await promise;
    expect(result).toBe('hello');
    expect(debouncer.pendingCount).toBe(0);
  });

  it('merges messages with the same key within the debounce window', async () => {
    const debouncer = new GatewayDebouncer(500);

    // First message
    debouncer.debounce('discord', 'user1', 'chan1', 'hello');
    // Second message within window (same key)
    vi.advanceTimersByTime(200);
    const promise = debouncer.debounce('discord', 'user1', 'chan1', 'world');

    expect(debouncer.pendingCount).toBe(1);

    vi.advanceTimersByTime(500);
    const result = await promise;
    expect(result).toBe('hello\nworld');
  });

  it('keeps different keys as separate pending entries', async () => {
    const debouncer = new GatewayDebouncer(500);

    const p1 = debouncer.debounce('discord', 'user1', 'chan1', 'msg-a');
    const p2 = debouncer.debounce('slack', 'user2', 'chan2', 'msg-b');

    expect(debouncer.pendingCount).toBe(2);

    vi.advanceTimersByTime(500);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('msg-a');
    expect(r2).toBe('msg-b');
    expect(debouncer.pendingCount).toBe(0);
  });

  it('resets the timer when a new message arrives within the window', async () => {
    const debouncer = new GatewayDebouncer(500);

    debouncer.debounce('discord', 'user1', 'chan1', 'first');
    vi.advanceTimersByTime(400);

    // Second message resets the 500ms timer
    const promise = debouncer.debounce('discord', 'user1', 'chan1', 'second');
    expect(debouncer.pendingCount).toBe(1);

    // At original 500ms mark, should still be pending (timer was reset)
    vi.advanceTimersByTime(100);
    expect(debouncer.pendingCount).toBe(1);

    // At 400ms after second message (total 900ms), still pending
    vi.advanceTimersByTime(300);
    expect(debouncer.pendingCount).toBe(1);

    // Complete the window (500ms from second message)
    vi.advanceTimersByTime(100);
    const result = await promise;
    expect(result).toBe('first\nsecond');
    expect(debouncer.pendingCount).toBe(0);
  });

  it('uses default 500ms window when no argument is provided', async () => {
    const debouncer = new GatewayDebouncer();
    const promise = debouncer.debounce('telegram', 'u1', 'c1', 'test');

    vi.advanceTimersByTime(499);
    expect(debouncer.pendingCount).toBe(1);

    vi.advanceTimersByTime(1);
    const result = await promise;
    expect(result).toBe('test');
  });
});
