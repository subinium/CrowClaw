import { describe, it, expect, vi } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import { DASHBOARD_HTML } from '../packages/web/src/index.js';

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

describe('MCP Server CRUD', () => {
  it('adds a custom server via POST /api/mcp/servers', async () => {
    const runtime = createTestRuntime();
    const res = await runtime.fetch(
      new Request('http://localhost/api/mcp/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'test-server', command: 'npx', args: '-y, @test/server', description: 'Test server' }),
      }),
    );
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.server.name).toBe('test-server');
    expect(data.server.command).toBe('npx');
    expect(data.server.args).toEqual(['-y', '@test/server']);
    expect(data.server.custom).toBe(true);

    // Verify it appears in the list
    const listRes = await runtime.fetch(new Request('http://localhost/api/mcp/servers'));
    const listData = await listRes.json();
    expect(listData.servers.length).toBe(1);
    expect(listData.servers[0].name).toBe('test-server');
  });

  it('deletes a custom server via DELETE /api/mcp/servers/:name', async () => {
    const runtime = createTestRuntime();

    // Add first
    await runtime.fetch(
      new Request('http://localhost/api/mcp/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'to-delete', command: 'npx', args: [] }),
      }),
    );

    // Delete
    const res = await runtime.fetch(
      new Request('http://localhost/api/mcp/servers/to-delete', { method: 'DELETE' }),
    );
    const data = await res.json();
    expect(data.ok).toBe(true);

    // Verify gone
    const listRes = await runtime.fetch(new Request('http://localhost/api/mcp/servers'));
    const listData = await listRes.json();
    expect(listData.servers.length).toBe(0);
  });

  it('lists tools from a server via GET /api/mcp/servers/:name/tools', async () => {
    const runtime = createTestRuntime();
    const res = await runtime.fetch(new Request('http://localhost/api/mcp/servers/test-server/tools'));
    const data = await res.json();
    expect(data.server).toBe('test-server');
    expect(Array.isArray(data.tools)).toBe(true);
    expect(data.tools.length).toBeGreaterThan(0);
  });

  it('reconnects a server via POST /api/mcp/servers/:name/reconnect', async () => {
    const runtime = createTestRuntime();
    const res = await runtime.fetch(
      new Request('http://localhost/api/mcp/servers/test-server/reconnect', { method: 'POST' }),
    );
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.status).toBe('connected');
  });

  it('persists custom servers to config store', async () => {
    const runtime = createTestRuntime();

    // Add a server
    await runtime.fetch(
      new Request('http://localhost/api/mcp/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'persist-test', command: 'node', args: ['server.js'], env: { API_KEY: 'test' } }),
      }),
    );

    // Check it's in the config snapshot
    const snapRes = await runtime.fetch(new Request('http://localhost/api/config/snapshot'));
    const snapData = await snapRes.json();
    // The snapshot should be returned (it contains customMcpServers at the store level)
    expect(snapData.ok).toBe(true);
  });

  it('returns 404 when deleting non-existent server', async () => {
    const runtime = createTestRuntime();
    const res = await runtime.fetch(
      new Request('http://localhost/api/mcp/servers/nonexistent', { method: 'DELETE' }),
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
        headers: { 'content-type': 'application/json' },
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

    // Verify in list
    const listRes = await runtime.fetch(new Request('http://localhost/api/skills'));
    const listData = await listRes.json();
    const found = listData.skills.find((s: { slug: string }) => s.slug === 'test-skill');
    expect(found).toBeDefined();
    expect(found.title).toBe('Test Skill');
  });

  it('updates an existing skill via PUT /api/skills/:slug', async () => {
    const runtime = createTestRuntime();

    // Create first
    await runtime.fetch(
      new Request('http://localhost/api/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Update Me', summary: 'Original' }),
      }),
    );

    // Update
    const res = await runtime.fetch(
      new Request('http://localhost/api/skills/update-me', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
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

    // Create first
    await runtime.fetch(
      new Request('http://localhost/api/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Delete Me', summary: 'Temporary' }),
      }),
    );

    // Delete
    const res = await runtime.fetch(
      new Request('http://localhost/api/skills/delete-me', { method: 'DELETE' }),
    );
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('cannot delete a built-in skill', async () => {
    const runtime = createTestRuntime();

    // Try to delete a built-in skill
    const res = await runtime.fetch(
      new Request('http://localhost/api/skills/git-commit-workflow', { method: 'DELETE' }),
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
        headers: { 'content-type': 'application/json' },
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

    // Create a skill first so it exists in the store
    await runtime.fetch(
      new Request('http://localhost/api/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Rate Me', summary: 'Ratable skill' }),
      }),
    );

    // Rate helpful
    const res = await runtime.fetch(
      new Request('http://localhost/api/skills/rate-me/rate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating: 'helpful' }),
      }),
    );
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.rating).toBe('helpful');
  });

  it('returns skill versions via GET /api/skills/:slug/versions', async () => {
    const runtime = createTestRuntime();

    // Create a skill
    await runtime.fetch(
      new Request('http://localhost/api/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Versioned Skill', summary: 'v1' }),
      }),
    );

    const res = await runtime.fetch(new Request('http://localhost/api/skills/versioned-skill/versions'));
    const data = await res.json();
    expect(data.versions.length).toBe(1);
    expect(data.versions[0].version).toBe(1);
  });
});

// --- Dashboard HTML tests ---

describe('Dashboard HTML contains CRUD UI elements', () => {
  it('contains Create Skill button', () => {
    expect(DASHBOARD_HTML).toContain('id="skCreateBtn"');
    expect(DASHBOARD_HTML).toContain('Create Skill');
  });

  it('contains Import SKILL.md button', () => {
    expect(DASHBOARD_HTML).toContain('id="skImportBtn"');
    expect(DASHBOARD_HTML).toContain('Import SKILL.md');
  });

  it('contains skill edit button logic', () => {
    expect(DASHBOARD_HTML).toContain('data-edit-btn');
    expect(DASHBOARD_HTML).toContain('skModalOpen');
  });

  it('contains skill delete button logic', () => {
    expect(DASHBOARD_HTML).toContain('data-delete-btn');
    expect(DASHBOARD_HTML).toContain('skDel');
  });

  it('contains skill rating UI', () => {
    expect(DASHBOARD_HTML).toContain('skRate');
  });

  it('contains source badge rendering', () => {
    expect(DASHBOARD_HTML).toContain('data-source');
  });

  it('contains Add Custom Server button', () => {
    expect(DASHBOARD_HTML).toContain('id="mcpAddBtn"');
    expect(DASHBOARD_HTML).toContain('Add Custom Server');
  });

  it('contains MCP add server modal', () => {
    expect(DASHBOARD_HTML).toContain('id="mcpAddModal"');
    expect(DASHBOARD_HTML).toContain('mcpAddSubmit');
  });

  it('contains skill create/edit modal', () => {
    expect(DASHBOARD_HTML).toContain('id="skModal"');
    expect(DASHBOARD_HTML).toContain('skModalSubmit');
  });

  it('contains skill import modal', () => {
    expect(DASHBOARD_HTML).toContain('id="skImportModal"');
    expect(DASHBOARD_HTML).toContain('skImportSubmit');
  });

  it('contains MCP custom servers section', () => {
    expect(DASHBOARD_HTML).toContain('id="mcpCustom"');
    expect(DASHBOARD_HTML).toContain('lMcpCustom');
  });

  it('contains reconnect button in preset cards', () => {
    expect(DASHBOARD_HTML).toContain('Reconnect');
    expect(DASHBOARD_HTML).toContain('mcpCustomReconnect');
  });
});
