import { join as joinPath } from 'node:path';
import { InMemoryCheckpointStore, PersonaRegistry, DetailedUsageTracker, SecurityAuditLog, FileSecurityAuditLog, restoreFromCheckpoint, type ToolExecutionContext } from '@crowclaw/core';
import { createLogger, type Logger } from './logger.js';
import { installOpenTelemetryBridge, observeRuntimeTelemetryEvent } from './otel.js';
import { SessionMutex } from './session-mutex.js';
import { EventBus } from './event-bus.js';
import { InMemoryGatewayIdempotencyStore, WsAuthRateLimiter } from '@crowclaw/gateway';
import { LearningPipeline, InMemorySkillStore, SkillRegistry, createLlmSkillExtractor } from '@crowclaw/learning';
import { McpClient, McpHttpTransport } from '@crowclaw/mcp';
import { MemoryService, InMemoryMemoryProvider, memoryProviderFromPluginRegistry, type MemoryProvider } from '@crowclaw/memory';
import { UserModelService } from '@crowclaw/memory';
import { EchoProvider } from '@crowclaw/providers';
import { InMemorySessionStore } from '@crowclaw/storage';
import { ToolRegistry, createDefaultWorkerRegistry, listToolsetPresets, registerSchedulerTools, createFrozenMemorySetTool, createFrozenMemoryRemoveTool } from '@crowclaw/tools';
import { FileConfigStore } from './config-store.js';
import type { CodeBridgeSession } from './bridge-state.js';
import type { BrowserSessionState } from './browser-state.js';
import type { BridgeProcessRecord } from './bridge-process.js';
import {
  RateLimiter,
  checkContentLengthCap,
  isLocalhostAddress,
  parseUsdCap,
  readJsonWithSizeCap,
  sanitizeConfigMutation,
  createRuntimeRouteHandler,
} from './route-handlers.js';
import { resolveProviderFromConfig } from './provider-factory.js';
import { createDefaultSecretChain } from './secret-loader.js';
import { SessionController } from './session-controller.js';
import { WebSocketManager } from './websocket.js';
import { createEmbeddedProtocolServers } from './mcp-acp-embed.js';
import { createGatewayActivityLog, createGatewayAccessController, createGatewayDelivery } from './gateway-wiring.js';
import { createAgentBootstrap, isInProgressCheckpoint } from './agent-bootstrap.js';
import {
  FeedbackLedger,
  GatewayDebouncer,
  claimIdempotency,
  directToolAliases,
  formatSseFrame,
  getRequestLocale,
  normalizeCheckpointTrigger,
  releaseIdempotency,
  renderBrowserBackResult,
  renderBrowserClickRefResult,
  renderBrowserConsoleResult,
  renderBrowserGotoResult,
  renderBrowserImagesResult,
  renderBrowserPressResult,
  renderBrowserScrollResult,
  renderBrowserSnapshotResult,
  renderBrowserVisionResult,
  renderBrowserWaitForResult,
  renderScreenshotResult,
  summarizeBridgeSessionRecord,
  summarizeBridgeSessionsAggregate,
  summarizeDirectTools,
  summarizeSessionRecord,
  summarizeSessionTranscript,
  type NodeRuntimeOptions,
  type SseSubscriber,
} from './runtime-support.js';
import {
  collectProviderKeysFromEnv,
  createContextEngineState,
  createFrozenMemoryState,
  createPersonaState,
  createRuntimeConfigStore,
  createRuntimeMemoryStore,
  createRuntimeSchedulerStore,
  createRuntimeWorkspaceStore,
  getRuntimeDataDir,
  getRuntimeEnv,
  loadRuntimeSkills,
  summarizeProviderPoolFromEnv,
} from './runtime-init.js';
import { createRuntimeShutdown } from './runtime-lifecycle.js';
import { createDefaultPluginManager, createRuntimePluginCatalog } from './runtime-plugins.js';
import { createRuntimeScheduler } from './runtime-scheduler.js';
import { configureTelegramWebhookStartup, warnWhenDashboardTokenMissing } from './runtime-startup.js';

export { SecretChain, envSource, filesSource, systemdCredsSource, onePasswordSource, createDefaultSecretChain, resolveSecret } from './secret-loader.js';
export {
  MAX_REQUEST_BODY_BYTES,
  RateLimiter,
  checkContentLengthCap,
  readJsonWithSizeCap,
  sanitizeConfigMutation,
} from './route-handlers.js';
export { FeedbackLedger, GatewayDebouncer } from './runtime-support.js';
export type { FeedbackEntry, NodeRuntimeOptions, SseSubscriber } from './runtime-support.js';

export function createNodeRuntime(options: NodeRuntimeOptions = {}) {
  const store = options.sessionStore ?? new InMemorySessionStore();
  const runtimeEnv = getRuntimeEnv();
  const secretChain = createDefaultSecretChain(runtimeEnv);
  let dashboardToken = runtimeEnv.CROWCLAW_DASHBOARD_TOKEN?.trim() || undefined;
  let secretLoadError: string | null = null;
  let dashboardTokenReady: Promise<void> = Promise.resolve();
  const refreshRuntimeSecrets = async (): Promise<void> => {
    try {
      dashboardToken = await secretChain.resolve('CROWCLAW_DASHBOARD_TOKEN');
      secretLoadError = null;
    } catch (err: unknown) {
      secretLoadError = err instanceof Error ? err.message : String(err);
    }
  };
  dashboardTokenReady = refreshRuntimeSecrets();
  const dataDir = getRuntimeDataDir(options, runtimeEnv);
  const { memoryStore } = createRuntimeMemoryStore(options);
  const workspaceStore = createRuntimeWorkspaceStore(options);
  const schedulerStore = createRuntimeSchedulerStore(options, dataDir);
  const skillStore = options.skillStore ?? new InMemorySkillStore();
  const gatewayIdempotencyStore = options.gatewayIdempotencyStore ?? new InMemoryGatewayIdempotencyStore();
  const feedbackLedger = new FeedbackLedger();
  const gatewayDebouncer = new GatewayDebouncer();
  const gatewayActivityLog = createGatewayActivityLog(100);
  let releaseCheckCache: { fetchedAt: number; latest: string | null; isOutdated: boolean } | null = null;

  const isVitest = typeof process !== 'undefined'
    && (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test');
  const configStore = createRuntimeConfigStore(options, dataDir, isVitest);
  const { messageStore, frozenMemory, frozenUserProfile, frozenMemoryReady } = createFrozenMemoryState(dataDir);
  const contextEngine = createContextEngineState(options);

  // Security audit log, rate limiters, logger, and session mutex
  const securityAuditLog = options.auditLogPath === null
    ? new SecurityAuditLog(500)
    : new FileSecurityAuditLog({ baseDir: options.auditLogPath ?? joinPath(dataDir, 'audit'), maxEvents: 500 });
  const rateLimiter = new RateLimiter();
  const authRateLimiter = new RateLimiter();
  const webhookRateLimiter = new RateLimiter();
  const chatRateLimiter = new RateLimiter();
  // Issue #69: per-IP WS auth rate limiter with exponential backoff bans.
  // Lives in @crowclaw/gateway so the same primitive can be reused by other
  // runtimes (CF Workers). Defaults: 5 failures / minute trigger a 5-minute
  // ban; bans double on each escalation up to a 1-hour cap. A successful
  // auth resets both the failure window and the escalation level for that IP.
  const wsAuthRateLimiter = new WsAuthRateLimiter();
  const log: Logger = createLogger({ name: 'crowclaw', level: (options as Record<string, unknown>).logLevel as 'debug' | 'info' | undefined ?? 'info' });
  const processRef = (globalThis as unknown as {
    process?: {
      on?: (event: string, listener: () => void) => unknown;
      off?: (event: string, listener: () => void) => unknown;
      removeListener?: (event: string, listener: () => void) => unknown;
    };
  }).process;
  const reloadSecretsOnSighup = (): void => {
    dashboardTokenReady = (async () => {
      await refreshRuntimeSecrets();
      if (!options.provider && !isHermeticMode) {
        const resolved = await resolveProviderFromConfig({ secretChain });
        if (resolved.source !== 'echo') {
          provider = resolved.provider;
        }
      }
      if (secretLoadError) {
        log.error('Runtime secret reload failed', { component: 'secrets', error: secretLoadError });
      } else {
        log.info('Runtime secrets reloaded', { component: 'secrets' });
      }
    })().catch((err: unknown) => {
      secretLoadError = err instanceof Error ? err.message : String(err);
      log.error('Runtime secret reload failed', { component: 'secrets', error: secretLoadError });
    });
  };
  const sighupListenerAttached = !isVitest && !!processRef?.on;
  if (sighupListenerAttached) {
    processRef.on?.('SIGHUP', reloadSecretsOnSighup);
  }
  if (options.otel ?? runtimeEnv.CROWCLAW_OTEL_ENABLED === 'true') {
    void installOpenTelemetryBridge();
  }
  const sessionMutex = new SessionMutex();
  const eventBus = new EventBus();
  let lastHeartbeatAt: string | null = null;
  const unsubscribeRuntimeTelemetryMetrics = eventBus.subscribe((event) => {
    observeRuntimeTelemetryEvent(event);
  });
  // #118: Capture the unsubscribe so `shutdown()` can detach the listener.
  // EventBus is per-runtime today, but listeners outliving their runtime would
  // still pin closures (resolve fns, runtime locals) until GC, and any future
  // refactor that hoists EventBus to a singleton would leak across runtimes.
  const unsubscribeHeartbeatTracker = eventBus.subscribe((event) => {
    if (event.type === 'chat:complete' || event.type === 'session:updated') {
      lastHeartbeatAt = new Date().toISOString();
    }
  });
  const sessionController = new SessionController(eventBus);
  const wsManager = new WebSocketManager();
  wsManager.setStatsProvider(() => ({
    sessions: (store as unknown as { size?: number }).size ?? 0,
    subscribers: eventBus.subscriberCount,
  }));
  wsManager.start(eventBus);
  wsManager.onAbort((sid) => sessionController.abort(sid));

  // #41: track every open SSE subscriber so SIGTERM drain can flush them in
  //      one pass instead of waiting for each `request.signal` to fire (which
  //      doesn't reliably happen on abrupt server shutdown).
  const sseSubscribers = new Set<SseSubscriber>();

  // #42: track in-flight `learning.autoCapture` promises so SIGTERM drain can
  //      await them (with a 5s cap) instead of dropping skill captures on
  //      shutdown. autoCapture is fire-and-forget on the hot path, so without
  //      this set the runtime would lose skills that were almost saved.
  const inFlightLearning = new Set<Promise<void>>();
  const trackLearning = (p: Promise<unknown>): void => {
    const wrapped = p.then(() => undefined, () => undefined);
    inFlightLearning.add(wrapped);
    wrapped.finally(() => { inFlightLearning.delete(wrapped); });
  };

  const skillRegistry = new SkillRegistry({ skillStore });

  // Wire LLM skill extractor — uses the current provider for intelligent skill extraction
  const llmSkillExtractor = createLlmSkillExtractor(async (prompt: string) => {
    if (!providerReady) return ''; // provider not resolved yet
    const result = await provider.generate({
      messages: [{ role: 'user', content: prompt, createdAt: new Date().toISOString() }],
      systemPrompt: 'You are a skill extraction assistant. Output valid JSON only.',
      availableTools: [],
    });
    return result.assistantMessage ?? '';
  });

  const learning = new LearningPipeline(skillStore, { extractionProvider: llmSkillExtractor });
  learning.setRegistry(skillRegistry);
  // v0.8.0 Hermes parity (#233): construct (or accept) a pluggable provider.
  const plugins = options.plugins ?? createDefaultPluginManager();
  // The MemoryService facade still drives the v0.7 call sites, but it now
  // delegates the v0.8 surface (prefetch / sync_turn / shutdown) to this
  // provider so adapters can intercept those hooks without rewriting the
  // facade's twenty-plus call sites.
  const memoryProvider: MemoryProvider = options.memoryProvider
    ?? memoryProviderFromPluginRegistry(plugins)
    ?? new InMemoryMemoryProvider(memoryStore);
  if ((runtimeEnv.CROWCLAW_MEMORY_SUMMARIZE === 'true' || (options as Record<string, unknown>).memorySummarize === true) && !memoryProvider.llmSummarize) {
    memoryProvider.llmSummarize = async (messages) => {
      if (!providerReady) return '';
      const transcript = messages
        .slice(-24)
        .map((message) => `${message.role}: ${message.content.slice(0, 2000)}`)
        .join('\n');
      const result = await provider.generate({
        messages: [{
          role: 'user',
          content: `Summarize this session for future cross-session recall. Preserve durable decisions, constraints, names, and open tasks. Return one concise paragraph and no preamble.\n\n${transcript}`,
          createdAt: new Date().toISOString(),
        }],
        systemPrompt: 'You write concise semantic memory summaries for an agent memory index.',
        availableTools: [],
      });
      return result.assistantMessage?.trim() ?? '';
    };
  }
  const memoryService = new MemoryService(memoryStore, undefined, memoryProvider);
  const userModelService = new UserModelService(memoryStore);
  const mcpClient = options.mcpClient ?? new McpClient(new McpHttpTransport({ baseUrl: options.mcpBaseUrl ?? 'https://mcp.example.com' }));
  const { installedPluginConfigs, createCatalogPlugin, listInstalledPlugins } = createRuntimePluginCatalog(plugins);
  const tools = options.tools ?? createDefaultWorkerRegistry({
    sessionSearchStore: store,
    memoryStore,
    workspaceStore,
    mcpClient,
    recallFn: (sessionId: string, query: string, limit: number) => memoryService.recall(sessionId, query, limit)
  });
  const terminalBackgroundProcesses = new Map<number, unknown>();
  const terminalToolContext = (sessionId: string): ToolExecutionContext => ({
    agentId: options.agentId ?? 'crowclaw',
    sessionId,
    backgroundProcesses: terminalBackgroundProcesses,
  } as ToolExecutionContext);

  // Provider: resolve from env/config if not explicitly provided.
  // Hermetic mode (skip ALL env/config resolution → keep EchoProvider) when:
  //   - configStorePath is explicitly null (test fixture opt-in), OR
  //   - we're running under Vitest and the caller didn't pass either provider
  //     or configStorePath (auto-detected to prevent local API keys from
  //     leaking into the in-process test runtime).
  const isHermeticMode = options.configStorePath === null
    || (isVitest && options.configStorePath === undefined && !options.provider);
  let provider = options.provider ?? new EchoProvider();
  let providerReady = !!options.provider || isHermeticMode;
  if (!options.provider && !isHermeticMode) {
    void resolveProviderFromConfig({ secretChain }).then((resolved) => {
      if (resolved.source !== 'echo') {
        provider = resolved.provider;
        // v0.7.2: surface the Codex/ChatGPT route specifically so operators
        // know the runtime is talking to the undocumented chatgpt.com backend
        // instead of api.openai.com.
        const ctorName = (resolved.provider as unknown as { constructor?: { name?: string } })?.constructor?.name;
        const maybeGetModel = (resolved.provider as unknown as { getModel?: () => string }).getModel;
        const model = typeof maybeGetModel === 'function' ? maybeGetModel.call(resolved.provider) : '';
        if (ctorName === 'OpenAICompatibleProvider' && /^gpt-5\.\d/.test(model)) {
          console.log(
            `[crowclaw] Using ChatGPT subscription via Codex CLI (model=${model}). Run \`codex login\` if auth fails.`
          );
        }
      } else {
        // Issue #175: No real provider key — switch to EchoProvider demo mode
        // so onboarding (memory capture / skill matching / scheduler / plugin
        // hooks) exercises the full pipeline against simulated streaming, and
        // log a prominent banner so operators understand why responses look
        // canned.
        provider = new EchoProvider({ demoMode: true });
        console.log(
          '[crowclaw] DEMO MODE: EchoProvider active. Set OPENROUTER_API_KEY for real LLM. Memory + Skills + Scheduler still fully exercised.'
        );
      }
      providerReady = true;
    }).catch((err: unknown) => {
      secretLoadError = err instanceof Error ? err.message : String(err);
      log.error('Provider secret resolution failed', { component: 'secrets', error: secretLoadError });
      providerReady = true;
    });
  }

  const toolsetPresets = new Map<string, (ReturnType<typeof listToolsetPresets>)[number]>(
    listToolsetPresets().map((preset) => [preset.name, preset])
  );
  const codeBridgeSessions = new Map<string, CodeBridgeSession>();
  const bridgeProcesses = new Map<string, BridgeProcessRecord>();
  const browserSessions = new Map<string, BrowserSessionState>();
  const usageTracker = options.usageTracker ?? new DetailedUsageTracker();
  let activeUsageSessionId: string | null = null;
  const recordUsageEntry = usageTracker.record.bind(usageTracker);
  usageTracker.record = ((entry: Parameters<DetailedUsageTracker['record']>[0] & { sessionId?: string; toolName?: string }) => {
    recordUsageEntry({
      ...entry,
      ...(entry.sessionId || !activeUsageSessionId ? {} : { sessionId: activeUsageSessionId }),
    } as Parameters<DetailedUsageTracker['record']>[0]);
  }) as DetailedUsageTracker['record'];
  const deploymentName = options.deploymentName ?? 'crowclaw-node';
  const version = options.version ?? '0.1.0';

  function usageCostForToday(): number {
    const today = new Date().toISOString().slice(0, 10);
    return usageTracker.getSummary().entries
      .filter((entry) => entry.timestamp.slice(0, 10) === today)
      .reduce((sum, entry) => sum + entry.costUsd, 0);
  }

  function enforceDailyUsdCap(surface: string, key: string, sessionId?: string): Response | null {
    const cap = parseUsdCap(runtimeEnv.CROWCLAW_DAILY_USD_CAP);
    if (cap === null) return null;
    const spent = usageCostForToday();
    if (spent < cap) return null;
    securityAuditLog.record({
      type: 'rate_limit_exceeded',
      severity: 'warning',
      detail: `${surface} budget exceeded key=${key} spent=${spent.toFixed(6)} cap=${cap.toFixed(6)}`,
      ...(sessionId ? { sessionId } : {}),
    });
    return Response.json(
      { error: 'Daily LLM budget exceeded', code: 'BUDGET_EXCEEDED', spentUsd: spent, capUsd: cap },
      { status: 429, headers: { 'Retry-After': '3600' } },
    );
  }

  const collectProviderKeys = (prefix: string) => collectProviderKeysFromEnv(runtimeEnv, prefix);
  const summarizeProviderPool = (providerName: string) => summarizeProviderPoolFromEnv(runtimeEnv, providerName);
  loadRuntimeSkills(skillRegistry, options, runtimeEnv);

  const personaRegistry = new PersonaRegistry();
  const personaState = createPersonaState(personaRegistry, options, runtimeEnv);

  // Cap at 1000 checkpoints across all sessions. With autoCheckpoint on,
  // a long-running server accumulates one per iteration forever — the cap
  // keeps in-memory growth bounded. FIFO evicts the oldest.
  const checkpointStore = options.checkpointStore ?? new InMemoryCheckpointStore({ maxCheckpoints: 1000 });
  const autoResumedCheckpointIds = new Set<string>();

  const agentBootstrap = createAgentBootstrap({
    options,
    provider: () => provider,
    store,
    configStore,
    tools,
    toolsetPresets,
    skillRegistry,
    personaRegistry,
    getPersonaPrompt: personaState.getPersonaPrompt,
    plugins,
    usageTracker,
    checkpointStore,
    autoResumedCheckpointIds,
    securityAuditLog,
    eventBus,
    log,
    contextEngineReady: contextEngine.contextEngineReady,
    getContextEngineResult: contextEngine.getContextEngineResult,
    frozenMemoryReady,
    memoryProvider,
    userModelService,
    frozenMemory,
    frozenUserProfile,
    feedbackLedger,
    messageStore,
    setActiveUsageSessionId: (sessionId) => { activeUsageSessionId = sessionId; },
  });
  const { createConfiguredAgent, runConfiguredAgent } = agentBootstrap;

  const autoResumeStartupReady = (async () => {
    if (options.autoResumeCheckpoints === false) return;
    const listSessions = (store as unknown as { list?: () => Promise<Array<{ sessionId: string }>> }).list;
    if (typeof listSessions !== 'function') return;
    const sessions = await listSessions.call(store);
    for (const sessionSummary of sessions) {
      const session = await store.get(sessionSummary.sessionId);
      if (!session) continue;
      const checkpoints = await checkpointStore.listBySession(session.sessionId);
      const checkpoint = checkpoints.slice().reverse().find((cp) => isInProgressCheckpoint(cp) && !autoResumedCheckpointIds.has(cp.id));
      if (!checkpoint) continue;
      const restored = restoreFromCheckpoint(checkpoint, session);
      await store.put(restored.session);
      autoResumedCheckpointIds.add(checkpoint.id);
      eventBus.emit('session:resumed', {
        sessionId: session.sessionId,
        action: 'checkpoint:auto-resume',
        checkpointId: checkpoint.id,
        reason: 'in_progress_checkpoint',
        messageCount: restored.session.messages.length,
      });
    }
  })().catch((err: unknown) => {
    log.warn('Checkpoint auto-resume startup sweep failed', {
      component: 'checkpoints',
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // #152: wire ownerToken from CROWCLAW_DASHBOARD_TOKEN so the embedded MCP
  // server enforces ownerOnly tool gating. Without this, the bridge runs in
  // "legacy mode" where every caller is treated as owner — any unauthenticated
  // POST to /api/mcp/server/request could invoke `crowclaw.chat`.
  const embeddedMcpOwnerToken = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CROWCLAW_DASHBOARD_TOKEN;
  const { embeddedMcpServer, embeddedAcpServer } = createEmbeddedProtocolServers({
    run: async (input) => runConfiguredAgent({ ...input, systemPrompt: input.systemPrompt ?? '' }),
    agentId: options.agentId ?? 'crowclaw-mcp-server',
    version,
    ownerToken: embeddedMcpOwnerToken,
  });

  const { getGatewayAccessPolicy, enforceGatewayAccess } = createGatewayAccessController({
    configStore,
    eventBus,
    gatewayActivityLog,
  });

  const deliverToGateway = createGatewayDelivery({
    configStore,
    eventBus,
    gatewayActivityLog,
  });

  const { schedulerExecutor, autonomousScheduler } = createRuntimeScheduler({
    schedulerStore,
    eventBus,
    createConfiguredAgent,
    deliverToGateway,
  });

  // Register scheduler tools so the LLM can create/list/delete/toggle jobs from chat
  if (tools instanceof ToolRegistry) {
    registerSchedulerTools(tools, schedulerStore, autonomousScheduler);
  }

  // Register frozen memory tools (memory.set, memory.remove)
  tools.register(createFrozenMemorySetTool(frozenMemory));
  tools.register(createFrozenMemoryRemoveTool(frozenMemory));

  // Auto-start scheduler if there are existing jobs
  schedulerStore.listJobs().then((jobs) => {
    if (jobs.length > 0) {
      autonomousScheduler.start();
    }
  }).catch(() => { /* scheduler store may not be ready yet */ });

  warnWhenDashboardTokenMissing({
    dashboardTokenReady,
    getDashboardToken: () => dashboardToken,
    options,
    isLocalhostAddress,
    log,
  });
  const publicUrl = configureTelegramWebhookStartup({ options, runtimeEnv, configStore, log });

  const shutdown = createRuntimeShutdown({
    sseSubscribers,
    wsManager,
    unsubscribeHeartbeatTracker,
    unsubscribeRuntimeTelemetryMetrics,
    clearContextRefresh: contextEngine.clearContextRefresh,
    gatewayDebouncer,
    inFlightLearning,
    memoryProvider,
    sighupListenerAttached,
    processRef,
    reloadSecretsOnSighup,
    securityAuditLog,
  });

  return {
    tools,
    store,
    memoryStore,
    memoryProvider,
    workspaceStore,
    schedulerStore,
    skillStore,
    configStore,
    securityAuditLog,
    userModelService,
    mcpClient,
    plugins,
    autonomousScheduler,
    log,
    sessionMutex,
    eventBus,
    feedbackLedger,
    shutdown,
    autoResumeStartupReady,
    // v0.7.1: exposed so Node entry-points (serve-local.mjs) can wire an
    // upgraded `ws` library WebSocket into the runtime's event broadcast
    // pipeline. The fetch() path uses Workers-only WebSocketPair which is
    // unavailable on Node, so this is the only route for live events on
    // the Node host.
    wsManager,
    fetch: createRuntimeRouteHandler({
      options,
      runtimeEnv,
      dashboardTokenReady: () => dashboardTokenReady,
      dashboardToken: () => dashboardToken,
      secretLoadError: () => secretLoadError,
      provider: () => provider,
      setPersonaPrompt: personaState.setPersonaPrompt,
      contextEngineResult: contextEngine.getContextEngineResult,
      lastHeartbeatAt: () => lastHeartbeatAt,
      publicUrl,
      store,
      memoryStore,
      memoryService,
      memoryProvider,
      workspaceStore,
      schedulerStore,
      skillStore,
      configStore,
      securityAuditLog,
      userModelService,
      mcpClient,
      plugins,
      autonomousScheduler,
      log,
      sessionMutex,
      eventBus,
      feedbackLedger,
      wsManager,
      rateLimiter,
      authRateLimiter,
      webhookRateLimiter,
      chatRateLimiter,
      wsAuthRateLimiter,
      gatewayDebouncer,
      gatewayIdempotencyStore,
      runConfiguredAgent,
      createConfiguredAgent,
      embeddedMcpServer,
      embeddedAcpServer,
      getGatewayAccessPolicy,
      enforceGatewayAccess,
      deliverToGateway,
      sessionController,
      sseSubscribers,
      skillRegistry,
      learning,
      llmSkillExtractor,
      tools,
      terminalToolContext,
      codeBridgeSessions,
      bridgeProcesses,
      browserSessions,
      usageTracker,
      deploymentName,
      version,
      enforceDailyUsdCap,
      collectProviderKeys,
      summarizeProviderPool,
      gatewayActivityLog,
      schedulerExecutor,
      personaRegistry,
      installedPluginConfigs,
      createCatalogPlugin,
      listInstalledPlugins,
      toolsetPresets,
      checkpointStore,
      autoResumedCheckpointIds,
      frozenMemoryReady,
      frozenMemory,
      frozenUserProfile,
      messageStore,
      releaseCheckCache,
      trackLearning,
      getRequestLocale,
      normalizeCheckpointTrigger,
      directToolAliases,
      summarizeDirectTools,
      summarizeSessionRecord,
      summarizeSessionTranscript,
      summarizeBridgeSessionRecord,
      summarizeBridgeSessionsAggregate,
      renderScreenshotResult,
      renderBrowserGotoResult,
      renderBrowserWaitForResult,
      renderBrowserSnapshotResult,
      renderBrowserBackResult,
      renderBrowserScrollResult,
      renderBrowserPressResult,
      renderBrowserConsoleResult,
      renderBrowserVisionResult,
      renderBrowserImagesResult,
      renderBrowserClickRefResult,
      claimIdempotency,
      releaseIdempotency,
      formatSseFrame,
    })
  };
}
