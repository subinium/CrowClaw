import { describe, it, expect } from 'vitest';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
} from '@crowclaw/core';
import { AgentLoop } from '@crowclaw/core';
import { ToolRegistry } from '@crowclaw/tools';
import { InMemorySessionStore } from '@crowclaw/storage';

// ---------------------------------------------------------------------------
// Mock providers
// ---------------------------------------------------------------------------

/**
 * Provider that throws "context_length_exceeded" on the first call,
 * then succeeds on subsequent calls (after compaction).
 */
class ContextOverflowThenSucceedProvider implements ProviderAdapter {
  private callCount = 0;

  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    this.callCount += 1;
    if (this.callCount === 1) {
      throw new Error('context_length_exceeded: maximum context length is 8192 tokens');
    }
    return { assistantMessage: 'Recovered after compaction.' };
  }
}

/**
 * Provider that always throws "context_length_exceeded".
 * Used to test that recovery fails gracefully when compaction does not help.
 */
class AlwaysOverflowProvider implements ProviderAdapter {
  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    throw new Error('context_length_exceeded: maximum context length is 8192 tokens');
  }
}

/**
 * Provider that throws a non-overflow error (generic error).
 * This should NOT trigger the context overflow recovery path.
 */
class GenericErrorProvider implements ProviderAdapter {
  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    throw new Error('Internal server error: something went wrong');
  }
}

/**
 * Mock compression provider that returns a short summary.
 * This enables the LLM compression path in recoverFromContextOverflow,
 * which is needed because the heuristic path uses messages.length as threshold
 * and therefore cannot actually reduce the message count.
 */
class MockCompressionProvider implements ProviderAdapter {
  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    return {
      assistantMessage: 'Summary: previous conversation about testing.',
    };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('context overflow recovery', () => {
  it('context overflow triggers auto-compact and retry succeeds', async () => {
    const provider = new ContextOverflowThenSucceedProvider();
    const compressionProvider = new MockCompressionProvider();
    const tools = new ToolRegistry();
    const store = new InMemorySessionStore();

    // Pre-seed the session with enough messages to allow compaction
    const sessionId = 'overflow-recover-1';
    await store.put({
      agentId: 'test',
      sessionId,
      messages: Array.from({ length: 20 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `Message ${i}: ${'x'.repeat(100)}`,
        createdAt: new Date(Date.now() - (20 - i) * 1000).toISOString(),
      })),
      updatedAt: new Date().toISOString(),
    });

    const agent = new AgentLoop(provider, tools, store, {
      maxToolIterations: 3,
      compressAfterMessageCount: 10,
      protectLastMessages: 4,
      compressionProvider,
    });

    const result = await agent.run({
      agentId: 'test',
      sessionId,
      userMessage: 'continue our conversation',
    });

    // Should have recovered successfully
    expect(result.finalResponse).toBe('Recovered after compaction.');
    expect(result.session).toBeTruthy();
  });

  it('non-overflow error throws normally and is not caught by recovery', async () => {
    const provider = new GenericErrorProvider();
    const tools = new ToolRegistry();

    const agent = new AgentLoop(provider, tools, new InMemorySessionStore(), {
      maxToolIterations: 3,
    });

    await expect(
      agent.run({
        agentId: 'test',
        sessionId: 'generic-error-1',
        userMessage: 'hello',
      }),
    ).rejects.toThrow('Internal server error');
  });

  it('context overflow with too few messages to compact still throws', async () => {
    // With no pre-seeded messages, compaction cannot help (< 4 messages)
    const provider = new AlwaysOverflowProvider();
    const tools = new ToolRegistry();

    const agent = new AgentLoop(provider, tools, new InMemorySessionStore(), {
      maxToolIterations: 3,
    });

    await expect(
      agent.run({
        agentId: 'test',
        sessionId: 'overflow-no-compact-1',
        userMessage: 'hello',
      }),
    ).rejects.toThrow('context_length_exceeded');
  });
});
