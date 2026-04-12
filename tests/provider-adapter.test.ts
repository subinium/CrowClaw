import { describe, expect, it } from 'vitest';
import { parseSlashToolCall } from '@crowclaw/core';
import { EchoProvider } from '@crowclaw/providers';

describe('provider adapters', () => {
  it('parses slash tool commands consistently', () => {
    expect(parseSlashToolCall('/tool echo {"value":"hi"}')).toEqual({
      name: 'echo',
      input: { value: 'hi' }
    });
  });

  it('echo provider emits tool calls for slash commands', async () => {
    const provider = new EchoProvider();
    const result = await provider.generate({
      messages: [{ role: 'user', content: '/tool echo {"value":"hi"}', createdAt: new Date().toISOString() }],
      availableTools: []
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]?.name).toBe('echo');
  });
});
