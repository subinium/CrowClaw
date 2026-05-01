/**
 * E2E Agent Quality Tests
 *
 * Tests that the agent loop correctly:
 * 1. Selects and executes tools based on user intent
 * 2. Maintains context across multiple turns
 * 3. Utilizes frozen memory in responses
 * 4. Matches and applies relevant skills
 * 5. Handles tool errors gracefully
 * 6. Preserves key facts through compression
 *
 * Uses a ScriptedProvider that returns predetermined responses
 * to test agent behavior deterministically without a real LLM.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop, type ProviderAdapter, type ProviderRequest, type ProviderResponse, type ConversationMessage } from '../packages/core/src/index.js';
import { ToolRegistry, type ToolDefinition } from '../packages/tools/src/index.js';
import { InMemorySessionStore } from '../packages/storage/src/index.js';

// ---------------------------------------------------------------------------
// ScriptedProvider: returns predetermined responses based on turn number
// ---------------------------------------------------------------------------

function createScriptedProvider(responses: Array<{
  text?: string;
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
}>): ProviderAdapter {
  let turnIndex = 0;
  return {
    generate(request: ProviderRequest): Promise<ProviderResponse> {
      const response = responses[turnIndex] ?? responses[responses.length - 1];
      turnIndex++;
      return Promise.resolve({
        assistantMessage: response?.text,
        toolCalls: response?.toolCalls,
      });
    },
    getModel() { return 'scripted-test'; },
  };
}

// ---------------------------------------------------------------------------
// Test tools
// ---------------------------------------------------------------------------

function createTestTools(): ToolRegistry {
  const registry = new ToolRegistry();

  const searchTool: ToolDefinition = {
    manifest: {
      name: 'web.search', description: 'Search the web',
      runtime: 'worker', streaming: false, stateful: false,
      requiresWorkspace: false, requiresNetwork: true, dangerLevel: 'low',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
    async execute(input) {
      return {
        toolName: 'web.search', runtime: 'worker', ok: true,
        output: JSON.stringify({ results: [{ title: `Result for: ${input.query}`, url: 'https://example.com' }] }),
      };
    },
  };

  const writeTool: ToolDefinition = {
    manifest: {
      name: 'workspace.write', description: 'Write a file',
      runtime: 'worker', streaming: false, stateful: true,
      requiresWorkspace: true, requiresNetwork: false, dangerLevel: 'medium',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    },
    async execute(input) {
      return {
        toolName: 'workspace.write', runtime: 'worker', ok: true,
        output: `Written ${(input.content as string).length} bytes to ${input.path}`,
      };
    },
  };

  const failingTool: ToolDefinition = {
    manifest: {
      name: 'db.query', description: 'Query database',
      runtime: 'worker', streaming: false, stateful: false,
      requiresWorkspace: false, requiresNetwork: true, dangerLevel: 'low',
      inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    },
    async execute() {
      return {
        toolName: 'db.query', runtime: 'worker', ok: false,
        output: 'Error: connection refused',
      };
    },
  };

  registry.register(searchTool);
  registry.register(writeTool);
  registry.register(failingTool);
  return registry;
}

// ---------------------------------------------------------------------------
// 1. Tool selection based on user intent
// ---------------------------------------------------------------------------

describe('Agent tool selection', () => {
  it('executes the tool the provider selects and returns result in context', async () => {
    const provider = createScriptedProvider([
      { toolCalls: [{ name: 'web.search', input: { query: 'TypeScript agent frameworks' } }] },
      { text: 'Based on the search results, here are the top frameworks.' },
    ]);

    const store = new InMemorySessionStore();
    const loop = new AgentLoop(provider, createTestTools(), store);

    const result = await loop.run({
      agentId: 'test', sessionId: 'tool-select-1',
      userMessage: 'Search for TypeScript agent frameworks',
      systemPrompt: 'You are a helpful assistant.',
    });

    expect(result.toolResults.length).toBeGreaterThanOrEqual(1);
    expect(result.toolResults[0].toolName).toBe('web.search');
    expect(result.toolResults[0].ok).toBe(true);
    expect(result.finalResponse).toContain('frameworks');
  });

  it('handles multiple sequential tool calls', async () => {
    const provider = createScriptedProvider([
      { toolCalls: [{ name: 'web.search', input: { query: 'best practices' } }] },
      { toolCalls: [{ name: 'workspace.write', input: { path: 'notes.md', content: '# Best Practices\n- Use TypeScript' } }] },
      { text: 'I searched and wrote the notes.' },
    ]);

    const store = new InMemorySessionStore();
    const loop = new AgentLoop(provider, createTestTools(), store);

    const result = await loop.run({
      agentId: 'test', sessionId: 'multi-tool-1',
      userMessage: 'Research best practices and save to notes.md',
      systemPrompt: 'You are a helpful assistant.',
    });

    expect(result.toolResults.length).toBe(2);
    expect(result.toolResults[0].toolName).toBe('web.search');
    expect(result.toolResults[1].toolName).toBe('workspace.write');
    expect(result.finalResponse).toContain('notes');
  });
});

// ---------------------------------------------------------------------------
// 2. Multi-turn context preservation
// ---------------------------------------------------------------------------

describe('Multi-turn context', () => {
  it('preserves conversation history across turns', async () => {
    const store = new InMemorySessionStore();
    const tools = createTestTools();

    // Turn 1
    const provider1 = createScriptedProvider([{ text: 'My name is CrowClaw.' }]);
    const loop1 = new AgentLoop(provider1, tools, store);
    await loop1.run({
      agentId: 'test', sessionId: 'context-1',
      userMessage: 'What is your name?',
      systemPrompt: 'Your name is CrowClaw.',
    });

    // Turn 2 - verify context carries over
    let capturedMessages: ConversationMessage[] = [];
    const provider2: ProviderAdapter = {
      generate(request: ProviderRequest) {
        capturedMessages = request.messages;
        return Promise.resolve({ assistantMessage: 'Yes, I am CrowClaw.' });
      },
      getModel() { return 'capture-test'; },
    };
    const loop2 = new AgentLoop(provider2, tools, store);
    await loop2.run({
      agentId: 'test', sessionId: 'context-1',
      userMessage: 'Do you remember your name?',
      systemPrompt: 'Your name is CrowClaw.',
    });

    // Provider should receive prior messages
    expect(capturedMessages.length).toBeGreaterThanOrEqual(3); // system + user1 + assistant1 + user2
    const contents = capturedMessages.map(m => m.content).join(' ');
    expect(contents).toContain('What is your name');
    expect(contents).toContain('CrowClaw');
  });
});

// ---------------------------------------------------------------------------
// 3. Memory injection into context
// ---------------------------------------------------------------------------

describe('Memory utilization', () => {
  it('injects recalled memories as untrusted context in messages (not system prompt)', async () => {
    let capturedMessages: ConversationMessage[] = [];
    let capturedSystemPrompt = '';
    const provider: ProviderAdapter = {
      generate(request: ProviderRequest) {
        capturedMessages = request.messages;
        capturedSystemPrompt = request.systemPrompt ?? '';
        return Promise.resolve({ assistantMessage: 'Got it.' });
      },
      getModel() { return 'memory-test'; },
    };

    const store = new InMemorySessionStore();
    const loop = new AgentLoop(provider, createTestTools(), store);

    await loop.run({
      agentId: 'test', sessionId: 'mem-1',
      userMessage: 'Hello',
      systemPrompt: 'You are helpful.',
      memories: ['User prefers Korean', 'Project: CrowClaw v0.3.1'],
    });

    // Memories should NOT be in the system prompt (security: untrusted prefix pattern)
    expect(capturedSystemPrompt).not.toContain('User prefers Korean');

    // Memories should be in the messages array as a recalled-context block
    const memoryMsg = capturedMessages.find(m => m.content.includes('recalled-context'));
    expect(memoryMsg).toBeDefined();
    expect(memoryMsg!.content).toContain('User prefers Korean');
    expect(memoryMsg!.content).toContain('CrowClaw v0.3.1');
  });
});

// ---------------------------------------------------------------------------
// 4. Skill matching and application
// ---------------------------------------------------------------------------

describe('Skill matching', () => {
  it('includes matched skill instructions in user-role envelope', async () => {
    let capturedMessages: ConversationMessage[] = [];
    const provider: ProviderAdapter = {
      generate(request: ProviderRequest) {
        capturedMessages = request.messages;
        return Promise.resolve({ assistantMessage: 'Done.' });
      },
      getModel() { return 'skill-test'; },
    };

    const store = new InMemorySessionStore();
    const loop = new AgentLoop(provider, createTestTools(), store, {
      skills: [{
        manifest: {
          name: 'code-review',
          description: 'Reviews code for bugs and style',
          triggers: ['review this code', 'code review'],
          tools: ['workspace.read'],
        },
        instructions: '1. Read the code\n2. Check for bugs\n3. Suggest improvements',
        raw: '',
      }],
    });

    await loop.run({
      agentId: 'test', sessionId: 'skill-1',
      userMessage: 'Please review this code for me',
      systemPrompt: 'You are helpful.',
    });

    // v0.8.0 (#230): skills inject as a user-role message instead of into
    // the system prompt — keeps the system prompt byte-stable for prefix
    // caching. The skill content lives in a `<crowclaw-skills>` envelope.
    const skillMsg = capturedMessages.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('<crowclaw-skills>'),
    );
    expect(skillMsg).toBeDefined();
    expect(skillMsg?.content as string).toContain('code-review');
    expect(skillMsg?.content as string).toContain('Check for bugs');
  });
});

// ---------------------------------------------------------------------------
// 5. Error recovery
// ---------------------------------------------------------------------------

describe('Error recovery', () => {
  it('agent continues after tool failure', async () => {
    const provider = createScriptedProvider([
      { toolCalls: [{ name: 'db.query', input: { sql: 'SELECT 1' } }] },
      { text: 'The database query failed. Let me try a different approach.' },
    ]);

    const store = new InMemorySessionStore();
    const loop = new AgentLoop(provider, createTestTools(), store);

    const result = await loop.run({
      agentId: 'test', sessionId: 'error-1',
      userMessage: 'Query the database',
      systemPrompt: 'You are helpful.',
    });

    expect(result.toolResults.length).toBe(1);
    expect(result.toolResults[0].ok).toBe(false);
    expect(result.finalResponse).toContain('failed');
  });
});

// ---------------------------------------------------------------------------
// 6. Session state persistence
// ---------------------------------------------------------------------------

describe('Session persistence', () => {
  it('session state survives across agent runs', async () => {
    const store = new InMemorySessionStore();
    const tools = createTestTools();

    // Run 1: establish context
    const p1 = createScriptedProvider([{ text: 'I will remember that you like Python.' }]);
    await new AgentLoop(p1, tools, store).run({
      agentId: 'test', sessionId: 'persist-1',
      userMessage: 'I like Python',
      systemPrompt: 'Remember user preferences.',
    });

    // Verify session was saved
    const session = await store.get('persist-1');
    expect(session).not.toBeNull();
    expect(session!.messages.length).toBeGreaterThanOrEqual(2); // user + assistant (system is injected at request time)

    // Run 2: session carries forward
    const p2 = createScriptedProvider([{ text: 'Yes, you mentioned Python.' }]);
    const result = await new AgentLoop(p2, tools, store).run({
      agentId: 'test', sessionId: 'persist-1',
      userMessage: 'What do I like?',
      systemPrompt: 'Remember user preferences.',
    });

    const updatedSession = await store.get('persist-1');
    expect(updatedSession!.messages.length).toBeGreaterThan(session!.messages.length);
  });
});

// ---------------------------------------------------------------------------
// 7. Max iterations enforcement
// ---------------------------------------------------------------------------

describe('Iteration limits', () => {
  it('stops after maxToolIterations even if provider keeps calling tools', async () => {
    // Provider that always calls tools (never gives a text response)
    const infiniteToolProvider: ProviderAdapter = {
      generate() {
        return Promise.resolve({
          toolCalls: [{ name: 'web.search', input: { query: 'infinite loop' } }],
        });
      },
      getModel() { return 'infinite-test'; },
    };

    const store = new InMemorySessionStore();
    const loop = new AgentLoop(infiniteToolProvider, createTestTools(), store, {
      maxToolIterations: 3,
      synthesizeOnExhaustion: true,
    });

    const result = await loop.run({
      agentId: 'test', sessionId: 'limit-1',
      userMessage: 'Search forever',
      systemPrompt: 'You are helpful.',
    });

    // Should stop at 3 iterations
    expect(result.toolResults.length).toBeLessThanOrEqual(3);
    // Should have a final response (synthesized)
    expect(result.session.messages.length).toBeGreaterThan(0);
  });
});
