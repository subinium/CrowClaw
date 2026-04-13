import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import { DASHBOARD_HTML } from '../packages/web/src/index.js';

// MCP server CRUD routes are dangerous — require auth token
const TEST_TOKEN = 'test-mcp-crud-token';
beforeAll(() => { process.env.CROWCLAW_DASHBOARD_TOKEN = TEST_TOKEN; });
afterAll(() => { delete process.env.CROWCLAW_DASHBOARD_TOKEN; });

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() })),
}));

function createTestRuntime() {
  const tools = [
    { name: 'search', originalName: 'search', registeredName: 'search', description: 'Search the web', inputSchema: { type: 'object' } },
  ];
  return createNodeRuntime({
    mcpClient: {
      listTools: async () => tools,
      listResources: async () => [],
      listPrompts: async () => [],
      getStatus: () => ({
        toolsRevision: 0,
        cachedTools: 1,
        supportsResources: true,
        supportsPrompts: true,
        degraded: false,
        lastError: undefined,
        lastRefreshAt: undefined,
      }),
      refreshTools: async () => tools,
      notifyToolsChanged: async () => ({ ok: true, refreshed: tools }),
      callTool: async (name: string, args: Record<string, unknown>) => ({ ok: true, content: { name, args } }),
      inspect: async () => ({
        status: { toolsRevision: 0, cachedTools: 1, supportsResources: true, supportsPrompts: true, degraded: false },
        tools,
        resources: [],
        prompts: [],
      }),
      verify: async () => ({ ok: true, toolCount: 1, latencyMs: 10 }),
    } as never,
    configStorePath: null,
  });
}

// --- MCP CRUD tests ---

const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };

describe('MCP Server CRUD', () => {
  it('adds a custom server via POST /api/mcp/servers', async () => {
    const runtime = createTestRuntime();
    const res = await runtime.fetch(
      new Request('http://localhost/api/mcp/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({ name: 'test-server', command: 'npx', args: '-y, @test/server', description: 'Test server' }),
      }),
    );
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.server.name).toBe('test-server');
    expect(data.server.command).toBe('npx');
    expect(data.server.args).toEqual(['-y', '@test/server']);
    expect(data.server.custom).toBe(true);

    const listRes = await runtime.fetch(new Request('http://localhost/api/mcp/servers', { headers: authHeaders }));
    const listData = await listRes.json();
    expect(listData.servers.length).toBe(1);
    expect(listData.servers[0].name).toBe('test-server');
  });

  it('deletes a custom server via DELETE /api/mcp/servers/:name', async () => {
    const runtime = createTestRuntime();

    await runtime.fetch(
      new Request('http://localhost/api/mcp/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({ name: 'to-delete', command: 'npx', args: [] }),
      }),
    );

    const res = await runtime.fetch(
      new Request('http://localhost/api/mcp/servers/to-delete', { method: 'DELETE', headers: authHeaders }),
    );
    const data = await res.json();
    expect(data.ok).toBe(true);

    const listRes = await runtime.fetch(new Request('http://localhost/api/mcp/servers', { headers: authHeaders }));
    const listData = await listRes.json();
    expect(listData.servers.length).toBe(0);
  });

  it('lists tools from a server via GET /api/mcp/servers/:name/tools', async () => {
    const runtime = createTestRuntime();
    const res = await runtime.fetch(new Request('http://localhost/api/mcp/servers/test-server/tools', { headers: authHeaders }));
    const data = await res.json();
    expect(data.server).toBe('test-server');
    expect(Array.isArray(data.tools)).toBe(true);
    expect(data.tools.length).toBeGreaterThan(0);
  });

  it('reconnects a server via POST /api/mcp/servers/:name/reconnect', async () => {
    const runtime = createTestRuntime();
    const res = await runtime.fetch(
      new Request('http://localhost/api/mcp/servers/test-server/reconnect', { method: 'POST', headers: authHeaders }),
    );
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.status).toBe('connected');
  });

  it('persists custom servers to config store', async () => {
    const runtime = createTestRuntime();

    await runtime.fetch(
      new Request('http://localhost/api/mcp/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({ name: 'persist-test', command: 'node', args: ['server.js'], env: { API_KEY: 'test' } }),
      }),
    );

    const snapRes = await runtime.fetch(new Request('http://localhost/api/config/snapshot', { headers: authHeaders }));
    const snapData = await snapRes.json();
    expect(snapData.ok).toBe(true);
  });

  it('returns 404 when deleting non-existent server', async () => {
    const runtime = createTestRuntime();
    const res = await runtime.fetch(
      new Request('http://localhost/api/mcp/servers/nonexistent', { method: 'DELETE', headers: authHeaders }),
    );
    expect(res.status).toBe(404);
  });
});

// --- Skill CRUD tests ---

describe('Skill CRUD', () => {
  it('creates a skill via POST /api/skills', async () => {
    const runtime = createTestRuntime();
    const res = await runtime.fetch(
      new Request('http://localhost/api/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          title: 'Test Skill',
          summary: 'A test skill',
          triggerPhrases: ['test this', 'run test'],
          steps: ['Step 1', 'Step 2'],
          requiredTools: ['workspace.read'],
        }),
      }),
    );
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.skill.title).toBe('Test Skill');
    expect(data.skill.slug).toBe('test-skill');
    expect(data.skill.status).toBe('published');

    const listRes = await runtime.fetch(new Request('http://localhost/api/skills', { headers: authHeaders }));
    const listData = await listRes.json();
    const found = listData.skills.find((s: { slug: string }) => s.slug === 'test-skill');
    expect(found).toBeDefined();
    expect(found.title).toBe('Test Skill');
  });

  it('updates an existing skill via PUT /api/skills/:slug', async () => {
    const runtime = createTestRuntime();

    await runtime.fetch(
      new Request('http://localhost/api/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({ title: 'Update Me', summary: 'Original' }),
      }),
    );

    const res = await runtime.fetch(
      new Request('http://localhost/api/skills/update-me', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({ summary: 'Updated summary', steps: ['New step'] }),
      }),
    );
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.skill.summary).toBe('Updated summary');
    expect(data.skill.version).toBe(2);
  });

  it('deletes a learned/custom skill via DELETE /api/skills/:slug', async () => {
    const runtime = createTestRuntime();

    await runtime.fetch(
      new Request('http://localhost/api/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({ title: 'Delete Me', summary: 'Temporary' }),
      }),
    );

    const res = await runtime.fetch(
      new Request('http://localhost/api/skills/delete-me', { method: 'DELETE', headers: authHeaders }),
    );
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('cannot delete a built-in skill', async () => {
    const runtime = createTestRuntime();

    const res = await runtime.fetch(
      new Request('http://localhost/api/skills/git-commit-workflow', { method: 'DELETE', headers: authHeaders }),
    );
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toContain('built-in');
  });

  it('imports from SKILL.md format via POST /api/skills/import', async () => {
    const runtime = createTestRuntime();
    const markdown = `# My Imported Skill

## Summary
This skill does something useful.

## Trigger phrases
- do the thing
- run the process

## Steps
1. First step
2. Second step
3. Third step`;

    const res = await runtime.fetch(
      new Request('http://localhost/api/skills/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({ markdown }),
      }),
    );
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.skill.title).toBe('My Imported Skill');
    expect(data.skill.triggerPhrases).toContain('do the thing');
    expect(data.skill.steps.length).toBe(3);
  });

  it('rates a skill via POST /api/skills/:slug/rate', async () => {
    const runtime = createTestRuntime();

    await runtime.fetch(
      new Request('http://localhost/api/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({ title: 'Rate Me', summary: 'Ratable skill' }),
      }),
    );

    const res = await runtime.fetch(
      new Request('http://localhost/api/skills/rate-me/rate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({ rating: 'helpful' }),
      }),
    );
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.rating).toBe('helpful');
  });

  it('returns skill versions via GET /api/skills/:slug/versions', async () => {
    const runtime = createTestRuntime();

    await runtime.fetch(
      new Request('http://localhost/api/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({ title: 'Versioned Skill', summary: 'v1' }),
      }),
    );

    const res = await runtime.fetch(new Request('http://localhost/api/skills/versioned-skill/versions', { headers: authHeaders }));
    const data = await res.json();
    expect(data.versions.length).toBe(1);
    expect(data.versions[0].version).toBe(1);
  });
});

// --- Dashboard HTML tests ---

describe('Dashboard HTML contains CRUD UI elements', () => {
  it('contains Create Skill text', () => {
    expect(DASHBOARD_HTML).toContain('Create Skill');
  });

  it('contains Import text for skills', () => {
    expect(DASHBOARD_HTML).toContain('Import');
  });

  it('contains skill management in crowclaw-agent-view', () => {
    expect(DASHBOARD_HTML).toContain('crowclaw-agent-view');
  });

  it('contains skills API endpoint', () => {
    expect(DASHBOARD_HTML).toContain('/api/skills');
  });

  it('contains Delete action for skills', () => {
    expect(DASHBOARD_HTML).toContain('Delete');
  });

  it('contains crowclaw-modal for skill operations', () => {
    expect(DASHBOARD_HTML).toContain('crowclaw-modal');
  });

  it('contains MCP servers API endpoint', () => {
    expect(DASHBOARD_HTML).toContain('/api/mcp/servers');
  });

  it('contains crowclaw-connect-view for MCP management', () => {
    expect(DASHBOARD_HTML).toContain('crowclaw-connect-view');
  });

  it('contains MCP status API endpoint', () => {
    expect(DASHBOARD_HTML).toContain('/api/mcp/servers');
  });

  it('contains tools API endpoint', () => {
    expect(DASHBOARD_HTML).toContain('/api/tools');
  });

  it('contains MCP section in connect view', () => {
    expect(DASHBOARD_HTML).toContain('MCP');
  });

  it('contains reconnect functionality', () => {
    expect(DASHBOARD_HTML).toContain('reconnect');
  });
});
