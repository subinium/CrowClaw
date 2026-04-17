import { getSandbox } from '@cloudflare/sandbox';
import { AgentLoop, getAgentPreset, listAgentPresets, InMemoryCheckpointStore, createCheckpoint, restoreFromCheckpoint, createReplaySession, type ParsedSkillFile, type ProviderAdapter, type CheckpointTrigger, type SessionState } from '@crowclaw/core';
import { buildGatewayDeliveryPlan, normalizeGatewayRequest } from '@crowclaw/gateway';
import { InMemorySkillStore, LearningPipeline, SkillRegistry, getBuiltInSkills } from '@crowclaw/learning';
import { McpClient, McpHttpTransport, getMcpPresetDescription, listMcpPresetNames } from '@crowclaw/mcp';
import { MemoryService } from '@crowclaw/memory';
import { MemoryCapturePlugin, PluginManager } from '@crowclaw/plugins';
import { OpenAICompatibleProvider, isModelOverridable } from '@crowclaw/providers';
import { buildToolBridgeArtifacts, CloudflareSandboxExecutor, registerSandboxTools } from '@crowclaw/sandbox-executor';
import { InMemorySchedulerStore, SchedulerExecutor, collectDueJobs, createEveryNMinutesJob, createScheduledAgentJob, markJobRun } from '@crowclaw/scheduler';
import { D1MemoryStore, D1SessionStore, type SessionListStore } from '@crowclaw/storage';
import { ToolRegistry, createDefaultWorkerRegistry, listToolsetPresets } from '@crowclaw/tools';
import { InMemoryWorkspaceStore } from '@crowclaw/workspace';
import type { RuntimeEnv } from './env';

type DurableObjectState = { id: { toString(): string } };

function normalizeCheckpointTrigger(value: unknown): CheckpointTrigger {
  return value === 'iteration' || value === 'manual' || value === 'pre-dangerous' || value === 'error' || value === 'completion'
    ? value
    : 'manual';
}

function createRegistry(sessionStore: D1SessionStore, memoryStore: D1MemoryStore, workspaceStore: InMemoryWorkspaceStore, mcpClient: McpClient) {
  const registry = createDefaultWorkerRegistry({
    sessionSearchStore: sessionStore,
    memoryStore,
    workspaceStore,
    mcpClient
  });
  registerSandboxTools(registry, new CloudflareSandboxExecutor());
  return registry;
}

function summarizeSessionRecord(session: SessionState) {
  const lastMessage = [...session.messages].reverse().find((message) => message.role !== 'system');
  // Derive a human-readable title for the dashboard session picker:
  // 1. Prefer an explicit rename (stored as a [session-meta] system message)
  // 2. Fall back to the first user message
  // 3. Fall back to the empty string — the UI then shows the sessionId
  const renameMeta = session.messages.find(
    (m) => m.role === 'system' && m.content?.startsWith('[session-meta] name='),
  );
  const renamedTitle = renameMeta?.content.replace('[session-meta] name=', '').trim();
  const firstUser = session.messages.find((m) => m.role === 'user');
  const title = renamedTitle || firstUser?.content?.slice(0, 60).trim() || '';
  return {
    sessionId: session.sessionId,
    title,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    userId: session.userId,
    workspaceId: session.workspaceId,
    lastRole: lastMessage?.role ?? null,
    preview: lastMessage?.content.slice(0, 140) ?? '',
  };
}

function buildGatewayStatusPayload() {
  return {
    platforms: [
      {
        name: 'telegram',
        inboundRoute: '/webhooks/telegram',
        inboundStatus: 'webhook-ready',
        outboundMode: 'runtime-route',
        outboundRoute: '/api/telegram/send',
        sampleBody: { botToken: '<telegram-bot-token>', chatId: '<chat-id>', text: 'Hello from CrowClaw' }
      },
      {
        name: 'discord',
        inboundRoute: '/webhooks/discord',
        inboundStatus: 'webhook-ready',
        outboundMode: 'runtime-route',
        outboundRoute: '/api/discord/send',
        sampleBody: { webhookUrl: 'https://discord.com/api/webhooks/...', content: 'Hello from CrowClaw' }
      },
      {
        name: 'slack',
        inboundRoute: '/webhooks/slack',
        inboundStatus: 'webhook-ready',
        outboundMode: 'runtime-route',
        outboundRoute: '/api/slack/send',
        sampleBody: { botToken: '<slack-bot-token>', channel: 'C123456', text: 'Hello from CrowClaw' }
      },
      {
        name: 'whatsapp',
        inboundRoute: '/webhooks/whatsapp',
        inboundStatus: 'webhook-ready',
        outboundMode: 'helper-only',
        helper: 'sendWhatsAppMessage(accessToken, phoneNumberId, to, text)',
        sampleBody: { accessToken: '<meta-access-token>', phoneNumberId: '<phone-number-id>', to: '<recipient>', text: 'Hello from CrowClaw' }
      },
      {
        name: 'signal',
        inboundRoute: '/webhooks/signal',
        inboundStatus: 'webhook-ready',
        outboundMode: 'not-exposed',
        sampleBody: null
      },
      {
        name: 'email',
        inboundRoute: '/webhooks/email',
        inboundStatus: 'webhook-ready',
        outboundMode: 'helper-only',
        helper: 'sendEmailMessage(apiUrl, apiKey, to, subject, text, from?)',
        sampleBody: { apiUrl: 'https://mail.example.com/send', apiKey: '<api-key>', to: 'user@example.com', subject: 'CrowClaw', text: 'Hello from CrowClaw' }
      },
      {
        name: 'matrix',
        inboundRoute: '/webhooks/matrix',
        inboundStatus: 'webhook-ready',
        outboundMode: 'helper-only',
        helper: 'sendMatrixMessage(homeserverUrl, accessToken, roomId, text)',
        sampleBody: { homeserverUrl: 'https://matrix.example.com', accessToken: '<access-token>', roomId: '!room:example.com', text: 'Hello from CrowClaw' }
      },
      {
        name: 'sms',
        inboundRoute: '/webhooks/sms',
        inboundStatus: 'webhook-ready',
        outboundMode: 'not-exposed',
        sampleBody: null
      },
      {
        name: 'webhook',
        inboundRoute: '/webhooks/generic',
        inboundStatus: 'webhook-ready',
        outboundMode: 'not-applicable',
        sampleBody: { channelId: 'room-1', userId: 'user-1', text: 'Hello from CrowClaw' }
      }
    ]
  };
}

export class AgentSessionDurableObject {
  private readonly skillRegistry: SkillRegistry;
  private readonly sessionStore: D1SessionStore;
  private readonly memoryStore: D1MemoryStore;
  private readonly memoryService: MemoryService;
  private readonly workspaceStore = new InMemoryWorkspaceStore();
  private readonly schedulerStore = new InMemorySchedulerStore();
  private readonly checkpointStore = new InMemoryCheckpointStore();
  private readonly skillStore = new InMemorySkillStore();
  private readonly learning = new LearningPipeline(this.skillStore);
  private readonly mcpClient: McpClient;
  private readonly plugins = new PluginManager().register(new MemoryCapturePlugin());
  private readonly gatewayIdempotencyKeys = new Set<string>();
  private readonly codeBridgeSessions = new Map<string, {
    maxToolCalls?: number;
    status: 'open' | 'closed';
    openedAt: string;
    lastActivityAt: string;
    closedAt?: string;
    reopenCount: number;
    transcript: Array<{ toolName: string; ok: boolean; output: string; createdAt: string }>;
  }>();
  private readonly browserSessions = new Map<string, { currentUrl?: string; history: string[]; lastSnapshot?: string; lastRefs: string[]; updatedAt: string }>();
  private readonly schedulerExecutor: SchedulerExecutor;
  private skillsInitialized = false;

  constructor(private readonly state: DurableObjectState, private readonly env: RuntimeEnv) {
    this.sessionStore = new D1SessionStore(env.DB);
    this.memoryStore = new D1MemoryStore(env.DB);
    this.memoryService = new MemoryService(this.memoryStore);
    this.mcpClient = new McpClient(new McpHttpTransport({ baseUrl: env.MCP_BASE_URL ?? 'https://mcp.example.com' }));

    this.skillRegistry = new SkillRegistry({ skillStore: this.skillStore });
    this.skillRegistry.loadBuiltIn(getBuiltInSkills());
    this.learning.setRegistry(this.skillRegistry);
    // Local skill loading (CROWCLAW_SKILL_DIR) is not supported on Cloudflare Workers
    // because Workers have no filesystem access. Use built-in or learned skills instead.

    this.schedulerExecutor = new SchedulerExecutor(
      this.schedulerStore,
      async (input) => {
        await this.ensureSkillsLoaded();
        const result = await this.createAgent({
          skillSlugs: input.skillSlugs,
          agentPreset: input.agentPreset,
          toolsetPreset: input.toolsetPreset,
          model: input.model,
        }).run({
          agentId: input.agentId,
          sessionId: input.sessionId,
          userMessage: input.userMessage,
          systemPrompt: 'You are CrowClaw executing a scheduled task on Cloudflare.',
        });
        return {
          finalResponse: result.finalResponse,
          toolResults: result.toolResults.map((r) => ({
            toolName: r.toolName,
            ok: r.ok,
            output: r.output,
          })),
        };
      },
    );
  }

  /** Ensure learned skills are loaded from the store (once per DO lifetime). */
  private async ensureSkillsLoaded(): Promise<void> {
    if (this.skillsInitialized) return;
    await this.skillRegistry.refreshLearned();
    this.skillsInitialized = true;
  }

  /** Create a fresh AgentLoop with current skills from the registry. */
  private createAgent(overrides?: {
    skillSlugs?: string[];
    agentPreset?: string;
    toolsetPreset?: string;
    model?: string;
  }): AgentLoop {
    const provider = new OpenAICompatibleProvider({
      apiKey: this.env.OPENAI_API_KEY,
      baseUrl: this.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      model: this.env.OPENAI_MODEL ?? 'gpt-4.1-mini'
    });
    let resolvedProvider: ProviderAdapter = provider;
    if (overrides?.model) {
      if (isModelOverridable(provider)) {
        resolvedProvider = provider.withModel(overrides.model);
      } else {
        console.warn(`[crowclaw] Model override '${overrides.model}' requested but provider does not support withModel(). Using default.`);
      }
    }

    // Resolve skills with optional slug filter
    let skills: ParsedSkillFile[] = this.skillRegistry.resolve();
    if (overrides?.skillSlugs && overrides.skillSlugs.length > 0) {
      const allowedSlugs = new Set(overrides.skillSlugs);
      skills = skills.filter((s) => allowedSlugs.has(s.manifest.name));
    }

    // Resolve agent preset
    let agentPreset: { role: string; goal: string; backstory?: string } | undefined;
    if (overrides?.agentPreset) {
      const preset = getAgentPreset(overrides.agentPreset);
      if (preset) {
        agentPreset = { role: preset.role, goal: preset.goal, backstory: preset.backstory };
      }
    }

    // Resolve toolset preset — filter tools when a preset is specified
    let registry = createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient);
    if (overrides?.toolsetPreset) {
      const allPresets = new Map<string, (ReturnType<typeof listToolsetPresets>)[number]>(listToolsetPresets().map((p) => [p.name, p]));
      const preset = allPresets.get(overrides.toolsetPreset);
      if (preset && preset.toolNames.length > 0) {
        const filtered = new ToolRegistry();
        for (const manifest of registry.list()) {
          if (!preset.toolNames.includes(manifest.name)) continue;
          const definition = registry.get(manifest.name);
          if (definition) filtered.register(definition);
        }
        registry = filtered;
      }
    }

    return new AgentLoop(
      resolvedProvider,
      registry,
      this.sessionStore,
      { plugins: this.plugins, runtimeName: 'cloudflare', skills, agentPreset }
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const ensureBrowserSession = (sessionId: string) => {
      const existing = this.browserSessions.get(sessionId);
      if (existing) return existing;
      const created = { currentUrl: undefined, history: [] as string[], lastSnapshot: undefined, lastRefs: [] as string[], updatedAt: new Date().toISOString() };
      this.browserSessions.set(sessionId, created);
      return created;
    };
    const recordBrowserNavigation = (sessionId: string, targetUrl: string) => {
      const session = ensureBrowserSession(sessionId);
      if (session.history.at(-1) !== targetUrl) {
        session.history.push(targetUrl);
      }
      session.currentUrl = targetUrl;
      session.updatedAt = new Date().toISOString();
      return session;
    };

    if (request.method === 'GET' && url.pathname.endsWith('/plugins')) {
      return Response.json(this.plugins.list().map((plugin) => ({ name: plugin.name })));
    }

    if (request.method === 'GET' && url.pathname.endsWith('/system/status')) {
      const registry = createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient);
      const listStore = this.sessionStore as D1SessionStore & SessionListStore;
      const sessions = typeof listStore.listRecent === 'function'
        ? await listStore.listRecent(50)
        : [];
      const dynamicMcpClient = this.mcpClient as unknown as { getStatus?: () => unknown };
      return Response.json({
        ok: true,
        runtime: 'cloudflare',
        service: 'crowclaw',
        deployment: 'crowclaw-cloudflare',
        version: '0.1.0',
        tools: registry.list().map((tool) => ({
          name: tool.name,
          description: tool.description,
          runtime: tool.runtime,
          dangerLevel: tool.dangerLevel
        })),
        model: this.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
        provider: this.env.OPENAI_API_KEY ? 'openai-compatible' : 'none',
        plugins: this.plugins.list().map((plugin) => plugin.name),
        mcp: dynamicMcpClient.getStatus ? dynamicMcpClient.getStatus() : null,
        gateway: {
          slackSigningSecretConfigured: Boolean(this.env.SLACK_SIGNING_SECRET)
        },
        counts: {
          sessions: sessions.length,
          browserSessions: this.browserSessions.size,
          bridgeSessions: this.codeBridgeSessions.size,
          schedulerJobs: (await this.schedulerStore.listJobs()).length
        }
      });
    }

    if (request.method === 'GET' && url.pathname.endsWith('/skills')) {
      await this.ensureSkillsLoaded();
      const allSkills = this.skillRegistry.resolveAll();
      const stats = this.skillRegistry.stats();
      return Response.json({
        skills: allSkills.map(({ skill, enabled }) => ({
          slug: skill.manifest.name,
          title: this.skillRegistry.getDisplayTitle(skill.manifest.name) ?? skill.manifest.name,
          summary: skill.manifest.description,
          triggerPhrases: skill.manifest.triggers,
          status: this.skillRegistry.getStatus(skill.manifest.name) ?? 'published',
          source: (skill.manifest.category as 'builtin' | 'learned' | 'local') ?? 'builtin',
          enabled,
        })),
        count: allSkills.length,
        stats,
      });
    }

    if (request.method === 'GET' && url.pathname.endsWith('/presets')) {
      const mcpNames = listMcpPresetNames();
      return Response.json({
        agents: listAgentPresets(),
        toolsets: listToolsetPresets(),
        mcp: mcpNames.map((name) => ({ name, description: getMcpPresetDescription(name) }))
      });
    }

    if (request.method === 'GET' && url.pathname.endsWith('/gateway/status')) {
      return Response.json(buildGatewayStatusPayload());
    }

    if (request.method === 'GET' && url.pathname.endsWith('/sessions')) {
      const limitParam = Number(url.searchParams.get('limit') ?? '50');
      const limit = Number.isFinite(limitParam) ? limitParam : 50;
      const listStore = this.sessionStore as D1SessionStore & SessionListStore;
      const sessions = typeof listStore.listRecent === 'function'
        ? await listStore.listRecent(limit)
        : [];
      return Response.json({
        ok: true,
        supported: typeof listStore.listRecent === 'function',
        count: sessions.length,
        sessions: sessions.map(summarizeSessionRecord)
      });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/create')) {
      const body = (await request.json().catch(() => ({}))) as { userId?: string; workspaceId?: string };
      const existing = await this.sessionStore.get(this.state.id.toString());
      const session = existing ?? {
        agentId: 'crowclaw',
        sessionId: this.state.id.toString(),
        userId: body.userId,
        workspaceId: body.workspaceId,
        messages: [],
        updatedAt: new Date().toISOString(),
        lineage: {
          rootSessionId: this.state.id.toString(),
          compressionCount: 0
        }
      } satisfies SessionState;
      if (!existing) {
        await this.sessionStore.put(session);
      }
      return Response.json({
        ok: true,
        session: summarizeSessionRecord(session)
      });
    }

    if (request.method === 'GET' && url.pathname.endsWith('/scheduler/jobs')) {
      return Response.json(await this.schedulerStore.listJobs());
    }

    if (request.method === 'POST' && url.pathname.endsWith('/scheduler/jobs')) {
      const body = (await request.json()) as {
        id: string;
        everyMinutes?: number;
        schedule?: string;
        task: string;
        skillSlugs?: string[];
        toolsetPreset?: string;
        agentPreset?: string;
        model?: string;
        deliverTo?: { platform: string; config: Record<string, string> };
        timeoutMs?: number;
        maxRuns?: number;
      };

      const schedule = body.schedule ?? `every:${body.everyMinutes ?? 5}m`;
      const job = createScheduledAgentJob({
        id: body.id,
        schedule,
        task: body.task,
        skillSlugs: body.skillSlugs,
        toolsetPreset: body.toolsetPreset,
        agentPreset: body.agentPreset,
        model: body.model,
        deliverTo: body.deliverTo,
        maxRuns: body.maxRuns,
        timeoutMs: body.timeoutMs,
      });
      await this.schedulerStore.saveJob(job);
      return Response.json(job);
    }

    if (request.method === 'POST' && url.pathname.endsWith('/scheduler/tick')) {
      const results = await this.schedulerExecutor.tick();
      return Response.json({ ok: true, results });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/gateway/idempotency')) {
      const body = (await request.json()) as { key?: string };
      const key = typeof body.key === 'string' ? body.key : '';
      if (!key) {
        return Response.json({ ok: false, duplicate: false });
      }
      const duplicate = this.gatewayIdempotencyKeys.has(key);
      if (!duplicate) {
        this.gatewayIdempotencyKeys.add(key);
      }
      return Response.json({ ok: true, duplicate });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/gateway/inspect')) {
      const body = (await request.json()) as { platform?: 'webhook' | 'telegram' | 'discord' | 'slack' | 'whatsapp' | 'signal' | 'email'; payload?: unknown };
      const platform = body.platform ?? 'webhook';
      const message = await normalizeGatewayRequest(
        platform,
        new Request('https://internal/gateway-inspect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body.payload ?? {})
        })
      );
      if (!message) {
        return Response.json({ ok: false, error: 'Unable to normalize gateway payload.', platform }, { status: 400 });
      }
      return Response.json({
        ok: true,
        message,
        deliveryPlan: buildGatewayDeliveryPlan(message)
      });
    }


    if (request.method === 'POST' && url.pathname.endsWith('/web/fetch')) {
      const body = (await request.json()) as { url: string };
      const response = await fetch(body.url);
      return new Response(await response.text(), {
        status: response.status,
        headers: { 'content-type': response.headers.get('content-type') ?? 'text/plain; charset=utf-8' }
      });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/web/metadata')) {
      const body = (await request.json()) as { url: string };
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('web.extractMetadata', { url: body.url }, {
        agentId: 'crowclaw',
        sessionId: this.state.id.toString(),
        env: this.env,
      }));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/web/links')) {
      const body = (await request.json()) as { url: string };
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('web.extractLinks', { url: body.url }, {
        agentId: 'crowclaw',
        sessionId: this.state.id.toString(),
        env: this.env,
      }));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/web/text')) {
      const body = (await request.json()) as { url: string };
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('web.extractText', { url: body.url }, {
        agentId: 'crowclaw',
        sessionId: this.state.id.toString(),
        env: this.env,
      }));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/code/exec')) {
      const body = (await request.json()) as { language?: string; code?: string; cwd?: string; timeoutMs?: number; toolBridge?: boolean; maxToolCalls?: number };
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('code.exec', {
        language: body.language,
        code: body.code,
        cwd: body.cwd,
        timeoutMs: body.timeoutMs,
        toolBridge: body.toolBridge,
        maxToolCalls: body.maxToolCalls
      }, {
        agentId: 'crowclaw',
        sessionId: this.state.id.toString(),
        workspaceId: body.cwd,
        env: this.env,
      }));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/code/bridge')) {
      const body = (await request.json()) as { sessionId?: string; maxToolCalls?: number };
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : this.state.id.toString();
      const existing = this.codeBridgeSessions.get(sessionId);
      if (!existing) {
        const now = new Date().toISOString();
        this.codeBridgeSessions.set(sessionId, {
          maxToolCalls: body.maxToolCalls,
          status: 'open',
          openedAt: now,
          lastActivityAt: now,
          reopenCount: 0,
          transcript: []
        });
      } else if (typeof body.maxToolCalls === 'number') {
        existing.maxToolCalls = body.maxToolCalls;
        if (existing.status === 'closed') {
          existing.status = 'open';
          existing.closedAt = undefined;
          existing.reopenCount += 1;
          existing.transcript = [];
        }
        existing.lastActivityAt = new Date().toISOString();
      }
      return Response.json(buildToolBridgeArtifacts(sessionId, body.maxToolCalls));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/code/bridge/call')) {
      const body = (await request.json()) as { sessionId?: string; name?: string; arguments?: Record<string, unknown>; maxToolCalls?: number };
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : this.state.id.toString();
      const name = typeof body.name === 'string' ? body.name : '';
      const existing = this.codeBridgeSessions.get(sessionId);
      const session = existing
        ?? {
          maxToolCalls: body.maxToolCalls,
          status: 'open' as const,
          openedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          reopenCount: 0,
          transcript: [] as Array<{ toolName: string; ok: boolean; output: string; createdAt: string }>
        };
      if (!existing) {
        this.codeBridgeSessions.set(sessionId, session);
      } else if (typeof body.maxToolCalls === 'number') {
        session.maxToolCalls = body.maxToolCalls;
      }

      if (!name) {
        return Response.json({ ok: false, error: 'Missing tool name.', sessionId }, { status: 400 });
      }

      if (session.status === 'closed') {
        return Response.json({ ok: false, error: 'Bridge session is closed.', sessionId }, { status: 409 });
      }

      if (typeof session.maxToolCalls === 'number' && session.transcript.length >= session.maxToolCalls) {
        return Response.json({
          ok: false,
          error: 'Tool bridge maxToolCalls exceeded.',
          sessionId,
          maxToolCalls: session.maxToolCalls,
          callsUsed: session.transcript.length
        }, { status: 429 });
      }

      const result = await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute(name, body.arguments ?? {}, {
        agentId: 'crowclaw-bridge',
        sessionId,
        env: this.env,
      });
      session.transcript.push({
        toolName: result.toolName,
        ok: result.ok,
        output: result.output,
        createdAt: new Date().toISOString()
      });
      session.lastActivityAt = new Date().toISOString();

      return Response.json({ sessionId, result, transcriptLength: session.transcript.length, status: session.status });
    }

    if (request.method === 'GET' && url.pathname.endsWith('/code/bridge/status')) {
      const sessionId = url.searchParams.get('sessionId') ?? this.state.id.toString();
      const session = this.codeBridgeSessions.get(sessionId);
      return Response.json({
        sessionId,
        exists: Boolean(session),
        status: session?.status ?? 'closed',
        openedAt: session?.openedAt,
        lastActivityAt: session?.lastActivityAt,
        closedAt: session?.closedAt,
        reopenCount: session?.reopenCount ?? 0,
        maxToolCalls: session?.maxToolCalls,
        transcriptLength: session?.transcript.length ?? 0
      });
    }

    if (request.method === 'GET' && url.pathname.endsWith('/code/bridge/transcript')) {
      const sessionId = url.searchParams.get('sessionId') ?? this.state.id.toString();
      const session = this.codeBridgeSessions.get(sessionId);
      return Response.json({
        sessionId,
        status: session?.status ?? 'closed',
        openedAt: session?.openedAt,
        lastActivityAt: session?.lastActivityAt,
        closedAt: session?.closedAt,
        maxToolCalls: session?.maxToolCalls,
        transcript: session?.transcript ?? []
      });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/code/bridge/close')) {
      const body = (await request.json()) as { sessionId?: string };
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : this.state.id.toString();
      const session = this.codeBridgeSessions.get(sessionId);
      const transcriptLength = session?.transcript.length ?? 0;
      if (session) {
        session.status = 'closed';
        session.closedAt = new Date().toISOString();
        session.lastActivityAt = session.closedAt;
      }
      return Response.json({
        ok: true,
        sessionId,
        closed: true,
        transcriptLength,
        status: session?.status ?? 'closed',
        reopenCount: session?.reopenCount ?? 0
      });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/node/exec')) {
      const body = (await request.json()) as { code?: string; cwd?: string; timeoutMs?: number; toolBridge?: boolean; maxToolCalls?: number };
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('node.exec', {
        code: body.code,
        cwd: body.cwd,
        timeoutMs: body.timeoutMs,
        toolBridge: body.toolBridge,
        maxToolCalls: body.maxToolCalls
      }, {
        agentId: 'crowclaw',
        sessionId: this.state.id.toString(),
        workspaceId: body.cwd,
        env: this.env,
      }));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/python/exec')) {
      const body = (await request.json()) as { code?: string; cwd?: string; timeoutMs?: number; toolBridge?: boolean; maxToolCalls?: number };
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('python.exec', {
        code: body.code,
        cwd: body.cwd,
        timeoutMs: body.timeoutMs,
        toolBridge: body.toolBridge,
        maxToolCalls: body.maxToolCalls
      }, {
        agentId: 'crowclaw',
        sessionId: this.state.id.toString(),
        workspaceId: body.cwd,
        env: this.env,
      }));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/browser/screenshot')) {
      const body = (await request.json()) as { url?: string; path?: string; fullPage?: boolean; sessionId?: string };
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : this.state.id.toString();
      const session = ensureBrowserSession(sessionId);
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('browser.screenshot', {
        url: body.url ?? session.currentUrl,
        path: body.path,
        fullPage: body.fullPage
      }, {
        agentId: 'crowclaw',
        sessionId,
        workspaceId: body.path,
        env: this.env,
      }));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/browser/goto')) {
      const body = (await request.json()) as { url?: string; sessionId?: string };
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : this.state.id.toString();
      const session = ensureBrowserSession(sessionId);
      const targetUrl = body.url ?? session.currentUrl;
      if (targetUrl) {
        recordBrowserNavigation(sessionId, targetUrl);
      }
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('browser.goto', {
        url: targetUrl,
      }, {
        agentId: 'crowclaw',
        sessionId,
        env: this.env,
      }));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/browser/open')) {
      const body = (await request.json()) as { url?: string; sessionId?: string };
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : this.state.id.toString();
      const session = ensureBrowserSession(sessionId);
      const targetUrl = body.url ?? session.currentUrl;
      if (targetUrl) {
        recordBrowserNavigation(sessionId, targetUrl);
      }
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('browser.open', {
        url: targetUrl,
      }, {
        agentId: 'crowclaw',
        sessionId,
        env: this.env,
      }));
    }

    if (request.method === 'POST' && (url.pathname.endsWith('/browser/wait') || url.pathname.endsWith('/browser/wait-for'))) {
      const body = (await request.json()) as { url?: string; selector?: string; timeoutMs?: number; sessionId?: string };
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : this.state.id.toString();
      const session = ensureBrowserSession(sessionId);
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('browser.waitFor', {
        url: body.url ?? session.currentUrl,
        selector: body.selector,
        timeoutMs: body.timeoutMs,
      }, {
        agentId: 'crowclaw',
        sessionId,
        env: this.env,
      }));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/browser/navigate')) {
      const body = (await request.json()) as { url?: string; sessionId?: string };
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : this.state.id.toString();
      const session = ensureBrowserSession(sessionId);
      const targetUrl = body.url ?? session.currentUrl;
      if (targetUrl) {
        recordBrowserNavigation(sessionId, targetUrl);
      }
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('browser.navigate', {
        url: targetUrl,
      }, {
        agentId: 'crowclaw',
        sessionId,
        env: this.env,
      }));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/browser/snapshot')) {
      const body = (await request.json()) as { url?: string; full?: boolean; sessionId?: string };
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : this.state.id.toString();
      const session = ensureBrowserSession(sessionId);
      const result = await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('browser.snapshot', {
        url: body.url ?? session.currentUrl,
        full: body.full,
      }, {
        agentId: 'crowclaw',
        sessionId,
        env: this.env,
      });
      if (result.ok) {
        session.currentUrl = typeof body.url === 'string' ? body.url : session.currentUrl;
        session.lastSnapshot = result.output;
        session.lastRefs = ((result.metadata as { refs?: string[] } | undefined)?.refs) ?? [];
        session.updatedAt = new Date().toISOString();
      }
      return Response.json(result);
    }

    if (request.method === 'POST' && url.pathname.endsWith('/browser/back')) {
      const body = (await request.json()) as { steps?: number; sessionId?: string };
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : this.state.id.toString();
      const session = ensureBrowserSession(sessionId);
      const steps = typeof body.steps === 'number' ? body.steps : 1;
      if (session.history.length > 1) {
        for (let index = 0; index < steps && session.history.length > 1; index += 1) {
          session.history.pop();
        }
        session.currentUrl = session.history.at(-1);
        session.updatedAt = new Date().toISOString();
        return Response.json({
          toolName: 'browser.back',
          runtime: 'sandbox',
          ok: true,
          output: `Navigated back ${steps} step(s)`,
          metadata: { simulated: true, steps, finalUrl: session.currentUrl }
        });
      }
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('browser.back', {
        steps: body.steps,
      }, {
        agentId: 'crowclaw',
        sessionId,
        env: this.env,
      }));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/browser/scroll')) {
      const body = (await request.json()) as { url?: string; direction?: string; amount?: number; sessionId?: string };
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : this.state.id.toString();
      const session = ensureBrowserSession(sessionId);
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('browser.scroll', {
        url: body.url ?? session.currentUrl,
        direction: body.direction,
        amount: body.amount,
      }, {
        agentId: 'crowclaw',
        sessionId,
        env: this.env,
      }));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/browser/press')) {
      const body = (await request.json()) as { url?: string; key?: string; sessionId?: string };
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : this.state.id.toString();
      const session = ensureBrowserSession(sessionId);
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('browser.press', {
        url: body.url ?? session.currentUrl,
        key: body.key,
      }, {
        agentId: 'crowclaw',
        sessionId,
        env: this.env,
      }));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/browser/console')) {
      const body = (await request.json()) as { url?: string; sessionId?: string };
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : this.state.id.toString();
      const session = ensureBrowserSession(sessionId);
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('browser.console', {
        url: body.url ?? session.currentUrl,
      }, {
        agentId: 'crowclaw',
        sessionId,
        env: this.env,
      }));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/browser/vision')) {
      const body = (await request.json()) as { url?: string; prompt?: string; sessionId?: string };
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : this.state.id.toString();
      const session = ensureBrowserSession(sessionId);
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('browser.vision', {
        url: body.url ?? session.currentUrl,
        prompt: body.prompt,
      }, {
        agentId: 'crowclaw',
        sessionId,
        env: this.env,
      }));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/browser/images')) {
      const body = (await request.json()) as { url?: string; limit?: number; sessionId?: string };
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : this.state.id.toString();
      const session = ensureBrowserSession(sessionId);
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('browser.images', {
        url: body.url ?? session.currentUrl,
        limit: body.limit,
      }, {
        agentId: 'crowclaw',
        sessionId,
        env: this.env,
      }));
    }

    if (request.method === 'POST' && (url.pathname.endsWith('/browser/click-ref') || url.pathname.endsWith('/browser/clickRef'))) {
      const body = (await request.json()) as { url?: string; ref?: string; sessionId?: string };
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : this.state.id.toString();
      const session = ensureBrowserSession(sessionId);
      if (body.ref && session.lastRefs.length > 0 && !session.lastRefs.includes(body.ref)) {
        return Response.json({ toolName: 'browser.clickRef', runtime: 'sandbox', ok: false, output: `Unknown ref: ${body.ref}`, metadata: { knownRefs: session.lastRefs } });
      }
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('browser.clickRef', {
        url: body.url ?? session.currentUrl,
        ref: body.ref,
      }, {
        agentId: 'crowclaw',
        sessionId,
        env: this.env,
      }));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/browser/extract')) {
      const body = (await request.json()) as { url?: string; selector?: string; sessionId?: string };
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : this.state.id.toString();
      const session = ensureBrowserSession(sessionId);
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('browser.extract', {
        url: body.url ?? session.currentUrl,
        selector: body.selector,
      }, {
        agentId: 'crowclaw',
        sessionId,
        env: this.env,
      }));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/browser/click')) {
      const body = (await request.json()) as { url?: string; selector?: string; sessionId?: string };
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : this.state.id.toString();
      const session = ensureBrowserSession(sessionId);
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('browser.click', {
        url: body.url ?? session.currentUrl,
        selector: body.selector,
      }, {
        agentId: 'crowclaw',
        sessionId,
        env: this.env,
      }));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/browser/type')) {
      const body = (await request.json()) as { url?: string; selector?: string; text?: string; sessionId?: string };
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : this.state.id.toString();
      const session = ensureBrowserSession(sessionId);
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('browser.type', {
        url: body.url ?? session.currentUrl,
        selector: body.selector,
        text: body.text,
      }, {
        agentId: 'crowclaw',
        sessionId,
        env: this.env,
      }));
    }

    if (request.method === 'GET' && url.pathname.endsWith('/browser/session')) {
      const sessionId = url.searchParams.get('sessionId') ?? this.state.id.toString();
      const session = this.browserSessions.get(sessionId);
      return Response.json(session ?? { sessionId, currentUrl: null, history: [], lastSnapshot: null, lastRefs: [] });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/browser/session/reset')) {
      const body = (await request.json()) as { sessionId?: string };
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : this.state.id.toString();
      this.browserSessions.delete(sessionId);
      return Response.json({ ok: true, sessionId, reset: true });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/file/read')) {
      const body = (await request.json()) as { path?: string };
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('file.read', {
        path: body.path,
      }, {
        agentId: 'crowclaw',
        sessionId: this.state.id.toString(),
        env: this.env,
      }));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/file/write')) {
      const body = (await request.json()) as { path?: string; content?: string };
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('file.write', {
        path: body.path,
        content: body.content,
      }, {
        agentId: 'crowclaw',
        sessionId: this.state.id.toString(),
        env: this.env,
      }));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/file/exists')) {
      const body = (await request.json()) as { path?: string };
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('file.exists', {
        path: body.path,
      }, {
        agentId: 'crowclaw',
        sessionId: this.state.id.toString(),
        env: this.env,
      }));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/file/delete')) {
      const body = (await request.json()) as { path?: string };
      return Response.json(await createRegistry(this.sessionStore, this.memoryStore, this.workspaceStore, this.mcpClient).execute('file.delete', {
        path: body.path,
      }, {
        agentId: 'crowclaw',
        sessionId: this.state.id.toString(),
        env: this.env,
      }));
    }

    if (request.method === 'GET' && url.pathname.endsWith('/mcp/tools')) {
      return Response.json(await this.mcpClient.listTools());
    }

    if (request.method === 'GET' && url.pathname.endsWith('/mcp/resources')) {
      const dynamicClient = this.mcpClient as unknown as { listResources?: () => Promise<unknown[]> };
      return Response.json(dynamicClient.listResources ? await dynamicClient.listResources() : []);
    }

    if (request.method === 'GET' && url.pathname.endsWith('/mcp/prompts')) {
      const dynamicClient = this.mcpClient as unknown as { listPrompts?: () => Promise<unknown[]> };
      return Response.json(dynamicClient.listPrompts ? await dynamicClient.listPrompts() : []);
    }

    if (request.method === 'GET' && url.pathname.endsWith('/mcp/status')) {
      const dynamicClient = this.mcpClient as unknown as { getStatus?: () => unknown };
      return Response.json(dynamicClient.getStatus ? dynamicClient.getStatus() : null);
    }

    if (request.method === 'GET' && url.pathname.endsWith('/mcp/inspect')) {
      const dynamicClient = this.mcpClient as unknown as {
        inspect?: (options?: { refresh?: boolean }) => Promise<unknown>;
        getStatus?: () => unknown;
        listTools?: (options?: { refresh?: boolean }) => Promise<unknown>;
        listResources?: () => Promise<unknown>;
        listPrompts?: () => Promise<unknown>;
      };
      const refresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
      if (dynamicClient.inspect) {
        return Response.json(await dynamicClient.inspect({ refresh }));
      }
      return Response.json({
        status: dynamicClient.getStatus ? dynamicClient.getStatus() : null,
        tools: dynamicClient.listTools ? await dynamicClient.listTools({ refresh }) : [],
        resources: dynamicClient.listResources ? await dynamicClient.listResources() : [],
        prompts: dynamicClient.listPrompts ? await dynamicClient.listPrompts() : []
      });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/mcp/reload')) {
      return Response.json(await this.mcpClient.refreshTools());
    }

    if (request.method === 'POST' && url.pathname.endsWith('/mcp/list-changed')) {
      const dynamicClient = this.mcpClient as unknown as { notifyToolsChanged?: () => Promise<unknown> };
      return Response.json(dynamicClient.notifyToolsChanged
        ? await dynamicClient.notifyToolsChanged()
        : { ok: true, refreshed: await this.mcpClient.refreshTools() });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/mcp/call')) {
      const body = (await request.json()) as { name: string; arguments?: Record<string, unknown> };
        return Response.json(await this.mcpClient.callTool(body.name, body.arguments ?? {}));
    }

    if (request.method === 'GET' && url.pathname.endsWith('/learning/drafts')) {
      return Response.json(await this.learning.listDrafts());
    }

    if (request.method === 'POST' && url.pathname.endsWith('/learning/drafts')) {
      const body = (await request.json()) as { title: string; messages: Array<{ role: 'user' | 'assistant' | 'tool' | 'system'; content: string; createdAt?: string }> };
      const stored = await this.learning.captureDraft(
        body.messages.map((message) => ({ ...message, createdAt: message.createdAt ?? new Date().toISOString() })),
        body.title
      );
      return Response.json(stored);
    }

    if (request.method === 'POST' && /\/learning\/drafts\/.+\/publish$/.test(url.pathname)) {
      const parts = url.pathname.split('/').filter(Boolean);
      const id = parts[parts.length - 2] ?? '';
      const result = await this.learning.publishDraft(id);
      await this.skillRegistry.refreshLearned();
      return Response.json(result);
    }

    if (request.method === 'POST' && /\/learning\/drafts\/.+\/unpublish$/.test(url.pathname)) {
      const parts = url.pathname.split('/').filter(Boolean);
      const id = parts[parts.length - 2] ?? '';
      const result = await this.learning.unpublishDraft(id);
      await this.skillRegistry.refreshLearned();
      return Response.json(result);
    }

    // Legacy: POST /learning/drafts/:id (without /publish suffix) — treat as publish
    if (request.method === 'POST' && /\/learning\/drafts\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
      const result = await this.learning.publishDraft(id);
      await this.skillRegistry.refreshLearned();
      return Response.json(result);
    }

    if (request.method === 'GET' && url.pathname.endsWith('/workspace')) {
      const path = url.searchParams.get('path');
      if (path) {
        const file = await this.workspaceStore.read(path);
        return Response.json(file ?? { path, content: null });
      }
      const prefix = url.searchParams.get('prefix') ?? '';
      return Response.json(await this.workspaceStore.list(prefix));
    }

    if (request.method === 'GET' && url.pathname.endsWith('/workspace/exists')) {
      const path = url.searchParams.get('path') ?? '';
      return Response.json({ path, exists: await this.workspaceStore.exists(path) });
    }

    if (request.method === 'GET' && url.pathname.includes('/workspace/')) {
      const path = url.pathname.split('/workspace/')[1] ?? '';
      const file = await this.workspaceStore.read(path);
      return Response.json(file ?? { path, content: null });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/workspace/write')) {
      const body = (await request.json()) as { path: string; content: string };
      return Response.json(await this.workspaceStore.write(body.path, body.content));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/workspace/patch')) {
      const body = (await request.json()) as { path: string; patches: Array<{ line: number; value: string }> };
      return Response.json(await this.workspaceStore.patchLines(body.path, body.patches));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/workspace/patch-text')) {
      const body = (await request.json()) as { path: string; replacements: Array<{ from: string; to: string }> };
      return Response.json(await this.workspaceStore.patchText(body.path, body.replacements));
    }

    if (request.method === 'POST' && url.pathname.endsWith('/workspace/delete')) {
      const body = (await request.json()) as { path: string };
      return Response.json({ path: body.path, removed: await this.workspaceStore.remove(body.path) });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/workspace/rename')) {
      const body = (await request.json()) as { fromPath: string; toPath: string };
      const file = await this.workspaceStore.rename(body.fromPath, body.toPath);
      return Response.json(file ?? { fromPath: body.fromPath, toPath: body.toPath, content: null });
    }

    if (request.method === 'GET' && (url.pathname.endsWith('/history') || url.pathname.endsWith('/state'))) {
      const session = await this.sessionStore.get(this.state.id.toString());
      return session
        ? Response.json({ ok: true, session })
        : Response.json({ ok: false, error: 'Session not found' }, { status: 404 });
    }

    if (request.method === 'GET' && url.pathname.endsWith('/memories')) {
      const scopeParam = url.searchParams.get('scope');
      const scopeKey = url.searchParams.get('scopeKey') ?? undefined;
      const limitParam = Number(url.searchParams.get('limit') ?? '50');
      const limit = Number.isFinite(limitParam) ? limitParam : 50;
      const records = scopeParam === 'session' || scopeParam === 'user' || scopeParam === 'workspace'
        ? await this.memoryService.listByScope(scopeParam, limit, scopeKey)
        : await this.memoryService.list(this.state.id.toString(), limit);
      return Response.json({ ok: true, records, ...(scopeParam ? { scope: scopeParam, scopeKey } : { sessionId: this.state.id.toString() }) });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/remember')) {
      const body = (await request.json()) as { summary: string; tags?: string[]; metadata?: Record<string, unknown>; scope?: 'session' | 'user' | 'workspace'; scopeKey?: string };
      const record = await this.memoryService.remember(this.state.id.toString(), body.summary, body.tags ?? [], body.metadata, body.scope ?? 'session', body.scopeKey);
      return Response.json(record);
    }

    if (request.method === 'POST' && url.pathname.endsWith('/capture')) {
      const body = (await request.json()) as { scope?: 'session' | 'user' | 'workspace'; scopeKey?: string; messages?: Array<{ role: 'user' | 'assistant' | 'tool' | 'system'; content: string; createdAt?: string }> };
      const messages = body.messages?.map((message) => ({ ...message, createdAt: message.createdAt ?? new Date().toISOString() })) ?? [];
      const record = await this.memoryService.captureScopedSummary(body.scope ?? 'session', this.state.id.toString(), messages, body.scopeKey);
      return Response.json(record);
    }

    if (request.method === 'POST' && url.pathname.endsWith('/search')) {
      const body = (await request.json()) as { query: string; source?: 'session' | 'memory'; scope?: 'session' | 'user' | 'workspace'; scopeKey?: string; limit?: number };
      const limit = typeof body.limit === 'number' ? body.limit : 10;
      if (body.source === 'memory' && body.scope) {
        const results = await this.memoryService.recallByScope(body.scope, body.query, limit, body.scopeKey);
        return Response.json({ ok: true, source: 'memory', scope: body.scope, scopeKey: body.scopeKey, results });
      }
      if (body.source === 'memory') {
        const results = await this.memoryStore.search(this.state.id.toString(), body.query, limit);
        return Response.json({ ok: true, source: 'memory', results });
      }

      const results = await this.sessionStore.search(this.state.id.toString(), body.query, limit);
      return Response.json({ ok: true, source: 'session', results });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/message')) {
      await this.ensureSkillsLoaded();
      const body = (await request.json()) as { userMessage: string; userId?: string; workspaceId?: string };
      const agent = this.createAgent();
      const result = await agent.run({
        agentId: 'crowclaw',
        sessionId: this.state.id.toString(),
        userMessage: body.userMessage,
        userId: body.userId,
        workspaceId: body.workspaceId,
        systemPrompt: 'You are CrowClaw running on Cloudflare. Prefer worker-native tools and use sandbox tools for execution-heavy tasks.',
        env: this.env
      });
      await this.memoryService.captureSessionSummary(result.session.sessionId, result.session.messages);
      return Response.json(result);
    }

    if (request.method === 'POST' && url.pathname.endsWith('/sandbox/exec')) {
      const body = (await request.json()) as { command?: string };
      const command = body.command?.trim() || 'pwd';
      const sandbox = getSandbox(this.env.Sandbox, this.state.id.toString());
      const result = await sandbox.exec(command);
      return Response.json({
        ok: result.success,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
      });
    }

    // Checkpoint routes
    if (request.method === 'POST' && url.pathname.endsWith('/checkpoint')) {
      const sessionId = this.state.id.toString();
      const session = await this.sessionStore.get(sessionId);
      if (!session) return Response.json({ error: 'Session not found' }, { status: 404 });
      const body = (await request.json()) as { label?: string; trigger?: string };

      // Extract tool results from session messages. Read the authoritative
      // `metadata.ok` stored by core's toolMessage() — prior regex scrape
      // falsely flagged outputs containing "error" as failed.
      const toolResults = session.messages
        .filter((m): m is typeof m & { role: 'tool' } => m.role === 'tool')
        .map((m) => ({
          toolName: m.name ?? 'unknown',
          runtime: 'worker' as const,
          ok: (m.metadata as { ok?: boolean } | undefined)?.ok ?? true,
          output: m.content,
        }));

      const cp = createCheckpoint(
        session,
        toolResults,
        session.messages.length,
        normalizeCheckpointTrigger(body.trigger),
        body.label,
        {
          currentIteration: toolResults.length,
          systemPrompt: session.messages.find((m) => m.role === 'system')?.content,
        },
      );
      await this.checkpointStore.save(cp);
      return Response.json({
        ok: true,
        checkpoint: {
          id: cp.id,
          iteration: cp.iteration,
          trigger: cp.metadata.trigger,
          label: cp.metadata.label,
          createdAt: cp.createdAt,
          messageCount: cp.metadata.messageCount,
        },
      });
    }

    if (request.method === 'GET' && url.pathname.endsWith('/checkpoints')) {
      const sessionId = this.state.id.toString();
      const checkpoints = await this.checkpointStore.listBySession(sessionId);
      return Response.json({
        checkpoints: checkpoints.map((cp) => ({
          id: cp.id,
          iteration: cp.iteration,
          trigger: cp.metadata.trigger,
          label: cp.metadata.label,
          createdAt: cp.createdAt,
          messageCount: cp.metadata.messageCount,
          toolCallCount: cp.metadata.toolCallCount,
        })),
      });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/restore')) {
      const sessionId = this.state.id.toString();
      const body = (await request.json()) as { checkpointId?: string };
      const cpId = body.checkpointId;
      if (!cpId) return Response.json({ error: 'Missing checkpointId' }, { status: 400 });
      const checkpoint = await this.checkpointStore.get(cpId);
      if (!checkpoint) return Response.json({ error: 'Checkpoint not found' }, { status: 404 });
      const session = await this.sessionStore.get(sessionId);
      if (!session) return Response.json({ error: 'Session not found' }, { status: 404 });
      const restored = restoreFromCheckpoint(checkpoint, session);
      await this.sessionStore.put(restored.session);
      // Surface toolResults + loopState (previously dropped) so the Cloudflare
      // restore path matches Node — UIs can thread them into the next run().
      return Response.json({
        ok: true,
        restoredTo: cpId,
        messageCount: restored.session.messages.length,
        toolResults: restored.toolResults,
        loopState: restored.loopState,
        restoredIteration: checkpoint.iteration,
      });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/replay')) {
      const body = (await request.json()) as { checkpointId?: string; newSessionId?: string };
      const cpId = body.checkpointId;
      if (!cpId) return Response.json({ error: 'Missing checkpointId' }, { status: 400 });
      const checkpoint = await this.checkpointStore.get(cpId);
      if (!checkpoint) return Response.json({ error: 'Checkpoint not found' }, { status: 404 });
      const replaySession = createReplaySession(checkpoint, body.newSessionId);
      await this.sessionStore.put(replaySession);
      return Response.json({ ok: true, sessionId: replaySession.sessionId, messageCount: replaySession.messages.length });
    }

    return new Response('Not found', { status: 404 });
  }
}
