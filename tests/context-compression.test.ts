import { describe, expect, it } from 'vitest';
import { AgentLoop } from '@crowclaw/core';
import { EchoProvider } from '@crowclaw/providers';
import { InMemorySessionStore } from '@crowclaw/storage';
import { ToolRegistry, createEchoTool } from '@crowclaw/tools';

describe('context compression semantics', () => {
  it('compresses older messages into a summary while preserving the latest ones', async () => {
    const tools = new ToolRegistry().register(createEchoTool());
    const store = new InMemorySessionStore();
    const agent = new AgentLoop(new EchoProvider(), tools, store, {
      compressAfterMessageCount: 6,
      protectLastMessages: 4
    });

    for (let i = 0; i < 4; i += 1) {
      await agent.run({
        agentId: 'crowclaw',
        sessionId: 'compress-1',
        userMessage: `message-${i}`
      });
    }

    const session = await store.get('compress-1');
    expect(session).not.toBeNull();
    expect(session?.messages[0]?.role).toBe('system');
    expect(session?.messages[0]?.content).toContain('Compressed conversation summary');
    expect(session?.messages.some((message) => message.content.includes('message-3'))).toBe(true);
  });

  it('tracks compression lineage metadata when compression occurs', async () => {
    const tools = new ToolRegistry().register(createEchoTool());
    const store = new InMemorySessionStore();
    const agent = new AgentLoop(new EchoProvider(), tools, store, {
      compressAfterMessageCount: 6,
      protectLastMessages: 4
    });

    for (let i = 0; i < 4; i += 1) {
      await agent.run({
        agentId: 'crowclaw',
        sessionId: 'compress-2',
        userMessage: `message-${i}`
      });
    }

    const session = await store.get('compress-2');
    expect(session?.lineage?.rootSessionId).toBe('compress-2');
    expect(session?.lineage?.compressionCount).toBeGreaterThan(0);
    expect(session?.lineage?.compressedMessageCount).toBeGreaterThan(0);
  });
});
