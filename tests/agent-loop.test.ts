import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { ProviderAdapter, ProviderRequest, ProviderResponse, ToolExecutionContext, ToolExecutionResult, AgentEventEmitter, ParsedSkillFile } from '@crowclaw/core';
import { AgentLoop, type ToolDefinition } from '@crowclaw/core';
import { EchoProvider } from '@crowclaw/providers';
import { InMemorySessionStore } from '@crowclaw/storage';
import { ToolRegistry, createEchoTool } from '@crowclaw/tools';

class ScriptedLoopProvider implements ProviderAdapter {
  private callCount = 0;

  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    this.callCount += 1;
    if (this.callCount === 1) {
      return {
        assistantMessage: 'Need first tool.',
        toolCalls: [{ name: 'echo', input: { step: 1 } }]
      };
    }
    if (this.callCount === 2) {
      return {
        assistantMessage: 'Need second tool.',
        toolCalls: [{ name: 'echo', input: { step: 2 } }]
      };
    }
    return {
      assistantMessage: 'All done after multiple tool iterations.'
    };
  }
}

class ToolFailureProvider implements ProviderAdapter {
  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    return {
      assistantMessage: 'Run the missing tool.',
      toolCalls: [{ name: 'missing.tool', input: {} }]
    };
  }
}

class FailingProvider implements ProviderAdapter {
  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    throw new Error('Primary provider failed.');
  }
}

class RetryOnceProvider implements ProviderAdapter {
  private attempts = 0;

  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new Error('Transient failure');
    }
    return { assistantMessage: 'Recovered after retry.' };
  }
}

class AbortAwareProvider implements ProviderAdapter {
  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.signal?.aborted) {
      throw new Error('Provider saw abort');
    }
    return { assistantMessage: 'Should not happen if aborted early.' };
  }
}

function delayedTool(name: string, delayMs: number, dangerLevel: 'low' | 'medium' | 'high' = 'low'): ToolDefinition {
  return {
    manifest: {
      name,
      description: `Delayed tool ${name}`,
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel
    },
    async execute(_input: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        toolName: name,
        runtime: 'worker',
        ok: true,
        output: name
      };
    }
  };
}

class ParallelProvider implements ProviderAdapter {
  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const toolMessages = request.messages.filter((message) => message.role === 'tool');
    if (toolMessages.length === 0) {
      return {
        assistantMessage: 'Run both tools.',
        toolCalls: [
          { name: 'slow', input: {} },
          { name: 'fast', input: {} }
        ]
      };
    }

    return {
      assistantMessage: `Observed order: ${toolMessages.map((message) => message.name).join(',')}`
    };
  }
}

class DangerousToolProvider implements ProviderAdapter {
  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const toolMessages = request.messages.filter((message) => message.role === 'tool');
    if (toolMessages.length > 0) {
      return {
        assistantMessage: 'Dangerous tool handled.'
      };
    }

    return {
      assistantMessage: 'Run the dangerous tool.',
      toolCalls: [{ name: 'danger', input: { command: 'rm -rf /tmp/demo' } }]
    };
  }
}

describe('AgentLoop', () => {
  it('returns a plain response for normal chat input', async () => {
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new EchoProvider(), tools, new InMemorySessionStore());
    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'session-1',
      userMessage: 'hello crowclaw'
    });

    expect(result.finalResponse).toContain('CrowClaw received');
    expect(result.toolResults).toHaveLength(0);
    expect(result.session.messages.at(-1)?.role).toBe('assistant');
  });

  it('falls back to a secondary provider when the primary fails', async () => {
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new FailingProvider(), tools, new InMemorySessionStore(), {
      fallbackProviders: [new EchoProvider()]
    });
    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'fallback-1',
      userMessage: 'fallback me'
    });

    expect(result.finalResponse).toContain('CrowClaw received: fallback me');
  });

  it('retries a transient provider failure before succeeding', async () => {
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new RetryOnceProvider(), tools, new InMemorySessionStore(), {
      retryDelaysMs: [0]
    });
    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'retry-1',
      userMessage: 'retry me'
    });

    expect(result.finalResponse).toContain('Recovered after retry.');
  });

  it('throws if aborted before running', async () => {
    const controller = new AbortController();
    controller.abort();
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new AbortAwareProvider(), tools, new InMemorySessionStore());

    await expect(agent.run({
      agentId: 'crowclaw',
      sessionId: 'abort-1',
      userMessage: 'should abort',
      signal: controller.signal
    })).rejects.toThrow('Agent run aborted.');
  });

  it('runs a tool then asks the provider for a final post-tool answer', async () => {
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new EchoProvider(), tools, new InMemorySessionStore());
    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'session-2',
      // v0.8.0 #235: tool inputs are now validated against `inputSchema`
      // before execution. The echo tool requires `{ message: string }`, so
      // the slash-tool payload must satisfy that shape.
      userMessage: '/tool echo {"message":"world"}'
    });

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]).toMatchObject({
      toolName: 'echo',
      runtime: 'worker',
      ok: true
    });
    expect(result.finalResponse).toContain('Tool echo returned');
  });

  it('continues looping while the provider keeps returning tool calls', async () => {
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new ScriptedLoopProvider(), tools, new InMemorySessionStore(), {
      maxToolIterations: 3
    });

    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'session-3',
      userMessage: 'do the whole workflow'
    });

    expect(result.toolResults).toHaveLength(2);
    expect(result.finalResponse).toContain('All done after multiple tool iterations.');
    expect(result.session.messages.filter((message) => message.role === 'tool')).toHaveLength(2);
  });

  it('stops early on tool failure by default', async () => {
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new ToolFailureProvider(), tools, new InMemorySessionStore(), {
      errorReflection: false,
    });
    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'session-4',
      userMessage: 'run failing tool'
    });

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]?.ok).toBe(false);
    expect(result.finalResponse).toContain('Stopped after tool failure.');
  });

  it('executes concurrent tool calls while preserving declared order in results/messages', async () => {
    const tools = new ToolRegistry()
      .register(delayedTool('slow', 20))
      .register(delayedTool('fast', 1));
    const agent = new AgentLoop(new ParallelProvider(), tools, new InMemorySessionStore(), {
      concurrentToolCalls: true
    });

    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'session-5',
      userMessage: 'run in parallel'
    });

    expect(result.toolResults.map((tool) => tool.toolName)).toEqual(['slow', 'fast']);
    expect(result.finalResponse).toContain('Observed order: slow,fast');
  });

  it('blocks dangerous tools when approval is required and denied', async () => {
    const tools = new ToolRegistry().register(delayedTool('danger', 0, 'high'));
    const agent = new AgentLoop(new DangerousToolProvider(), tools, new InMemorySessionStore(), {
      requireApprovalForDangerousTools: true,
      approvalDecider: async () => false
    });

    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'session-6',
      userMessage: 'run dangerous tool'
    });

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]).toMatchObject({ ok: false });
    expect(result.toolResults[0]?.output).toContain('requires approval');
  });

  it('allows dangerous tools when approval is granted', async () => {
    const tools = new ToolRegistry().register(delayedTool('danger', 0, 'high'));
    const agent = new AgentLoop(new DangerousToolProvider(), tools, new InMemorySessionStore(), {
      requireApprovalForDangerousTools: true,
      approvalDecider: async () => true
    });

    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'session-7',
      userMessage: 'run dangerous tool'
    });

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]).toMatchObject({ ok: true, toolName: 'danger' });
  });

  it('blocks medium-danger inputs that match destructive command patterns when approval is required', async () => {
    const riskyTool: ToolDefinition = {
      manifest: {
        name: 'terminal.exec',
        description: 'Runs shell commands',
        runtime: 'worker',
        streaming: false,
        stateful: false,
        requiresWorkspace: false,
        requiresNetwork: false,
        dangerLevel: 'medium'
      },
      async execute() {
        return { toolName: 'terminal.exec', runtime: 'worker', ok: true, output: 'should not run' };
      }
    };
    const provider: ProviderAdapter = {
      async generate() {
        return {
          assistantMessage: 'Run risky command.',
          toolCalls: [{ name: 'terminal.exec', input: { command: 'rm -rf /tmp/demo' } }]
        };
      }
    };
    const tools = new ToolRegistry().register(riskyTool);
    const agent = new AgentLoop(provider, tools, new InMemorySessionStore(), {
      requireApprovalForDangerousTools: true,
      approvalDecider: async () => false
    });

    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'session-7b',
      userMessage: 'run dangerous pattern'
    });

    expect(result.toolResults[0]?.metadata).toMatchObject({ blockedByApproval: true });
    expect(result.toolResults[0]?.output).toContain('requires approval');
  });

  it('stops when max tool iterations are exhausted', async () => {
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new ScriptedLoopProvider(), tools, new InMemorySessionStore(), {
      maxToolIterations: 1,
      synthesizeOnExhaustion: false,
    });

    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'session-8',
      userMessage: 'loop until capped'
    });

    expect(result.toolResults).toHaveLength(1);
    expect(result.finalResponse).toContain('Reached maximum tool iterations.');
  });
});

// ---------------------------------------------------------------------------
// v0.8.0 Hermes parity — issues #230, #235, #239
// ---------------------------------------------------------------------------

/**
 * Captures the system prompt of every provider call so assertions can compare
 * its byte stability across runs (#230 cache-hit invariant).
 */
class SystemPromptCaptureProvider implements ProviderAdapter {
  public seenSystemPrompts: Array<string | undefined> = [];
  public seenMessageRoles: string[][] = [];
  public seenMessages: ProviderRequest['messages'][] = [];

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.seenSystemPrompts.push(request.systemPrompt);
    this.seenMessageRoles.push(request.messages.map((m) => m.role));
    this.seenMessages.push(request.messages);
    return { assistantMessage: 'ok' };
  }
}

/**
 * Provider that always asks for one tool call. Used for budget-exhaustion and
 * repeated-failure tests.
 */
class AlwaysCallToolProvider implements ProviderAdapter {
  constructor(private toolName: string, private input: Record<string, unknown> = {}) {}
  public seenMessages: ProviderRequest['messages'][] = [];
  public seenAvailableTools: ProviderRequest['availableTools'][] = [];
  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.seenMessages.push(request.messages);
    this.seenAvailableTools.push(request.availableTools);
    if (request.availableTools.length === 0) {
      // Synthesis turn (#239) — return a final text response.
      return { assistantMessage: 'final synthesis response' };
    }
    return {
      assistantMessage: 'calling tool',
      toolCalls: [{ name: this.toolName, input: this.input }],
    };
  }
}

function makeFailingTool(name: string): ToolDefinition {
  return {
    manifest: {
      name,
      description: `${name} always fails`,
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
    },
    async execute(): Promise<ToolExecutionResult> {
      throw new Error(`${name} blew up`);
    },
  };
}

function makeSkillFile(name: string, triggers: string[]): ParsedSkillFile {
  return {
    manifest: { name, description: `desc-${name}`, triggers },
    instructions: `instructions for ${name}`,
    raw: '',
  };
}

class RecordingEventBus implements AgentEventEmitter {
  public events: Array<{ type: string; data: Record<string, unknown> }> = [];
  emit(type: string, data: Record<string, unknown>): void {
    this.events.push({ type, data });
  }
}

describe('AgentLoop v0.8.0 Hermes parity', () => {
  // -------------------------------------------------------------------------
  // #230 — skills as user-role ephemeral messages, system prompt byte-stable
  // -------------------------------------------------------------------------
  it('#230: system prompt is byte-stable across two calls with same skills', async () => {
    const skill = makeSkillFile('vercel-deploy', ['deploy']);
    const tools = new ToolRegistry().register(createEchoTool());
    const provider = new SystemPromptCaptureProvider();
    const store = new InMemorySessionStore();
    const agent = new AgentLoop(provider, tools, store, { skills: [skill] });

    await agent.run({ agentId: 'a', sessionId: 's-230-stable', userMessage: 'please deploy' });
    await agent.run({ agentId: 'a', sessionId: 's-230-stable', userMessage: 'please deploy' });

    expect(provider.seenSystemPrompts.length).toBeGreaterThanOrEqual(2);
    const hashes = provider.seenSystemPrompts.map((p) =>
      createHash('sha256').update(p ?? '').digest('hex'),
    );
    // All system prompts seen must be identical — that is the cache-hit invariant.
    for (const h of hashes) expect(h).toBe(hashes[0]);
  });

  it('#230: skill content is injected as a user-role message, not in system prompt', async () => {
    const skill = makeSkillFile('vercel-deploy', ['deploy']);
    const tools = new ToolRegistry().register(createEchoTool());
    const provider = new SystemPromptCaptureProvider();
    const store = new InMemorySessionStore();
    const agent = new AgentLoop(provider, tools, store, { skills: [skill] });

    await agent.run({ agentId: 'a', sessionId: 's-230-inject', userMessage: 'please deploy' });

    const sysPrompt = provider.seenSystemPrompts[0] ?? '';
    expect(sysPrompt).not.toContain('vercel-deploy');
    expect(sysPrompt).not.toContain('<skill');

    // The first call's messages should include a user-role <crowclaw-skills> envelope.
    const msgs = provider.seenMessages[0];
    const skillMsg = msgs.find(
      (m) => m.role === 'user' && m.content.startsWith('<crowclaw-skills>')
    );
    expect(skillMsg).toBeTruthy();
    expect(skillMsg?.content).toContain('vercel-deploy');
    expect(skillMsg?.content).toContain('instructions for vercel-deploy');
    expect(skillMsg?.metadata?.ephemeral).toBe(true);
    expect(skillMsg?.metadata?.kind).toBe('skill-injection');
  });

  it('#230: skill-injection user message is NOT persisted to session.messages', async () => {
    const skill = makeSkillFile('vercel-deploy', ['deploy']);
    const tools = new ToolRegistry().register(createEchoTool());
    const provider = new SystemPromptCaptureProvider();
    const store = new InMemorySessionStore();
    const agent = new AgentLoop(provider, tools, store, { skills: [skill] });

    const result = await agent.run({
      agentId: 'a',
      sessionId: 's-230-persist',
      userMessage: 'please deploy',
    });

    // No persisted message should be the skill-injection envelope.
    for (const m of result.session.messages) {
      expect(m.content.startsWith('<crowclaw-skills>')).toBe(false);
      expect(m.metadata?.ephemeral).not.toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // #235 — structured tool-error envelope + repeated-failure exit
  // -------------------------------------------------------------------------
  it('#235: tool throw produces a role:tool message with structured envelope', async () => {
    const tools = new ToolRegistry().register(makeFailingTool('boom'));
    // Use a provider that calls boom once, then returns a final text answer.
    let callCount = 0;
    const provider: ProviderAdapter = {
      async generate(): Promise<ProviderResponse> {
        callCount += 1;
        if (callCount === 1) {
          return { assistantMessage: 'calling', toolCalls: [{ name: 'boom', input: {} }] };
        }
        return { assistantMessage: 'all done.' };
      },
    };
    const agent = new AgentLoop(provider, tools, new InMemorySessionStore(), {
      errorReflection: false,
      stopOnToolError: false,
    });

    const result = await agent.run({
      agentId: 'a',
      sessionId: 's-235-envelope',
      userMessage: 'go',
    });

    const toolMsg = result.session.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeTruthy();
    const parsed = JSON.parse(toolMsg!.content);
    expect(parsed.ok).toBe(false);
    expect(parsed.name).toBe('boom');
    expect(parsed.error).toBeTruthy();
    expect(parsed.error.code).toBeDefined();
    expect(parsed.error.message).toContain('blew up');
    expect(parsed.retry_instruction).toContain('Call boom again');
  });

  it('#235: 3 consecutive identical failures terminate with tool_error_terminal and emit tool:repeated_failure', async () => {
    const tools = new ToolRegistry().register(makeFailingTool('boom'));
    const provider = new AlwaysCallToolProvider('boom');
    const eventBus = new RecordingEventBus();
    const agent = new AgentLoop(provider, tools, new InMemorySessionStore(), {
      errorReflection: false,
      stopOnToolError: false,
      maxToolIterations: 10,
      eventBus,
    });

    const result = await agent.run({
      agentId: 'a',
      sessionId: 's-235-streak',
      userMessage: 'do the impossible',
    });

    expect(result.terminationReason).toBe('tool_error_terminal');
    const repeated = eventBus.events.find((e) => e.type === 'tool:repeated_failure');
    expect(repeated).toBeTruthy();
    expect(repeated?.data.toolName).toBe('boom');
    expect(repeated?.data.consecutiveFailures).toBe(3);
    const terminated = eventBus.events.find((e) => e.type === 'agent:terminated');
    expect(terminated).toBeTruthy();
    expect(terminated?.data.reason).toBe('tool_error_terminal');
  });

  // -------------------------------------------------------------------------
  // #239 — graceful budget soft-landing with structured envelope
  // -------------------------------------------------------------------------
  it('#239: iteration cap injects <budget_exhausted> system message and terminates with budget_exhausted_with_synthesis', async () => {
    const tools = new ToolRegistry().register(createEchoTool());
    const provider = new AlwaysCallToolProvider('echo', { message: 'ping' });
    const eventBus = new RecordingEventBus();
    const agent = new AgentLoop(provider, tools, new InMemorySessionStore(), {
      maxToolIterations: 2,
      synthesizeOnExhaustion: true,
      eventBus,
    });

    const result = await agent.run({
      agentId: 'a',
      sessionId: 's-239-cap',
      userMessage: 'loop forever',
    });

    expect(result.terminationReason).toBe('budget_exhausted_with_synthesis');

    // The provider's last call should have been a synthesis turn (no tools)
    // whose history contained the <budget_exhausted> envelope.
    const lastCallMsgs = provider.seenMessages[provider.seenMessages.length - 1];
    const budgetMarker = lastCallMsgs.find(
      (m) =>
        m.role === 'system' &&
        m.content.includes('<budget_exhausted') &&
        m.content.includes('reason="iteration_cap"'),
    );
    expect(budgetMarker).toBeTruthy();
    // The marker should also be flagged ephemeral so it isn't persisted.
    expect(budgetMarker?.metadata?.ephemeral).toBe(true);

    const lastAvailableTools = provider.seenAvailableTools[provider.seenAvailableTools.length - 1];
    expect(lastAvailableTools.length).toBe(0);

    const terminated = eventBus.events.find((e) => e.type === 'agent:terminated');
    expect(terminated?.data.reason).toBe('budget_exhausted_with_synthesis');

    // Persisted messages must NOT contain the ephemeral budget marker.
    for (const m of result.session.messages) {
      expect(m.content.includes('<budget_exhausted')).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // #181 (v0.8.4) — skill:matched event for the dashboard chip row
  // -------------------------------------------------------------------------
  it('#181: emits skill:matched with matched triggers + reasons before the loop runs', async () => {
    const skill = makeSkillFile('vercel-deploy', ['deploy']);
    const tools = new ToolRegistry().register(createEchoTool());
    const provider = new EchoProvider();
    const store = new InMemorySessionStore();
    const eventBus = new RecordingEventBus();
    const agent = new AgentLoop(provider, tools, store, {
      skills: [skill],
      eventBus,
    });

    await agent.run({
      agentId: 'a',
      sessionId: 's-181-event',
      userMessage: 'please deploy to production',
    });

    const matched = eventBus.events.find((e) => e.type === 'skill:matched');
    expect(matched).toBeTruthy();
    expect(matched?.data.sessionId).toBe('s-181-event');
    const matches = matched?.data.matches as Array<{ name: string; matchedTriggers: string[]; reasons: string[]; score: number }>;
    expect(Array.isArray(matches)).toBe(true);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.name).toBe('vercel-deploy');
    expect(matches[0]!.matchedTriggers).toContain('deploy');
    expect(matches[0]!.score).toBeGreaterThan(0);
    expect(matches[0]!.reasons.length).toBeGreaterThan(0);
  });

  it('#181: does NOT emit skill:matched when no skills match', async () => {
    const skill = makeSkillFile('git-commit-workflow', ['commit code']);
    const tools = new ToolRegistry().register(createEchoTool());
    const provider = new EchoProvider();
    const store = new InMemorySessionStore();
    const eventBus = new RecordingEventBus();
    const agent = new AgentLoop(provider, tools, store, {
      skills: [skill],
      eventBus,
    });

    await agent.run({
      agentId: 'a',
      sessionId: 's-181-no-match',
      userMessage: 'tell me a joke about ducks',
    });

    const matched = eventBus.events.find((e) => e.type === 'skill:matched');
    expect(matched).toBeFalsy();
  });
});
