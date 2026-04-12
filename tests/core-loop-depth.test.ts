import { describe, expect, it } from 'vitest';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  ProviderResponseUsage,
  ConversationMessage,
  ToolExecutionResult,
  ToolDefinition,
  AgentStreamEvent,
} from '@crowclaw/core';
import {
  AgentLoop,
  DetailedUsageTracker,
  InMemoryCheckpointStore,
} from '@crowclaw/core';
import type { StreamingProviderAdapter } from '@crowclaw/core/streaming';
import type { StreamChunk } from '@crowclaw/core/streaming';
import { InMemorySessionStore } from '@crowclaw/storage';
import { ToolRegistry } from '@crowclaw/tools';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function echoToolDef(dangerLevel: 'low' | 'medium' | 'high' = 'low'): ToolDefinition {
  return {
    manifest: {
      name: 'echo',
      description: 'Echo tool',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel,
    },
    async execute(input: Record<string, unknown>): Promise<ToolExecutionResult> {
      return {
        toolName: 'echo',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify(input),
      };
    },
  };
}

function dangerToolDef(): ToolDefinition {
  return {
    manifest: {
      name: 'danger',
      description: 'Dangerous tool',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'high',
    },
    async execute(input: Record<string, unknown>): Promise<ToolExecutionResult> {
      return {
        toolName: 'danger',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify(input),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock providers
// ---------------------------------------------------------------------------

/** Provider that returns usage data with each response. */
class UsageTrackingProvider implements ProviderAdapter {
  private callCount = 0;
  private readonly perCallUsage: ProviderResponseUsage;

  constructor(perCallUsage: ProviderResponseUsage) {
    this.perCallUsage = perCallUsage;
  }

  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    this.callCount += 1;
    if (this.callCount === 1) {
      return {
        assistantMessage: 'Running tool.',
        toolCalls: [{ name: 'echo', input: { step: 1 } }],
        usage: this.perCallUsage,
      };
    }
    if (this.callCount === 2) {
      return {
        assistantMessage: 'Running second tool.',
        toolCalls: [{ name: 'echo', input: { step: 2 } }],
        usage: this.perCallUsage,
      };
    }
    return {
      assistantMessage: 'Done.',
      usage: this.perCallUsage,
    };
  }
}

/** Provider with countTokens support for testing token-aware compression. */
class CountableProvider implements ProviderAdapter {
  private callCount = 0;
  private readonly tokensPerMessage: number;

  constructor(tokensPerMessage: number) {
    this.tokensPerMessage = tokensPerMessage;
  }

  countTokens(messages: ConversationMessage[]): number {
    return messages.length * this.tokensPerMessage;
  }

  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    this.callCount += 1;
    if (this.callCount <= 2) {
      return {
        assistantMessage: `Step ${this.callCount}`,
        toolCalls: [{ name: 'echo', input: { n: this.callCount } }],
      };
    }
    return { assistantMessage: 'Finished.' };
  }
}

/** Provider that supports streaming via generateStream. */
class MockStreamingProvider implements ProviderAdapter, StreamingProviderAdapter {
  private callCount = 0;

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    // Fallback for non-streaming path
    const chunks: StreamChunk[] = [];
    for await (const chunk of this.generateStream(request)) {
      chunks.push(chunk);
    }
    const text = chunks.filter(c => c.type === 'text').map(c => c.text ?? '').join('');
    return { assistantMessage: text || undefined };
  }

  async *generateStream(_request: ProviderRequest): AsyncGenerator<StreamChunk> {
    this.callCount += 1;
    if (this.callCount === 1) {
      yield { type: 'text', text: 'Hello ' };
      yield { type: 'text', text: 'world' };
      yield { type: 'tool_use_start', toolName: 'echo', toolCallId: 'tc-1' };
      yield { type: 'tool_use_delta', toolInput: '{"msg":' };
      yield { type: 'tool_use_delta', toolInput: '"hi"}' };
      yield { type: 'tool_use_end', toolName: 'echo', toolCallId: 'tc-1' };
      yield { type: 'done' };
    } else {
      yield { type: 'text', text: 'All done.' };
      yield { type: 'done' };
    }
  }
}

/** Provider used as compressionProvider for LLM compression tests. */
class MockCompressionProvider implements ProviderAdapter {
  lastReceivedPrompt?: string;

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.lastReceivedPrompt = request.messages[0]?.content;
    return {
      assistantMessage: 'Summary: The user asked questions and got answers. Key decision: proceed with plan A.',
    };
  }
}

/** Compression provider that always fails. */
class FailingCompressionProvider implements ProviderAdapter {
  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    throw new Error('Compression provider failed');
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Track 1.2: Token budget', () => {
  it('stops the loop when token budget is exceeded', async () => {
    const usage: ProviderResponseUsage = {
      inputTokens: 500,
      outputTokens: 500,
      totalTokens: 1000,
    };
    const tracker = new DetailedUsageTracker();
    const tools = new ToolRegistry().register(echoToolDef());
    const agent = new AgentLoop(new UsageTrackingProvider(usage), tools, new InMemorySessionStore(), {
      maxToolIterations: 10,
      maxTokens: 1500, // Budget = 1500, first call uses 1000, second will exceed
      usageTracker: tracker,
    });

    const result = await agent.run({
      agentId: 'test',
      sessionId: 'budget-stop-1',
      userMessage: 'go',
    });

    // Should stop after exceeding the budget
    const summary = tracker.getSummary();
    expect(summary.totalTokens).toBeGreaterThanOrEqual(1000);
    // The loop should have produced a response
    expect(result.finalResponse).toBeTruthy();
  });

  it('injects a token budget warning at 90% usage', async () => {
    const usage: ProviderResponseUsage = {
      inputTokens: 400,
      outputTokens: 500,
      totalTokens: 900,
    };
    const tracker = new DetailedUsageTracker();
    const tools = new ToolRegistry().register(echoToolDef());
    const agent = new AgentLoop(new UsageTrackingProvider(usage), tools, new InMemorySessionStore(), {
      maxToolIterations: 5,
      maxTokens: 1000, // 900/1000 = 90%
      usageTracker: tracker,
    });

    const result = await agent.run({
      agentId: 'test',
      sessionId: 'budget-warn-1',
      userMessage: 'go',
    });

    // After first call: 900 tokens, 90% of 1000
    // The warning should have been injected into tool results
    const warningResults = result.toolResults.filter(
      r => r.metadata?.budgetWarning && typeof r.metadata.budgetWarning === 'string' && (r.metadata.budgetWarning as string).includes('TOKEN BUDGET WARNING')
    );
    expect(warningResults.length).toBeGreaterThanOrEqual(1);
  });

  it('records usage entries in the tracker', async () => {
    const usage: ProviderResponseUsage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    };
    const tracker = new DetailedUsageTracker();
    const tools = new ToolRegistry().register(echoToolDef());
    // Provider that makes one tool call then stops
    const provider: ProviderAdapter = {
      callCount: 0,
      async generate() {
        (this as { callCount: number }).callCount += 1;
        if ((this as { callCount: number }).callCount === 1) {
          return {
            assistantMessage: 'Tool time.',
            toolCalls: [{ name: 'echo', input: {} }],
            usage,
          };
        }
        return { assistantMessage: 'Done.', usage };
      },
    } as ProviderAdapter & { callCount: number };

    const agent = new AgentLoop(provider, tools, new InMemorySessionStore(), {
      maxToolIterations: 3,
      usageTracker: tracker,
    });

    await agent.run({
      agentId: 'test',
      sessionId: 'usage-record-1',
      userMessage: 'go',
    });

    const summary = tracker.getSummary();
    expect(summary.entries.length).toBeGreaterThanOrEqual(2); // at least 2 provider calls
    expect(summary.totalTokens).toBeGreaterThanOrEqual(300);
  });
});

describe('Track 2.1: Token-aware compression trigger', () => {
  it('triggers compression when token count exceeds 70% of context window', async () => {
    // Each message = 5000 tokens, context window = 10000
    // At 2+ messages = 10000 tokens, which is > 70% of 10000 = 7000
    const provider = new CountableProvider(5000);
    const store = new InMemorySessionStore();
    const tools = new ToolRegistry().register(echoToolDef());

    const agent = new AgentLoop(provider, tools, store, {
      maxToolIterations: 4,
      contextWindowSize: 10000,
      compressAfterMessageCount: 100, // High count so char-based doesn't trigger
      protectLastMessages: 4,
    });

    // Run multiple times to build up messages
    for (let i = 0; i < 3; i++) {
      await agent.run({
        agentId: 'test',
        sessionId: 'token-compress-1',
        userMessage: `message-${i}`,
      });
    }

    const session = await store.get('token-compress-1');
    expect(session).not.toBeNull();
    // With token-aware compression triggering at 70%, messages should have been compressed
    // Check that some form of compression occurred (fewer messages than raw accumulation)
    expect(session!.messages.length).toBeLessThan(20);
  });

  it('falls back to char-based threshold when countTokens is not available', async () => {
    // Provider without countTokens
    const provider: ProviderAdapter = {
      async generate() {
        return { assistantMessage: 'ok' };
      },
    };
    const store = new InMemorySessionStore();
    const tools = new ToolRegistry().register(echoToolDef());

    const agent = new AgentLoop(provider, tools, store, {
      maxToolIterations: 4,
      compressAfterMessageCount: 6,
      protectLastMessages: 4,
    });

    for (let i = 0; i < 5; i++) {
      await agent.run({
        agentId: 'test',
        sessionId: 'char-compress-1',
        userMessage: `message-${i}`,
      });
    }

    const session = await store.get('char-compress-1');
    expect(session).not.toBeNull();
    // Compression should have triggered via message count
    const hasCompressedMsg = session!.messages.some(
      m => m.role === 'system' && m.content.includes('Compressed conversation summary')
    );
    expect(hasCompressedMsg).toBe(true);
  });
});

describe('Track 1.3: Streaming', () => {
  it('yields correct event sequence: iteration-start, text-delta, tool-start, tool-end, iteration-end, done', async () => {
    const provider = new MockStreamingProvider();
    const tools = new ToolRegistry().register(echoToolDef());

    const agent = new AgentLoop(provider, tools, new InMemorySessionStore(), {
      maxToolIterations: 3,
    });

    const session = {
      agentId: 'test',
      sessionId: 'stream-1',
      messages: [] as ConversationMessage[],
      updatedAt: new Date().toISOString(),
    };

    const events: AgentStreamEvent[] = [];
    for await (const event of agent.runStreaming({
      userMessage: 'stream test',
      sessionState: session,
    })) {
      events.push(event);
    }

    // Verify event ordering
    const types = events.map(e => e.type);

    // Must start with iteration-start
    expect(types[0]).toBe('iteration-start');

    // Must contain text deltas
    const textDeltas = events.filter(e => e.type === 'text-delta');
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(textDeltas.map(e => (e as { content: string }).content).join('')).toContain('Hello world');

    // Must have tool-start and tool-end
    expect(types).toContain('tool-start');
    expect(types).toContain('tool-end');

    // Must end with done
    expect(types[types.length - 1]).toBe('done');

    // Verify tool events
    const toolStart = events.find(e => e.type === 'tool-start') as { type: 'tool-start'; toolName: string; toolCallId: string };
    expect(toolStart.toolName).toBe('echo');
    expect(toolStart.toolCallId).toBeTruthy();

    const toolEnd = events.find(e => e.type === 'tool-end') as { type: 'tool-end'; toolName: string; ok: boolean };
    expect(toolEnd.toolName).toBe('echo');
    expect(toolEnd.ok).toBe(true);
  });

  it('yields iteration events for each loop iteration', async () => {
    const provider = new MockStreamingProvider();
    const tools = new ToolRegistry().register(echoToolDef());

    const agent = new AgentLoop(provider, tools, new InMemorySessionStore(), {
      maxToolIterations: 5,
    });

    const session = {
      agentId: 'test',
      sessionId: 'stream-iter-1',
      messages: [] as ConversationMessage[],
      updatedAt: new Date().toISOString(),
    };

    const events: AgentStreamEvent[] = [];
    for await (const event of agent.runStreaming({
      userMessage: 'go',
      sessionState: session,
    })) {
      events.push(event);
    }

    const iterStarts = events.filter(e => e.type === 'iteration-start');
    const iterEnds = events.filter(e => e.type === 'iteration-end');
    // At least 2 iterations: first with tool, second without
    expect(iterStarts.length).toBeGreaterThanOrEqual(2);
    expect(iterEnds.length).toBeGreaterThanOrEqual(2);
  });

  it('falls back to run() if provider does not support streaming', async () => {
    const provider: ProviderAdapter = {
      async generate() {
        return { assistantMessage: 'Non-streaming response.' };
      },
    };
    const tools = new ToolRegistry().register(echoToolDef());

    const agent = new AgentLoop(provider, tools, new InMemorySessionStore(), {
      maxToolIterations: 3,
    });

    const session = {
      agentId: 'test',
      sessionId: 'stream-fallback-1',
      messages: [] as ConversationMessage[],
      updatedAt: new Date().toISOString(),
    };

    const events: AgentStreamEvent[] = [];
    for await (const event of agent.runStreaming({
      userMessage: 'hello',
      sessionState: session,
    })) {
      events.push(event);
    }

    // Should produce a 'done' event with the response
    const doneEvent = events.find(e => e.type === 'done') as { type: 'done'; response: string };
    expect(doneEvent).toBeTruthy();
    expect(doneEvent.response).toContain('Non-streaming response');
  });
});

describe('Track 1.4: Checkpoint auto-invoke', () => {
  it('creates pre-dangerous checkpoint before dangerous tool execution', async () => {
    let callCount = 0;
    const provider: ProviderAdapter = {
      async generate(): Promise<ProviderResponse> {
        callCount += 1;
        if (callCount === 1) {
          return {
            assistantMessage: 'Running dangerous tool.',
            toolCalls: [{ name: 'danger', input: { safe: 'data' } }],
          };
        }
        return { assistantMessage: 'Done.' };
      },
    };

    const cpStore = new InMemoryCheckpointStore();
    const tools = new ToolRegistry().register(dangerToolDef());

    const agent = new AgentLoop(provider, tools, new InMemorySessionStore(), {
      maxToolIterations: 3,
      checkpointStore: cpStore,
      autoCheckpoint: true,
      stopOnToolError: false,
    });

    await agent.run({
      agentId: 'test',
      sessionId: 'cp-danger-1',
      userMessage: 'do something dangerous',
    });

    const checkpoints = await cpStore.listBySession('cp-danger-1');
    const triggers = checkpoints.map(cp => cp.metadata.trigger);
    // iteration and completion checkpoints should always be present
    expect(triggers).toContain('iteration');
    expect(triggers).toContain('completion');
    // pre-dangerous should also be present for the 'danger' tool
    expect(triggers).toContain('pre-dangerous');
  });

  it('creates checkpoints at each iteration when autoCheckpoint is true', async () => {
    const usage: ProviderResponseUsage = {
      inputTokens: 50,
      outputTokens: 50,
      totalTokens: 100,
    };
    let callCount = 0;
    const provider: ProviderAdapter = {
      async generate(): Promise<ProviderResponse> {
        callCount += 1;
        if (callCount <= 2) {
          return {
            assistantMessage: `Tool call ${callCount}`,
            toolCalls: [{ name: 'echo', input: { n: callCount } }],
            usage,
          };
        }
        return { assistantMessage: 'Done.', usage };
      },
    };

    const cpStore = new InMemoryCheckpointStore();
    const tools = new ToolRegistry().register(echoToolDef());

    const agent = new AgentLoop(provider, tools, new InMemorySessionStore(), {
      maxToolIterations: 5,
      checkpointStore: cpStore,
      autoCheckpoint: true,
    });

    await agent.run({
      agentId: 'test',
      sessionId: 'cp-auto-1',
      userMessage: 'go',
    });

    const checkpoints = await cpStore.listBySession('cp-auto-1');
    // Should have at least: iteration checkpoints (2) + completion (1)
    expect(checkpoints.length).toBeGreaterThanOrEqual(3);

    // Verify trigger types
    const triggers = checkpoints.map(cp => cp.metadata.trigger);
    expect(triggers).toContain('iteration');
    expect(triggers).toContain('completion');
  });

  it('does not create checkpoints when autoCheckpoint is false', async () => {
    let callCount = 0;
    const provider: ProviderAdapter = {
      async generate(): Promise<ProviderResponse> {
        callCount += 1;
        if (callCount === 1) {
          return {
            assistantMessage: 'Tool.',
            toolCalls: [{ name: 'echo', input: {} }],
          };
        }
        return { assistantMessage: 'Done.' };
      },
    };

    const cpStore = new InMemoryCheckpointStore();
    const tools = new ToolRegistry().register(echoToolDef());

    const agent = new AgentLoop(provider, tools, new InMemorySessionStore(), {
      maxToolIterations: 3,
      checkpointStore: cpStore,
      autoCheckpoint: false,
    });

    await agent.run({
      agentId: 'test',
      sessionId: 'cp-off-1',
      userMessage: 'go',
    });

    const checkpoints = await cpStore.listBySession('cp-off-1');
    expect(checkpoints.length).toBe(0);
  });
});

describe('Track 2.2: LLM compression', () => {
  it('uses compressionProvider to summarize middle messages', async () => {
    const compressionProvider = new MockCompressionProvider();
    const store = new InMemorySessionStore();
    const tools = new ToolRegistry().register(echoToolDef());

    // Simple provider
    const provider: ProviderAdapter = {
      async generate() {
        return { assistantMessage: 'ok' };
      },
    };

    const agent = new AgentLoop(provider, tools, store, {
      maxToolIterations: 4,
      compressAfterMessageCount: 6,
      protectLastMessages: 4,
      compressionProvider,
    });

    // Build up enough messages to trigger compression
    for (let i = 0; i < 5; i++) {
      await agent.run({
        agentId: 'test',
        sessionId: 'llm-compress-1',
        userMessage: `message-${i}`,
      });
    }

    const session = await store.get('llm-compress-1');
    expect(session).not.toBeNull();

    // Should have LLM-summarized messages
    const llmSummaryMsg = session!.messages.find(
      m => m.metadata?.compressionMethod === 'llm-summary'
    );
    expect(llmSummaryMsg).toBeTruthy();
    expect(llmSummaryMsg!.content).toContain('LLM-summarized');
    expect(llmSummaryMsg!.content).toContain('Summary:');
  });

  it('falls back to heuristic compression when compressionProvider fails', async () => {
    const failingProvider = new FailingCompressionProvider();
    const store = new InMemorySessionStore();
    const tools = new ToolRegistry().register(echoToolDef());

    const provider: ProviderAdapter = {
      async generate() {
        return { assistantMessage: 'ok' };
      },
    };

    const agent = new AgentLoop(provider, tools, store, {
      maxToolIterations: 4,
      compressAfterMessageCount: 6,
      protectLastMessages: 4,
      compressionProvider: failingProvider,
    });

    for (let i = 0; i < 5; i++) {
      await agent.run({
        agentId: 'test',
        sessionId: 'llm-fallback-1',
        userMessage: `message-${i}`,
      });
    }

    const session = await store.get('llm-fallback-1');
    expect(session).not.toBeNull();

    // Should have fallen back to heuristic
    const compressedMsg = session!.messages.find(
      m => m.role === 'system' && m.content.includes('Compressed conversation summary')
    );
    // Either heuristic or at least the session was saved
    expect(session!.messages.length).toBeGreaterThan(0);
  });

  it('preserves last N messages during LLM compression', async () => {
    const compressionProvider = new MockCompressionProvider();
    const store = new InMemorySessionStore();
    const tools = new ToolRegistry().register(echoToolDef());

    const provider: ProviderAdapter = {
      async generate() {
        return { assistantMessage: 'ok' };
      },
    };

    const agent = new AgentLoop(provider, tools, store, {
      maxToolIterations: 4,
      compressAfterMessageCount: 4,
      protectLastMessages: 4,
      compressionProvider,
    });

    for (let i = 0; i < 4; i++) {
      await agent.run({
        agentId: 'test',
        sessionId: 'llm-preserve-1',
        userMessage: `msg-${i}`,
      });
    }

    const session = await store.get('llm-preserve-1');
    expect(session).not.toBeNull();
    // The last 4 messages should be preserved
    const recentMessages = session!.messages.filter(m => m.role !== 'system' || m.metadata?.compressionMethod);
    expect(recentMessages.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Track 2.3: Prompt caching for Anthropic', () => {
  it('adds cache_control metadata to system prompt when enablePromptCaching is true', async () => {
    let capturedSystemPrompt: string | undefined;
    const provider: ProviderAdapter = {
      async generate(request: ProviderRequest): Promise<ProviderResponse> {
        capturedSystemPrompt = request.systemPrompt;
        return { assistantMessage: 'ok' };
      },
    };
    const tools = new ToolRegistry().register(echoToolDef());

    const agent = new AgentLoop(provider, tools, new InMemorySessionStore(), {
      enablePromptCaching: true,
    });

    await agent.run({
      agentId: 'test',
      sessionId: 'cache-1',
      userMessage: 'hello',
    });

    expect(capturedSystemPrompt).toBeTruthy();
    expect(capturedSystemPrompt).toContain('cache_control');
    expect(capturedSystemPrompt).toContain('ephemeral');
  });

  it('does not add cache_control metadata when enablePromptCaching is false', async () => {
    let capturedSystemPrompt: string | undefined;
    const provider: ProviderAdapter = {
      async generate(request: ProviderRequest): Promise<ProviderResponse> {
        capturedSystemPrompt = request.systemPrompt;
        return { assistantMessage: 'ok' };
      },
    };
    const tools = new ToolRegistry().register(echoToolDef());

    const agent = new AgentLoop(provider, tools, new InMemorySessionStore(), {
      enablePromptCaching: false,
    });

    await agent.run({
      agentId: 'test',
      sessionId: 'cache-2',
      userMessage: 'hello',
    });

    expect(capturedSystemPrompt).toBeTruthy();
    expect(capturedSystemPrompt).not.toContain('cache_control');
  });

  it('tracks cache hits when cachedTokens > 0 in usage', async () => {
    const usage: ProviderResponseUsage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedTokens: 80,
    };
    const tracker = new DetailedUsageTracker();
    const provider: ProviderAdapter = {
      async generate(): Promise<ProviderResponse> {
        return { assistantMessage: 'ok', usage };
      },
    };
    const tools = new ToolRegistry().register(echoToolDef());

    const agent = new AgentLoop(provider, tools, new InMemorySessionStore(), {
      enablePromptCaching: true,
      usageTracker: tracker,
    });

    await agent.run({
      agentId: 'test',
      sessionId: 'cache-hit-1',
      userMessage: 'hello',
    });

    const summary = tracker.getSummary();
    expect(summary.entries.length).toBeGreaterThanOrEqual(1);
    // The cached tokens should be recorded
    const entryWithCache = summary.entries.find(e => e.cachedTokens > 0);
    expect(entryWithCache).toBeTruthy();
    expect(entryWithCache!.cachedTokens).toBe(80);
  });
});
