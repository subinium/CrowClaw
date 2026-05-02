/**
 * E2E: Dashboard API — cross-subsystem integration
 *
 * Tests all major API endpoints exposed by createNodeRuntime(), verifying
 * that different subsystems (capabilities, usage, personas, scheduler,
 * auth, skills) respond correctly through the HTTP surface.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

// Clear any leaked CROWCLAW_DASHBOARD_TOKEN between tests
function clearEnvToken(): void {
  const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
  if (proc?.env) {
    delete proc.env.CROWCLAW_DASHBOARD_TOKEN;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function json(url: string, body?: unknown, method?: string): Request {
  if (body === undefined) {
    return new Request(url, { method: method ?? 'GET' });
  }
  return new Request(url, {
    method: method ?? 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function get(path: string): Request {
  return new Request(`http://localhost${path}`);
}

function post(path: string, body?: unknown): Request {
  return json(`http://localhost${path}`, body ?? {}, 'POST');
}

// ============================================================================
// 1. GET /api/capabilities
// ============================================================================

describe('E2E dashboard: capabilities endpoint', () => {
  it('returns all expected capability keys', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });

    const res = await runtime.fetch(get('/api/capabilities'));
    expect(res.status).toBe(200);

    const data = await res.json() as Record<string, unknown>;

    // Should have these top-level keys
    const expectedKeys = [
      'provider', 'chat', 'streaming', 'tools', 'memory',
      'skills', 'scheduler', 'gateway', 'mcp', 'browser', 'workspace',
    ];
    for (const key of expectedKeys) {
      expect(data).toHaveProperty(key);
    }

    // Each capability should have a status field
    for (const key of expectedKeys) {
      const cap = data[key] as { status: string };
      expect(typeof cap.status).toBe('string');
    }
  });

  it('tools capability reports registered tool count', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });

    const res = await runtime.fetch(get('/api/capabilities'));
    const data = await res.json() as { tools: { status: string; detail: string } };

    expect(data.tools.status).toBe('live');
    expect(data.tools.detail).toMatch(/\d+ registered/);
  });
});

// ============================================================================
// 2. GET /api/usage + POST /api/usage/reset
// ============================================================================

describe('E2E dashboard: usage endpoints', () => {
  it('GET /api/usage returns usage summary structure', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });

    const res = await runtime.fetch(get('/api/usage'));
    expect(res.status).toBe(200);

    const data = await res.json() as {
      totalTokens: number;
      totalCostUsd: number;
      totalInputTokens: number;
      totalOutputTokens: number;
    };

    expect(typeof data.totalTokens).toBe('number');
    expect(typeof data.totalCostUsd).toBe('number');
    expect(typeof data.totalInputTokens).toBe('number');
    expect(typeof data.totalOutputTokens).toBe('number');
  });

  it('POST /api/usage/reset clears usage data', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });

    const resetRes = await runtime.fetch(post('/api/usage/reset'));
    expect(resetRes.status).toBe(200);

    const resetData = await resetRes.json() as { ok: boolean };
    expect(resetData.ok).toBe(true);

    // After reset, usage should be zero
    const usageRes = await runtime.fetch(get('/api/usage'));
    const usageData = await usageRes.json() as { totalTokens: number };
    expect(usageData.totalTokens).toBe(0);
  });
});

describe('E2E dashboard: memory edit and pin endpoints', () => {
  it('updates, pins, and unpins a remembered memory', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    const rememberedRes = await runtime.fetch(post('/api/sessions/memory-ux/remember', {
      summary: 'initial memory summary',
      tags: ['dashboard'],
    }));
    expect(rememberedRes.status).toBe(200);
    const remembered = await rememberedRes.json() as { id: string };

    const updateRes = await runtime.fetch(new Request(`http://localhost/api/memories/${remembered.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary: 'edited memory summary', tags: ['dashboard', 'edited'] }),
    }));
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json() as { record: { summary: string; metadata?: Record<string, unknown> } };
    expect(updated.record.summary).toBe('edited memory summary');
    expect(typeof updated.record.metadata?.sizeBytes).toBe('number');

    const pinRes = await runtime.fetch(post(`/api/memories/${remembered.id}/pin`, { pinned: true }));
    expect(pinRes.status).toBe(200);
    const pinned = await pinRes.json() as { record: { metadata?: Record<string, unknown> } };
    expect(pinned.record.metadata?.pinned).toBe(true);
  });
});

// ============================================================================
// 3. GET /api/personas + POST /api/persona/switch
// ============================================================================

describe('E2E dashboard: persona endpoints', () => {
  it('GET /api/personas returns array', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });

    const res = await runtime.fetch(get('/api/personas'));
    expect(res.status).toBe(200);

    const data = await res.json() as { personas: unknown[] };
    expect(Array.isArray(data.personas)).toBe(true);
  });

  it('GET /api/persona/active returns the current active persona', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });

    const res = await runtime.fetch(get('/api/persona/active'));
    expect(res.status).toBe(200);

    const data = await res.json() as { name: string };
    expect(typeof data.name).toBe('string');
  });

  it('POST /api/persona/switch with invalid name returns error', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });

    const res = await runtime.fetch(post('/api/persona/switch', { name: 'nonexistent-persona-xyz' }));
    // Should return error status
    const data = await res.json() as { ok?: boolean; error?: string };
    expect(data.ok).toBe(false);
  });
});

// ============================================================================
// 4. Scheduler API endpoints
// ============================================================================

describe('E2E dashboard: scheduler endpoints', () => {
  it('GET /api/scheduler/status returns running state', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });

    const res = await runtime.fetch(get('/api/scheduler/status'));
    expect(res.status).toBe(200);

    const data = await res.json() as { running: boolean; interval: number };
    expect(typeof data.running).toBe('boolean');
    expect(typeof data.interval).toBe('number');
  });

  it('POST /api/scheduler/jobs/:id/pause and resume lifecycle', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });

    // Create a job first
    await runtime.fetch(
      json('http://localhost/api/scheduler/jobs', {
        id: 'pause-test-job',
        everyMinutes: 5,
        task: 'pause test task',
      }),
    );

    // Pause — returns the updated job object with enabled: false
    const pauseRes = await runtime.fetch(post('/api/scheduler/jobs/pause-test-job/pause'));
    expect(pauseRes.status).toBe(200);
    const pauseData = await pauseRes.json() as { id: string; enabled: boolean };
    expect(pauseData.id).toBe('pause-test-job');
    expect(pauseData.enabled).toBe(false);

    // Resume — returns the updated job object with enabled: true
    const resumeRes = await runtime.fetch(post('/api/scheduler/jobs/pause-test-job/resume'));
    expect(resumeRes.status).toBe(200);
    const resumeData = await resumeRes.json() as { id: string; enabled: boolean };
    expect(resumeData.id).toBe('pause-test-job');
    expect(resumeData.enabled).toBe(true);
  });

  it('GET /api/scheduler/jobs/:id/history returns array', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });

    // Create a job
    await runtime.fetch(
      json('http://localhost/api/scheduler/jobs', {
        id: 'history-test-job',
        everyMinutes: 5,
        task: 'history test',
      }),
    );

    const res = await runtime.fetch(get('/api/scheduler/jobs/history-test-job/history'));
    expect(res.status).toBe(200);

    const data = await res.json() as unknown[];
    expect(Array.isArray(data)).toBe(true);
  });

  it('scheduler start and stop lifecycle', async () => {
    const token = 'sched-test-token';
    (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process = {
      ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process,
      env: {
        ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env,
        CROWCLAW_DASHBOARD_TOKEN: token,
      },
    };
    const runtime = createNodeRuntime({ configStorePath: null });
    function authed(path: string, body?: unknown): Request {
      if (body !== undefined) {
        return new Request(`http://localhost${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
          body: JSON.stringify(body),
        });
      }
      return new Request(`http://localhost${path}`, { headers: { 'authorization': `Bearer ${token}` } });
    }

    // Start
    const startRes = await runtime.fetch(authed('/api/scheduler/start', {}));
    const startData = await startRes.json() as { ok: boolean; running: boolean };
    expect(startData.ok).toBe(true);
    expect(startData.running).toBe(true);

    // Verify status
    const statusRes = await runtime.fetch(authed('/api/scheduler/status'));
    const statusData = await statusRes.json() as { running: boolean };
    expect(statusData.running).toBe(true);

    // Stop
    const stopRes = await runtime.fetch(authed('/api/scheduler/stop', {}));
    const stopData = await stopRes.json() as { ok: boolean; running: boolean };
    expect(stopData.ok).toBe(true);
    expect(stopData.running).toBe(false);
  });
});

// ============================================================================
// 5. POST /api/auth/verify
// ============================================================================

describe('E2E dashboard: auth verify endpoint', () => {
  beforeEach(() => clearEnvToken());

  it('returns ok when no CROWCLAW_DASHBOARD_TOKEN is set (bypass mode)', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });

    const res = await runtime.fetch(post('/api/auth/verify', { token: 'anything' }));
    expect(res.status).toBe(200);

    const data = await res.json() as { ok: boolean; bypass?: boolean };
    expect(data.ok).toBe(true);
    expect(data.bypass).toBe(true);
  });
});

// ============================================================================
// 6. Skills API through runtime
// ============================================================================

describe('E2E dashboard: skills API', () => {
  beforeEach(() => clearEnvToken());
  it('GET /api/skills returns skills with stats', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });

    const res = await runtime.fetch(get('/api/skills'));
    expect(res.status).toBe(200);

    const data = await res.json() as {
      skills: Array<{ slug: string; source: string; enabled: boolean }>;
      count: number;
      stats: { builtin: number; learned: number; total: number };
    };

    expect(data.count).toBeGreaterThan(0);
    expect(data.skills.length).toBe(data.count);
    expect(data.stats).toBeDefined();
    expect(data.stats.builtin).toBeGreaterThanOrEqual(50);

    // All skills should have required fields
    for (const skill of data.skills) {
      expect(typeof skill.slug).toBe('string');
      expect(typeof skill.source).toBe('string');
      expect(typeof skill.enabled).toBe('boolean');
    }
  });

  it('skill toggle disables and re-enables via HTTP', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });

    // Disable
    await runtime.fetch(
      json('http://localhost/api/skills/git-commit-workflow/toggle', { enabled: false }),
    );

    // Verify disabled
    let res = await runtime.fetch(get('/api/skills'));
    let data = await res.json() as { skills: Array<{ slug: string; enabled: boolean }> };
    let skill = data.skills.find((s) => s.slug === 'git-commit-workflow');
    expect(skill?.enabled).toBe(false);

    // Re-enable
    await runtime.fetch(
      json('http://localhost/api/skills/git-commit-workflow/toggle', { enabled: true }),
    );

    // Verify enabled
    res = await runtime.fetch(get('/api/skills'));
    data = await res.json() as { skills: Array<{ slug: string; enabled: boolean }> };
    skill = data.skills.find((s) => s.slug === 'git-commit-workflow');
    expect(skill?.enabled).toBe(true);
  });
});

// ============================================================================
// 7. System health and version
// ============================================================================

describe('E2E dashboard: system endpoints', () => {
  beforeEach(() => clearEnvToken());
  it('GET /health returns ok', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });

    const res = await runtime.fetch(get('/health'));
    expect(res.status).toBe(200);

    const data = await res.json() as { ok: boolean };
    expect(data.ok).toBe(true);
  });

  it('GET /api/system/status returns deployment info', async () => {
    const runtime = createNodeRuntime({ configStorePath: null, deploymentName: 'e2e-dashboard' });

    const res = await runtime.fetch(get('/api/system/status'));
    expect(res.status).toBe(200);

    const data = await res.json() as { ok: boolean; deployment: string; runtime: string };
    expect(data.ok).toBe(true);
    expect(data.deployment).toBe('e2e-dashboard');
    expect(data.runtime).toBe('node');
  });
});

// ============================================================================
// 8. Learning drafts through runtime
// ============================================================================

describe('E2E dashboard: learning drafts API', () => {
  beforeEach(() => clearEnvToken());
  it('full draft lifecycle: create -> list -> publish -> verify in skills', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });

    // Create draft
    const createRes = await runtime.fetch(
      json('http://localhost/api/learning/drafts', {
        title: 'e2e-dashboard-skill',
        messages: [
          { role: 'user', content: 'build a dashboard' },
          { role: 'assistant', content: 'Dashboard built successfully. All done!' },
        ],
      }),
    );
    const draft = await createRes.json() as { id: string; slug: string; status: string };
    expect(draft.status).toBe('draft');

    // List drafts
    const listRes = await runtime.fetch(get('/api/learning/drafts'));
    const drafts = await listRes.json() as Array<{ slug: string }>;
    expect(drafts.some((d) => d.slug === 'e2e-dashboard-skill')).toBe(true);

    // Publish
    const publishRes = await runtime.fetch(
      post(`/api/learning/drafts/${draft.id}/publish`),
    );
    const published = await publishRes.json() as { status: string };
    expect(published.status).toBe('published');

    // Verify in skills
    const skillsRes = await runtime.fetch(get('/api/skills'));
    const skillsData = await skillsRes.json() as {
      skills: Array<{ slug: string; source: string }>;
    };
    const found = skillsData.skills.find((s) => s.slug === 'e2e-dashboard-skill');
    expect(found).toBeDefined();
    expect(found!.source).toBe('learned');
  });
});
