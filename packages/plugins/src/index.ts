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
}

export class MemoryCapturePlugin implements Plugin {
  readonly name = 'memory-capture';
  public seen: Array<{ hook: PluginHookName; sessionId: string }> = [];

  async on<K extends PluginHookName>(hook: K, _payload: PluginHookPayloads[K], context: PluginContext): Promise<void> {
    this.seen.push({ hook, sessionId: context.sessionId });
  }
}
