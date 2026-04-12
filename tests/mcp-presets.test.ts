import { describe, expect, it } from 'vitest';
import {
  McpClient,
  McpJsonRpcStdioTransport,
  mcpPresets,
  createMcpFromPreset,
} from '../packages/mcp/src/index.js';

describe('McpJsonRpcStdioTransport', () => {
  it('can be constructed with minimal config', () => {
    const transport = new McpJsonRpcStdioTransport({ command: 'echo' });
    expect(transport).toBeInstanceOf(McpJsonRpcStdioTransport);
  });

  it('can be constructed with full config', () => {
    const transport = new McpJsonRpcStdioTransport(
      {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        env: { FOO: 'bar' },
        cwd: '/tmp',
      },
      { requestTimeoutMs: 60_000 }
    );
    expect(transport).toBeInstanceOf(McpJsonRpcStdioTransport);
  });

  it('throws when calling methods before connect', async () => {
    const transport = new McpJsonRpcStdioTransport({ command: 'echo' });
    await expect(transport.listTools()).rejects.toThrow('not connected');
    await expect(transport.callTool('test', {})).rejects.toThrow('not connected');
    await expect(transport.listResources()).rejects.toThrow('not connected');
    await expect(transport.listPrompts()).rejects.toThrow('not connected');
  });
});

describe('MCP presets', () => {
  it('filesystem preset generates correct config', () => {
    const config = mcpPresets.filesystem({ roots: ['/home/user/docs', '/tmp'] });
    expect(config).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/user/docs', '/tmp'],
    });
  });

  it('github preset generates config with token', () => {
    const config = mcpPresets.github({ token: 'ghp_abc123' });
    expect(config).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_abc123' },
    });
  });

  it('github preset generates config without token', () => {
    const config = mcpPresets.github({});
    expect(config).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: undefined,
    });
  });

  it('braveSearch preset generates correct config', () => {
    const config = mcpPresets.braveSearch({ apiKey: 'BSA_key123' });
    expect(config).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-brave-search'],
      env: { BRAVE_API_KEY: 'BSA_key123' },
    });
  });

  it('memory preset generates correct config', () => {
    const config = mcpPresets.memory();
    expect(config).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
    });
  });

  it('puppeteer preset generates correct config', () => {
    const config = mcpPresets.puppeteer();
    expect(config).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    });
  });

  it('fetch preset generates correct config', () => {
    const config = mcpPresets.fetch();
    expect(config).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-fetch'],
    });
  });
});

describe('createMcpFromPreset', () => {
  it('creates an McpClient from a preset', () => {
    const client = createMcpFromPreset('filesystem', { roots: ['/tmp'] });
    expect(client).toBeInstanceOf(McpClient);
  });

  it('creates an McpClient with client options', () => {
    const client = createMcpFromPreset('github', { token: 'ghp_test' }, { toolPrefix: 'gh' });
    expect(client).toBeInstanceOf(McpClient);
  });

  it('creates an McpClient for parameterless presets', () => {
    const client = createMcpFromPreset('memory', undefined as never);
    expect(client).toBeInstanceOf(McpClient);
  });
});

describe('McpClient.fromStdio', () => {
  it('creates an McpClient with a stdio transport', () => {
    const client = McpClient.fromStdio({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] });
    expect(client).toBeInstanceOf(McpClient);
  });

  it('creates an McpClient with client options', () => {
    const client = McpClient.fromStdio(
      { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
      { toolPrefix: 'fs' }
    );
    expect(client).toBeInstanceOf(McpClient);
  });
});
