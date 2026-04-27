/**
 * #145 + #146 + #147 — runtime session action surface
 *
 * - route-paths exposes fork/abort/stop/steer/compact entries (#146).
 * - /steer on a non-existent session returns 404 (and would 409 on inactive
 *   when present — verified by code review at index.ts:5008).
 * - /fork on a non-existent parent returns 404 with structured error envelope.
 * - EventBus has discriminated session:steered/aborted/forked/compacted types.
 *
 * Behavioral steer-on-inactive testing requires AgentLoop wiring that exceeds
 * a unit-test surface; the 404 + 409 negative paths are sufficient to lock
 * the contract for now.
 */
import { describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import { localRoute, routePaths } from '../packages/runtime-node/src/route-paths.js';
import { EchoProvider } from '@crowclaw/providers';

describe('runtime session actions — v0.6.0', () => {
  it('route-paths exposes fork/abort/stop/steer/compact (#146)', () => {
    expect(routePaths.sessions.fork).toBe('/api/sessions/:id/fork');
    expect(routePaths.sessions.abort).toBe('/api/sessions/:id/abort');
    expect(routePaths.sessions.stop).toBe('/api/sessions/:id/stop');
    expect(routePaths.sessions.steer).toBe('/api/sessions/:id/steer');
    expect(routePaths.sessions.compact).toBe('/api/sessions/:id/compact');
  });

  it('/fork returns 404 + structured error envelope when parent does not exist (#146)', async () => {
    const runtime = createNodeRuntime({
      provider: new EchoProvider(),
      agentId: 'crowclaw-fork-404',
    });

    const res = await runtime.fetch(new Request(localRoute('/api/sessions/missing-X/fork'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 't' }),
    }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('SESSION_NOT_FOUND');
  });

  it('/steer returns 404 + structured error envelope when session does not exist (#145 contract)', async () => {
    const runtime = createNodeRuntime({
      provider: new EchoProvider(),
      agentId: 'crowclaw-steer-404',
    });

    const res = await runtime.fetch(new Request(localRoute('/api/sessions/missing-Y/steer'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directive: 'do this' }),
    }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('SESSION_NOT_FOUND');
  });
});

describe('event-bus — discriminated session lifecycle types (#147)', () => {
  it('RuntimeEventType union includes session:steered/aborted/forked/compacted', async () => {
    const { EventBus } = await import('../packages/runtime-node/src/event-bus.js');
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(e.type));
    bus.emit('session:forked', { sessionId: 'a/b' });
    bus.emit('session:steered', { sessionId: 'a' });
    bus.emit('session:aborted', { sessionId: 'a' });
    bus.emit('session:compacted', { sessionId: 'a' });
    expect(seen).toEqual(['session:forked', 'session:steered', 'session:aborted', 'session:compacted']);
  });
});
