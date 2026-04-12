export interface PluginContext {
  runtime: string;
  sessionId: string;
  agentId: string;
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

export type PluginHookName = keyof PluginHookPayloads;

export interface Plugin {
  name: string;
  on?<K extends PluginHookName>(hook: K, payload: PluginHookPayloads[K], context: PluginContext): Promise<void> | void;
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
}

export class MemoryCapturePlugin implements Plugin {
  readonly name = 'memory-capture';
  public seen: Array<{ hook: PluginHookName; sessionId: string }> = [];

  async on<K extends PluginHookName>(hook: K, _payload: PluginHookPayloads[K], context: PluginContext): Promise<void> {
    this.seen.push({ hook, sessionId: context.sessionId });
  }
}
