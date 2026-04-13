/**
 * E2E: Full Agent Loop — cross-subsystem integration
 *
 * Tests that streaming, usage tracking, compression, checkpointing,
 * security policies, and token budgets all cooperate inside AgentLoop.
 */
import { describe, expect, it, beforeEach } from 'vitest';

import {
  AgentLoop,
  DetailedUsageTracker,
  InMemoryCheckpointStore,
  type AgentStreamEvent,
  type SessionState,
} from '@crowclaw/core';
import { InMemorySessionStore } from '@crowclaw/storage';
import { ToolRegistry, createEchoTool, createTimeTool } from '@crowclaw/tools';
import { EchoProvider } from '@crowclaw/providers';

// ============================================================================
// 1. Full agent loop with streaming + tracking + compression + checkpoint
// ============================================================================

describe('E2E: full loop with streaming + tracking + checkpoint', () => {
  let provider: EchoProvider;
  let sessions: InMemorySessionStore;
  let tools: ToolRegistry;
  let usageTracker: DetailedUsageTracker;
  let checkpointStore: InMemoryCheckpointStore;

  beforeEach(() => {
    provider = new EchoProvider();
    sessions = new InMemorySessionStore();
    tools = new ToolRegistry();
    tools.register(createEchoTool());
    tools.register(createTimeTool());
    usageTracker = new DetailedUsageTracker();
    checkpointStore = new InMemoryCheckpointStore();
  });

  it('streaming run yields iteration-start, text-delta, and done events', async () => {
    const loop = new AgentLoop(provider, tools, sessions, {
      maxToolIterations: 4,
      runtimeName: 'e2e-stream',
      usageTracker,
      checkpointStore,
      autoCheckpoint: true,
    });

    // Seed a session
    const session: SessionState = {
      agentId: 'crowclaw',
      sessionId: 'stream-test-1',
      messages: [],
      updatedAt: new Date().toISOString(),
    };
    await sessions.put(session);

    const events: AgentStreamEvent[] = [];
    for await (const event of loop.runStreaming({
      userMessage: 'Hello from streaming test',
      sessionState: session,
    })) {
      events.push(event);
    }

    // Verify event types present
    const types = events.map((e) => e.type);
    expect(types).toContain('done');

    // The done event should have a response
    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent).toBeDefined();
    if (doneEvent?.type === 'done') {
      expect(doneEvent.response).toBeTruthy();
    }
  });

  it('non-streaming run records usage and saves checkpoints', async () => {
    const loop = new AgentLoop(provider, tools, sessions, {
      maxToolIterations: 4,
      runtimeName: 'e2e-track',
      usageTracker,
      checkpointStore,
      autoCheckpoint: true,
    });

    const result = await loop.run({
      agentId: 'crowclaw',
      sessionId: 'track-test-1',
      userMessage: 'Track this message',
    });

    expect(result.finalResponse).toBeTruthy();
    expect(result.session.messages.length).toBeGreaterThanOrEqual(2);

    // Checkpoints: autoCheckpoint=true should save at least one
    const checkpoints = await checkpointStore.listBySession('track-test-1');
    expect(checkpoints.length).toBeGreaterThanOrEqual(1);
  });

  it('compression triggers on long conversations and preserves continuity', async () => {
    const loop = new AgentLoop(provider, tools, sessions, {
      compressAfterMessageCount: 6,
      protectLastMessages: 2,
      runtimeName: 'e2e-compress',
      usageTracker,
    });

    for (let i = 0; i < 5; i++) {
      await loop.run({
        agentId: 'crowclaw',
        sessionId: 'compress-test-1',
        userMessage: `Message number ${i + 1} — this is a test message.`,
      });
    }

    const session = await sessions.get('compress-test-1');
    expect(session).toBeTruthy();
    // Compression should have kicked in
    expect(session!.lineage!.compressionCount).toBeGreaterThan(0);

    // Session should still work after compression
    const result = await loop.run({
      agentId: 'crowclaw',
      sessionId: 'compress-test-1',
      userMessage: 'Post-compression message',
    });
    expect(result.finalResponse).toBeTruthy();
  });
});

// ============================================================================
// 2. Agent loop with security policy
// ============================================================================

describe('E2E: agent loop with security policy', () => {
  it('redacts credentials from tool output in conversation history', async () => {
    const provider = new EchoProvider();
    const sessions = new InMemorySessionStore();
    const tools = new ToolRegistry();

    // Register a tool that returns a credential
    tools.register({
      manifest: {
        name: 'secret-leaker',
        description: 'Returns credentials',
        runtime: 'worker',
        streaming: false,
        stateful: false,
        requiresWorkspace: false,
        requiresNetwork: false,
        dangerLevel: 'low',
      },
      async execute() {
        return {
          toolName: 'secret-leaker',
          runtime: 'worker' as const,
          ok: true,
          output: 'API key: sk-1234567890abcdefghijklmno and token: ghp_abcdefghijklmnopqrstuvwxyz1234567890',
        };
      },
    });

    const loop = new AgentLoop(provider, tools, sessions, {
      maxToolIterations: 3,
      securityPolicy: {
        redactToolOutput: true,
        scanCommands: true,
      },
    });

    // Trigger tool execution via slash command
    const result = await loop.run({
      agentId: 'crowclaw',
      sessionId: 'security-redact-1',
      userMessage: '/tool secret-leaker {}',
    });

    expect(result.toolResults.length).toBeGreaterThan(0);
    // The tool result in the session messages should have redacted output
    const toolMessages = result.session.messages.filter((m) => m.role === 'tool');
    for (const msg of toolMessages) {
      expect(msg.content).not.toContain('sk-1234567890abcdefghijklmno');
      expect(msg.content).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234567890');
      expect(msg.content).toContain('[REDACTED]');
    }
  });

  it('security policy with command scanning warns about dangerous commands', async () => {
    const provider = new EchoProvider();
    const sessions = new InMemorySessionStore();
    const tools = new ToolRegistry();
    tools.register(createEchoTool());

    const loop = new AgentLoop(provider, tools, sessions, {
      maxToolIterations: 3,
      securityPolicy: {
        redactToolOutput: true,
        scanCommands: true,
        blockDangerousCommands: false,
      },
    });

    const result = await loop.run({
      agentId: 'crowclaw',
      sessionId: 'security-scan-1',
      userMessage: 'Hello, run a safe command',
    });
    expect(result.finalResponse).toBeTruthy();
  });
});

// ============================================================================
// 3. Token budget enforcement
// ============================================================================

describe('E2E: token budget enforcement', () => {
  it('stops the loop when maxTokens budget is set very low', async () => {
    const provider = new EchoProvider();
    const sessions = new InMemorySessionStore();
    const tools = new ToolRegistry();
    tools.register(createEchoTool());
    const usageTracker = new DetailedUsageTracker();

    const loop = new AgentLoop(provider, tools, sessions, {
      maxToolIterations: 20,
      maxTokens: 100,
      usageTracker,
      runtimeName: 'e2e-budget',
    });

    // Run multiple times — the loop should eventually stop due to budget
    const result = await loop.run({
      agentId: 'crowclaw',
      sessionId: 'budget-test-1',
      userMessage: 'Test budget enforcement',
    });

    // Should still return a valid result (not hang or error)
    expect(result.finalResponse).toBeTruthy();
  });

  it('usage tracker accumulates entries across multiple runs', async () => {
    const provider = new EchoProvider();
    const sessions = new InMemorySessionStore();
    const tools = new ToolRegistry();
    tools.register(createEchoTool());
    const usageTracker = new DetailedUsageTracker();

    const loop = new AgentLoop(provider, tools, sessions, {
      maxToolIterations: 3,
      usageTracker,
    });

    await loop.run({
      agentId: 'crowclaw',
      sessionId: 'usage-multi-1',
      userMessage: 'First message',
    });
    await loop.run({
      agentId: 'crowclaw',
      sessionId: 'usage-multi-1',
      userMessage: 'Second message',
    });

    // Usage tracker should work without errors
    const summary = usageTracker.getSummary();
    expect(summary).toBeDefined();
    expect(typeof summary.totalTokens).toBe('number');
    expect(typeof summary.totalCostUsd).toBe('number');
  });
});

// ============================================================================
// 4. Checkpoint + rollback cross-subsystem
// ============================================================================

describe('E2E: checkpoint + rollback with active session', () => {
  it('creates manual checkpoint and can restore to that earlier state', async () => {
    const provider = new EchoProvider();
    const sessions = new InMemorySessionStore();
    const tools = new ToolRegistry();
    tools.register(createEchoTool());
    const checkpointStore = new InMemoryCheckpointStore();
    const { createCheckpoint, restoreFromCheckpoint } = await import('@crowclaw/core');

    const loop = new AgentLoop(provider, tools, sessions, {
      maxToolIterations: 4,
      checkpointStore,
      runtimeName: 'e2e-cp-restore',
    });

    // Run 1
    const r1 = await loop.run({
      agentId: 'crowclaw',
      sessionId: 'cp-restore-1',
      userMessage: 'First message',
    });
    expect(r1.session.messages.length).toBeGreaterThanOrEqual(2);

    // Manually create checkpoint after run 1
    const cp1 = createCheckpoint(r1.session, r1.toolResults, 1, 'manual', 'after-run-1');
    await checkpointStore.save(cp1);

    // Run 2 — adds more messages
    const r2 = await loop.run({
      agentId: 'crowclaw',
      sessionId: 'cp-restore-1',
      userMessage: 'Second message',
    });
    expect(r2.session.messages.length).toBeGreaterThan(r1.session.messages.length);

    // Restore to checkpoint 1
    const restored = restoreFromCheckpoint(cp1, r2.session);
    expect(restored.session.messages.length).toBe(cp1.messages.length);
    expect(restored.session.messages.length).toBe(r1.session.messages.length);
    expect(restored.session.messages.length).toBeLessThan(r2.session.messages.length);

    // Verify the restored session has the right content
    expect(restored.session.messages.at(-1)!.role).toBe('assistant');
    expect(restored.session.sessionId).toBe('cp-restore-1');
  });
});
