/**
 * E2E: per-session memory size + cost surfacing on the dashboard API (#187).
 *
 * Covers SessionState.memoryEntryCount + memoryBytes — the runtime should
 * populate them on GET /api/sessions list responses and on
 * GET /api/sessions/:id session-state responses.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

interface SessionSummary {
  sessionId: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  memoryEntryCount?: number;
  memoryBytes?: number;
}

interface SessionsListResponse {
  ok: boolean;
  supported: boolean;
  count: number;
  sessions: SessionSummary[];
}

function get(path: string): Request {
  return new Request(`http://localhost${path}`);
}

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function clearEnvToken(): void {
  const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
  if (proc?.env) delete proc.env.CROWCLAW_DASHBOARD_TOKEN;
}

async function createSession(
  runtime: { fetch: (req: Request) => Promise<Response> },
  sessionId: string,
): Promise<void> {
  const created = await runtime.fetch(postJson('/api/sessions', { sessionId }));
  expect(created.status).toBe(200);
}

describe('GET /api/sessions per-session memory metrics (#187)', () => {
  beforeEach(() => clearEnvToken());

  it('includes memoryEntryCount + memoryBytes on the list response', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    await createSession(runtime, 'mem-1');

    // Seed two memories so the per-session count is observable.
    const r1 = await runtime.fetch(postJson('/api/sessions/mem-1/remember', {
      summary: 'first memory snippet',
      tags: ['t1'],
    }));
    expect(r1.status).toBe(200);
    const r2 = await runtime.fetch(postJson('/api/sessions/mem-1/remember', {
      summary: 'second much longer memory snippet that should bump bytes',
      tags: ['t2'],
    }));
    expect(r2.status).toBe(200);

    const res = await runtime.fetch(get('/api/sessions'));
    const data = await res.json() as SessionsListResponse;
    const target = data.sessions.find((s) => s.sessionId === 'mem-1');
    expect(target).toBeDefined();
    expect(target!.memoryEntryCount).toBe(2);
    expect(typeof target!.memoryBytes).toBe('number');
    const expectedFloor = Buffer.byteLength('first memory snippet', 'utf8')
      + Buffer.byteLength('second much longer memory snippet that should bump bytes', 'utf8');
    expect(target!.memoryBytes!).toBeGreaterThanOrEqual(expectedFloor);
  });

  it('includes memoryEntryCount + memoryBytes on /api/sessions/:id', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    await createSession(runtime, 'mem-2');
    await runtime.fetch(postJson('/api/sessions/mem-2/remember', {
      summary: 'only one memory',
      tags: [],
    }));

    const res = await runtime.fetch(get('/api/sessions/mem-2'));
    expect(res.status).toBe(200);
    const data = await res.json() as { sessionId: string; memoryEntryCount?: number; memoryBytes?: number };
    expect(data.memoryEntryCount).toBe(1);
    expect(data.memoryBytes).toBeGreaterThanOrEqual(Buffer.byteLength('only one memory', 'utf8'));
  });

  it('reports 0 memoryEntryCount + memoryBytes for sessions with no memories', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    await createSession(runtime, 'no-mem');

    const res = await runtime.fetch(get('/api/sessions'));
    const data = await res.json() as SessionsListResponse;
    const target = data.sessions.find((s) => s.sessionId === 'no-mem');
    expect(target).toBeDefined();
    expect(target!.memoryEntryCount).toBe(0);
    expect(target!.memoryBytes).toBe(0);
  });
});
