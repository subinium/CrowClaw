/**
 * #304 (v0.9.0 Hermes parity): `X-CrowClaw-Session-Key` header support for
 * stable per-session memory provider keying.
 *
 * Acceptance criteria from the issue, all verified below:
 *   - Two requests with the same `X-CrowClaw-Session-Key` and different
 *     `sessionId` share the same memory namespace.
 *   - Existing providers without `sessionKey` awareness keep working
 *     (backward compatible).
 *   - `InMemoryMemoryProvider` ships a reference impl that namespaces by
 *     `sessionKey` when present.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryMemoryProvider } from '@crowclaw/memory';
import { InMemoryMemoryStore } from '@crowclaw/storage';
import { getRequestSessionKey } from '../packages/runtime-node/src/runtime-support.js';

describe('getRequestSessionKey (#304)', () => {
  it('reads the X-CrowClaw-Session-Key header', () => {
    const request = new Request('https://example.com/api/chat', {
      method: 'POST',
      headers: { 'X-CrowClaw-Session-Key': 'telegram:42' },
    });
    expect(getRequestSessionKey(request)).toBe('telegram:42');
  });

  it('falls back to the body field when the header is absent', () => {
    const request = new Request('https://example.com/api/chat', { method: 'POST' });
    expect(getRequestSessionKey(request, { sessionKey: 'desktop:install-9' })).toBe('desktop:install-9');
  });

  it('prefers the header over the body field', () => {
    const request = new Request('https://example.com/api/chat', {
      method: 'POST',
      headers: { 'X-CrowClaw-Session-Key': 'from-header' },
    });
    expect(getRequestSessionKey(request, { sessionKey: 'from-body' })).toBe('from-header');
  });

  it('returns undefined for an empty or whitespace header value', () => {
    const blank = new Request('https://example.com/api/chat', {
      method: 'POST',
      headers: { 'X-CrowClaw-Session-Key': '   ' },
    });
    expect(getRequestSessionKey(blank)).toBeUndefined();

    const empty = new Request('https://example.com/api/chat', { method: 'POST' });
    expect(getRequestSessionKey(empty)).toBeUndefined();
  });

  it('rejects non-string body values', () => {
    const request = new Request('https://example.com/api/chat', { method: 'POST' });
    expect(getRequestSessionKey(request, { sessionKey: 42 })).toBeUndefined();
    expect(getRequestSessionKey(request, { sessionKey: null })).toBeUndefined();
    expect(getRequestSessionKey(request, { sessionKey: { nested: 'bad' } as unknown })).toBeUndefined();
  });

  it('truncates absurdly long keys to keep them safe as DB/cache keys', () => {
    const long = 'x'.repeat(300);
    const request = new Request('https://example.com/api/chat', {
      method: 'POST',
      headers: { 'X-CrowClaw-Session-Key': long },
    });
    const result = getRequestSessionKey(request);
    expect(result).toBeDefined();
    expect(result!.length).toBe(256);
  });

  it('case-insensitive header lookup (Request normalizes header names)', () => {
    const request = new Request('https://example.com/api/chat', {
      method: 'POST',
      headers: { 'x-crowclaw-session-key': 'lowercase' },
    });
    expect(getRequestSessionKey(request)).toBe('lowercase');
  });
});

describe('InMemoryMemoryProvider sessionKey namespacing (#304)', () => {
  it('shares the same memory bucket across two sessionIds with the same sessionKey', async () => {
    const store = new InMemoryMemoryStore();
    const provider = new InMemoryMemoryProvider(store);

    // Caller 1 stores a memory under sessionKey=K with sessionId=A.
    await provider.store(
      { sessionId: 'sess-A', scope: 'session', summary: 'I like trains', tags: ['interest'] },
      { sessionKey: 'shared-key-K' },
    );

    // Caller 2 uses a different sessionId but the SAME sessionKey to recall.
    // (The new request might rotate sessionId on /new but keep the
    // X-CrowClaw-Session-Key header pinned.)
    const recalled = await provider.recall(
      'sess-B-different',
      'trains',
      5,
      undefined,
      undefined,
      { sessionKey: 'shared-key-K' },
    );

    expect(recalled.length).toBeGreaterThan(0);
    expect(recalled[0]!.summary).toContain('trains');
  });

  it('keeps memory separate when sessionKeys differ', async () => {
    const store = new InMemoryMemoryStore();
    const provider = new InMemoryMemoryProvider(store);

    await provider.store(
      { sessionId: 'shared', scope: 'session', summary: 'alpha secret', tags: [] },
      { sessionKey: 'tenant-1' },
    );
    await provider.store(
      { sessionId: 'shared', scope: 'session', summary: 'beta secret', tags: [] },
      { sessionKey: 'tenant-2' },
    );

    const t1 = await provider.recall('whatever', 'secret', 5, undefined, undefined, { sessionKey: 'tenant-1' });
    expect(t1.map((r) => r.summary)).toEqual(['alpha secret']);

    const t2 = await provider.recall('whatever', 'secret', 5, undefined, undefined, { sessionKey: 'tenant-2' });
    expect(t2.map((r) => r.summary)).toEqual(['beta secret']);
  });

  it('backward-compatible — recall without sessionKey still finds session-scoped memory', async () => {
    const store = new InMemoryMemoryStore();
    const provider = new InMemoryMemoryProvider(store);

    // Legacy caller: no sessionKey, stores under sessionId.
    await provider.store({ sessionId: 'legacy-session', scope: 'session', summary: 'legacy note', tags: [] });

    // Legacy recall — no sessionKey, same sessionId. Should still work.
    const recalled = await provider.recall('legacy-session', 'legacy', 5);
    expect(recalled.length).toBe(1);
    expect(recalled[0]!.summary).toBe('legacy note');
  });

  it('prefetch with sessionKey also routes to the namespace', async () => {
    const store = new InMemoryMemoryStore();
    const provider = new InMemoryMemoryProvider(store);

    await provider.store(
      { sessionId: 'old', scope: 'session', summary: 'prefetch me', tags: [] },
      { sessionKey: 'pf-key' },
    );

    const out = await provider.prefetch('newSessionId', 'prefetch', 5, { sessionKey: 'pf-key' });
    expect(out.length).toBe(1);
    expect(out[0]!.summary).toBe('prefetch me');
  });
});
