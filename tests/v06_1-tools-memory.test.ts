import { describe, it, expect, beforeEach } from 'vitest';
import {
  ToolRegistry,
  createWorkspaceReadTool,
  WORKSPACE_READ_DEDUP_LIMIT,
  resetWorkspaceReadDedup,
  getWorkspaceReadDedupCount,
  withApproval,
  requestApproval,
  type ApprovalCallback,
} from '../packages/tools/src/index.js';
import {
  MemoryManager,
  type MemoryProvider,
  type ManagerMemoryRecord,
  type SessionTranscriptMessage,
} from '../packages/memory/src/index.js';
import type { ToolExecutionContext, ToolDefinition, ToolExecutionResult } from '../packages/core/src/index.js';
import { InMemoryWorkspaceStore, type WorkspaceStore } from '../packages/workspace/src/index.js';

/**
 * v0.6.1 regression suite for the tools + memory ownership block.
 *
 *  - #85   MemoryManager.shutdown forwards the live transcript to providers'
 *          onSessionEnd hook (was passing `[]` and silently disabling
 *          dream-memory live capture and end-of-session summarisation).
 *  - #86   ToolRegistry.execute snapshots the approval callback per dispatch
 *          so concurrent `Promise.all` tool workers see a stable reference
 *          even when the parent context is mutated mid-flight.
 *  - #88   `workspace.read` escalates dedup-stub repetition to a synthetic
 *          BLOCKED result after WORKSPACE_READ_DEDUP_LIMIT (3) reads of the
 *          same path within a session.
 */

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function createInMemoryWorkspace(
  files: Record<string, string> = {},
): Promise<WorkspaceStore> {
  const store = new InMemoryWorkspaceStore();
  for (const [path, content] of Object.entries(files)) {
    await store.write(path, content);
  }
  return store;
}

function createContext(sessionId: string): ToolExecutionContext {
  return {
    agentId: 'test-agent',
    sessionId,
  };
}

// -----------------------------------------------------------------------------
// #85 — MemoryManager.shutdown forwards transcript to onSessionEnd
// -----------------------------------------------------------------------------

describe('#85 MemoryManager.shutdown forwards transcript', () => {
  function createCapturingProvider(
    name: string,
    options: { throws?: boolean } = {},
  ): MemoryProvider & { calls: Array<{ sessionId: string; messages: SessionTranscriptMessage[] }> } {
    const calls: Array<{ sessionId: string; messages: SessionTranscriptMessage[] }> = [];
    return {
      name,
      calls,
      async store(): Promise<void> {},
      async recall(): Promise<ManagerMemoryRecord[]> { return []; },
      async forget(): Promise<boolean> { return true; },
      async onSessionEnd(sessionId, messages): Promise<void> {
        calls.push({ sessionId, messages });
        if (options.throws) {
          throw new Error(`${name} blew up`);
        }
      },
    };
  }

  it('passes the live transcript (not []) to every provider with onSessionEnd', async () => {
    const manager = new MemoryManager();
    const a = createCapturingProvider('a');
    const b = createCapturingProvider('b');
    manager.addProvider(a);
    manager.addProvider(b);

    const transcript: SessionTranscriptMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    const results = await manager.shutdown('session-42', transcript);

    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    expect(a.calls[0]?.sessionId).toBe('session-42');
    expect(a.calls[0]?.messages).toHaveLength(2);
    expect(a.calls[0]?.messages[0]?.content).toBe('hello');
    expect(a.calls[0]?.messages).not.toEqual([]);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.invoked && r.ok)).toBe(true);
  });

  it('skips providers without an onSessionEnd hook (invoked=false, ok=true)', async () => {
    const manager = new MemoryManager();
    const minimal: MemoryProvider = {
      name: 'minimal',
      async store(): Promise<void> {},
      async recall(): Promise<ManagerMemoryRecord[]> { return []; },
      async forget(): Promise<boolean> { return true; },
    };
    manager.addProvider(minimal);

    const results = await manager.shutdown('session-1', [
      { role: 'user', content: 'noop' },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ provider: 'minimal', invoked: false, ok: true });
  });

  it('isolates per-provider failures so one bad backend cannot abort the rest', async () => {
    const manager = new MemoryManager();
    const good = createCapturingProvider('good');
    const bad = createCapturingProvider('bad', { throws: true });
    manager.addProvider(bad);
    manager.addProvider(good);

    const results = await manager.shutdown('s1', [{ role: 'user', content: 'x' }]);

    expect(results).toHaveLength(2);
    const goodResult = results.find((r) => r.provider === 'good');
    const badResult = results.find((r) => r.provider === 'bad');
    expect(goodResult).toMatchObject({ invoked: true, ok: true });
    expect(badResult).toMatchObject({ invoked: true, ok: false });
    expect(badResult?.error).toContain('bad blew up');
    // The "good" provider must still have been called even though "bad" threw.
    expect(good.calls).toHaveLength(1);
  });

  it('coerces a non-array `messages` argument to [] without throwing (defensive)', async () => {
    const manager = new MemoryManager();
    const provider = createCapturingProvider('p');
    manager.addProvider(provider);

    // Simulate a host bug that passes `undefined` instead of session.messages.
    const results = await manager.shutdown(
      's1',
      undefined as unknown as SessionTranscriptMessage[],
    );

    expect(results[0]?.ok).toBe(true);
    expect(provider.calls[0]?.messages).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// #86 — Approval callback survives concurrent dispatch
// -----------------------------------------------------------------------------

describe('#86 ToolRegistry approval propagation under Promise.all', () => {
  /**
   * Tool that *demands* the approval callback be reachable; otherwise it
   * fails. Lets us exercise the gate without going through AgentLoop.
   */
  function approvalProbeTool(): ToolDefinition {
    return {
      manifest: {
        name: 'test.approvalProbe',
        description: 'Probe that calls the approval callback to verify reachability.',
        runtime: 'worker',
        streaming: false,
        stateful: false,
        requiresWorkspace: false,
        requiresNetwork: false,
        dangerLevel: 'low',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
      async execute(input, context): Promise<ToolExecutionResult> {
        const ok = await requestApproval(context, 'test.approvalProbe', input);
        return {
          toolName: 'test.approvalProbe',
          runtime: 'worker',
          ok,
          output: ok ? 'approved' : 'no-callback',
          metadata: { id: input.id },
        };
      },
    };
  }

  it('every concurrent worker sees the approval callback', async () => {
    const registry = new ToolRegistry();
    registry.register(approvalProbeTool());

    const callCounts: string[] = [];
    const callback: ApprovalCallback = async (req) => {
      callCounts.push(String(req.input.id));
      return true;
    };
    const baseCtx = withApproval(createContext('s-concurrent'), callback);

    // Fan out 5 concurrent dispatches sharing the same source context — this
    // is the AgentLoop safety-partition pattern that #86 broke.
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        registry.execute('test.approvalProbe', { id: `t${i}` }, baseCtx),
      ),
    );

    expect(results.map((r) => r.ok)).toEqual([true, true, true, true, true]);
    expect(results.map((r) => r.output)).toEqual([
      'approved', 'approved', 'approved', 'approved', 'approved',
    ]);
    expect(callCounts).toHaveLength(5);
    expect(new Set(callCounts)).toEqual(new Set(['t0', 't1', 't2', 't3', 't4']));
  });

  it('a parent that mutates context.approval mid-flight cannot disable an in-flight worker', async () => {
    const registry = new ToolRegistry();
    registry.register(approvalProbeTool());

    let callbackInvocations = 0;
    const callback: ApprovalCallback = async () => {
      callbackInvocations++;
      // Yield so the test can race a mutation against the in-flight call.
      await new Promise((r) => setTimeout(r, 10));
      return true;
    };
    const sourceCtx = withApproval(createContext('s-mutation'), callback) as
      ToolExecutionContext & { approval?: ApprovalCallback };

    const dispatchPromise = registry.execute('test.approvalProbe', { id: 'one' }, sourceCtx);
    // Simulate a teardown hook that wipes `approval` on the shared context
    // immediately after dispatch — without the per-dispatch snapshot, the
    // probe would observe `undefined` and report `no-callback`.
    sourceCtx.approval = undefined;

    const result = await dispatchPromise;
    expect(result.ok).toBe(true);
    expect(result.output).toBe('approved');
    expect(callbackInvocations).toBe(1);
  });

  it('reports no-callback when no approval is wired (graceful degradation)', async () => {
    const registry = new ToolRegistry();
    registry.register(approvalProbeTool());
    const result = await registry.execute(
      'test.approvalProbe',
      { id: 'x' },
      createContext('s-no-cb'),
    );
    expect(result.ok).toBe(false);
    expect(result.output).toBe('no-callback');
  });

  it('requestApproval returns false (fail-closed) when the callback throws', async () => {
    const registry = new ToolRegistry();
    registry.register(approvalProbeTool());
    const ctx = withApproval(createContext('s-throw'), async () => {
      throw new Error('operator denied');
    });
    const result = await registry.execute('test.approvalProbe', { id: 'x' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.output).toBe('no-callback');
  });
});

// -----------------------------------------------------------------------------
// #88 — workspace.read dedup-stub escalates to BLOCKED
// -----------------------------------------------------------------------------

describe('#88 workspace.read dedup escalation', () => {
  beforeEach(() => {
    resetWorkspaceReadDedup();
  });

  it(`allows the first ${WORKSPACE_READ_DEDUP_LIMIT} reads of the same path`, async () => {
    const workspace = await createInMemoryWorkspace({ 'a.md': 'hello' });
    const tool = createWorkspaceReadTool(workspace);
    const ctx = createContext('s-1');

    for (let i = 0; i < WORKSPACE_READ_DEDUP_LIMIT; i++) {
      const result = await tool.execute({ path: 'a.md' }, ctx);
      expect(result.ok).toBe(true);
      expect(result.output).toBe('hello');
      expect(result.metadata?.['tool:blocked_dedup']).toBeUndefined();
    }
    expect(getWorkspaceReadDedupCount('s-1', 'a.md')).toBe(WORKSPACE_READ_DEDUP_LIMIT);
  });

  it(`returns BLOCKED with tool:blocked_dedup on the (limit+1)th read`, async () => {
    const workspace = await createInMemoryWorkspace({ 'a.md': 'hello' });
    const tool = createWorkspaceReadTool(workspace);
    const ctx = createContext('s-2');

    for (let i = 0; i < WORKSPACE_READ_DEDUP_LIMIT; i++) {
      await tool.execute({ path: 'a.md' }, ctx);
    }
    const result = await tool.execute({ path: 'a.md' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('BLOCKED');
    expect(result.output).toContain('a.md');
    expect(result.metadata?.['tool:blocked_dedup']).toBe(true);
    expect(result.metadata?.blocked).toBe(true);
    expect(result.metadata?.path).toBe('a.md');
    expect(result.metadata?.limit).toBe(WORKSPACE_READ_DEDUP_LIMIT);
  });

  it('counts are isolated per session', async () => {
    const workspace = await createInMemoryWorkspace({ 'a.md': 'hello' });
    const tool = createWorkspaceReadTool(workspace);

    // Saturate session 1
    for (let i = 0; i < WORKSPACE_READ_DEDUP_LIMIT; i++) {
      await tool.execute({ path: 'a.md' }, createContext('s-1'));
    }
    const blocked = await tool.execute({ path: 'a.md' }, createContext('s-1'));
    expect(blocked.metadata?.['tool:blocked_dedup']).toBe(true);

    // Different session must still pass
    const fresh = await tool.execute({ path: 'a.md' }, createContext('s-2'));
    expect(fresh.ok).toBe(true);
    expect(fresh.metadata?.['tool:blocked_dedup']).toBeUndefined();
  });

  it('counts are isolated per path', async () => {
    const workspace = await createInMemoryWorkspace({ 'a.md': 'hello', 'b.md': 'world' });
    const tool = createWorkspaceReadTool(workspace);
    const ctx = createContext('s-paths');

    for (let i = 0; i < WORKSPACE_READ_DEDUP_LIMIT; i++) {
      await tool.execute({ path: 'a.md' }, ctx);
    }
    // a.md is at the limit, but b.md is a fresh path.
    const result = await tool.execute({ path: 'b.md' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toBe('world');
  });

  it('resetWorkspaceReadDedup(sessionId) clears only that session', async () => {
    const workspace = await createInMemoryWorkspace({ 'a.md': 'hello' });
    const tool = createWorkspaceReadTool(workspace);

    for (let i = 0; i < WORKSPACE_READ_DEDUP_LIMIT; i++) {
      await tool.execute({ path: 'a.md' }, createContext('s-A'));
      await tool.execute({ path: 'a.md' }, createContext('s-B'));
    }
    resetWorkspaceReadDedup('s-A');
    expect(getWorkspaceReadDedupCount('s-A', 'a.md')).toBe(0);
    expect(getWorkspaceReadDedupCount('s-B', 'a.md')).toBe(WORKSPACE_READ_DEDUP_LIMIT);

    const a = await tool.execute({ path: 'a.md' }, createContext('s-A'));
    const b = await tool.execute({ path: 'a.md' }, createContext('s-B'));
    expect(a.ok).toBe(true);
    expect(b.metadata?.['tool:blocked_dedup']).toBe(true);
  });

  it('rejects missing path with a clear error (does not increment the dedup counter)', async () => {
    const workspace = await createInMemoryWorkspace({});
    const tool = createWorkspaceReadTool(workspace);
    const ctx = createContext('s-missing');

    const result = await tool.execute({}, ctx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Missing path');
    expect(getWorkspaceReadDedupCount('s-missing', '')).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Verification of items already shipped in v0.6.0 (smoke checks only)
// -----------------------------------------------------------------------------

describe('v0.6.0 — verifications (already shipped)', () => {
  it('#93 scheduler.enabledToolsets is part of CronJobDefinition (per-job allowlist)', async () => {
    const { createScheduledAgentJob } = await import('../packages/scheduler/src/index.js');
    const job = createScheduledAgentJob({
      id: 'job-1',
      schedule: 'every:5m',
      task: 'do work',
      enabledToolsets: ['web.search'],
    });
    expect(job.enabledToolsets).toEqual(['web.search']);
  });

  it('#121/#122 InMemoryDreamStore caps long-term entries (defensive smoke)', async () => {
    const { InMemoryDreamStore } = await import('../packages/memory/src/index.js');
    const store = new InMemoryDreamStore();
    // Add a small, bounded sample to confirm the cap path exists without
    // burning runtime — the full bound test lives in dream-memory.test.ts.
    for (let i = 0; i < 5; i++) {
      await store.addLive(`s-${i}`, `summary-${i}`);
      await store.consolidate();
    }
    const longTerm = await store.getLongTerm(50);
    expect(longTerm.length).toBeLessThanOrEqual(500);
    expect(longTerm.length).toBeGreaterThan(0);
  });
});
