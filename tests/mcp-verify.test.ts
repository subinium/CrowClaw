import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  McpClient,
  type McpTransport,
  type McpToolDefinition,
  type McpResourceDefinition,
  type McpPromptDefinition,
  type McpCallResult,
  type McpVerifyResult,
} from '../packages/mcp/src/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: build a mock transport with configurable behavior
// ---------------------------------------------------------------------------
function createMockTransport(overrides: Partial<{
  listTools: () => Promise<McpToolDefinition[]>;
  listResources: () => Promise<McpResourceDefinition[]>;
  listPrompts: () => Promise<McpPromptDefinition[]>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<McpCallResult>;
}> = {}): McpTransport {
  return {
    listTools: overrides.listTools ?? (async () => [
      { name: 'read_file', description: 'Read a file' },
      { name: 'write_file', description: 'Write a file' },
      { name: 'list_dir', description: 'List directory contents' },
    ]),
    listResources: overrides.listResources ?? (async () => [
      { uri: 'file://README.md', name: 'README' },
      { uri: 'file://LICENSE', name: 'LICENSE' },
    ]),
    listPrompts: overrides.listPrompts ?? (async () => [
      { name: 'summarize', description: 'Summarize a document' },
    ]),
    callTool: overrides.callTool ?? (async () => ({ ok: true, content: {} })),
  };
}

// ---------------------------------------------------------------------------
// McpClient.verify() tests
// ---------------------------------------------------------------------------
describe('McpClient.verify()', () => {
  it('returns ok with correct tool/resource/prompt counts', async () => {
    const transport = createMockTransport();
    const client = new McpClient(transport);
    const result = await client.verify();

    expect(result.ok).toBe(true);
    expect(result.toolCount).toBe(3);
    expect(result.resourceCount).toBe(2);
    expect(result.promptCount).toBe(1);
    expect(result.error).toBeUndefined();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('latency measurement is reasonable (< 1000ms for mock)', async () => {
    const transport = createMockTransport();
    const client = new McpClient(transport);
    const result = await client.verify();

    expect(result.latencyMs).toBeLessThan(1000);
  });

  it('returns ok even when resources/prompts are not supported', async () => {
    const transport: McpTransport = {
      listTools: async () => [{ name: 'echo' }],
      callTool: async () => ({ ok: true, content: {} }),
    };
    const client = new McpClient(transport);
    const result = await client.verify();

    expect(result.ok).toBe(true);
    expect(result.toolCount).toBe(1);
    expect(result.resourceCount).toBeUndefined();
    expect(result.promptCount).toBeUndefined();
  });

  it('handles transport error gracefully', async () => {
    const transport = createMockTransport({
      listTools: async () => {
        throw new Error('Connection refused');
      },
    });
    const client = new McpClient(transport);
    const result = await client.verify();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Connection refused');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.toolCount).toBeUndefined();
  });

  it('handles timeout when transport does not respond', async () => {
    const transport = createMockTransport({
      listTools: () => new Promise(() => {
        // Never resolves
      }),
    });
    const client = new McpClient(transport);
    const result = await client.verify({ timeoutMs: 100 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');
    expect(result.latencyMs).toBeGreaterThanOrEqual(90);
  });

  it('succeeds for tools but handles resource listing failure gracefully', async () => {
    const transport = createMockTransport({
      listResources: async () => {
        throw new Error('Resources not supported');
      },
    });
    const client = new McpClient(transport);
    const result = await client.verify();

    expect(result.ok).toBe(true);
    expect(result.toolCount).toBe(3);
    expect(result.resourceCount).toBeUndefined();
    expect(result.promptCount).toBe(1);
  });

  it('succeeds for tools but handles prompt listing failure gracefully', async () => {
    const transport = createMockTransport({
      listPrompts: async () => {
        throw new Error('Prompts not supported');
      },
    });
    const client = new McpClient(transport);
    const result = await client.verify();

    expect(result.ok).toBe(true);
    expect(result.toolCount).toBe(3);
    expect(result.resourceCount).toBe(2);
    expect(result.promptCount).toBeUndefined();
  });

  it('verify result matches the McpVerifyResult interface shape', async () => {
    const transport = createMockTransport();
    const client = new McpClient(transport);
    const result: McpVerifyResult = await client.verify();

    expect(typeof result.ok).toBe('boolean');
    expect(typeof result.latencyMs).toBe('number');
    if (result.ok) {
      expect(typeof result.toolCount).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// verifyPresetAvailability tests
// ---------------------------------------------------------------------------
describe('verifyPresetAvailability', () => {
  async function getVerifyFn() {
    const mod = await import('../packages/mcp/src/presets.js');
    return mod.verifyPresetAvailability;
  }

  it('returns available for presets with no env var requirements', async () => {
    const verifyPresetAvailability = await getVerifyFn();
    const result = await verifyPresetAvailability('filesystem');

    expect(result.command).toBe('npx');
    expect(result.available).toBe(true);
  });

  it('returns unavailable when required env var is missing', async () => {
    const verifyPresetAvailability = await getVerifyFn();

    const origToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    const origGhToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    delete process.env.GITHUB_TOKEN;

    try {
      const result = await verifyPresetAvailability('github');
      expect(result.available).toBe(false);
      expect(result.error).toContain('not set');
      expect(result.command).toBe('npx');
    } finally {
      if (origToken !== undefined) process.env.GITHUB_PERSONAL_ACCESS_TOKEN = origToken;
      if (origGhToken !== undefined) process.env.GITHUB_TOKEN = origGhToken;
    }
  });

  it('returns available when required env var is set', async () => {
    const verifyPresetAvailability = await getVerifyFn();

    const origToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token-12345';

    try {
      const result = await verifyPresetAvailability('github');
      expect(result.available).toBe(true);
      expect(result.command).toBe('npx');
    } finally {
      if (origToken !== undefined) {
        process.env.GITHUB_TOKEN = origToken;
      } else {
        delete process.env.GITHUB_TOKEN;
      }
    }
  });

  it('returns error for unknown preset', async () => {
    const verifyPresetAvailability = await getVerifyFn();
    const result = await verifyPresetAvailability('nonexistent-preset');

    expect(result.available).toBe(false);
    expect(result.error).toContain('Unknown preset');
  });

  it('checks brave search env var requirement', async () => {
    const verifyPresetAvailability = await getVerifyFn();

    const orig = process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_API_KEY;

    try {
      const result = await verifyPresetAvailability('braveSearch');
      expect(result.available).toBe(false);
      expect(result.error).toContain('BRAVE_API_KEY');
    } finally {
      if (orig !== undefined) process.env.BRAVE_API_KEY = orig;
    }
  });
});

// ---------------------------------------------------------------------------
// Dashboard HTML verification tests
// ---------------------------------------------------------------------------
describe('Dashboard HTML contains verification UI elements', () => {
  async function getDashboardHtml() {
    const mod = await import('../packages/web/src/index.js');
    return mod.DASHBOARD_HTML as string;
  }

  it('contains crowclaw-connect-view for MCP management', async () => {
    const html = await getDashboardHtml();
    expect(html).toContain('crowclaw-connect-view');
  });

  it('contains MCP servers API endpoint', async () => {
    const html = await getDashboardHtml();
    expect(html).toContain('/api/mcp/servers');
  });

  it('contains MCP status API endpoint', async () => {
    const html = await getDashboardHtml();
    expect(html).toContain('/api/mcp/servers');
  });

  it('contains MCP section text', async () => {
    const html = await getDashboardHtml();
    expect(html).toContain('MCP');
  });

  it('contains tools API endpoint', async () => {
    const html = await getDashboardHtml();
    expect(html).toContain('/api/tools');
  });

  it('contains reconnect functionality', async () => {
    const html = await getDashboardHtml();
    expect(html).toContain('reconnect');
  });
});

// ---------------------------------------------------------------------------
// API response shape verification
// ---------------------------------------------------------------------------
describe('API response shapes', () => {
  it('McpVerifyResult has the expected structure for success', async () => {
    const transport = createMockTransport();
    const client = new McpClient(transport);
    const result = await client.verify();

    const expected = {
      ok: true,
      toolCount: 3,
      resourceCount: 2,
      promptCount: 1,
      latencyMs: expect.any(Number),
    };
    expect(result).toMatchObject(expected);
    expect(result.error).toBeUndefined();
    expect(result.serverName).toBeUndefined();
    expect(result.serverVersion).toBeUndefined();
  });

  it('McpVerifyResult has the expected structure for failure', async () => {
    const transport = createMockTransport({
      listTools: async () => { throw new Error('boom'); },
    });
    const client = new McpClient(transport);
    const result = await client.verify();

    expect(result).toMatchObject({
      ok: false,
      error: 'boom',
      latencyMs: expect.any(Number),
    });
    expect(result.toolCount).toBeUndefined();
    expect(result.resourceCount).toBeUndefined();
    expect(result.promptCount).toBeUndefined();
  });
});
