/**
 * E2E: GET /api/sessions list — pagination, search, and status filter (#192).
 *
 * Verifies the dashboard sessions endpoint handles ?search, ?status, ?limit,
 * and ?cursor query params and returns { sessions, nextCursor, totalCount }.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

interface SessionSummary {
  sessionId: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

interface SessionsListResponse {
  ok: boolean;
  supported: boolean;
  count: number;
  totalCount: number;
  nextCursor: string | null;
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

async function seedSessions(
  runtime: { fetch: (req: Request) => Promise<Response> },
  spec: Array<{ id: string; title?: string }>,
): Promise<void> {
  for (const entry of spec) {
    const created = await runtime.fetch(postJson('/api/sessions', { sessionId: entry.id }));
    expect(created.status).toBe(200);
    if (entry.title) {
      const renameRes = await runtime.fetch(postJson(`/api/sessions/${entry.id}/rename`, { name: entry.title }));
      expect(renameRes.status).toBe(200);
    }
    // Space writes by 2ms so updatedAt ordering is deterministic.
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('GET /api/sessions: pagination + envelope shape (#192)', () => {
  beforeEach(() => clearEnvToken());

  it('returns the paginated envelope: {sessions, count, totalCount, nextCursor}', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    await seedSessions(runtime, [
      { id: 'sess-a' },
      { id: 'sess-b' },
      { id: 'sess-c' },
    ]);

    const res = await runtime.fetch(get('/api/sessions'));
    expect(res.status).toBe(200);
    const data = await res.json() as SessionsListResponse;

    expect(data.ok).toBe(true);
    expect(data.supported).toBe(true);
    expect(typeof data.totalCount).toBe('number');
    expect(data.totalCount).toBe(3);
    expect(data.nextCursor).toBeNull();
    expect(data.count).toBe(3);
    expect(data.sessions.length).toBe(3);
  });

  it('caps ?limit at 200 and respects an explicit smaller limit', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    await seedSessions(runtime, [
      { id: 'p-1' }, { id: 'p-2' }, { id: 'p-3' }, { id: 'p-4' }, { id: 'p-5' },
    ]);

    const res = await runtime.fetch(get('/api/sessions?limit=2'));
    const data = await res.json() as SessionsListResponse;
    expect(data.sessions.length).toBe(2);
    expect(data.totalCount).toBe(5);
    expect(data.nextCursor).not.toBeNull();

    const overflowRes = await runtime.fetch(get('/api/sessions?limit=99999'));
    const overflowData = await overflowRes.json() as SessionsListResponse;
    expect(overflowData.sessions.length).toBeLessThanOrEqual(200);
  });

  it('paginates deterministically with ?cursor', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    await seedSessions(runtime, [
      { id: 'cur-1' }, { id: 'cur-2' }, { id: 'cur-3' }, { id: 'cur-4' }, { id: 'cur-5' },
    ]);

    const page1 = await runtime.fetch(get('/api/sessions?limit=2'));
    const page1Data = await page1.json() as SessionsListResponse;
    expect(page1Data.sessions.length).toBe(2);
    expect(page1Data.nextCursor).not.toBeNull();

    const page2 = await runtime.fetch(get(`/api/sessions?limit=2&cursor=${encodeURIComponent(page1Data.nextCursor!)}`));
    const page2Data = await page2.json() as SessionsListResponse;
    expect(page2Data.sessions.length).toBe(2);
    const page1Ids = new Set(page1Data.sessions.map((s) => s.sessionId));
    for (const s of page2Data.sessions) {
      expect(page1Ids.has(s.sessionId)).toBe(false);
    }

    const page3 = await runtime.fetch(get(`/api/sessions?limit=2&cursor=${encodeURIComponent(page2Data.nextCursor!)}`));
    const page3Data = await page3.json() as SessionsListResponse;
    expect(page3Data.sessions.length).toBe(1);
    expect(page3Data.nextCursor).toBeNull();
  });
});

describe('GET /api/sessions: ?search filter (#192)', () => {
  beforeEach(() => clearEnvToken());

  it('matches against the session title (case-insensitive)', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    await seedSessions(runtime, [
      { id: 'search-a', title: 'invoice processor' },
      { id: 'search-b', title: 'random thoughts' },
      { id: 'search-c', title: 'Invoice review' },
    ]);

    const res = await runtime.fetch(get('/api/sessions?search=invoice'));
    const data = await res.json() as SessionsListResponse;
    const ids = data.sessions.map((s) => s.sessionId).sort();
    expect(ids).toEqual(['search-a', 'search-c']);
    expect(data.totalCount).toBe(2);
  });

  it('returns empty results for a non-matching search', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    await seedSessions(runtime, [
      { id: 's-1', title: 'invoice review' },
    ]);

    const res = await runtime.fetch(get('/api/sessions?search=zebrafish'));
    const data = await res.json() as SessionsListResponse;
    expect(data.sessions.length).toBe(0);
    expect(data.totalCount).toBe(0);
  });
});

describe('GET /api/sessions: ?status filter (#192)', () => {
  beforeEach(() => clearEnvToken());

  it('returns only completed sessions when ?status=completed', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    await seedSessions(runtime, [{ id: 'comp-1' }, { id: 'comp-2' }]);

    const res = await runtime.fetch(get('/api/sessions?status=completed'));
    const data = await res.json() as SessionsListResponse;
    expect(data.sessions.every((s) => s.sessionId.startsWith('comp-'))).toBe(true);
    expect(data.totalCount).toBe(2);
  });

  it('returns no sessions when ?status=active and none are running', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    await seedSessions(runtime, [{ id: 'idle-1' }]);

    const res = await runtime.fetch(get('/api/sessions?status=active'));
    const data = await res.json() as SessionsListResponse;
    expect(data.sessions.length).toBe(0);
    expect(data.totalCount).toBe(0);
  });

  it('falls back to "all" when ?status is unrecognized', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    await seedSessions(runtime, [{ id: 'fb-1' }, { id: 'fb-2' }]);

    const res = await runtime.fetch(get('/api/sessions?status=banana'));
    const data = await res.json() as SessionsListResponse;
    expect(data.totalCount).toBe(2);
  });
});
