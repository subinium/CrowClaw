/**
 * Plugin contract + manager.
 *
 * Owned by `@crowclaw/core` (issue #158). The legacy `@crowclaw/plugins`
 * package re-exports everything below as a backward-compat shim. This keeps
 * the dependency direction sane — runtime/test code may depend on either
 * `@crowclaw/core` (preferred) or `@crowclaw/plugins` (shim), and both reach
 * the same definitions defined here.
 */

export interface PluginContext {
  runtime: string;
  sessionId: string;
  agentId: string;
}

/**
 * #95: Plugin can veto a tool call before execution.
 * Return `{ veto: true, reason }` to block; return `{ veto: false }` (or
 * undefined / void) to allow. The agent loop OR-aggregates across plugins:
 * any single veto blocks the call.
 */
export interface PreToolCallVeto {
  veto: boolean;
  reason?: string;
}

/**
 * #95: Plugin can transform a tool result after execution but before the
 * agent loop appends it to conversation history. Return a partial override
 * (only the fields you want to change) or undefined to leave it untouched.
 *
 * Note: this runs *after* core's redaction + injection-scan layer, so plugins
 * see the already-redacted output. They cannot un-redact.
 */
export interface ToolResultTransform {
  output?: string;
  ok?: boolean;
  metadata?: Record<string, unknown>;
}

export interface PluginHookPayloads {
  'agent:beforeRun': { input: { agentId: string; sessionId: string; [key: string]: unknown } };
  'agent:afterRun': { input: { agentId: string; sessionId: string; [key: string]: unknown }; result: { finalResponse: string; toolResults: Array<{ toolName: string; ok: boolean }> } };
  'provider:beforeGenerate': { attempt: number; providerIndex: number; messageCount: number };
  'provider:afterGenerate': { attempt: number; providerIndex: number; messageCount: number; toolCallCount: number; assistantMessage?: string };
  'provider:error': { attempt: number; providerIndex: number; messageCount: number; error: string };
  'tool:beforeExecute': { toolName: string; input: Record<string, unknown>; sessionId: string; agentId: string };
  'tool:result': { result: { toolName: string; ok: boolean; output: string }; sessionId: string; agentId: string };
  'tool:error': { result: { toolName: string; ok: boolean; output: string }; sessionId: string; agentId: string };
  /**
   * #302 (v0.9.0 Hermes parity): observer hook fired when the
   * `transformLLMOutput` chain drops a turn (any plugin returned `null`).
   * The agent loop logs this and treats it as a retry trigger.
   */
  'plugin:llm_output_dropped': {
    sessionId: string;
    agentId: string;
    iteration: number;
    pluginName: string;
    /** Optional reason string the plugin can return alongside `null`. */
    reason?: string;
  };
}

/**
 * #302 (v0.9.0 Hermes parity): minimal shape of the assistant message a
 * plugin can reshape via `transformLLMOutput`. Mirrors the runtime
 * `ProviderResponse` surface but is intentionally restated here so the
 * plugin contract stays a leaf module (no upward import of the agent loop
 * types).
 */
export interface AssistantMessage {
  /** Stripped assistant text. May be empty when only `toolCalls` are present. */
  assistantMessage?: string;
  /** Tool calls extracted from the provider response, if any. */
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
  /** Optional reasoning blocks (Hermes-style XML) parsed by the provider. */
  reasoningBlocks?: unknown[];
}

/**
 * #302: return shape for `transformLLMOutput`.
 *
 *   - return an `AssistantMessage` to replace the running message body
 *   - return `null` to drop the turn entirely (agent loop retries and emits
 *     `plugin:llm_output_dropped`)
 *   - return `undefined` (or no value) to leave the running message unchanged
 *
 * `reason` is an optional log/debug hint surfaced via the dropped-turn event.
 */
export type LLMOutputTransform = AssistantMessage | { drop: true; reason?: string } | null | void;

/**
 * #302 (v0.9.0): per-turn context handed to `transformLLMOutput` plugins.
 * Mirrors what providers see at generate time plus the iteration index so
 * plugins can branch on early vs late iterations.
 */
export interface LLMOutputTurn {
  sessionId: string;
  agentId: string;
  /** 0-based agent-loop iteration. First call (before the first tool round
   *  trip) is iteration 0; subsequent retries reuse the same index. */
  iteration: number;
  /** Snapshot of the prompt messages sent to the provider for this turn. */
  messages: Array<{ role: string; content: string }>;
}

/**
 * #95: Hooks that *return* a value (veto / transform) are kept separate from
 * the fire-and-forget `on` hooks so their signatures can encode return types
 * cleanly. Plugins implement only the methods they care about.
 */
export interface PluginInvocationPayloads {
  /** Pre-execution gate. Plugins return `{veto:true,reason}` to block. */
  'tool:preExecute': {
    payload: { toolName: string; input: Record<string, unknown>; sessionId: string; agentId: string };
    result: PreToolCallVeto | void;
  };
  /** Post-execution transform. Plugins return a partial override of the tool result. */
  'tool:transformResult': {
    payload: {
      toolName: string;
      input: Record<string, unknown>;
      result: { toolName: string; ok: boolean; output: string; metadata?: Record<string, unknown> };
      sessionId: string;
      agentId: string;
    };
    result: ToolResultTransform | void;
  };
  /**
   * #302 (v0.9.0 Hermes parity): post-generation transform on the raw
   * assistant message. Runs in registration order; later plugins see the
   * output of earlier ones. Returning `null` drops the turn entirely and
   * triggers a retry.
   */
  'llm:transformOutput': {
    payload: { turn: LLMOutputTurn; raw: AssistantMessage };
    result: LLMOutputTransform;
  };
}

export type PluginHookName = keyof PluginHookPayloads;
export type PluginInvocationName = keyof PluginInvocationPayloads;

export interface Plugin {
  name: string;
  /** Fire-and-forget observer hooks. */
  on?<K extends PluginHookName>(hook: K, payload: PluginHookPayloads[K], context: PluginContext): Promise<void> | void;
  /**
   * #95: Pre-execution veto. Return `{veto:true,reason}` to block this tool
   * call. Multiple plugins are OR-aggregated: any veto blocks. Throwing here
   * is treated as a non-vetoing error and logged; it never blocks.
   */
  preToolCall?(
    payload: PluginInvocationPayloads['tool:preExecute']['payload'],
    context: PluginContext,
  ): Promise<PreToolCallVeto | void> | PreToolCallVeto | void;
  /**
   * #95: Post-execution transform. Return a partial override of the result
   * (any field you don't return is preserved). Plugins are applied in
   * registration order; later plugins see the output of earlier ones.
   * Throwing here passes the previous result through unchanged.
   */
  transformToolResult?(
    payload: PluginInvocationPayloads['tool:transformResult']['payload'],
    context: PluginContext,
  ): Promise<ToolResultTransform | void> | ToolResultTransform | void;
  /**
   * #302 (v0.9.0 Hermes parity): post-generation transform on the raw
   * assistant message. Sibling to `transformToolResult` but for the LLM
   * response stream — runs AFTER the provider returns but BEFORE the agent
   * loop appends to `session.messages` and BEFORE tool extraction. Plugins
   * see the prior plugin's output (registration-order chain) and may:
   *
   *   - return an `AssistantMessage` to replace the running message
   *   - return `null` (or `{ drop: true, reason }`) to drop the turn — the
   *     loop retries up to `maxLLMOutputRetries` and emits
   *     `plugin:llm_output_dropped`
   *   - return `undefined` to leave the running message untouched
   *
   * Throwing here passes the prior message through unchanged (parity with
   * `transformToolResult`). Plugins cannot un-redact secrets — the core
   * redaction pass runs AFTER the chain so injected credentials still get
   * scrubbed.
   */
  transformLLMOutput?(
    payload: PluginInvocationPayloads['llm:transformOutput']['payload'],
    context: PluginContext,
  ): Promise<LLMOutputTransform> | LLMOutputTransform;
}

/**
 * #302 (v0.9.0): canonical "turn was dropped" outcome returned by
 * `PluginManager.transformLLMOutput` when any plugin in the chain asked
 * to drop. Carries the dropping plugin's name + optional reason so the
 * agent loop can populate the `plugin:llm_output_dropped` event.
 */
export interface LLMOutputDroppedOutcome {
  dropped: true;
  pluginName: string;
  reason?: string;
}

export class PluginManager {
  private readonly plugins = new Map<string, Plugin>();

  register(plugin: Plugin): this {
    this.plugins.set(plugin.name, plugin);
    return this;
  }

  list(): Plugin[] {
    return [...this.plugins.values()];
  }

  get(name: string): Plugin | undefined {
    return this.plugins.get(name);
  }

  unregister(name: string): boolean {
    return this.plugins.delete(name);
  }

  async emit<K extends PluginHookName>(hook: K, payload: PluginHookPayloads[K], context: PluginContext): Promise<void> {
    for (const plugin of this.plugins.values()) {
      await plugin.on?.(hook, payload, context);
    }
  }

  /**
   * #95: Run pre-tool-call gates across all plugins. OR-aggregates: the first
   * `veto:true` short-circuits and is returned. Plugin throws are caught and
   * treated as non-vetoing (we don't want a buggy plugin to lock out tools).
   */
  async preToolCall(
    payload: PluginInvocationPayloads['tool:preExecute']['payload'],
    context: PluginContext,
  ): Promise<PreToolCallVeto> {
    for (const plugin of this.plugins.values()) {
      if (!plugin.preToolCall) continue;
      try {
        const verdict = await plugin.preToolCall(payload, context);
        if (verdict && verdict.veto) {
          return {
            veto: true,
            reason: verdict.reason ? `${plugin.name}: ${verdict.reason}` : `${plugin.name}: vetoed`,
          };
        }
      } catch (error) {
        // Buggy plugin must not block tools — log and continue.
        // (We don't have a logger here; best the manager can do is swallow.)
        void error;
      }
    }
    return { veto: false };
  }

  /**
   * #95: Run post-tool-call transforms across all plugins. Each plugin sees
   * the output of the previous transform; returning `void`/undefined leaves
   * the running result unchanged. Plugin throws revert to the prior result.
   */
  async transformToolResult(
    payload: PluginInvocationPayloads['tool:transformResult']['payload'],
    context: PluginContext,
  ): Promise<{ toolName: string; ok: boolean; output: string; metadata?: Record<string, unknown> }> {
    let current = payload.result;
    for (const plugin of this.plugins.values()) {
      if (!plugin.transformToolResult) continue;
      try {
        const transform = await plugin.transformToolResult(
          { ...payload, result: current },
          context,
        );
        if (!transform) continue;
        current = {
          toolName: current.toolName,
          ok: transform.ok ?? current.ok,
          output: transform.output ?? current.output,
          metadata: transform.metadata
            ? { ...(current.metadata ?? {}), ...transform.metadata }
            : current.metadata,
        };
      } catch (error) {
        // Plugin error: keep prior result, continue with the next plugin.
        void error;
      }
    }
    return current;
  }

  /**
   * #302 (v0.9.0 Hermes parity): run post-generation transforms across all
   * registered plugins. Chain semantics mirror `transformToolResult`:
   *
   *   - Plugins execute in registration order
   *   - Each plugin sees the output of the previous transform
   *   - `void` / `undefined` leaves the running message unchanged
   *   - A plugin that returns `null` (or `{ drop: true }`) short-circuits
   *     the chain and the manager returns `{ dropped: true, pluginName }`
   *   - A plugin that throws is logged-and-skipped; the chain continues
   *     with the prior message intact (matches `transformToolResult`
   *     resilience contract — a buggy plugin must not lock out turns)
   *
   * The caller is responsible for the subsequent redaction pass — this
   * keeps the manager free of the security imports that would otherwise
   * create an upward dependency.
   */
  async transformLLMOutput(
    payload: PluginInvocationPayloads['llm:transformOutput']['payload'],
    context: PluginContext,
  ): Promise<AssistantMessage | LLMOutputDroppedOutcome> {
    let current: AssistantMessage = payload.raw;
    for (const plugin of this.plugins.values()) {
      if (!plugin.transformLLMOutput) continue;
      try {
        const transform = await plugin.transformLLMOutput(
          { turn: payload.turn, raw: current },
          context,
        );
        if (transform === undefined) continue;
        if (transform === null) {
          return { dropped: true, pluginName: plugin.name };
        }
        if (typeof transform === 'object' && 'drop' in transform && transform.drop === true) {
          return { dropped: true, pluginName: plugin.name, reason: transform.reason };
        }
        // Object return: replace the running message. Fields the plugin
        // omits fall back to the prior message so partial transforms don't
        // accidentally erase toolCalls.
        const asMessage = transform as AssistantMessage;
        current = {
          assistantMessage: asMessage.assistantMessage ?? current.assistantMessage,
          toolCalls: asMessage.toolCalls ?? current.toolCalls,
          reasoningBlocks: asMessage.reasoningBlocks ?? current.reasoningBlocks,
        };
      } catch (error) {
        // Plugin error: keep prior message, continue with the next plugin.
        // (Parity with `transformToolResult` — a buggy plugin cannot stall
        // the loop.)
        void error;
      }
    }
    return current;
  }
}

export class MemoryCapturePlugin implements Plugin {
  readonly name = 'memory-capture';
  public seen: Array<{ hook: PluginHookName; sessionId: string }> = [];

  async on<K extends PluginHookName>(hook: K, _payload: PluginHookPayloads[K], context: PluginContext): Promise<void> {
    this.seen.push({ hook, sessionId: context.sessionId });
  }
}
