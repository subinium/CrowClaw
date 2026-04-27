/**
 * #152 + #154: verify the embedded MCP server is wired with ownerToken from
 * CROWCLAW_DASHBOARD_TOKEN, and that the routes pass the caller's Bearer
 * token into the MCP layer for per-tool owner gating.
 *
 * The /api/mcp/server/* routes sit behind the existing dashboard auth
 * middleware — a request that fails dashboard auth never reaches the MCP
 * code. These tests verify the inner wiring with valid auth: when the bearer
 * token matches CROWCLAW_DASHBOARD_TOKEN, ownerOnly tools must be visible
 * and invocable; when no token is configured (legacy mode), behavior is
 * preserved for local dev.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import { localRoute, routePaths } from '../packages/runtime-node/src/route-paths.js';
import { EchoProvider } from '@crowclaw/providers';

const TOKEN = 'unit-test-owner-token-vG9pq3xZ';

describe('embedded MCP server — ownerToken wiring (#152, #154)', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.CROWCLAW_DASHBOARD_TOKEN;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CROWCLAW_DASHBOARD_TOKEN;
    else process.env.CROWCLAW_DASHBOARD_TOKEN = originalEnv;
  });

  it('legacy mode (no token): ownerOnly tools remain visible (preserves existing dev ergonomics)', async () => {
    delete process.env.CROWCLAW_DASHBOARD_TOKEN;
    const runtime = createNodeRuntime({
      provider: new EchoProvider(),
      agentId: 'crowclaw-mcp-legacy',
    });

    const res = await runtime.fetch(new Request(localRoute(routePaths.mcp.serverTools)));
    const body = (await res.json()) as { tools: Array<{ name: string }> };

    expect(body.tools.map((t) => t.name)).toContain('crowclaw.chat');
    expect(body.tools.map((t) => t.name)).toContain('crowclaw.tools.list');
  });

  it('with dashboard token + matching bearer: ownerOnly tools are visible', async () => {
    process.env.CROWCLAW_DASHBOARD_TOKEN = TOKEN;
    const runtime = createNodeRuntime({
      provider: new EchoProvider(),
      agentId: 'crowclaw-mcp-owner',
    });

    const res = await runtime.fetch(new Request(localRoute(routePaths.mcp.serverTools), {
      headers: { authorization: `Bearer ${TOKEN}` },
    }));
    const body = (await res.json()) as { tools: Array<{ name: string }> };

    expect(body.tools.map((t) => t.name)).toContain('crowclaw.chat');
    expect(body.tools.map((t) => t.name)).toContain('crowclaw.sessions.list');
  });

  it('with dashboard token + matching bearer: tools/call on ownerOnly chat tool succeeds', async () => {
    process.env.CROWCLAW_DASHBOARD_TOKEN = TOKEN;
    const runtime = createNodeRuntime({
      provider: new EchoProvider(),
      agentId: 'crowclaw-mcp-owner',
    });

    const res = await runtime.fetch(new Request(localRoute(routePaths.mcp.serverRequest), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'wired',
        method: 'tools/call',
        params: {
          name: 'crowclaw.chat',
          arguments: { sessionId: 'wire-test', message: 'hello owner' },
        },
      }),
    }));
    const body = (await res.json()) as {
      result?: { content: Array<{ text: string }> };
      error?: { message: string };
    };

    expect(body.error).toBeUndefined();
    expect(body.result?.content[0]?.text).toContain('CrowClaw received');
  });
});
