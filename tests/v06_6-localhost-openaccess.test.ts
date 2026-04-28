/**
 * v0.6.6: when CROWCLAW_DASHBOARD_TOKEN is unset AND the runtime is bound
 * to a localhost interface, dangerous routes (`/api/providers/config`,
 * `/api/config/agent`, etc.) are reachable without a bearer token. Without
 * this carve-out the dashboard's init sequence in dev mode 401s and
 * surfaces "Session expired" — even though serve-local.mjs prints
 * "Dashboard token: NOT SET (open access)".
 *
 * The startup security warning ("CROWCLAW_DASHBOARD_TOKEN is not set")
 * still fires; non-localhost binds without a token still 4xx through the
 * upstream gate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import { localRoute } from '../packages/runtime-node/src/route-paths.js';
import { EchoProvider } from '@crowclaw/providers';

describe('v0.6.6 localhost open-access', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.CROWCLAW_DASHBOARD_TOKEN;
    delete process.env.CROWCLAW_DASHBOARD_TOKEN;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CROWCLAW_DASHBOARD_TOKEN;
    else process.env.CROWCLAW_DASHBOARD_TOKEN = originalEnv;
  });

  it('dangerous route /api/providers/config is reachable on localhost without token', async () => {
    const runtime = createNodeRuntime({
      provider: new EchoProvider(),
      agentId: 'crowclaw-localhost-openaccess',
      hostname: '127.0.0.1',
    });

    const res = await runtime.fetch(new Request(localRoute('/api/providers/config')));
    expect(res.status).not.toBe(401);
  });

  it('dangerous route /api/config/agent is reachable on localhost without token', async () => {
    const runtime = createNodeRuntime({
      provider: new EchoProvider(),
      agentId: 'crowclaw-localhost-openaccess-2',
      hostname: '127.0.0.1',
    });

    const res = await runtime.fetch(new Request(localRoute('/api/config/agent')));
    expect(res.status).not.toBe(401);
  });

  it('GET on dangerous routes (read-only listings) is allowed on localhost no-token', async () => {
    const runtime = createNodeRuntime({
      provider: new EchoProvider(),
      agentId: 'crowclaw-localhost-readonly',
      hostname: '127.0.0.1',
    });
    // Dashboard init fetches these — must NOT 401, otherwise the
    // crowclaw:auth-required event fires and the user sees "Session expired".
    const readOnlyDangerous = [
      '/api/mcp/servers',
      '/api/scheduler/start',  // GET on a typically-POST path: still no 401
      '/api/providers/config',
    ];
    for (const p of readOnlyDangerous) {
      const res = await runtime.fetch(new Request(localRoute(p))); // GET
      expect(res.status, `GET ${p} should not 401`).not.toBe(401);
    }
  });

  it('execution routes (terminal/workspace-mutate/mcp-server CRUD) STAY locked on localhost no-token', async () => {
    const runtime = createNodeRuntime({
      provider: new EchoProvider(),
      agentId: 'crowclaw-localhost-execution-locked',
      hostname: '127.0.0.1',
    });

    // Each must 401 even though we're on localhost without a token —
    // tests/security-critical.test.ts is the binding contract.
    const lockedPaths = [
      '/api/terminal/exec',
      '/api/terminal/background',
      '/api/terminal/kill',
      '/api/workspace/write',
      '/api/workspace/delete',
      '/api/scheduler/start',
      '/api/scheduler/stop',
      '/api/mcp/servers',
      '/api/security/policy',
    ];
    for (const p of lockedPaths) {
      const res = await runtime.fetch(new Request(localRoute(p), { method: 'POST', body: '{}' }));
      expect(res.status, `${p} should still 401`).toBe(401);
    }
  });

  it('non-localhost bind WITHOUT token fail-closes (500 config error) on protected surfaces', async () => {
    const runtime = createNodeRuntime({
      provider: new EchoProvider(),
      agentId: 'crowclaw-public-no-token',
      hostname: '0.0.0.0',
    });

    // Pre-existing fail-close at runtime-node:2315 returns HTTP 500 with a
    // clear "CROWCLAW_DASHBOARD_TOKEN is required when binding to
    // non-localhost" message. We assert this stays in place — v0.6.6's
    // localhost carve-out must not weaken the public-bind fail-close.
    const res = await runtime.fetch(new Request(localRoute('/api/providers/config')));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('CROWCLAW_DASHBOARD_TOKEN');
  });

  it('with token set + matching bearer: dangerous route still passes', async () => {
    process.env.CROWCLAW_DASHBOARD_TOKEN = 'unit-test-tok-Zx9pQ3rV';
    const runtime = createNodeRuntime({
      provider: new EchoProvider(),
      agentId: 'crowclaw-token-set',
      hostname: '127.0.0.1',
    });

    const res = await runtime.fetch(new Request(localRoute('/api/providers/config'), {
      headers: { authorization: 'Bearer unit-test-tok-Zx9pQ3rV' },
    }));
    expect(res.status).not.toBe(401);
  });

  it('with token set + WRONG bearer: 401s', async () => {
    process.env.CROWCLAW_DASHBOARD_TOKEN = 'unit-test-tok-Zx9pQ3rV';
    const runtime = createNodeRuntime({
      provider: new EchoProvider(),
      agentId: 'crowclaw-token-set-wrong',
      hostname: '127.0.0.1',
    });

    const res = await runtime.fetch(new Request(localRoute('/api/providers/config'), {
      headers: { authorization: 'Bearer wrong-tok-different-len' },
    }));
    expect(res.status).toBe(401);
  });
});

describe('v0.6.6 /healthz + /readyz aliases', () => {
  it('GET /healthz returns 200 + same shape as /health', async () => {
    const runtime = createNodeRuntime({
      provider: new EchoProvider(),
      agentId: 'crowclaw-healthz',
      hostname: '127.0.0.1',
    });

    const res = await runtime.fetch(new Request(localRoute('/healthz')));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string; runtime: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('crowclaw');
    expect(body.runtime).toBe('node');
  });

  it('GET /readyz returns 200 + same shape', async () => {
    const runtime = createNodeRuntime({
      provider: new EchoProvider(),
      agentId: 'crowclaw-readyz',
      hostname: '127.0.0.1',
    });

    const res = await runtime.fetch(new Request(localRoute('/readyz')));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
