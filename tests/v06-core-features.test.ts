import { describe, expect, it, vi } from 'vitest';
import type {
  ConversationMessage,
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  SessionState,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from '@crowclaw/core';
import {
  AgentLoop,
  CommandTamperedError,
  forkSession,
  freezeCommand,
  getForkEnabledToolsets,
  hasReasoningContent,
  isApprovedCommand,
  isToolAllowedForFork,
  stripReasoningContent,
  verifyCommand,
} from '@crowclaw/core';
import { PluginManager, type Plugin, type PreToolCallVeto, type ToolResultTransform } from '@crowclaw/plugins';
import { InMemorySessionStore } from '@crowclaw/storage';
import { ToolRegistry } from '@crowclaw/tools';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const echoToolDef: ToolDefinition = {
  manifest: {
    name: 'echo',
    description: 'Echo back input.',
    runtime: 'worker',
    streaming: false,
    stateful: false,
    requiresWorkspace: false,
    requiresNetwork: false,
    dangerLevel: 'low',
  },
  async execute(input: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    return {
      toolName: 'echo',
      runtime: 'worker',
      ok: true,
      output: `echo:${JSON.stringify(input)}`,
    };
  },
};

class CallOnceTool implements ToolDefinition {
  manifest = echoToolDef.manifest;
  async execute(input: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    return { toolName: 'echo', runtime: 'worker', ok: true, output: `out:${JSON.stringify(input)}` };
  }
}

/** Provider that runs `echo` once then settles. Used to drive a single tool iteration. */
class OneToolProvider implements ProviderAdapter {
  private called = 0;
  async generate(_req: ProviderRequest): Promise<ProviderResponse> {
    this.called += 1;
    if (this.called === 1) {
      return { assistantMessage: 'calling echo', toolCalls: [{ name: 'echo', input: { x: 1 } }] };
    }
    return { assistantMessage: 'final answer' };
  }
}

// ---------------------------------------------------------------------------
// #83: stripReasoningContent
// ---------------------------------------------------------------------------

describe('#83 stripReasoningContent', () => {
  it('removes well-formed <think> blocks from assistant messages', () => {
    const messages: ConversationMessage[] = [
      { role: 'user', content: 'hi', createdAt: '0' },
      {
        role: 'assistant',
        content: '<think>internal monologue here</think>\nHello!',
        createdAt: '0',
      },
    ];
    const out = stripReasoningContent(messages, 'deepseek', 'kimi');
    expect(out[1].content).toBe('Hello!');
    expect(hasReasoningContent(out[1])).toBe(false);
  });

  it('removes <reasoning> blocks (Hermes variant)', () => {
    const messages: ConversationMessage[] = [
      { role: 'assistant', content: '<reasoning>plan</reasoning>visible answer', createdAt: '0' },
    ];
    const out = stripReasoningContent(messages, 'hermes', 'anthropic');
    expect(out[0].content).toBe('visible answer');
  });

  it('strips trailing unclosed <think> tag (provider truncation)', () => {
    const messages: ConversationMessage[] = [
      { role: 'assistant', content: 'partial answer<think>still thinking', createdAt: '0' },
    ];
    const out = stripReasoningContent(messages, 'deepseek', 'kimi');
    expect(out[0].content).toBe('partial answer');
  });

  it('drops reasoningContent metadata', () => {
    const messages: ConversationMessage[] = [
      {
        role: 'assistant',
        content: 'visible',
        createdAt: '0',
        metadata: { reasoningContent: 'hidden cot', other: 'keep' },
      },
    ];
    const out = stripReasoningContent(messages, 'openai', 'anthropic');
    expect(out[0].metadata).toEqual({ other: 'keep' });
  });

  it('does not touch user/tool/system messages even when they contain <think> literals', () => {
    const messages: ConversationMessage[] = [
      { role: 'user', content: '<think>this is data</think>', createdAt: '0' },
      { role: 'tool', content: '<think>scraped page</think>', createdAt: '0', name: 'web.fetch' },
    ];
    const out = stripReasoningContent(messages, 'a', 'b');
    expect(out[0].content).toContain('<think>');
    expect(out[1].content).toContain('<think>');
  });

  it('returns the same array reference when nothing changes (no allocation)', () => {
    const messages: ConversationMessage[] = [
      { role: 'user', content: 'hi', createdAt: '0' },
      { role: 'assistant', content: 'no reasoning here', createdAt: '0' },
    ];
    const out = stripReasoningContent(messages, 'a', 'b');
    expect(out).toBe(messages);
  });

  it('hooks into the loop on fallback: messages handed to the fallback contain no <think>', async () => {
    // Primary returns a response with reasoning baked into the assistant message,
    // then errors. Fallback should never see the <think> block.
    const seenByFallback: ConversationMessage[][] = [];

    class PrimaryWithThinking implements ProviderAdapter {
      private calls = 0;
      async generate(req: ProviderRequest): Promise<ProviderResponse> {
        this.calls += 1;
        if (this.calls === 1) {
          // Pretend the assistant message has reasoning baked in. The agent
          // loop appends this assistant message into `nextMessages` before
          // the next iteration.
          return {
            assistantMessage: '<think>plan plan plan</think>Calling echo.',
            toolCalls: [{ name: 'echo', input: { step: 1 } }],
          };
        }
        throw new Error('primary down');
      }
    }
    class Fallback implements ProviderAdapter {
      async generate(req: ProviderRequest): Promise<ProviderResponse> {
        seenByFallback.push(req.messages.map((m) => ({ ...m })));
        return { assistantMessage: 'fallback done' };
      }
    }

    const tools = new ToolRegistry().register(echoToolDef);
    const agent = new AgentLoop(new PrimaryWithThinking(), tools, new InMemorySessionStore(), {
      providerName: 'deepseek',
      fallbackProviders: [new Fallback()],
      fallbackProviderNames: ['kimi'],
    });
    await agent.run({
      agentId: 'a',
      sessionId: 'sw-1',
      userMessage: 'go',
    });

    // Fallback was invoked at least once.
    expect(seenByFallback.length).toBeGreaterThan(0);
    const allText = seenByFallback
      .flat()
      .map((m) => m.content)
      .join('\n');
    expect(allText).not.toMatch(/<think>/i);
  });
});

// ---------------------------------------------------------------------------
// #84: forkSession enabledToolsets
// ---------------------------------------------------------------------------

describe('#84 forkSession enabledToolsets', () => {
  const parent: SessionState = {
    agentId: 'parent',
    sessionId: 'parent-1',
    messages: [],
    updatedAt: '0',
  };

  it('legacy string suffix still works (backward compatible)', () => {
    // Legacy callers passed a bare suffix string as the 4th arg.
    const child = forkSession(parent, 'task', 'child-agent', 'my-suffix');
    expect(child.sessionId).toBe('parent-1/my-suffix');
    expect(getForkEnabledToolsets(child)).toBeUndefined();
  });

  it('records enabledToolsets on the child seed message', () => {
    const child = forkSession(parent, 'task', 'reviewer', {
      enabledToolsets: ['memory', 'skills'],
      purpose: 'background-review',
    });
    expect(getForkEnabledToolsets(child)).toEqual(['memory', 'skills']);
    expect(child.messages[0].metadata?.forkPurpose).toBe('background-review');
  });

  it('isToolAllowedForFork respects exact + prefix matches', () => {
    const child = forkSession(parent, 'task', 'reviewer', {
      enabledToolsets: ['memory', 'skills.match'],
    });
    expect(isToolAllowedForFork(child, 'memory.recall')).toBe(true);
    expect(isToolAllowedForFork(child, 'memory.store')).toBe(true);
    expect(isToolAllowedForFork(child, 'skills.match')).toBe(true);
    expect(isToolAllowedForFork(child, 'skills.list')).toBe(false);
    expect(isToolAllowedForFork(child, 'terminal.exec')).toBe(false);
  });

  it('empty whitelist locks down all tools', () => {
    const child = forkSession(parent, 'task', 'reviewer', { enabledToolsets: [] });
    expect(getForkEnabledToolsets(child)).toEqual([]);
    expect(isToolAllowedForFork(child, 'memory.recall')).toBe(false);
    expect(isToolAllowedForFork(child, 'echo')).toBe(false);
  });

  it('unrestricted fork allows every tool (legacy behavior preserved)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const child = forkSession(parent, 'task', 'reviewer');
    expect(isToolAllowedForFork(child, 'terminal.exec')).toBe(true);
    expect(isToolAllowedForFork(child, 'anything.at.all')).toBe(true);
    // Warning fires when no restriction is set so operators notice.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not warn when an explicit (even empty) restriction is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    forkSession(parent, 'task', 'reviewer', { enabledToolsets: [] });
    forkSession(parent, 'task', 'reviewer', { enabledToolsets: ['memory'] });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// #95: pre_tool_call veto + transform_tool_result
// ---------------------------------------------------------------------------

describe('#95 plugin pre_tool_call veto + transform_tool_result', () => {
  it('a pre_tool_call veto blocks the tool from running', async () => {
    let executed = false;
    const tool: ToolDefinition = {
      manifest: { ...echoToolDef.manifest, name: 'observed' },
      async execute() {
        executed = true;
        return { toolName: 'observed', runtime: 'worker', ok: true, output: 'ran' };
      },
    };

    const vetoer: Plugin = {
      name: 'gatekeeper',
      preToolCall(): PreToolCallVeto {
        return { veto: true, reason: 'not on tuesday' };
      },
    };
    const plugins = new PluginManager().register(vetoer);

    class P implements ProviderAdapter {
      private c = 0;
      async generate(): Promise<ProviderResponse> {
        this.c += 1;
        if (this.c === 1) return { assistantMessage: 'go', toolCalls: [{ name: 'observed', input: {} }] };
        return { assistantMessage: 'done' };
      }
    }

    const tools = new ToolRegistry().register(tool);
    const agent = new AgentLoop(new P(), tools, new InMemorySessionStore(), { plugins });
    const result = await agent.run({ agentId: 'a', sessionId: 's-veto', userMessage: 'hi' });

    expect(executed).toBe(false);
    expect(result.toolResults[0].ok).toBe(false);
    expect(result.toolResults[0].output).toContain('vetoed by plugin');
    expect(result.toolResults[0].output).toContain('not on tuesday');
    expect(result.toolResults[0].metadata?.vetoedByPlugin).toBe(true);
  });

  it('any single veto across multiple plugins short-circuits (OR-aggregate)', async () => {
    const allow: Plugin = { name: 'allow', preToolCall: () => ({ veto: false }) };
    const deny: Plugin = {
      name: 'deny',
      preToolCall: () => ({ veto: true, reason: 'policy' }),
    };
    const plugins = new PluginManager().register(allow).register(deny);

    let executed = false;
    const tool: ToolDefinition = {
      manifest: { ...echoToolDef.manifest, name: 'guarded' },
      async execute() {
        executed = true;
        return { toolName: 'guarded', runtime: 'worker', ok: true, output: 'ran' };
      },
    };
    class P implements ProviderAdapter {
      private c = 0;
      async generate(): Promise<ProviderResponse> {
        this.c += 1;
        if (this.c === 1) return { assistantMessage: 'go', toolCalls: [{ name: 'guarded', input: {} }] };
        return { assistantMessage: 'done' };
      }
    }
    const agent = new AgentLoop(new P(), new ToolRegistry().register(tool), new InMemorySessionStore(), { plugins });
    const result = await agent.run({ agentId: 'a', sessionId: 's-veto2', userMessage: 'hi' });

    expect(executed).toBe(false);
    expect(result.toolResults[0].metadata?.vetoReason).toContain('policy');
  });

  it('a buggy plugin that throws in preToolCall does not block the call', async () => {
    const bad: Plugin = { name: 'bad', preToolCall: () => { throw new Error('boom'); } };
    const plugins = new PluginManager().register(bad);

    let executed = false;
    const tool: ToolDefinition = {
      manifest: { ...echoToolDef.manifest, name: 'hit' },
      async execute() {
        executed = true;
        return { toolName: 'hit', runtime: 'worker', ok: true, output: 'ok' };
      },
    };
    class P implements ProviderAdapter {
      private c = 0;
      async generate(): Promise<ProviderResponse> {
        this.c += 1;
        if (this.c === 1) return { assistantMessage: 'go', toolCalls: [{ name: 'hit', input: {} }] };
        return { assistantMessage: 'done' };
      }
    }
    const agent = new AgentLoop(new P(), new ToolRegistry().register(tool), new InMemorySessionStore(), { plugins });
    await agent.run({ agentId: 'a', sessionId: 's-bad', userMessage: 'hi' });
    expect(executed).toBe(true);
  });

  it('transform_tool_result mutates output before it lands in conversation history', async () => {
    const upper: Plugin = {
      name: 'upper',
      transformToolResult(payload): ToolResultTransform {
        return { output: payload.result.output.toUpperCase() };
      },
    };
    const plugins = new PluginManager().register(upper);
    const tools = new ToolRegistry().register(echoToolDef);
    const agent = new AgentLoop(new OneToolProvider(), tools, new InMemorySessionStore(), { plugins });
    const result = await agent.run({ agentId: 'a', sessionId: 's-tr', userMessage: 'hi' });
    expect(result.toolResults[0].output).toBe('ECHO:{"X":1}'); // input keys upper too
  });

  it('multiple transform plugins compose in registration order', async () => {
    const plugins = new PluginManager()
      .register({
        name: 'add-prefix',
        transformToolResult: (p) => ({ output: `[a]${p.result.output}` }),
      })
      .register({
        name: 'add-suffix',
        transformToolResult: (p) => ({ output: `${p.result.output}[b]` }),
      });
    const tools = new ToolRegistry().register(echoToolDef);
    const agent = new AgentLoop(new OneToolProvider(), tools, new InMemorySessionStore(), { plugins });
    const result = await agent.run({ agentId: 'a', sessionId: 's-tr2', userMessage: 'hi' });
    expect(result.toolResults[0].output).toMatch(/^\[a\]echo:.+\[b\]$/);
  });

  it('transform plugins see redacted output, never raw secrets', async () => {
    const sniffed: string[] = [];
    const sniffer: Plugin = {
      name: 'sniffer',
      transformToolResult: (p) => {
        sniffed.push(p.result.output);
        return undefined;
      },
    };
    const plugins = new PluginManager().register(sniffer);
    const leaky: ToolDefinition = {
      manifest: { ...echoToolDef.manifest, name: 'leaky' },
      async execute() {
        return {
          toolName: 'leaky',
          runtime: 'worker',
          ok: true,
          // OpenAI-style key — should be redacted by the core layer before
          // any plugin sees it.
          output: 'token: sk-' + 'A'.repeat(48),
        };
      },
    };
    class P implements ProviderAdapter {
      private c = 0;
      async generate(): Promise<ProviderResponse> {
        this.c += 1;
        if (this.c === 1) return { assistantMessage: 'go', toolCalls: [{ name: 'leaky', input: {} }] };
        return { assistantMessage: 'done' };
      }
    }
    const agent = new AgentLoop(new P(), new ToolRegistry().register(leaky), new InMemorySessionStore(), { plugins });
    await agent.run({ agentId: 'a', sessionId: 's-redact', userMessage: 'hi' });
    expect(sniffed[0]).not.toMatch(/sk-[A-Z]{40,}/);
  });
});

// ---------------------------------------------------------------------------
// #79: contextInjection: 'never'
// ---------------------------------------------------------------------------

describe('#79 contextInjection', () => {
  it("'auto' (default) injects runtime context + tool list into system prompt", async () => {
    let seenSystem: string | undefined;
    class CapturingProvider implements ProviderAdapter {
      async generate(req: ProviderRequest): Promise<ProviderResponse> {
        seenSystem = req.systemPrompt;
        return { assistantMessage: 'done' };
      }
    }
    const tools = new ToolRegistry().register(echoToolDef);
    const agent = new AgentLoop(new CapturingProvider(), tools, new InMemorySessionStore());
    await agent.run({
      agentId: 'a',
      sessionId: 's-auto',
      userMessage: 'hi',
      systemPrompt: 'You are an assistant.',
    });
    expect(seenSystem).toContain('Runtime context');
    expect(seenSystem).toContain('Available tools');
    expect(seenSystem).toContain('You are an assistant.');
  });

  it("'never' suppresses runtime context + tool list but keeps caller-supplied basePrompt", async () => {
    let seenSystem: string | undefined;
    class CapturingProvider implements ProviderAdapter {
      async generate(req: ProviderRequest): Promise<ProviderResponse> {
        seenSystem = req.systemPrompt;
        return { assistantMessage: 'done' };
      }
    }
    const tools = new ToolRegistry().register(echoToolDef);
    const agent = new AgentLoop(new CapturingProvider(), tools, new InMemorySessionStore(), {
      contextInjection: 'never',
    });
    await agent.run({
      agentId: 'a',
      sessionId: 's-never',
      userMessage: 'hi',
      systemPrompt: 'You are the prompt owner.',
    });
    expect(seenSystem).toContain('You are the prompt owner.');
    expect(seenSystem).not.toContain('Runtime context');
    expect(seenSystem).not.toContain('Available tools');
    expect(seenSystem).not.toContain('Approach:'); // reasoning guidance suppressed
  });
});

// ---------------------------------------------------------------------------
// #66: ApprovedCommand
// ---------------------------------------------------------------------------

describe('#66 ApprovedCommand', () => {
  it('freezeCommand produces a frozen, hash-bound value object', async () => {
    const cmd = await freezeCommand({ command: 'rm', args: ['-rf', '/tmp/x'] });
    expect(isApprovedCommand(cmd)).toBe(true);
    expect(cmd.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(cmd)).toBe(true);
    expect(Object.isFrozen(cmd.args)).toBe(true);
  });

  it('verifyCommand passes for an unmodified ApprovedCommand', async () => {
    const cmd = await freezeCommand({ command: 'echo', args: ['hello'] });
    await expect(verifyCommand(cmd)).resolves.toBeUndefined();
  });

  it('verifyCommand throws CommandTamperedError when bytes are forged', async () => {
    const cmd = await freezeCommand({ command: 'echo', args: ['hello'] });
    // Simulate an attacker who hand-rolls a forged ApprovedCommand by reusing
    // a real hash but swapping in different argv bytes. The frozen original
    // can't be mutated, so we build the forgery as a parallel object with
    // the same shape.
    const forged = {
      ...cmd,
      args: ['rm', '-rf', '/'], // tampered argv
    } as typeof cmd;
    await expect(verifyCommand(forged)).rejects.toBeInstanceOf(CommandTamperedError);
  });

  it('verifyCommand rejects non-ApprovedCommand inputs', async () => {
    await expect(verifyCommand({} as never)).rejects.toBeInstanceOf(CommandTamperedError);
  });

  it('canonicalization: equivalent inputs (same env, different key order) hash equally', async () => {
    const a = await freezeCommand({ command: 'node', args: ['x'], env: { B: '2', A: '1' } });
    const b = await freezeCommand({ command: 'node', args: ['x'], env: { A: '1', B: '2' } });
    expect(a.hash).toBe(b.hash);
  });

  it('different argv produces different hash', async () => {
    const a = await freezeCommand({ command: 'rm', args: ['-rf', '/tmp'] });
    const b = await freezeCommand({ command: 'rm', args: ['-rf', '/'] });
    expect(a.hash).not.toBe(b.hash);
  });

  it('caller mutating the source argv array AFTER freeze does not affect the frozen copy', async () => {
    const argv = ['safe', 'arg'];
    const cmd = await freezeCommand({ command: 'echo', args: argv });
    argv[1] = 'EVIL'; // attacker mutates their reference
    // Frozen copy is unchanged, hash still verifies.
    expect(cmd.args[1]).toBe('arg');
    await expect(verifyCommand(cmd)).resolves.toBeUndefined();
  });
});
