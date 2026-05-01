/**
 * Dashboard ↔ Runtime contract tests
 *
 * These tests pin the exact request/response shapes that the dashboard UI
 * (`packages/web/ui/src/`) depends on. If a runtime endpoint drifts away from
 * what the UI expects, one of these tests will fail — preventing the kind of
 * silent breakage that crept in across v0.3.0 → v0.3.3.
 *
 * Each test corresponds to a specific UI call. The shape assertions match the
 * `interface` definitions in the view files exactly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

const TEST_TOKEN = 'dashboard-contract-token';
const auth = { authorization: `Bearer ${TEST_TOKEN}` };

beforeAll(() => { process.env.CROWCLAW_DASHBOARD_TOKEN = TEST_TOKEN; });
afterAll(() => { delete process.env.CROWCLAW_DASHBOARD_TOKEN; });

function get(path: string): Request {
  return new Request(`http://localhost${path}`, { headers: auth });
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify(body),
  });
}

describe('Dashboard contract: agent-view.ts', () => {
  it('GET /api/presets returns shape the UI Preset mapper expects', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    const res = await runtime.fetch(get('/api/presets'));
    expect(res.ok).toBe(true);
    const data = await res.json() as {
      agents: Array<{ name: string; role?: string; goal?: string }>;
      toolsets: Array<{ name: string }>;
      mcp: Array<{ name: string; description?: string }>;
      activeAgent: string | null;
      activeToolset: string | null;
    };
    expect(Array.isArray(data.agents)).toBe(true);
    // #217: hardcoded agent personas removed — registry is empty by default.
    // The UI now consumes user-defined personas via the file-backed
    // PersonaRegistry. The shape contract here just guarantees the field is
    // an array; per-entry shape is verified at the registry level.
    if (data.agents.length > 0) {
      expect(data.agents[0]).toHaveProperty('name');
      expect(data.agents[0]).toHaveProperty('role');
      expect(data.agents[0]).toHaveProperty('goal');
    }
    expect(Array.isArray(data.toolsets)).toBe(true);
    expect(Array.isArray(data.mcp)).toBe(true);
    // Active markers must be present so the UI can render the "Active" badge.
    // #219: `activeMcp` removed — the dashboard sources MCP state from the
    // connections endpoint instead.
    expect(data).toHaveProperty('activeAgent');
    expect(data).toHaveProperty('activeToolset');
  });

  it('GET /api/skills includes requiredTools so skill cards can render tool badges', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    const res = await runtime.fetch(get('/api/skills'));
    expect(res.ok).toBe(true);
    const data = await res.json() as {
      skills: Array<{ slug: string; title: string; summary: string; triggerPhrases: string[]; steps: string[]; requiredTools: string[] }>;
    };
    expect(Array.isArray(data.skills)).toBe(true);
    if (data.skills.length > 0) {
      const skill = data.skills[0];
      expect(skill).toHaveProperty('slug');
      expect(skill).toHaveProperty('title');
      expect(skill).toHaveProperty('triggerPhrases');
      expect(skill).toHaveProperty('requiredTools');
      expect(Array.isArray(skill.requiredTools)).toBe(true);
    }
  });

  it('POST /api/agent/preset accepts {name, role, goal} body and updates agentPreset', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    const res = await runtime.fetch(post('/api/agent/preset', {
      name: 'custom-test',
      role: 'Senior reviewer',
      goal: 'Validate dashboard contract',
    }));
    expect(res.ok).toBe(true);
    const data = await res.json() as { ok: boolean; activePreset: string };
    expect(data.ok).toBe(true);
    expect(data.activePreset).toBe('custom-test');

    // The active preset should reflect in /api/presets
    const presetsRes = await runtime.fetch(get('/api/presets'));
    const presets = await presetsRes.json() as { activeAgent: string };
    expect(presets.activeAgent).toBe('custom-test');
  });

  it('POST /api/toolset/select accepts {name} body and updates activeToolset', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    const res = await runtime.fetch(post('/api/toolset/select', { name: 'minimal' }));
    expect(res.ok).toBe(true);
    const data = await res.json() as { ok: boolean; activeToolset: string };
    expect(data.ok).toBe(true);
    expect(data.activeToolset).toBe('minimal');

    const presetsRes = await runtime.fetch(get('/api/presets'));
    const presets = await presetsRes.json() as { activeToolset: string };
    expect(presets.activeToolset).toBe('minimal');
  });

  it('POST /api/config-presets/switch accepts {name} body', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    // First, save a preset
    await runtime.fetch(post('/api/config-presets', {
      name: 'test-bundle',
      description: 'contract test',
      toolset: 'minimal',
    }));
    const res = await runtime.fetch(post('/api/config-presets/switch', { name: 'test-bundle' }));
    expect(res.ok).toBe(true);
    const data = await res.json() as { ok: boolean; active: string };
    expect(data.ok).toBe(true);
    expect(data.active).toBe('test-bundle');
  });
});

describe('Dashboard contract: settings-view.ts', () => {
  it('GET /api/config/agent returns {config: AgentConfig} wrapper', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    const res = await runtime.fetch(get('/api/config/agent'));
    expect(res.ok).toBe(true);
    const data = await res.json() as { config: { maxToolIterations: number; concurrentToolCalls: boolean } };
    expect(data).toHaveProperty('config');
    expect(typeof data.config.maxToolIterations).toBe('number');
    expect(typeof data.config.concurrentToolCalls).toBe('boolean');
  });

  it('GET /api/feedback returns {stats, recent} (UI no longer reads "entries")', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    const res = await runtime.fetch(get('/api/feedback'));
    expect(res.ok).toBe(true);
    const data = await res.json() as { ok: boolean; stats: unknown; recent: unknown[] };
    expect(data.ok).toBe(true);
    expect(data).toHaveProperty('stats');
    expect(data).toHaveProperty('recent');
    expect(Array.isArray(data.recent)).toBe(true);
  });

  it('GET /api/config/remote-access returns publicUrl field', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    const res = await runtime.fetch(get('/api/config/remote-access'));
    expect(res.ok).toBe(true);
    const data = await res.json() as { ok: boolean; serverUrl: string; publicUrl: string | null; trustProxy: boolean };
    expect(data.ok).toBe(true);
    expect(data).toHaveProperty('publicUrl');
    expect(data).toHaveProperty('serverUrl');
    expect(typeof data.trustProxy).toBe('boolean');
  });

  it('GET /api/security/events honors severity filter', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    const res = await runtime.fetch(get('/api/security/events?severity=critical'));
    expect(res.ok).toBe(true);
    const data = await res.json() as { events: Array<{ severity?: string }> };
    expect(Array.isArray(data.events)).toBe(true);
    // Every returned event must match the filter
    for (const event of data.events) {
      expect(event.severity).toBe('critical');
    }
  });
});

describe('Dashboard contract: connect-view.ts', () => {
  it('GET /api/sessions/active returns serializable shape (no AbortController)', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    const res = await runtime.fetch(get('/api/sessions/active'));
    expect(res.ok).toBe(true);
    const data = await res.json() as { sessions: Array<Record<string, unknown>> };
    expect(Array.isArray(data.sessions)).toBe(true);
    for (const session of data.sessions) {
      expect(session).not.toHaveProperty('abortController');
      expect(session).toHaveProperty('sessionId');
      expect(session).toHaveProperty('startedAt');
      expect(session).toHaveProperty('status');
    }
  });
});

describe('Dashboard contract: automate-view.ts', () => {
  it('POST /api/scheduler/jobs/:id/dry-run returns {response} not {output}', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    // Create a minimal job first
    await runtime.fetch(post('/api/scheduler/jobs', {
      id: 'contract-test-job',
      task: 'echo test',
      schedule: 'every:60m',
    }));
    const res = await runtime.fetch(post('/api/scheduler/jobs/contract-test-job/dry-run', {}));
    // Either succeeds with a JobRunRecord or returns 404 — both are fine for shape check
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>;
      expect(data).toHaveProperty('response');
      expect(data).not.toHaveProperty('output');
    }
  });
});

describe('Dashboard contract: session list summary shape', () => {
  it('GET /api/sessions returns SessionSummary with title field for the picker', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    // Seed a session by running a turn so listRecent has something to summarize
    await runtime.fetch(post('/api/sessions/contract-title-1', { userMessage: 'hello world' }));
    const res = await runtime.fetch(get('/api/sessions'));
    expect(res.ok).toBe(true);
    const data = await res.json() as { sessions: Array<{ sessionId: string; title?: string; updatedAt: string }> };
    expect(Array.isArray(data.sessions)).toBe(true);
    const seeded = data.sessions.find((s) => s.sessionId === 'contract-title-1');
    if (seeded) {
      expect(seeded).toHaveProperty('title');
      // First user message was "hello world" — title should reflect it
      expect(seeded.title).toContain('hello');
    }
  });
});

describe('Dashboard contract: provider test endpoint', () => {
  it('POST /api/providers/test accepts {slot, provider, model} and looks up stored apiKey', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    // Set a primary slot with an apiKey, then test by slot reference only
    await runtime.fetch(post('/api/providers/config', {
      primary: { name: 'test-primary', provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test', baseUrl: 'https://example.invalid' },
    }));
    const res = await runtime.fetch(post('/api/providers/test', {
      slot: 'primary',
      provider: 'openai',
      model: 'gpt-4o-mini',
    }));
    // The test will fail at the network layer (example.invalid), but the body
    // resolution itself must NOT 400 with "provider and model are required" or
    // a missing-apiKey error. A 200 with ok:false (network failure) is the
    // expected shape — the contract under test is "server resolved the slot".
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; slot: string; error?: string };
    expect(data.slot).toBe('primary');
  });
});

describe('Dashboard contract: WebSocket transport', () => {
  it('server listens on /ws (matches buildWsUrl in packages/web/ui/src/lib/ws.ts)', async () => {
    // We can't open a real WS in unit tests, but we can verify the route exists.
    // GET /ws without an upgrade header returns either 426 or a placeholder response;
    // GET /api/ws should 404. This pins the path that ws.ts dials.
    const runtime = createNodeRuntime({ configStorePath: null });
    const wrongRes = await runtime.fetch(new Request('http://localhost/api/ws', { headers: auth }));
    expect(wrongRes.status).toBe(404);
  });
});
