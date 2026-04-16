import { describe, expect, it } from 'vitest';
import { SessionMutex } from '@crowclaw/runtime-node/session-mutex';

describe('SessionMutex', () => {
  it('acquires and releases immediately when no contention', async () => {
    const mutex = new SessionMutex();
    const release = await mutex.acquire('s1');
    expect(mutex.activeCount).toBe(1);
    release();
    expect(mutex.activeCount).toBe(0);
  });

  it('serializes concurrent requests to the same session', async () => {
    const mutex = new SessionMutex();
    const order: number[] = [];

    const r1 = await mutex.acquire('s1');
    // Second acquire should block until r1 releases
    const p2 = mutex.acquire('s1').then((release) => {
      order.push(2);
      release();
    });

    order.push(1);
    r1();

    await p2;
    expect(order).toEqual([1, 2]);
  });

  it('allows parallel access to different sessions', async () => {
    const mutex = new SessionMutex();
    const r1 = await mutex.acquire('s1');
    const r2 = await mutex.acquire('s2');
    expect(mutex.activeCount).toBe(2);
    r1();
    r2();
    expect(mutex.activeCount).toBe(0);
  });

  it('handles three concurrent acquires in FIFO order', async () => {
    const mutex = new SessionMutex();
    const order: number[] = [];

    const r1 = await mutex.acquire('s1');

    const p2 = mutex.acquire('s1').then((release) => {
      order.push(2);
      release();
    });
    const p3 = mutex.acquire('s1').then((release) => {
      order.push(3);
      release();
    });

    order.push(1);
    r1();

    await Promise.all([p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('cleans up map entry when tail lock releases', async () => {
    const mutex = new SessionMutex();
    const release = await mutex.acquire('s1');
    release();
    expect(mutex.activeCount).toBe(0);
  });

  it('double-release is idempotent (does not throw or corrupt state)', async () => {
    const mutex = new SessionMutex();
    const release = await mutex.acquire('s1');

    // First release — normal
    release();
    expect(mutex.activeCount).toBe(0);

    // Second release — should be safe (no throw, no state corruption)
    release();
    expect(mutex.activeCount).toBe(0);

    // Mutex should still work for new acquires
    const r2 = await mutex.acquire('s1');
    expect(mutex.activeCount).toBe(1);
    r2();
    expect(mutex.activeCount).toBe(0);
  });

  it('throws when capacity is reached instead of silently evicting a live chain', async () => {
    const mutex = new SessionMutex({ maxSessions: 2 });

    // Fill to capacity with two live sessions
    const r1 = await mutex.acquire('s1');
    const r2 = await mutex.acquire('s2');
    expect(mutex.activeCount).toBe(2);

    // A third distinct session must NOT evict an active chain — old behaviour
    // removed 's1' from the map, letting a subsequent 's1' acquire skip the
    // queue and run concurrently with the existing holder.
    await expect(mutex.acquire('s3')).rejects.toThrow(/capacity/);

    // Re-entering an existing session is still allowed (it chains behind r1)
    const queued = mutex.acquire('s1');

    r1();
    r2();

    const r1b = await queued;
    r1b();
    expect(mutex.activeCount).toBe(0);
  });
});
