/**
 * #302 (v0.9.0 Hermes parity): `transformLLMOutput` plugin lifecycle hook.
 *
 * Acceptance criteria from the issue, all verified below:
 *   - Plugin replacing the LLM message body sees that replacement reach the
 *     tool extractor (the assistant message stored in `session.messages`
 *     is the plugin-rewritten one, not the raw model output).
 *   - Plugin returning `null` triggers retry, increments a counter, and
 *     logs `plugin:llm_output_dropped`.
 *   - Plugin throw doesn't kill the chain; subsequent plugins still run.
 *   - Redaction runs AFTER plugin transforms (verified by injecting a fake
 *     credential into plugin output → still redacted in stored history).
 */

import { describe, expect, it } from 'vitest';
import {
  AgentLoop,
  PluginManager,
  type AssistantMessage,
  type LLMOutputTransform,
  type LLMOutputTurn,
  type Plugin,
  type PluginContext,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResponse,
} from '@crowclaw/core';
import { InMemorySessionStore } from '@crowclaw/storage';
import { ToolRegistry } from '@crowclaw/tools';

class StaticProvider implements ProviderAdapter {
  public callCount = 0;
  constructor(private readonly response: () => ProviderResponse) {}
  async generate(_req: ProviderRequest): Promise<ProviderResponse> {
    this.callCount += 1;
    return this.response();
  }
}

function makeLoop(provider: ProviderAdapter, plugins: PluginManager) {
  return new AgentLoop(provider, new ToolRegistry(), new InMemorySessionStore(), {
    plugins,
    runtimeName: 'node',
    maxToolIterations: 1,
    // Disable redaction by default; specific tests opt in.
    securityPolicy: { redactToolOutput: false },
  });
}

describe('Plugin.transformLLMOutput (#302)', () => {
  it('replaces the assistant message body before it reaches the conversation history', async () => {
    const provider = new StaticProvider(() => ({ assistantMessage: 'raw model output' }));
    const plugin: Plugin = {
      name: 'rewriter',
      transformLLMOutput(payload: { turn: LLMOutputTurn; raw: AssistantMessage }, _ctx: PluginContext): LLMOutputTransform {
        return { assistantMessage: 'rewritten by plugin' };
      },
    };
    const plugins = new PluginManager().register(plugin);
    const loop = makeLoop(provider, plugins);

    const result = await loop.run({
      agentId: 'crowclaw',
      sessionId: 's1',
      userMessage: 'hi',
    });

    expect(result.finalResponse).toBe('rewritten by plugin');
    const lastAssistant = result.session.messages.filter((m) => m.role === 'assistant').pop();
    expect(lastAssistant?.content).toBe('rewritten by plugin');
  });

  it('chains plugins in registration order — later sees earlier output', async () => {
    const provider = new StaticProvider(() => ({ assistantMessage: 'A' }));
    const order: string[] = [];
    const p1: Plugin = {
      name: 'one',
      transformLLMOutput(payload): LLMOutputTransform {
        order.push(`one saw: ${payload.raw.assistantMessage}`);
        return { assistantMessage: `${payload.raw.assistantMessage}-B` };
      },
    };
    const p2: Plugin = {
      name: 'two',
      transformLLMOutput(payload): LLMOutputTransform {
        order.push(`two saw: ${payload.raw.assistantMessage}`);
        return { assistantMessage: `${payload.raw.assistantMessage}-C` };
      },
    };
    const plugins = new PluginManager().register(p1).register(p2);
    const loop = makeLoop(provider, plugins);

    const result = await loop.run({ agentId: 'crowclaw', sessionId: 's2', userMessage: 'hi' });
    expect(order).toEqual(['one saw: A', 'two saw: A-B']);
    expect(result.finalResponse).toBe('A-B-C');
  });

  it('drops the turn on null and triggers a retry (counter + dropped event)', async () => {
    let providerCalls = 0;
    const provider: ProviderAdapter = {
      async generate(): Promise<ProviderResponse> {
        providerCalls += 1;
        return { assistantMessage: providerCalls === 1 ? 'drop-me' : 'keep-me' };
      },
    };
    let dropEvents = 0;
    let droppedPlugin = '';
    const dropper: Plugin = {
      name: 'dropper',
      on(hook, payload) {
        if (hook === 'plugin:llm_output_dropped') {
          dropEvents += 1;
          droppedPlugin = (payload as { pluginName: string }).pluginName;
        }
      },
      transformLLMOutput(payload): LLMOutputTransform {
        if (payload.raw.assistantMessage === 'drop-me') return null;
        return undefined;
      },
    };
    const plugins = new PluginManager().register(dropper);
    const loop = makeLoop(provider, plugins);

    const result = await loop.run({ agentId: 'crowclaw', sessionId: 's3', userMessage: 'hi' });
    expect(providerCalls).toBe(2);
    expect(dropEvents).toBe(1);
    expect(droppedPlugin).toBe('dropper');
    expect(result.finalResponse).toBe('keep-me');
  });

  it('honours `{ drop: true, reason }` shape and surfaces the reason in the event', async () => {
    let providerCalls = 0;
    const provider: ProviderAdapter = {
      async generate(): Promise<ProviderResponse> {
        providerCalls += 1;
        return { assistantMessage: providerCalls === 1 ? 'bad' : 'good' };
      },
    };
    let lastReason: string | undefined;
    const dropper: Plugin = {
      name: 'reason-dropper',
      on(hook, payload) {
        if (hook === 'plugin:llm_output_dropped') {
          lastReason = (payload as { reason?: string }).reason;
        }
      },
      transformLLMOutput(payload): LLMOutputTransform {
        if (payload.raw.assistantMessage === 'bad') return { drop: true, reason: 'profanity-detected' };
        return undefined;
      },
    };
    const loop = makeLoop(provider, new PluginManager().register(dropper));
    await loop.run({ agentId: 'crowclaw', sessionId: 's3b', userMessage: 'hi' });
    expect(lastReason).toBe('profanity-detected');
  });

  it('passes through unchanged when plugin throws — subsequent plugins still run', async () => {
    const provider = new StaticProvider(() => ({ assistantMessage: 'start' }));
    const ran: string[] = [];
    const thrower: Plugin = {
      name: 'thrower',
      transformLLMOutput(): LLMOutputTransform {
        ran.push('thrower');
        throw new Error('boom');
      },
    };
    const after: Plugin = {
      name: 'after',
      transformLLMOutput(payload): LLMOutputTransform {
        ran.push(`after:${payload.raw.assistantMessage}`);
        return { assistantMessage: `${payload.raw.assistantMessage}-survived` };
      },
    };
    const plugins = new PluginManager().register(thrower).register(after);
    const loop = makeLoop(provider, plugins);
    const result = await loop.run({ agentId: 'crowclaw', sessionId: 's4', userMessage: 'hi' });
    expect(ran).toEqual(['thrower', 'after:start']);
    expect(result.finalResponse).toBe('start-survived');
  });

  it('redacts credentials injected by a plugin — redaction runs AFTER the chain', async () => {
    const provider = new StaticProvider(() => ({ assistantMessage: 'clean text' }));
    // Plugin injects a fake AWS access key into the assistant text. The core
    // redaction pass must scrub it before the message lands in history.
    const injector: Plugin = {
      name: 'credential-injector',
      transformLLMOutput(): LLMOutputTransform {
        return { assistantMessage: 'leak AKIAIOSFODNN7EXAMPLE here' };
      },
    };
    const loop = new AgentLoop(provider, new ToolRegistry(), new InMemorySessionStore(), {
      plugins: new PluginManager().register(injector),
      runtimeName: 'node',
      maxToolIterations: 1,
      securityPolicy: { redactToolOutput: true },
    });
    const result = await loop.run({ agentId: 'crowclaw', sessionId: 's5', userMessage: 'hi' });
    expect(result.finalResponse).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result.finalResponse).toMatch(/redacted|REDACTED|\*\*\*/i);
  });

  it('returning `undefined` from a plugin leaves the running message unchanged', async () => {
    const provider = new StaticProvider(() => ({ assistantMessage: 'unchanged' }));
    const noop: Plugin = {
      name: 'noop',
      transformLLMOutput(): LLMOutputTransform {
        return undefined;
      },
    };
    const loop = makeLoop(provider, new PluginManager().register(noop));
    const result = await loop.run({ agentId: 'crowclaw', sessionId: 's6', userMessage: 'hi' });
    expect(result.finalResponse).toBe('unchanged');
  });

  it('falls through after `maxLLMOutputRetries` consecutive drops (no infinite loop)', async () => {
    let providerCalls = 0;
    const provider: ProviderAdapter = {
      async generate(): Promise<ProviderResponse> {
        providerCalls += 1;
        return { assistantMessage: 'always-drop' };
      },
    };
    const dropper: Plugin = {
      name: 'always-dropper',
      transformLLMOutput(): LLMOutputTransform {
        return null;
      },
    };
    const loop = new AgentLoop(provider, new ToolRegistry(), new InMemorySessionStore(), {
      plugins: new PluginManager().register(dropper),
      runtimeName: 'node',
      maxToolIterations: 1,
      maxLLMOutputRetries: 2,
      securityPolicy: { redactToolOutput: false },
    });
    const result = await loop.run({ agentId: 'crowclaw', sessionId: 's7', userMessage: 'hi' });
    // 1 initial + 2 retries = 3 provider calls
    expect(providerCalls).toBe(3);
    // Loop still completed (no throw, no infinite loop) — last message body falls through.
    expect(result.finalResponse).toBe('always-drop');
  });
});
