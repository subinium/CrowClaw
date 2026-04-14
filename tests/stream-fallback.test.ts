import { describe, it, expect } from 'vitest';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  ConversationMessage,
  AgentStreamEvent,
} from '@crowclaw/core';
import { AgentLoop } from '@crowclaw/core';
import type { StreamingProviderAdapter } from '@crowclaw/core/streaming';
import type { StreamChunk } from '@crowclaw/core/streaming';
import { ToolRegistry } from '@crowclaw/tools';
import { InMemorySessionStore } from '@crowclaw/storage';

// ---------------------------------------------------------------------------
// Mock providers
// ---------------------------------------------------------------------------

/** Streaming provider that always fails on generateStream. */
class FailingStreamProvider implements ProviderAdapter, StreamingProviderAdapter {
  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    throw new Error('Primary provider failed');
  }

  async *generateStream(_request: ProviderRequest): AsyncGenerator<StreamChunk> {
    throw new Error('Primary stream failed');
  }
}

/** Streaming provider that succeeds and yields a simple text response. */
class SuccessStreamProvider implements ProviderAdapter, StreamingProviderAdapter {
  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    return { assistantMessage: 'Fallback response' };
  }

  async *generateStream(_request: ProviderRequest): AsyncGenerator<StreamChunk> {
    yield { type: 'text', text: 'Fallback ' };
    yield { type: 'text', text: 'succeeded' };
    yield { type: 'done' };
  }
}

/** Streaming provider that also fails (for testing all-providers-fail scenario). */
class SecondFailingStreamProvider implements ProviderAdapter, StreamingProviderAdapter {
  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    throw new Error('Second provider also failed');
  }

  async *generateStream(_request: ProviderRequest): AsyncGenerator<StreamChunk> {
    throw new Error('Second stream also failed');
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stream fallback', () => {
  it('primary stream fails, fallback provider is used', async () => {
    const primary = new FailingStreamProvider();
    const fallback = new SuccessStreamProvider();
    const tools = new ToolRegistry();

    const agent = new AgentLoop(primary, tools, new InMemorySessionStore(), {
      maxToolIterations: 2,
      fallbackProviders: [fallback],
    });

    const session = {
      agentId: 'test',
      sessionId: 'stream-fb-1',
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

    const types = events.map((e) => e.type);

    // Should contain an error event for the primary failure
    const errorEvents = events.filter((e) => e.type === 'error') as Array<{ type: 'error'; error: string }>;
    expect(errorEvents.some((e) => e.error.includes('falling back'))).toBe(true);

    // Should have text-delta events from the fallback provider
    const textDeltas = events.filter((e) => e.type === 'text-delta') as Array<{ type: 'text-delta'; content: string }>;
    const fullText = textDeltas.map((e) => e.content).join('');
    expect(fullText).toContain('Fallback succeeded');

    // Should eventually produce a done event
    expect(types).toContain('done');
  });

  it('all providers fail, error event is yielded', async () => {
    const primary = new FailingStreamProvider();
    const secondFallback = new SecondFailingStreamProvider();
    const tools = new ToolRegistry();

    const agent = new AgentLoop(primary, tools, new InMemorySessionStore(), {
      maxToolIterations: 2,
      fallbackProviders: [secondFallback],
    });

    const session = {
      agentId: 'test',
      sessionId: 'stream-fb-fail-1',
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

    const types = events.map((e) => e.type);

    // Should have error events
    expect(types).toContain('error');

    // The last meaningful event should be an error (the stream terminates)
    const errorEvents = events.filter((e) => e.type === 'error') as Array<{ type: 'error'; error: string }>;
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);

    // Should NOT have a done event since all providers failed
    const doneEvents = events.filter((e) => e.type === 'done');
    expect(doneEvents).toHaveLength(0);
  });
});
