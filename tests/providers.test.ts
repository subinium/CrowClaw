import { describe, expect, it } from 'vitest';
import type { ProviderRequest } from '@crowclaw/core';
import { EchoProvider } from '@crowclaw/providers';

const baseRequest: ProviderRequest = {
  messages: [{ role: 'user', content: '', createdAt: new Date().toISOString() }],
  availableTools: [
    {
      name: 'terminal.exec',
      description: 'executes shell commands',
      runtime: 'sandbox',
      streaming: true,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: false,
      dangerLevel: 'high'
    }
  ]
};

describe('EchoProvider tool shortcut parsing', () => {
  it('coerces raw terminal shortcuts into command input', async () => {
    const provider = new EchoProvider();
    const response = await provider.generate({
      ...baseRequest,
      messages: [{ role: 'user', content: '/tool terminal.exec pwd', createdAt: new Date().toISOString() }]
    });

    expect(response.toolCalls?.[0]).toEqual({ name: 'terminal.exec', input: { command: 'pwd' } });
  });

  it('returns a helpful error for unknown tools', async () => {
    const provider = new EchoProvider();
    const response = await provider.generate({
      ...baseRequest,
      messages: [{ role: 'user', content: '/tool missing {}', createdAt: new Date().toISOString() }]
    });

    expect(response.assistantMessage).toContain('Unknown tool');
    expect(response.toolCalls).toBeUndefined();
  });

  it('treats non-JSON terminal arguments as a command shortcut', async () => {
    const provider = new EchoProvider();
    const response = await provider.generate({
      ...baseRequest,
      messages: [{ role: 'user', content: '/tool terminal.exec pwd', createdAt: new Date().toISOString() }]
    });

    expect(response.toolCalls?.[0]).toEqual({
      name: 'terminal.exec',
      input: { command: 'pwd' }
    });
  });
});
