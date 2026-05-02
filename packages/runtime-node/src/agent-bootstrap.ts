import {
  AgentLoop,
  getAgentPreset,
  restoreFromCheckpoint,
  formatContextForPrompt,
  scoreComplexity,
  selectModelForComplexity,
  type CheckpointStore,
  type ContextEngineResult,
  type ParsedSkillFile,
  type ProviderAdapter,
  type SessionCheckpoint,
  type ToolCatalog,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolExecutor,
  type ToolManifest,
  type SupportedLocale,
} from '@crowclaw/core';
import { isModelOverridable } from '@crowclaw/providers';
import { InMemorySessionStore, type MessageStore as MessageStoreInterface } from '@crowclaw/storage';
import { ToolRegistry } from '@crowclaw/tools';
import { createProviderFromSlot } from './provider-factory.js';
import type { RuntimeConfigStore } from './config-store.js';
import type { EventBus } from './event-bus.js';
import type { FeedbackLedger } from './runtime-support.js';
import type { Logger } from './logger.js';
import type { NodeRuntimeOptions } from './runtime-support.js';

export interface ExecutionOverrides {
  agentPreset?: string;
  toolsetPreset?: string;
  skillSlugs?: string[];
  model?: string;
}

export interface AgentBootstrapContext {
  options: NodeRuntimeOptions;
  provider: () => ProviderAdapter;
  store: InMemorySessionStore;
  configStore: RuntimeConfigStore;
  tools: ToolRegistry;
  toolsetPresets: Map<string, ReturnType<typeof import('@crowclaw/tools').listToolsetPresets>[number]>;
  skillRegistry: {
    resolve(): ParsedSkillFile[];
  };
  personaRegistry: {
    getActive(): { prompt?: string };
    getActivePrompt?(locale: SupportedLocale): string;
  };
  getPersonaPrompt: () => string | undefined;
  plugins: unknown;
  usageTracker: unknown;
  checkpointStore: CheckpointStore;
  autoResumedCheckpointIds: Set<string>;
  securityAuditLog: unknown;
  eventBus: EventBus;
  log: Logger;
  contextEngineReady: Promise<void>;
  getContextEngineResult: () => ContextEngineResult | null;
  frozenMemoryReady: Promise<unknown>;
  memoryProvider: {
    recall(sessionId: string, query: string, limit: number): Promise<Array<{ id: string; summary: string }>>;
    prefetch?: (sessionId: string, query: string, limit: number) => Promise<Array<{ id: string; summary: string }>>;
  };
  userModelService: {
    getProfile(sessionId: string, userId: string): Promise<{ expertise: string[]; preferences: string[] }>;
    updateFromConversation(messages: unknown[], sessionId: string): Promise<unknown>;
  };
  frozenMemory: {
    size: number;
    formatForPrompt(): string;
    set(key: string, value: string, category?: string, sessionId?: string): void;
    prune(maxEntries: number): void;
    save(sessionId?: string): Promise<unknown>;
  };
  frozenUserProfile: {
    size: number;
    formatForPrompt(): string;
    set(key: string, value: string, category?: string, sessionId?: string): void;
    save(sessionId?: string): Promise<unknown>;
  };
  feedbackLedger: FeedbackLedger;
  messageStore: MessageStoreInterface;
  setActiveUsageSessionId: (sessionId: string | null) => void;
}

export function isInProgressCheckpoint(checkpoint: SessionCheckpoint): boolean {
  const metadata = checkpoint.metadata as SessionCheckpoint['metadata'] & { status?: string; checkpointStatus?: string };
  return metadata.status === 'in_progress' ||
    metadata.checkpointStatus === 'in_progress' ||
    checkpoint.metadata.label === 'in_progress';
}

export function createAgentBootstrap(ctx: AgentBootstrapContext) {
  function buildConfiguredSkillManifests(overrides?: ExecutionOverrides): ParsedSkillFile[] {
    let skills = ctx.skillRegistry.resolve()
      .filter((skill) => ctx.configStore.isSkillEnabled(skill.manifest.name));

    if (overrides?.skillSlugs && overrides.skillSlugs.length > 0) {
      const allowed = new Set(overrides.skillSlugs);
      skills = skills.filter((s) => allowed.has(s.manifest.name));
    }

    return skills;
  }

  function buildConfiguredToolRegistry(overrides?: ExecutionOverrides): ToolRegistry {
    const activeToolset = overrides?.toolsetPreset ?? ctx.configStore.getActiveToolset();
    const disabledTools = new Set(ctx.configStore.getDisabledTools());

    if (!activeToolset) {
      if (disabledTools.size === 0) {
        return ctx.tools;
      }
      const filtered = new ToolRegistry();
      for (const manifest of ctx.tools.list()) {
        if (disabledTools.has(manifest.name)) continue;
        const definition = ctx.tools.get(manifest.name);
        if (definition) filtered.register(definition);
      }
      return filtered;
    }

    const preset = ctx.toolsetPresets.get(activeToolset);
    if (!preset || preset.toolNames.length === 0) {
      if (disabledTools.size === 0) {
        return ctx.tools;
      }
      const filtered = new ToolRegistry();
      for (const manifest of ctx.tools.list()) {
        if (disabledTools.has(manifest.name)) continue;
        const definition = ctx.tools.get(manifest.name);
        if (definition) filtered.register(definition);
      }
      return filtered;
    }

    const filtered = new ToolRegistry();
    for (const manifest of ctx.tools.list()) {
      if (!preset.toolNames.includes(manifest.name)) continue;
      if (disabledTools.has(manifest.name)) continue;
      const definition = ctx.tools.get(manifest.name);
      if (definition) filtered.register(definition);
    }
    return filtered;
  }

  function resolveConfiguredAgentPreset(overrides?: ExecutionOverrides): { role: string; goal: string; backstory?: string } | undefined {
    if (overrides?.agentPreset) {
      const preset = getAgentPreset(overrides.agentPreset);
      if (preset) return { role: preset.role, goal: preset.goal, backstory: preset.backstory };
    }

    const configured = ctx.configStore.getAgentPreset();
    if (configured?.role?.trim() || configured?.goal?.trim() || configured?.backstory?.trim()) {
      return {
        role: configured.role,
        goal: configured.goal,
        backstory: configured.backstory
      };
    }

    const activePreset = ctx.configStore.getActivePreset();
    if (!activePreset) return undefined;

    const preset = getAgentPreset(activePreset);
    if (!preset) return undefined;

    return {
      role: preset.role,
      goal: preset.goal,
      backstory: preset.backstory
    };
  }

  function resolveProvider(overrides?: ExecutionOverrides): ProviderAdapter {
    const provider = ctx.provider();
    if (overrides?.model) {
      if (isModelOverridable(provider)) {
        return provider.withModel(overrides.model);
      }
      ctx.log.warn('Model override requested but provider does not support withModel()', { requestedModel: overrides.model });
    }
    return provider;
  }

  function defaultApprovalDecider(tool: { manifest: { dangerLevel?: string } }): Promise<boolean> {
    const level = tool.manifest.dangerLevel;
    if (!level || level === 'low') {
      return Promise.resolve(true);
    }
    if (level === 'medium') {
      ctx.log.warn('Tool with medium danger level auto-approved', { dangerLevel: 'medium' });
      return Promise.resolve(true);
    }
    ctx.log.warn('Tool rejected by default approval decider', { dangerLevel: level });
    return Promise.resolve(false);
  }

  function instrumentToolRegistry(registry: ToolCatalog & ToolExecutor): ToolCatalog & ToolExecutor {
    return {
      list(): ToolManifest[] {
        return registry.list();
      },
      get(name: string): ToolDefinition | undefined {
        return registry.get(name);
      },
      async execute(name: string, input: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
        const callId = (typeof crypto !== 'undefined' && typeof (crypto as { randomUUID?: () => string }).randomUUID === 'function')
          ? (crypto as { randomUUID: () => string }).randomUUID()
          : `call-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const sessionId = (context as { sessionId?: string }).sessionId;
        const startedAt = performance.now();
        ctx.eventBus.emit('tool:start', {
          callId,
          toolName: name,
          sessionId,
          args: input,
          startedAt: new Date().toISOString(),
        });
        try {
          const result = await registry.execute(name, input, context);
          const durationMs = Math.round(performance.now() - startedAt);
          ctx.eventBus.emit('tool:complete', {
            callId,
            toolName: name,
            sessionId,
            ok: result.ok,
            durationMs,
            output: result.output.length > 4000 ? `${result.output.slice(0, 4000)}…[truncated]` : result.output,
            outputLength: result.output.length,
            metadata: result.metadata,
          });
          return result;
        } catch (err) {
          const durationMs = Math.round(performance.now() - startedAt);
          ctx.eventBus.emit('tool:complete', {
            callId,
            toolName: name,
            sessionId,
            ok: false,
            durationMs,
            output: err instanceof Error ? err.message : String(err),
            error: true,
          });
          throw err;
        }
      }
    };
  }

  function createConfiguredAgent(overrides?: ExecutionOverrides, locale?: SupportedLocale): AgentLoop {
    const activePersonaPrompt = (
      ctx.personaRegistry.getActivePrompt?.(locale ?? 'en') ??
      ctx.personaRegistry.getActive().prompt ??
      ctx.getPersonaPrompt()
    );
    const providerCfg = ctx.configStore.getProviderConfig();
    const fallbackProviders: ProviderAdapter[] = [];
    let compressionProvider: ProviderAdapter | undefined;

    if (providerCfg) {
      if (providerCfg.fallback) {
        fallbackProviders.push(createProviderFromSlot(providerCfg.fallback));
      }
      if (providerCfg.compression) {
        compressionProvider = createProviderFromSlot(providerCfg.compression);
      }
    }

    return new AgentLoop(resolveProvider(overrides), instrumentToolRegistry(buildConfiguredToolRegistry(overrides)), ctx.store, {
      plugins: ctx.plugins as never,
      runtimeName: 'node',
      skills: buildConfiguredSkillManifests(overrides),
      agentPreset: resolveConfiguredAgentPreset(overrides),
      personaPrompt: activePersonaPrompt,
      usageTracker: ctx.usageTracker as never,
      checkpointStore: ctx.checkpointStore,
      autoCheckpoint: ctx.options.autoCheckpoint ?? false,
      requireApprovalForDangerousTools: true,
      approvalDecider: defaultApprovalDecider,
      securityAuditLog: ctx.securityAuditLog as never,
      eventBus: ctx.eventBus,
      providerName: providerCfg?.primary?.provider ?? 'openai-compatible',
      securityPolicy: {
        redactToolOutput: ctx.configStore.getSecurityPolicy().redactToolOutput,
        scanUserInput: ctx.configStore.getSecurityPolicy().scanUserInput,
        scanCommands: ctx.configStore.getSecurityPolicy().scanCommands,
        blockDangerousCommands: ctx.configStore.getSecurityPolicy().blockDangerousCommands,
      },
      ...(fallbackProviders.length > 0 ? { fallbackProviders } : {}),
      ...(compressionProvider ? { compressionProvider } : {}),
    });
  }

  async function autoResumeFromInProgressCheckpoint(sessionId: string): Promise<void> {
    if (ctx.options.autoResumeCheckpoints === false) return;
    const session = await ctx.store.get(sessionId);
    if (!session) return;
    const checkpoints = await ctx.checkpointStore.listBySession(sessionId);
    const checkpoint = checkpoints.slice().reverse().find((cp) => isInProgressCheckpoint(cp) && !ctx.autoResumedCheckpointIds.has(cp.id));
    if (!checkpoint) return;
    const restored = restoreFromCheckpoint(checkpoint, session);
    await ctx.store.put(restored.session);
    ctx.autoResumedCheckpointIds.add(checkpoint.id);
    ctx.eventBus.emit('session:resumed', {
      sessionId,
      action: 'checkpoint:auto-resume',
      checkpointId: checkpoint.id,
      reason: 'in_progress_checkpoint',
      messageCount: restored.session.messages.length,
    });
  }

  async function runConfiguredAgent(input: {
    sessionId: string;
    userMessage: string;
    userId?: string;
    workspaceId?: string;
    systemPrompt: string;
    locale?: SupportedLocale;
  }, overrides?: ExecutionOverrides) {
    let memories: string[] = [];
    const contextAssembleStartedAt = performance.now();
    ctx.eventBus.emit('context:assemble_start', { sessionId: input.sessionId });
    await ctx.contextEngineReady;
    await ctx.frozenMemoryReady;
    await autoResumeFromInProgressCheckpoint(input.sessionId);

    try {
      const recallPromise = ctx.memoryProvider.prefetch
        ? ctx.memoryProvider.prefetch(input.sessionId, input.userMessage, 5)
        : ctx.memoryProvider.recall(input.sessionId, input.userMessage, 5);
      const [recalled, profile] = await Promise.all([
        recallPromise,
        ctx.userModelService.getProfile(input.sessionId, input.userId ?? 'default-user'),
      ]);
      if (recalled.length > 0) {
        ctx.eventBus.emit('memory:recalled', {
          sessionId: input.sessionId,
          query: input.userMessage,
          hits: recalled.length,
          ids: recalled.map((r) => r.id),
          summaries: recalled.map((r) => r.summary.slice(0, 200)),
        });
      }
      memories = recalled.map(r => r.summary);
      if (profile.expertise.length > 0 || profile.preferences.length > 0) {
        const profileParts: string[] = [];
        if (profile.expertise.length > 0) {
          profileParts.push(`User expertise: ${profile.expertise.slice(0, 8).join(', ')}`);
        }
        if (profile.preferences.length > 0) {
          profileParts.push(`User preferences: ${profile.preferences.slice(0, 5).join('; ')}`);
        }
        memories.push(...profileParts);
      }
    } catch {
      // Memory recall failed — proceed without memories.
    }

    if (ctx.frozenMemory.size > 0) {
      memories.push(ctx.frozenMemory.formatForPrompt());
    }
    if (ctx.frozenUserProfile.size > 0) {
      memories.push(ctx.frozenUserProfile.formatForPrompt());
    }

    const contextEngineResult = ctx.getContextEngineResult();
    if (contextEngineResult && contextEngineResult.files.length > 0) {
      memories.push(formatContextForPrompt(contextEngineResult));
    }

    const feedbackDigest = ctx.feedbackLedger.getDigest(30);
    if (feedbackDigest) {
      memories.push(feedbackDigest);
    }
    ctx.eventBus.emit('context:assemble_end', {
      sessionId: input.sessionId,
      memoryCount: memories.length,
      durationMs: Math.round(performance.now() - contextAssembleStartedAt),
    });

    const providerCfg = ctx.configStore.getProviderConfig();
    if (providerCfg?.fast && !overrides?.model) {
      const complexity = scoreComplexity(input.userMessage, buildConfiguredToolRegistry(overrides).list().length);
      const selectedModel = selectModelForComplexity(complexity, providerCfg.primary.model, providerCfg.fast.model);
      if (selectedModel !== providerCfg.primary.model) {
        overrides = { ...overrides, model: selectedModel };
      }
    }

    const turnStartedAt = new Date().toISOString();
    ctx.setActiveUsageSessionId(input.sessionId);
    let result: Awaited<ReturnType<AgentLoop['run']>>;
    try {
      result = await createConfiguredAgent(overrides, input.locale).run({
        agentId: ctx.options.agentId ?? 'crowclaw',
        ...input,
        memories,
      });
    } finally {
      ctx.setActiveUsageSessionId(null);
    }

    const allMsgs = result.session.messages;
    const newMsgs = allMsgs.filter(
      (m: { createdAt?: string }) => m.createdAt && m.createdAt >= turnStartedAt
    );
    if (newMsgs.length > 0) {
      const storedMsgs = newMsgs.map((m: { role: string; content: string; name?: string; createdAt?: string; metadata?: Record<string, unknown> }) => ({
        id: crypto.randomUUID(),
        sessionId: input.sessionId,
        role: m.role as 'system' | 'user' | 'assistant' | 'tool',
        content: m.content,
        name: m.name,
        createdAt: m.createdAt ?? new Date().toISOString(),
        metadata: m.metadata,
      }));
      void ctx.messageStore.appendBatch(storedMsgs).catch(() => {});
    }

    void (async () => {
      try {
        await ctx.userModelService.updateFromConversation(result.session.messages, input.sessionId);

        const profile = await ctx.userModelService.getProfile(input.sessionId, input.userId ?? 'default-user');
        if (profile.expertise.length > 0) {
          ctx.frozenUserProfile.set('expertise', profile.expertise.join(', '), 'profile', input.sessionId);
        }
        if (profile.preferences.length > 0) {
          ctx.frozenUserProfile.set('preferences', profile.preferences.join('; '), 'profile', input.sessionId);
        }
        await ctx.frozenUserProfile.save(input.sessionId);

        const turnToolMsgs = newMsgs.filter((m: { role: string }) => m.role === 'tool');
        for (const tm of turnToolMsgs.slice(-3)) {
          const name = (tm as { name?: string }).name ?? 'tool';
          const content = (tm as { content: string }).content;
          if (content && content.length > 10 && content.length < 500) {
            ctx.frozenMemory.set(`tool:${name}:${input.sessionId.slice(-6)}`, content.slice(0, 300), 'tool-result', input.sessionId);
          }
        }
        const assistantMsgs = newMsgs.filter((m: { role: string }) => m.role === 'assistant');
        const lastAssistant = assistantMsgs.at(-1) as { content: string } | undefined;
        if (lastAssistant?.content && /\b(decided|confirmed|set|created|updated|fixed|completed)\b/i.test(lastAssistant.content)) {
          const fact = lastAssistant.content.slice(0, 200);
          ctx.frozenMemory.set(`decision:${input.sessionId.slice(-6)}`, fact, 'decision', input.sessionId);
        }
        ctx.frozenMemory.prune(100);
        await ctx.frozenMemory.save(input.sessionId);
      } catch { /* best-effort */ }
    })();

    for (const tr of result.toolResults) {
      ctx.feedbackLedger.record({
        timestamp: new Date().toISOString(),
        toolName: tr.toolName,
        ok: tr.ok,
        error: tr.ok ? undefined : tr.output.slice(0, 200),
        sessionId: input.sessionId,
      });
    }

    return result;
  }

  return {
    buildConfiguredToolRegistry,
    createConfiguredAgent,
    runConfiguredAgent,
  };
}
