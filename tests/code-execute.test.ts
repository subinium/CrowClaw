import { describe, it, expect } from 'vitest';
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolCall,
} from '@crowclaw/core';
import { SecurityAuditLog } from '@crowclaw/core';
import { ToolRegistry, createCodeExecuteTool } from '@crowclaw/tools';
import { executeWithTools } from '@crowclaw/sandbox-executor';

// ---------------------------------------------------------------------------
// Test fixtures — three lightweight in-process tools the sandbox can call
// through the RPC bridge. We track call counts + arg shapes so we can verify
// the bridge actually round-trips through the host registry.
// ---------------------------------------------------------------------------

function makeTool(
  name: string,
  options: {
    safety?: 'read-only' | 'destructive' | 'idempotent';
    dangerLevel?: 'low' | 'medium' | 'high';
    impl?: (input: Record<string, unknown>) => string;
  } = {},
): ToolDefinition {
  return {
    manifest: {
      name,
      description: `test tool ${name}`,
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: options.dangerLevel ?? 'low',
      safety: options.safety,
    },
    async execute(input): Promise<ToolExecutionResult> {
      const out = options.impl ? options.impl(input) : JSON.stringify({ ok: true, name, input });
      return {
        toolName: name,
        runtime: 'worker',
        ok: true,
        output: out,
      };
    },
  };
}

function defaultCtx(): ToolExecutionContext {
  return { agentId: 'test-agent', sessionId: 'session-test' };
}

// ---------------------------------------------------------------------------

describe('code.execute (#234) — sandboxed pipeline tool', () => {
  it('runs a 3-tool pipeline in a single code.execute call', async () => {
    const calls: string[] = [];
    const registry = new ToolRegistry();
    registry.register(makeTool('web.search', {
      impl: (input) => {
        calls.push('web.search');
        return JSON.stringify({ hits: [`r-${(input as { q?: string }).q}`] });
      },
    }));
    registry.register(makeTool('web.fetch', {
      impl: (input) => {
        calls.push('web.fetch');
        return JSON.stringify({ url: (input as { url?: string }).url, body: 'BODY' });
      },
    }));
    registry.register(makeTool('memory.remember', {
      impl: () => {
        calls.push('memory.remember');
        return JSON.stringify({ stored: true });
      },
    }));

    const tool = createCodeExecuteTool({ toolRegistry: registry });
    registry.register(tool);

    const code = `
      const search = await tools['web.search']({ q: 'crowclaw' });
      const parsedSearch = JSON.parse(search);
      const fetched = await tools['web.fetch']({ url: parsedSearch.hits[0] });
      const _ = await tools['memory.remember']({ note: 'done' });
      console.log('chain done');
      return { searchHit: parsedSearch.hits[0], body: JSON.parse(fetched).body };
    `;

    const result = await tool.execute(
      { language: 'js', code, allowedTools: ['web.search', 'web.fetch', 'memory.remember'] },
      defaultCtx(),
    );

    expect(result.ok).toBe(true);
    expect(calls).toEqual(['web.search', 'web.fetch', 'memory.remember']);
    expect(result.metadata?.toolCallCount).toBe(3);
    const payload = JSON.parse(result.output) as {
      ok: boolean;
      stdout: string;
      toolCalls: Array<{ name: string; ok: boolean }>;
      returnValue?: { searchHit: string; body: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.stdout).toMatch(/chain done/);
    expect(payload.toolCalls.map((c) => c.name)).toEqual(['web.search', 'web.fetch', 'memory.remember']);
    expect(payload.returnValue).toEqual({ searchHit: 'r-crowclaw', body: 'BODY' });
  });

  it('routes destructive tool calls through the host approval gate (executeTool stub)', async () => {
    const registry = new ToolRegistry();
    const dangerous = makeTool('terminal.exec', { safety: 'destructive', dangerLevel: 'high' });
    registry.register(dangerous);

    let approvalAsked = false;
    const executeTool = async (
      tc: ToolCall,
      _ctx: ToolExecutionContext,
    ): Promise<ToolExecutionResult> => {
      // Simulate the agent loop's approval gate. For destructive tools we
      // require explicit approval; here we deny.
      if (tc.name === 'terminal.exec') {
        approvalAsked = true;
        return {
          toolName: 'terminal.exec',
          runtime: 'worker',
          ok: false,
          output: 'Tool call rejected: approval denied',
          metadata: { approvalDenied: true },
        };
      }
      return registry.execute(tc.name, tc.input, defaultCtx());
    };

    // We need policy.allowDangerous: true to even reach the executeTool path
    // (otherwise the DangerousToolBlocked check fires earlier inside the
    // bridge). The whole point of this test is to verify the host gate runs
    // when the operator has consciously opted into dangerous tools.
    const result = await executeWithTools({
      toolRegistry: registry,
      sessionId: 's',
      language: 'js',
      code: `
        try {
          await tools['terminal.exec']({ command: 'echo hi' });
          return 'unexpectedly allowed';
        } catch (err) {
          return { blocked: true, message: err.message };
        }
      `,
      policy: { allowedTools: ['terminal.exec'], allowDangerous: true },
      executeTool,
    });

    expect(result.ok).toBe(true);
    expect(approvalAsked).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.ok).toBe(false);
    const ret = result.returnValue as { blocked: boolean; message: string };
    expect(ret.blocked).toBe(true);
  });

  it('rejects destructive calls when allowDangerous is false (default)', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('workspace.delete', { safety: 'destructive', dangerLevel: 'high' }));

    const result = await executeWithTools({
      toolRegistry: registry,
      sessionId: 's',
      language: 'js',
      code: `
        try {
          await tools['workspace.delete']({ path: '/x' });
          return 'unexpectedly allowed';
        } catch (err) {
          return { blocked: true, code: err.message };
        }
      `,
      policy: { allowedTools: ['workspace.delete'], allowDangerous: false },
    });

    expect(result.ok).toBe(true);
    const ret = result.returnValue as { blocked: boolean; code: string };
    expect(ret.blocked).toBe(true);
    expect(ret.code).toMatch(/destructive/i);
  });

  it('hardline-blocklist matches inside the sandbox stop the call', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('terminal.exec'));

    // The static HARDLINE_BLOCKLIST already covers `rm -rf /` — we route the
    // sandbox call through it via the bridge.
    const result = await executeWithTools({
      toolRegistry: registry,
      sessionId: 's',
      language: 'js',
      code: `
        try {
          await tools['terminal.exec']({ command: 'rm -rf /' });
          return 'unexpectedly allowed';
        } catch (err) {
          return { blocked: true, message: err.message };
        }
      `,
      policy: { allowedTools: ['terminal.exec'], allowDangerous: true },
    });

    expect(result.ok).toBe(true);
    const ret = result.returnValue as { blocked: boolean; message: string };
    expect(ret.blocked).toBe(true);
    expect(ret.message).toMatch(/hardline blocklist/i);
    expect(result.toolCalls[0]?.ok).toBe(false);
  });

  it('returns a structured timeout error when the sandbox exceeds policy.timeoutMs', async () => {
    const registry = new ToolRegistry();

    const result = await executeWithTools({
      toolRegistry: registry,
      sessionId: 's',
      language: 'js',
      code: `
        // Spin via async micro-tasks so the AbortController-backed wall clock fires.
        await new Promise(() => {});
        return 'unreachable';
      `,
      policy: { allowedTools: [], timeoutMs: 50 },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeout/i);
    expect(result.stderr).toMatch(/timeout/i);
  });

  it('throws ToolNotAllowed for tools not in the allowlist', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('web.fetch'));
    registry.register(makeTool('web.search'));

    const result = await executeWithTools({
      toolRegistry: registry,
      sessionId: 's',
      language: 'js',
      code: `
        try {
          await tools['web.search']({ q: 'foo' });
          return 'allowed';
        } catch (err) {
          return { blocked: true, message: err.message };
        }
      `,
      // Only web.fetch is allowed; web.search must be blocked even though
      // it's registered on the host.
      policy: { allowedTools: ['web.fetch'] },
    });

    expect(result.ok).toBe(true);
    const ret = result.returnValue as { blocked: boolean; message: string };
    expect(ret.blocked).toBe(true);
    expect(ret.message).toMatch(/not in the sandbox allowedTools list/);
  });

  it('records a tool.code-execute audit entry at the call site', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('web.fetch'));

    const auditLog = new SecurityAuditLog(50);
    const tool = createCodeExecuteTool({ toolRegistry: registry, securityAuditLog: auditLog });

    await tool.execute(
      {
        language: 'js',
        code: 'return 42;',
        allowedTools: ['web.fetch'],
      },
      defaultCtx(),
    );

    const events = auditLog.getEventsByType('tool.code-execute');
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toMatch(/language=js/);
    expect(events[0]?.detail).toMatch(/web\.fetch/);
    expect(events[0]?.sessionId).toBe('session-test');
  });

  it('emits code:start / code:tool_called / code:complete events in order', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('web.fetch'));

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const eventBus = {
      emit(type: string, data: Record<string, unknown>) {
        events.push({ type, data });
      },
    };

    const result = await executeWithTools({
      toolRegistry: registry,
      sessionId: 's',
      language: 'js',
      eventBus,
      code: `
        await tools['web.fetch']({ url: 'https://example.com' });
        return true;
      `,
      policy: { allowedTools: ['web.fetch'] },
    });

    expect(result.ok).toBe(true);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('code:start');
    expect(types[types.length - 1]).toBe('code:complete');
    expect(types).toContain('code:tool_called');
    const completeEvent = events.find((e) => e.type === 'code:complete');
    expect(completeEvent?.data.ok).toBe(true);
    expect(completeEvent?.data.toolCallCount).toBe(1);
  });
});
