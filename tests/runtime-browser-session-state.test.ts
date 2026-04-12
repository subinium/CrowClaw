import { describe, expect, it, vi } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

describe('runtime browser session statefulness', () => {
  it('tracks currentUrl and snapshot refs across node browser session routes', async () => {
    const runtime = createNodeRuntime();

    const opened = await runtime.fetch(new Request('http://localhost/api/browser/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'browser-session-1', url: 'https://example.com/session' })
    }));
    expect((await opened.json() as { toolName: string }).toolName).toBe('browser.open');

    const snapshotted = await runtime.fetch(new Request('http://localhost/api/browser/snapshot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'browser-session-1', full: true })
    }));
    const snapshotPayload = await snapshotted.json() as { toolName: string; metadata: { refs: string[] } };
    expect(snapshotPayload.toolName).toBe('browser.snapshot');
    expect(snapshotPayload.metadata.refs).toEqual(['@e1', '@e2', '@e3']);

    const state = await runtime.fetch(new Request('http://localhost/api/browser/session?sessionId=browser-session-1'));
    const statePayload = await state.json() as { sessionId: string; currentUrl: string; lastSnapshot: string; lastRefs: string[] };
    expect(statePayload.sessionId).toBe('browser-session-1');
    expect(statePayload.currentUrl).toBe('https://example.com/session');
    expect(statePayload.lastSnapshot).toContain('Page snapshot for https://example.com/session');
    expect(statePayload.lastRefs).toEqual(['@e1', '@e2', '@e3']);

    const clickRef = await runtime.fetch(new Request('http://localhost/api/browser/click-ref', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'browser-session-1', ref: '@e1' })
    }));
    expect((await clickRef.json() as { ok: boolean; output: string }).output).toContain('Simulated click on ref @e1');

    const badClickRef = await runtime.fetch(new Request('http://localhost/api/browser/click-ref', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'browser-session-1', ref: '@missing' })
    }));
    const badPayload = await badClickRef.json() as { ok: boolean; output: string; metadata: { knownRefs: string[] } };
    expect(badPayload.ok).toBe(false);
    expect(badPayload.output).toContain('Unknown ref');
    expect(badPayload.metadata.knownRefs).toEqual(['@e1', '@e2', '@e3']);
  });

  it('resets node browser session state explicitly', async () => {
    const runtime = createNodeRuntime();

    await runtime.fetch(new Request('http://localhost/api/browser/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'browser-session-2', url: 'https://example.com/reset' })
    }));

    const beforeReset = await runtime.fetch(new Request('http://localhost/api/browser/session?sessionId=browser-session-2'));
    expect((await beforeReset.json() as { currentUrl: string }).currentUrl).toBe('https://example.com/reset');

    const reset = await runtime.fetch(new Request('http://localhost/api/browser/session/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'browser-session-2' })
    }));
    expect(await reset.json()).toEqual({ ok: true, sessionId: 'browser-session-2', reset: true });

    const afterReset = await runtime.fetch(new Request('http://localhost/api/browser/session?sessionId=browser-session-2'));
    expect(await afterReset.json()).toEqual({
      sessionId: 'browser-session-2',
      currentUrl: null,
      history: [],
      lastSnapshot: null,
      lastRefs: []
    });
  });
});
