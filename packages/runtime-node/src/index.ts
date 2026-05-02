import { homedir } from 'node:os';
import { join as joinPath } from 'node:path';
import { AgentLoop, getAgentPreset, listAgentPresets, InMemoryCheckpointStore, createCheckpoint, restoreFromCheckpoint, createReplaySession, loadSkillsFromDirectory, loadPersonaFiles, buildPersonaPrompt, getDefaultPersonaPrompt, PersonaRegistry, parseIdentity, DetailedUsageTracker, SecurityAuditLog, FileSecurityAuditLog, validateFetchUrl, scanCommand, redactToolOutput, scoreComplexity, selectModelForComplexity, forkSession, type ParsedSkillFile, type ProviderAdapter, type SessionState, type CheckpointTrigger, type CheckpointStore, type SessionCheckpoint, type SkillFileSystem, type ToolCatalog, type ToolExecutor, type ToolExecutionContext, type ToolExecutionResult, type ToolManifest, type ToolDefinition, type SupportedLocale } from '@crowclaw/core';
import { createLogger, type Logger } from './logger.js';
import { installOpenTelemetryBridge, observeRuntimeTelemetryEvent, renderPrometheusMetrics } from './otel.js';
import { SessionMutex } from './session-mutex.js';
import { EventBus } from './event-bus.js';
import {
  buildDiscordDispatch,
  buildDiscordEditPayload,
  buildDiscordWebhookEditUrl,
  buildDiscordWebhookSendUrl,
  buildGatewaySessionKey,
  buildGatewayIdempotencyKey,
  buildGatewayDeliveryPlan,
  buildEmailDispatch,
  buildMatrixDispatch,
  buildSmsDispatch,
  buildSignalDispatch,
  buildWhatsAppDispatch,
  InMemoryGatewayIdempotencyStore,
  buildSlackDispatch,
  buildSlackEditPayload,
  buildSlackEditUrl,
  buildSlackSendPayload,
  buildSlackSendUrl,
  buildTelegramEditPayload,
  buildTelegramEditUrl,
  buildTelegramDispatch,
  buildTelegramSendPayload,
  buildTelegramSendUrl,
  createTypingIndicator,
  normalizeGenericWebhook,
  normalizeDiscordWebhook,
  normalizeEmailWebhook,
  normalizeSlackWebhook,
  normalizeSignalWebhook,
  normalizeTelegramWebhook,
  normalizeWhatsAppWebhook,
  normalizeMatrixWebhook,
  normalizeSmsWebhook,
  normalizeGatewayRequest,
  approvePairing,
  verifySlackSignature,
  probeTelegram,
  probeSlack,
  probeDiscord,
  probeWhatsApp,
  probeMatrix,
  type NormalizedInboundMessage,
  type PairingChallenge,
  type ProbeResult,
  type GatewayPlatform,
  sendTelegramMessage,
  setTelegramWebhook,
  deleteTelegramWebhook,
  getTelegramWebhookInfo,
  WsAuthRateLimiter,
} from '@crowclaw/gateway';
import { LearningPipeline, InMemorySkillStore, getBuiltInSkills, SkillRegistry, createLlmSkillExtractor } from '@crowclaw/learning';
import { McpClient, McpHttpTransport, listMcpPresetNames, getMcpPresetDescription, verifyPresetAvailability } from '@crowclaw/mcp';
import { MemoryService, EmbeddingMemoryStore, InMemoryMemoryProvider, type EmbeddingProvider, type MemoryProvider } from '@crowclaw/memory';
import { UserModelService } from '@crowclaw/memory';
import { MemoryCapturePlugin, PluginManager, ReferencePreToolCallPlugin, ReferenceToolResultPlugin, validatePluginManifest, type Plugin, type PluginManifest } from '@crowclaw/plugins';
import { CredentialPool, EchoProvider, OpenAICompatibleProvider, AnthropicProvider, ProviderChain, SmartModelRouter, classifyQueryComplexity, listKnownModelMetadata, isModelOverridable } from '@crowclaw/providers';
import { InMemoryMemoryStore, InMemorySessionStore, type SessionListStore } from '@crowclaw/storage';
import { ToolRegistry, createDefaultWorkerRegistry, listToolsetPresets, registerSchedulerTools, createFrozenMemorySetTool, createFrozenMemoryRemoveTool } from '@crowclaw/tools';
import { InMemoryWorkspaceStore, FileWorkspaceStore, type WorkspaceStore } from '@crowclaw/workspace';
import { InMemorySchedulerStore, FileSchedulerStore, SchedulerExecutor, AutonomousScheduler, collectDueJobs, createEveryNMinutesJob, createScheduledAgentJob, markJobRun } from '@crowclaw/scheduler';
import { RuntimeConfigStore, FileConfigStore } from './config-store.js';
import { pruneStaleBridgeSessions, type CodeBridgeSession } from './bridge-state.js';
import { ensureBrowserSession, pruneStaleBrowserSessions, recordBrowserNavigation, type BrowserSessionState } from './browser-state.js';
import { handleCodeBridgeRoutes } from './bridge-routes.js';
import { pruneDeadBridgeProcesses, type BridgeProcessRecord } from './bridge-process.js';
import { routePaths } from './route-paths.js';
import {
  API_CSP,
  SECURITY_HEADERS_BASE,
  SESSION_DANGEROUS_ACTIONS,
  RateLimiter,
  checkContentLengthCap,
  dashboardCSP,
  getDerivedCookieToken,
  getRouteCapture,
  hashRateLimitSubject,
  injectScriptNonce,
  isDangerousRoute,
  isGatewayMutationRoute,
  isLocalDashConfigRoute,
  isLocalOperatorBypassRoute,
  isLocalhostAddress,
  normalizeIp,
  parseCidrMatcher,
  parseCookieToken,
  parsePositiveIntEnv,
  parseUsdCap,
  readJsonWithSizeCap,
  sanitizeConfigMutation,
  timingSafeEqual,
  verifyDiscordWebhookSignature,
  verifyGenericWebhookSignature,
  verifyTelegramWebhookSecret,
  verifyWebhookBearerSecret,
  generateNonce,
  createRuntimeRouteHandler,
  type CidrMatcher,
} from './route-handlers.js';
import { resolveProviderFromConfig, resolveProvidersFromConfig, createProviderFromSlot } from './provider-factory.js';
import { createDefaultSecretChain } from './secret-loader.js';
import { SessionController } from './session-controller.js';
import { WebSocketManager, handleWebSocketUpgrade } from './websocket.js';
import { generateConfigSchema, validateConfigUpdate, diffConfigs } from './config-schema.js';
import { createEmbeddedProtocolServers } from './mcp-acp-embed.js';
import { createGatewayActivityLog, compareSemverLike, createGatewayAccessController, createGatewayDelivery } from './gateway-wiring.js';
import { createAgentBootstrap, type ExecutionOverrides } from './agent-bootstrap.js';
import { BUILTIN_MCP_CATALOG, BUILTIN_PLUGIN_CATALOG, buildMcpServerConfigFromCatalog, getMcpCatalogEntry, getPluginCatalogEntry, validateMcpCatalogEnv } from './runtime-catalogs.js';
import { ContextEngine, formatContextForPrompt, type ContextEngineResult } from '@crowclaw/core';
import { FrozenMemory, InMemoryFrozenStore, FileFrozenStore } from '@crowclaw/memory';
import { InMemoryMessageStore, type MessageStore as MessageStoreInterface } from '@crowclaw/storage';
import { resolveApiMode } from '@crowclaw/providers';

export { SecretChain, envSource, filesSource, systemdCredsSource, onePasswordSource, createDefaultSecretChain, resolveSecret } from './secret-loader.js';
export {
  MAX_REQUEST_BODY_BYTES,
  RateLimiter,
  checkContentLengthCap,
  readJsonWithSizeCap,
  sanitizeConfigMutation,
} from './route-handlers.js';

function normalizeRequestLocale(value: unknown): SupportedLocale | undefined {
  if (value === 'ko' || value === 'en') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower.startsWith('ko')) return 'ko';
    if (lower.startsWith('en')) return 'en';
  }
  return undefined;
}

function getRequestLocale(request: Request, body?: { locale?: unknown }): SupportedLocale | undefined {
  return normalizeRequestLocale(body?.locale)
    ?? normalizeRequestLocale(request.headers.get('x-crowclaw-locale'))
    ?? normalizeRequestLocale(request.headers.get('accept-language'));
}

const directToolAliases = {
  'browser.wait': 'browser.waitFor',
  'browser.wait-for': 'browser.waitFor',
  'browser.click-ref': 'browser.clickRef'
} as const;

function normalizeCheckpointTrigger(value: unknown): CheckpointTrigger {
  return value === 'iteration' || value === 'manual' || value === 'pre-dangerous' || value === 'error' || value === 'completion'
    ? value
    : 'manual';
}

// --- Feature: Gateway message debouncing (P0-3) ---

interface DebouncePending {
  timer: ReturnType<typeof setTimeout>;
  messages: string[];
  resolve: (merged: string) => void;
}

export class GatewayDebouncer {
  private pending = new Map<string, DebouncePending>();
  private readonly windowMs: number;

  constructor(windowMs = 500) {
    this.windowMs = windowMs;
  }

  /**
   * Debounce a gateway message. Returns a promise that resolves with the
   * (possibly merged) text once the debounce window expires.
   * Key format: `${platform}:${senderId}:${channelId}`
   */
  debounce(platform: string, senderId: string, channelId: string, text: string): Promise<string> {
    const key = `${platform}:${senderId}:${channelId}`;
    const existing = this.pending.get(key);

    if (existing) {
      // Merge: append new message text
      existing.messages.push(text);
      // Reset the timer
      clearTimeout(existing.timer);
      // Resolve the previous caller's promise with the same merged result
      // (all callers for the same debounce window share the merged text)
      const previousResolve = existing.resolve;
      return new Promise<string>((resolve) => {
        existing.resolve = resolve;
        existing.timer = setTimeout(() => {
          this.pending.delete(key);
          const merged = existing.messages.join('\n');
          resolve(merged);
          previousResolve(merged); // Resolve the previous caller too
        }, this.windowMs);
      });
    }

    return new Promise<string>((resolve) => {
      const entry: DebouncePending = {
        messages: [text],
        resolve,
        timer: setTimeout(() => {
          this.pending.delete(key);
          resolve(entry.messages.join('\n'));
        }, this.windowMs),
      };
      this.pending.set(key, entry);
    });
  }

  /** Number of keys currently pending debounce */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * #120: Drain all pending debounce timers. Called from `shutdown()` so
   * pending timers and their resolve closures don't leak between runtime
   * lifetimes. Each pending caller resolves with whatever messages were
   * already accumulated (rather than rejecting) so awaiting code in the
   * gateway routes returns deterministically and any partially-merged
   * text still flows through downstream chat handling instead of being
   * silently dropped.
   *
   * Returns the number of pending entries that were flushed.
   */
  flush(): number {
    const drained = this.pending.size;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      try { entry.resolve(entry.messages.join('\n')); } catch { /* swallow */ }
    }
    this.pending.clear();
    return drained;
  }
}

// --- Feature: Feedback Ledger (P0-5) ---

export interface FeedbackEntry {
  timestamp: string;
  toolName: string;
  ok: boolean;
  durationMs?: number;
  error?: string;
  sessionId: string;
}

export class FeedbackLedger {
  private entries: FeedbackEntry[] = [];
  private maxEntries = 200;

  record(entry: FeedbackEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  getDigest(limit = 50): string {
    const recent = this.entries.slice(-limit);
    if (recent.length === 0) return '';
    const stats = this.getStats();
    const lines = [
      `## Tool Feedback (last ${recent.length} calls)`,
      `Total: ${stats.total} | Success: ${stats.success} | Failure: ${stats.failure}`,
      '',
    ];
    const toolNames = Object.keys(stats.byTool).slice(0, 10);
    for (const name of toolNames) {
      const t = stats.byTool[name];
      if (!t) continue;
      lines.push(`- **${name}**: ${t.ok} ok, ${t.fail} fail`);
    }
    return lines.join('\n');
  }

  getStats(): { total: number; success: number; failure: number; byTool: Record<string, { ok: number; fail: number }> } {
    const byTool: Record<string, { ok: number; fail: number }> = {};
    let success = 0;
    let failure = 0;
    for (const entry of this.entries) {
      if (entry.ok) success++;
      else failure++;
      if (!byTool[entry.toolName]) {
        byTool[entry.toolName] = { ok: 0, fail: 0 };
      }
      const toolStats = byTool[entry.toolName] ?? (byTool[entry.toolName] = { ok: 0, fail: 0 });
      if (entry.ok) toolStats.ok++;
      else toolStats.fail++;
    }
    return { total: this.entries.length, success, failure, byTool };
  }

  getEntries(limit?: number): FeedbackEntry[] {
    return limit ? this.entries.slice(-limit) : [...this.entries];
  }
}

export interface NodeRuntimeOptions {
  agentId?: string;
  version?: string;
  provider?: ProviderAdapter;
  tools?: ToolRegistry;
  sessionStore?: InMemorySessionStore;
  memoryStore?: InMemoryMemoryStore;
  /**
   * v0.8.0 Hermes parity (#233) — pluggable memory backend. Defaults to a
   * fresh `InMemoryMemoryProvider` wrapping `memoryStore`. Adapters
   * (D1, Postgres, vector DB) implement `MemoryProvider` and slot in here
   * without touching the runtime.
   */
  memoryProvider?: MemoryProvider;
  workspaceStore?: WorkspaceStore;
  /** If provided, use FileWorkspaceStore backed by this directory. Ignored if workspaceStore is set. */
  workspaceDir?: string;
  schedulerStore?: InMemorySchedulerStore;
  skillStore?: InMemorySkillStore;
  mcpClient?: McpClient;
  mcpBaseUrl?: string;
  plugins?: PluginManager;
  slackSigningSecret?: string;
  gatewayIdempotencyStore?: InMemoryGatewayIdempotencyStore;
  deploymentName?: string;
  /** Directory to load local SKILL.md files from. Also reads CROWCLAW_SKILL_DIR env var. */
  skillDir?: string;
  /** Filesystem adapter for loading local skills. Required if skillDir is set. */
  skillFs?: SkillFileSystem;
  /** Directory to load persona markdown files (SOUL.md, IDENTITY.md, etc.). Also reads CROWCLAW_PERSONA_DIR env var. */
  personaDir?: string;
  /** Filesystem adapter for loading persona files. Required if personaDir is set. */
  personaFs?: { readFile(path: string): Promise<string>; joinPath(...parts: string[]): string };
  /** Optional usage tracker for cost/token tracking. Created automatically if not provided. */
  usageTracker?: DetailedUsageTracker;
  /** Optional checkpoint store for manual restore/replay and auto-checkpoint integration. */
  checkpointStore?: CheckpointStore;
  /** Enable automatic checkpoints for agent turns. Default: false. */
  autoCheckpoint?: boolean;
  /** Restore the latest checkpoint marked in_progress before the next turn. Default: true. */
  autoResumeCheckpoints?: boolean;
  /** Path for persistent config store. Defaults to ~/.crowclaw/runtime-config.json. Set to null to use in-memory only. */
  configStorePath?: string | null;
  /** Seed provider slot configuration for tests or embedded runtimes. */
  initialProviderConfig?: import('./config-store.js').ProviderConfig | null;
  /** Use embedding-based memory store for similarity search. Defaults to true. */
  useEmbeddingMemory?: boolean;
  /** Path for persistent scheduler store. Defaults to ~/.crowclaw/scheduler-jobs.json. Set to null to use in-memory only. */
  schedulerStorePath?: string | null;
  /** Base data directory for file-backed runtime state. Defaults to CROWCLAW_DATA_DIR or ~/.crowclaw. */
  dataDir?: string;
  /** Directory for persistent security audit JSONL files. Defaults to <dataDir>/audit. Set to null to use in-memory only. */
  auditLogPath?: string | null;
  /** Hostname/address to bind to. Used for security checks. Defaults to '127.0.0.1'. */
  hostname?: string;
  /** Telegram webhook secret token (set via setWebhook secret_token parameter). */
  telegramWebhookSecret?: string;
  /** Discord application public key for webhook signature verification. */
  discordPublicKey?: string;
  /** Per-platform webhook secrets. Used for platforms without built-in signature verification. */
  webhookSecrets?: Record<string, string>;
  /** Public HTTPS URL for this server. Used for auto-registering Telegram webhooks on startup. */
  publicUrl?: string;
  /** Trust x-forwarded-for header for client IP detection (enable behind a reverse proxy). Default: false */
  trustProxy?: boolean;
  /** Enable optional OpenTelemetry bridge when @opentelemetry/api is installed. */
  otel?: boolean;
}

function summarizeDirectTools(bridgeProcesses: Map<string, BridgeProcessRecord>) {
  const nestedDirectTools = [...new Set(
    [...bridgeProcesses.values()].flatMap((process) => process.supportedDirectTools.filter((toolName) => toolName !== 'mcp.callTool'))
  )];
  const aliasEntries = Object.entries(directToolAliases) as Array<[keyof typeof directToolAliases, (typeof directToolAliases)[keyof typeof directToolAliases]]>;
  const supportedRequestedAliases = aliasEntries
    .filter(([, target]) => nestedDirectTools.includes(target))
    .map(([alias]) => alias);
  const supportedAliasTargets = [...new Set(aliasEntries
    .filter(([, target]) => nestedDirectTools.includes(target))
    .map(([, target]) => target))];
  return {
    supportsNestedCallToolDirect: true,
    directToolAliases,
    supportedRequestedAliasCount: supportedRequestedAliases.length,
    supportedAliasTargetCount: supportedAliasTargets.length,
    supportedRequestedAliases,
    supportedAliasTargets,
    directToolCount: nestedDirectTools.length,
    nestedDirectTools,
    directBrowserTools: nestedDirectTools.filter((toolName) => toolName.startsWith('browser.')),
    directMcpTools: nestedDirectTools.filter((toolName) => toolName.startsWith('mcp.')),
    directRuntimeTools: nestedDirectTools.filter((toolName) => !toolName.startsWith('browser.') && !toolName.startsWith('mcp.'))
  };
}

function summarizeSessionRecord(session: SessionState) {
  const lastMessage = [...session.messages].reverse().find((message) => message.role !== 'system');
  // Derive a human-readable title for the dashboard session picker:
  // 1. Prefer an explicit rename via /api/sessions/:id/rename (stored as a
  //    [session-meta] system message)
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

function summarizeSessionTranscript(session?: CodeBridgeSession) {
  const transcript = session?.transcript ?? [];
  const toolUsageCounts = Object.fromEntries(
    [...transcript.reduce((counts, entry) => {
      counts.set(entry.toolName, (counts.get(entry.toolName) ?? 0) + 1);
      return counts;
    }, new Map<string, number>()).entries()].sort(([a], [b]) => a.localeCompare(b))
  );
  const nestedDirectToolCounts = Object.fromEntries(
    [...transcript.reduce((counts, entry) => {
      if (entry.nestedDirectToolName) {
        counts.set(entry.nestedDirectToolName, (counts.get(entry.nestedDirectToolName) ?? 0) + 1);
      }
      return counts;
    }, new Map<string, number>()).entries()].sort(([a], [b]) => a.localeCompare(b))
  );
  const nestedRequestedAliasCounts = Object.fromEntries(
    [...transcript.reduce((counts, entry) => {
      if (entry.nestedAliasApplied && entry.nestedRequestedToolName) {
        counts.set(entry.nestedRequestedToolName, (counts.get(entry.nestedRequestedToolName) ?? 0) + 1);
      }
      return counts;
    }, new Map<string, number>()).entries()].sort(([a], [b]) => a.localeCompare(b))
  );
  const directRequestedAliasCounts = Object.fromEntries(
    [...transcript.reduce((counts, entry) => {
      if (entry.aliasApplied && entry.requestedToolName) {
        counts.set(entry.requestedToolName, (counts.get(entry.requestedToolName) ?? 0) + 1);
      }
      return counts;
    }, new Map<string, number>()).entries()].sort(([a], [b]) => a.localeCompare(b))
  );
  const aliasUsageCounts = Object.fromEntries(
    [...transcript.reduce((counts, entry) => {
      if (entry.aliasApplied && entry.canonicalToolName) {
        counts.set(entry.canonicalToolName, (counts.get(entry.canonicalToolName) ?? 0) + 1);
      }
      if (entry.nestedAliasApplied && entry.nestedCanonicalToolName) {
        counts.set(entry.nestedCanonicalToolName, (counts.get(entry.nestedCanonicalToolName) ?? 0) + 1);
      }
      return counts;
    }, new Map<string, number>()).entries()].sort(([a], [b]) => a.localeCompare(b))
  );
  const aliasAppliedEntries = transcript.filter((entry) => entry.aliasApplied).length;
  const nestedAliasAppliedEntries = transcript.filter((entry) => entry.nestedAliasApplied).length;
  return {
    transcriptSummary: {
      total: transcript.length,
      byTransport: {
        runtime: transcript.filter((entry) => entry.transport === 'runtime').length,
        socket: transcript.filter((entry) => entry.transport === 'socket').length
      },
      byExecutionMode: {
        runtime: transcript.filter((entry) => entry.executionMode === 'runtime').length,
        directSocket: transcript.filter((entry) => entry.executionMode === 'direct-socket').length,
        fallbackRuntime: transcript.filter((entry) => entry.executionMode === 'fallback-runtime').length
      },
      aliasAppliedEntries,
      nestedAliasAppliedEntries,
      aliasUsageCounts,
      directRequestedAliasCounts,
      nestedRequestedAliasCounts,
      toolUsageCounts,
      nestedDirectToolCounts,
      lastEntry: transcript.at(-1) ?? null
    }
  };
}

function summarizeSupportedDirectTools(supportedDirectTools: string[]) {
  const nestedDirectTools = supportedDirectTools.filter((toolName) => toolName !== 'mcp.callTool');
  const aliasEntries = Object.entries(directToolAliases) as Array<[keyof typeof directToolAliases, (typeof directToolAliases)[keyof typeof directToolAliases]]>;
  const supportedRequestedAliases = aliasEntries
    .filter(([, target]) => nestedDirectTools.includes(target))
    .map(([alias]) => alias);
  const supportedAliasTargets = [...new Set(aliasEntries
    .filter(([, target]) => nestedDirectTools.includes(target))
    .map(([, target]) => target))];
  return {
    directToolAliases,
    supportedRequestedAliasCount: supportedRequestedAliases.length,
    supportedAliasTargetCount: supportedAliasTargets.length,
    supportedRequestedAliases,
    supportedAliasTargets,
    directToolCount: nestedDirectTools.length,
    nestedDirectTools,
    directBrowserTools: nestedDirectTools.filter((toolName) => toolName.startsWith('browser.')),
    directMcpTools: nestedDirectTools.filter((toolName) => toolName.startsWith('mcp.')),
    directRuntimeTools: nestedDirectTools.filter((toolName) => !toolName.startsWith('browser.') && !toolName.startsWith('mcp.'))
  };
}

function summarizeBridgeSessionRecord(session: CodeBridgeSession, process?: BridgeProcessRecord) {
  const supportedDirectTools = process?.supportedDirectTools ?? [];
  return {
    sessionId: session.sessionId,
    status: session.status,
    runtimeMode: session.runtimeMode,
    processId: process?.pid ?? session.processId,
    lastToolName: session.lastToolName,
    maxToolCalls: session.maxToolCalls,
    supportsNestedCallToolDirect: true,
    supportedDirectTools,
    ...summarizeSupportedDirectTools(supportedDirectTools),
    ...summarizeSessionTranscript(session)
  };
}

function summarizeBridgeSessionsAggregate(
  codeBridgeSessions: Map<string, CodeBridgeSession>,
  bridgeProcesses: Map<string, BridgeProcessRecord>
) {
  const sessions = [...codeBridgeSessions.values()];
  const totalTranscriptEntries = sessions.reduce((sum, session) => sum + session.transcript.length, 0);
  const runtimeTranscriptEntries = sessions.reduce((sum, session) => sum + session.transcript.filter((entry) => entry.transport === 'runtime').length, 0);
  const socketTranscriptEntries = sessions.reduce((sum, session) => sum + session.transcript.filter((entry) => entry.transport === 'socket').length, 0);
  const directSocketEntries = sessions.reduce((sum, session) => sum + session.transcript.filter((entry) => entry.executionMode === 'direct-socket').length, 0);
  const fallbackRuntimeEntries = sessions.reduce((sum, session) => sum + session.transcript.filter((entry) => entry.executionMode === 'fallback-runtime').length, 0);
  const toolUsageCounts = Object.fromEntries(
    [...sessions.flatMap((session) => session.transcript).reduce((counts, entry) => {
      counts.set(entry.toolName, (counts.get(entry.toolName) ?? 0) + 1);
      return counts;
    }, new Map<string, number>()).entries()].sort(([a], [b]) => a.localeCompare(b))
  );
  const nestedDirectToolCounts = Object.fromEntries(
    [...sessions.flatMap((session) => session.transcript).reduce((counts, entry) => {
      if (entry.nestedDirectToolName) {
        counts.set(entry.nestedDirectToolName, (counts.get(entry.nestedDirectToolName) ?? 0) + 1);
      }
      return counts;
    }, new Map<string, number>()).entries()].sort(([a], [b]) => a.localeCompare(b))
  );
  const aliasAppliedEntries = sessions.reduce((sum, session) => sum + session.transcript.filter((entry) => entry.aliasApplied).length, 0);
  const nestedAliasAppliedEntries = sessions.reduce((sum, session) => sum + session.transcript.filter((entry) => entry.nestedAliasApplied).length, 0);
  const aliasUsageCounts = Object.fromEntries(
    [...sessions.flatMap((session) => session.transcript).reduce((counts, entry) => {
      if (entry.aliasApplied && entry.requestedToolName) {
        counts.set(entry.requestedToolName, (counts.get(entry.requestedToolName) ?? 0) + 1);
      }
      if (entry.nestedAliasApplied && entry.requestedToolName === 'mcp.callTool' && entry.nestedDirectToolName) {
        counts.set(entry.nestedDirectToolName, (counts.get(entry.nestedDirectToolName) ?? 0) + 1);
      }
      return counts;
    }, new Map<string, number>()).entries()].sort(([a], [b]) => a.localeCompare(b))
  );
  const nestedRequestedAliasCounts = Object.fromEntries(
    [...sessions.flatMap((session) => session.transcript).reduce((counts, entry) => {
      if (entry.nestedAliasApplied && entry.nestedRequestedToolName) {
        counts.set(entry.nestedRequestedToolName, (counts.get(entry.nestedRequestedToolName) ?? 0) + 1);
      }
      return counts;
    }, new Map<string, number>()).entries()].sort(([a], [b]) => a.localeCompare(b))
  );
  const directRequestedAliasCounts = Object.fromEntries(
    [...sessions.flatMap((session) => session.transcript).reduce((counts, entry) => {
      if (entry.aliasApplied && entry.requestedToolName) {
        counts.set(entry.requestedToolName, (counts.get(entry.requestedToolName) ?? 0) + 1);
      }
      return counts;
    }, new Map<string, number>()).entries()].sort(([a], [b]) => a.localeCompare(b))
  );
  const allSupportedDirectTools = [...new Set(
    [...bridgeProcesses.values()].flatMap((process) => process.supportedDirectTools.filter((toolName) => toolName !== 'mcp.callTool'))
  )];
  const aliasEntries = Object.entries(directToolAliases) as Array<[keyof typeof directToolAliases, (typeof directToolAliases)[keyof typeof directToolAliases]]>;
  const supportedRequestedAliases = aliasEntries
    .filter(([, target]) => allSupportedDirectTools.includes(target))
    .map(([alias]) => alias);
  const supportedAliasTargets = [...new Set(aliasEntries
    .filter(([, target]) => allSupportedDirectTools.includes(target))
    .map(([, target]) => target))];
  return {
    totalSessions: sessions.length,
    openSessions: sessions.filter((session) => session.status === 'open').length,
    busySessions: sessions.filter((session) => session.status === 'busy').length,
    closedSessions: sessions.filter((session) => session.status === 'closed').length,
    directToolCount: allSupportedDirectTools.length,
    directBrowserToolCount: allSupportedDirectTools.filter((toolName) => toolName.startsWith('browser.')).length,
    directMcpToolCount: allSupportedDirectTools.filter((toolName) => toolName.startsWith('mcp.')).length,
    directRuntimeToolCount: allSupportedDirectTools.filter((toolName) => !toolName.startsWith('browser.') && !toolName.startsWith('mcp.')).length,
    totalTranscriptEntries,
    runtimeTranscriptEntries,
    socketTranscriptEntries,
    directSocketEntries,
    fallbackRuntimeEntries,
    aliasAppliedEntries,
    nestedAliasAppliedEntries,
    averageTranscriptEntriesPerSession: sessions.length > 0 ? Number((totalTranscriptEntries / sessions.length).toFixed(2)) : 0,
    sessionsWithRuntimeTraffic: sessions.filter((session) => session.transcript.some((entry) => entry.transport === 'runtime')).length,
    sessionsWithSocketTraffic: sessions.filter((session) => session.transcript.some((entry) => entry.transport === 'socket')).length,
    sessionsWithDirectSocketTraffic: sessions.filter((session) => session.transcript.some((entry) => entry.executionMode === 'direct-socket')).length,
    sessionsWithFallbackRuntimeTraffic: sessions.filter((session) => session.transcript.some((entry) => entry.executionMode === 'fallback-runtime')).length,
    sessionsWithAliasTraffic: sessions.filter((session) => session.transcript.some((entry) => entry.aliasApplied)).length,
    sessionsWithNestedAliasTraffic: sessions.filter((session) => session.transcript.some((entry) => entry.nestedAliasApplied)).length,
    directToolAliases,
    supportedRequestedAliasCount: supportedRequestedAliases.length,
    supportedAliasTargetCount: supportedAliasTargets.length,
    supportedRequestedAliases,
    supportedAliasTargets,
    aliasUsageCounts,
    directRequestedAliasCounts,
    nestedRequestedAliasCounts,
    toolUsageCounts,
    nestedDirectToolCounts
  };
}

function renderScreenshotResult(url: string, path: string): { ok: true; output: string; metadata: { simulated: true; path: string; url: string } } {
  return {
    ok: true,
    output: `Simulated screenshot for ${url}`,
    metadata: { simulated: true, path, url }
  };
}

function renderBrowserGotoResult(url: string): { ok: true; output: string; metadata: { simulated: true; url: string; finalUrl: string } } {
  return {
    ok: true,
    output: `Simulated browser navigation to ${url}`,
    metadata: { simulated: true, url, finalUrl: url }
  };
}

function renderBrowserWaitForResult(url: string, selector: string, timeoutMs: number) {
  return {
    ok: true,
    output: `Simulated wait for ${selector} at ${url}`,
    metadata: { simulated: true, url, selector, timeoutMs, matched: true, finalUrl: url }
  };
}

function renderBrowserSnapshotResult(url: string, full: boolean) {
  const refs = full ? ['@e1', '@e2', '@e3'] : ['@e1', '@e2'];
  const output = full
    ? [
        `Page snapshot for ${url}`,
        '[@e1] heading "Example Domain"',
        '[@e2] link "More information..."',
        '[@e3] document "Static example content"'
      ].join('\n')
    : [
        `Snapshot for ${url}`,
        '[@e1] heading "Example Domain"',
        '[@e2] link "More information..."'
      ].join('\n');

  return {
    ok: true,
    output,
    metadata: { simulated: true, url, full, refs }
  };
}

function renderBrowserBackResult(steps: number) {
  return {
    ok: true,
    output: `Simulated browser back (${steps})`,
    metadata: { simulated: true, steps, finalUrl: 'about:blank' }
  };
}

function renderBrowserScrollResult(url: string, direction: string, amount: number) {
  return {
    ok: true,
    output: `Simulated scroll ${direction} (${amount}) at ${url}`,
    metadata: { simulated: true, url, direction, amount, finalUrl: url }
  };
}

function renderBrowserPressResult(url: string, key: string) {
  return {
    ok: true,
    output: `Simulated key press ${key} at ${url}`,
    metadata: { simulated: true, url, key, finalUrl: url }
  };
}

function renderBrowserConsoleResult(url: string) {
  const logs = [{ level: 'info', message: `Simulated console log for ${url}` }];
  return {
    ok: true,
    output: JSON.stringify(logs, null, 2),
    metadata: { simulated: true, url, count: logs.length }
  };
}

function renderBrowserVisionResult(url: string, prompt: string) {
  return {
    ok: true,
    output: `Simulated vision analysis for ${url}: ${prompt}`,
    metadata: { simulated: true, url, prompt }
  };
}

function renderBrowserImagesResult(url: string, limit: number) {
  const images = [
    { ref: '@img1', src: `${url.replace(/\/$/, '')}/hero.png`, alt: 'Hero image' },
    { ref: '@img2', src: `${url.replace(/\/$/, '')}/diagram.png`, alt: 'Diagram image' }
  ].slice(0, limit);
  return {
    ok: true,
    output: JSON.stringify(images, null, 2),
    metadata: { simulated: true, url, count: images.length }
  };
}

function renderBrowserClickRefResult(url: string, ref: string) {
  return {
    ok: true,
    output: `Simulated click on ref ${ref} at ${url}`,
    metadata: { simulated: true, url, ref, finalUrl: url }
  };
}

// ---------------------------------------------------------------------------
// Idempotency-store atomic claim helper (#29, #34)
// ---------------------------------------------------------------------------

/**
 * Atomic claim against a `GatewayIdempotencyStore`. Returns `true` if the
 * key was newly recorded (caller proceeds), `false` if a still-valid entry
 * already existed (caller should treat as a duplicate).
 *
 * Prefers the store's native `markIfAbsent` when available; falls back to
 * a `has` + `mark` pair which is only race-safe on single-process JS stores
 * (no `await` between the two calls). The fallback exists for backward
 * compatibility with custom stores that haven't implemented `markIfAbsent`
 * yet — runtime-node's default `InMemoryGatewayIdempotencyStore` always
 * exposes the atomic primitive.
 */
async function claimIdempotency(
  store: { markIfAbsent?: (key: string, ttlMs?: number) => Promise<boolean>; has: (key: string) => Promise<boolean>; mark: (key: string) => Promise<void> },
  key: string,
): Promise<boolean> {
  if (typeof store.markIfAbsent === 'function') {
    return store.markIfAbsent(key);
  }
  if (await store.has(key)) return false;
  await store.mark(key);
  return true;
}

/**
 * Best-effort release of an idempotency claim (#29, #34). Used when the
 * downstream agent run threw — we want the next retry delivery to be
 * processed instead of permanently swallowed as a duplicate.
 */
async function releaseIdempotency(
  store: { unmark?: (key: string) => Promise<void> },
  key: string,
): Promise<void> {
  if (typeof store.unmark === 'function') {
    try { await store.unmark(key); } catch { /* best-effort */ }
  }
  // No fallback: legacy `mark`-only stores can't be unmarked, so the retry
  // would be considered a duplicate. Acceptable trade-off — the default
  // InMemoryGatewayIdempotencyStore exposes `unmark`.
}

// ---------------------------------------------------------------------------
// SSE subscriber tracking (#41) and broadcast format cache (#49)
// ---------------------------------------------------------------------------

/**
 * Live SSE subscriber bookkeeping (#41). Each entry tracks the active
 * `ReadableStreamDefaultController`, its heartbeat timer, and the EventBus
 * unsubscribe so SIGTERM drain can flush in one pass instead of waiting
 * for individual `request.signal` aborts that may never fire on abrupt
 * termination.
 */
interface SseSubscriber {
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat: ReturnType<typeof setInterval>;
  unsubscribe: () => void;
}

/**
 * Pre-serialize a single SSE event frame (#49). The previous SSE handler
 * called `JSON.stringify(data)` once per subscriber per event — for N
 * subscribers and M events that's N×M serializations. With this helper the
 * frame is built once at emit time and the same string is enqueued into
 * every subscriber's controller.
 */
function formatSseFrame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function createNodeRuntime(options: NodeRuntimeOptions = {}) {
  const store = options.sessionStore ?? new InMemorySessionStore();
  const runtimeEnv = (globalThis as Record<string, unknown>).process
    ? ((globalThis as Record<string, unknown>).process as { env: Record<string, string | undefined> }).env
    : {};
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
  const dataDir = options.dataDir ?? runtimeEnv.CROWCLAW_DATA_DIR ?? joinPath(homedir(), '.crowclaw');

  // Memory store: wrap with EmbeddingMemoryStore by default for similarity search
  const useEmbeddingMemory = options.useEmbeddingMemory ?? true;
  const baseMemoryStore = options.memoryStore ?? new InMemoryMemoryStore();
  const memoryStore: InMemoryMemoryStore | EmbeddingMemoryStore = (() => {
    if (!useEmbeddingMemory || options.memoryStore) {
      return baseMemoryStore;
    }
    // Simple bag-of-words embedding (no external API needed)
    const simpleEmbeddingProvider: EmbeddingProvider = {
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map(text => {
          const words = text.toLowerCase().split(/\s+/);
          // Simple hash-based embedding into 128-dim vector
          const vec = new Array(128).fill(0) as number[];
          for (const word of words) {
            for (let i = 0; i < word.length; i++) {
              const index = (word.charCodeAt(i) * 31 + i) % 128;
              vec[index] = (vec[index] ?? 0) + 1;
            }
          }
          // Normalize
          const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
          return vec.map(v => v / norm);
        });
      }
    };
    return new EmbeddingMemoryStore({
      baseStore: baseMemoryStore,
      embeddingProvider: simpleEmbeddingProvider,
      similarityThreshold: 0.3,
    });
  })();

  const workspaceStore = options.workspaceStore
    ?? (options.workspaceDir
      ? new FileWorkspaceStore(options.workspaceDir)
      : new InMemoryWorkspaceStore());

  // Scheduler store: use FileSchedulerStore by default for persistence across restarts
  const schedulerStore = (() => {
    if (options.schedulerStore) return options.schedulerStore;
    if (options.schedulerStorePath === null) return new InMemorySchedulerStore();
    const schedulerPath = options.schedulerStorePath ?? joinPath(dataDir, 'scheduler-jobs.json');
    return new FileSchedulerStore(schedulerPath);
  })();
  const skillStore = options.skillStore ?? new InMemorySkillStore();
  const gatewayIdempotencyStore = options.gatewayIdempotencyStore ?? new InMemoryGatewayIdempotencyStore();
  const feedbackLedger = new FeedbackLedger();
  const gatewayDebouncer = new GatewayDebouncer();
  const gatewayActivityLog = createGatewayActivityLog(100);
  let releaseCheckCache: { fetchedAt: number; latest: string | null; isOutdated: boolean } | null = null;

  // Config store: FileConfigStore for persistence, or in-memory if null
  // Under Vitest, force in-memory to avoid parallel-test races on the shared
  // ~/.crowclaw/runtime-config.json file. Tests can still opt into the file
  // store by passing an explicit configStorePath.
  const isVitest = typeof process !== 'undefined'
    && (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test');
  const defaultConfigPath = joinPath(dataDir, 'runtime-config.json');
  const configStore: RuntimeConfigStore =
    options.configStorePath === null || (isVitest && options.configStorePath === undefined)
      ? new RuntimeConfigStore()
      : new FileConfigStore(options.configStorePath ?? defaultConfigPath ?? '');

  // If FileConfigStore, trigger lazy load
  if (configStore instanceof FileConfigStore) {
    void configStore.load();
  }
  if ('initialProviderConfig' in options) {
    configStore.setProviderConfig(options.initialProviderConfig ?? null);
  }

  // --- Hermes parity: ContextEngine, FrozenMemory, MessageStore ---
  const messageStore: MessageStoreInterface = new InMemoryMessageStore();

  const frozenMemoryStore = new FileFrozenStore(joinPath(dataDir, 'memory'));
  const frozenMemory = new FrozenMemory(frozenMemoryStore, 'MEMORY');
  const frozenUserProfile = new FrozenMemory(frozenMemoryStore, 'USER');

  // Load frozen snapshots at startup — await before first use
  const frozenMemoryReady = Promise.all([
    frozenMemory.load().catch(() => {}),
    frozenUserProfile.load().catch(() => {}),
  ]);

  // Context engine: discover .crowclaw.md, AGENTS.md, CLAUDE.md from working dir
  let contextEngineResult: ContextEngineResult | null = null;
  let contextEngineReady: Promise<void> = Promise.resolve();
  // #119: Hoist the refresh handle so `shutdown()` can clear it. Without this
  // two consecutive `createNodeRuntime({ workingDirectory })` calls leave a
  // stray 60s interval ticking against the previous engine's closure (each
  // capture pins a ContextEngine instance + its workingDir state).
  let contextRefresh: ReturnType<typeof setInterval> | null = null;
  // Context discovery: only when workingDirectory is explicitly provided in options
  // CLI/server sets this; tests and library consumers omit it
  const workingDir = (options as Record<string, unknown>).workingDirectory as string | undefined;
  if (workingDir) {
    const engine = new ContextEngine({ workingDirectory: workingDir });
    // Initial discovery — await this before first agent run
    contextEngineReady = engine.discover().then((result) => {
      contextEngineResult = result;
    }).catch(() => {});
    // Periodic refresh every 60 seconds (picks up .crowclaw.md changes)
    contextRefresh = setInterval(() => {
      engine.discover().then((result) => {
        contextEngineResult = result;
      }).catch(() => {});
    }, 60_000);
    // Unref so the interval doesn't prevent process exit in tests
    if (typeof contextRefresh === 'object' && contextRefresh !== null && 'unref' in contextRefresh) {
      (contextRefresh as { unref(): void }).unref();
    }
  }

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
  // The MemoryService facade still drives the v0.7 call sites, but it now
  // delegates the v0.8 surface (prefetch / sync_turn / shutdown) to this
  // provider so adapters can intercept those hooks without rewriting the
  // facade's twenty-plus call sites.
  const memoryProvider: MemoryProvider = options.memoryProvider ?? new InMemoryMemoryProvider(memoryStore);
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
  const plugins = options.plugins ?? new PluginManager().register(new MemoryCapturePlugin());
  const installedPluginConfigs = new Map<string, { manifest: PluginManifest; config?: Record<string, unknown>; installedAt: string }>();
  for (const plugin of plugins.list()) {
    const catalogEntry = getPluginCatalogEntry(plugin.name);
    installedPluginConfigs.set(plugin.name, {
      manifest: catalogEntry?.manifest ?? { name: plugin.name, hooks: [] },
      installedAt: new Date().toISOString(),
    });
  }

  const createCatalogPlugin = (slug: string, config: Record<string, unknown> = {}): Plugin => {
    if (slug === 'memory-capture') return new MemoryCapturePlugin();
    if (slug === 'reference-pre-tool-call') {
      const denyTools = Array.isArray(config.denyTools)
        ? config.denyTools.filter((tool): tool is string => typeof tool === 'string')
        : [];
      return new ReferencePreToolCallPlugin('reference-pre-tool-call', denyTools);
    }
    if (slug === 'reference-tool-result') return new ReferenceToolResultPlugin('reference-tool-result');
    const entry = getPluginCatalogEntry(slug);
    return { name: entry?.manifest.name ?? slug };
  };

  const listInstalledPlugins = () => plugins.list().map((plugin) => {
    const installed = installedPluginConfigs.get(plugin.name);
    return {
      name: plugin.name,
      manifest: installed?.manifest ?? { name: plugin.name },
      config: installed?.config ?? {},
      installedAt: installed?.installedAt,
    };
  });
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

  function collectProviderKeys(prefix: string): string[] {
    const direct = runtimeEnv[prefix];
    const numbered = Object.entries(runtimeEnv)
      .filter(([key, value]) => key.startsWith(`${prefix}_`) && typeof value === 'string' && value.trim().length > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, value]) => value!.trim());
    return [
      ...(typeof direct === 'string' && direct.trim().length > 0 ? [direct.trim()] : []),
      ...numbered
    ];
  }

  function summarizeProviderPool(providerName: string) {
    const normalized = providerName.toLowerCase();
    const prefix = normalized === 'openai'
      ? 'OPENAI_API_KEY'
      : normalized === 'anthropic'
        ? 'ANTHROPIC_API_KEY'
        : 'OPENROUTER_API_KEY';
    const keys = collectProviderKeys(prefix);
    if (keys.length === 0) {
      return {
        provider: normalized,
        configured: false,
        strategy: 'round-robin',
        total: 0,
        active: 0,
        coolingDown: 0,
        disabled: 0,
        status: []
      };
    }
    const pool = new CredentialPool({ keys, strategy: 'round-robin' });
    return {
      provider: normalized,
      configured: true,
      ...pool.summary()
    };
  }

  // Initialize skill registry: load built-in skills and refresh learned from store
  skillRegistry.loadBuiltIn(getBuiltInSkills());
  void skillRegistry.refreshLearned();

  // Load local skills from workspace if skillDir option or CROWCLAW_SKILL_DIR env var is set
  const envSkillDir = (globalThis as Record<string, unknown>).process
    ? ((globalThis as Record<string, unknown>).process as { env: Record<string, string | undefined> }).env.CROWCLAW_SKILL_DIR
    : undefined;
  const skillDir = options.skillDir ?? envSkillDir;
  if (skillDir) {
    // Default Node.js filesystem adapter — no options.skillFs required
    const nodeSkillFs: SkillFileSystem = options.skillFs ?? {
      async readDir(dirPath: string) {
        const { readdir } = await import('node:fs/promises');
        const entries = await readdir(dirPath, { withFileTypes: true });
        return entries.map((entry: { name: string; isDirectory(): boolean }) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
      },
      async readFile(filePath: string) {
        const { readFile: fsRead } = await import('node:fs/promises');
        return fsRead(filePath, 'utf-8');
      },
      joinPath(...parts: string[]) {
        // Use posix join as fallback since we can't synchronously import path
        return parts.join('/').replace(/\/+/g, '/');
      },
    };
    void loadSkillsFromDirectory(skillDir, nodeSkillFs).then(
      (localSkills) => skillRegistry.setLocalSkills(localSkills),
      () => { /* Skill directory doesn't exist or is invalid — silently ignore */ }
    );
  }

  // Persona registry — supports runtime persona switching
  const personaRegistry = new PersonaRegistry();

  // Load persona files if personaDir option or CROWCLAW_PERSONA_DIR env var is set
  const envPersonaDir = (globalThis as Record<string, unknown>).process
    ? ((globalThis as Record<string, unknown>).process as { env: Record<string, string | undefined> }).env.CROWCLAW_PERSONA_DIR
    : undefined;
  const personaDir = options.personaDir ?? envPersonaDir;
  let personaPrompt: string | undefined;
  if (personaDir && options.personaFs) {
    void loadPersonaFiles(personaDir, options.personaFs).then(
      (files) => {
        personaPrompt = buildPersonaPrompt(files) || undefined;
        // Also register as 'default' in the registry (overrides built-in default)
        if (personaPrompt) {
          personaRegistry.register('default', files);
        }
      },
      () => { /* Persona directory doesn't exist or is invalid — silently ignore */ }
    );
  }

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
    getPersonaPrompt: () => personaPrompt,
    plugins,
    usageTracker,
    checkpointStore,
    autoResumedCheckpointIds,
    securityAuditLog,
    eventBus,
    log,
    contextEngineReady,
    getContextEngineResult: () => contextEngineResult,
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

  // Scheduler executor — runs the real agent for scheduled jobs
  // Uses ExecutionOverrides (no global state mutation)
  const schedulerExecutor = new SchedulerExecutor(
    schedulerStore,
    async (input) => {
      eventBus.emit('job:start', { sessionId: input.sessionId, agentId: input.agentId });
      const overrides: ExecutionOverrides = {
        agentPreset: input.agentPreset,
        toolsetPreset: input.toolsetPreset,
        skillSlugs: input.skillSlugs,
        model: input.model,
      };

      try {
        const result = await createConfiguredAgent(overrides).run({
          agentId: input.agentId,
          sessionId: input.sessionId,
          userMessage: input.userMessage,
          systemPrompt: 'You are CrowClaw executing a scheduled task.',
        });

        eventBus.emit('job:complete', { sessionId: input.sessionId, toolCount: result.toolResults.length });
        return {
          finalResponse: result.finalResponse,
          toolResults: result.toolResults.map((r) => ({
            toolName: r.toolName,
            ok: r.ok,
            output: r.output,
          })),
        };
      } catch (err: unknown) {
        eventBus.emit('job:error', { sessionId: input.sessionId, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    },
    deliverToGateway,
  );

  const autonomousScheduler = new AutonomousScheduler(schedulerExecutor);

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

  // Startup security check: warn loudly if no dashboard token is set
  void dashboardTokenReady.then(() => {
    if (!dashboardToken) {
      const bindHost = options.hostname ?? '127.0.0.1';
      if (!isLocalhostAddress(bindHost)) {
        log.error('CROWCLAW_DASHBOARD_TOKEN is not set on non-localhost — admin API routes are unauthenticated', { component: 'security', bindHost });
      } else {
        log.warn('CROWCLAW_DASHBOARD_TOKEN is not set — dangerous routes disabled', { component: 'security' });
      }
    }
  });

  // Telegram webhook auto-registration (non-blocking)
  let publicUrl: string | null | undefined = options.publicUrl ?? (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CROWCLAW_PUBLIC_URL;
  // Sync initial publicUrl/trustProxy with configStore (persisted value takes priority on restart)
  if (configStore.getPublicUrl()) publicUrl = configStore.getPublicUrl();
  else if (publicUrl) configStore.setRemoteAccess(publicUrl, configStore.getTrustProxy());
  if (options.trustProxy && !configStore.getTrustProxy()) configStore.setRemoteAccess(configStore.getPublicUrl(), true);
  if (publicUrl) {
    const telegramConfig = configStore.getGatewayConfig('telegram');
    const telegramToken = telegramConfig?.token
      ?? (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CROWCLAW_TELEGRAM_TOKEN;
    if (telegramToken && telegramConfig?.enabled !== false) {
      const webhookUrl = `${publicUrl.replace(/\/$/, '')}/webhooks/telegram`;
      if (!webhookUrl.startsWith('https://')) {
        log.warn('Telegram webhook auto-registration skipped: publicUrl must use HTTPS', { component: 'gateway', publicUrl });
      } else {
        const webhookSecret = options.telegramWebhookSecret ?? telegramConfig?.webhookSecret;
        setTelegramWebhook(telegramToken, webhookUrl, {
          secretToken: webhookSecret,
        }).then((result) => {
          if (result.ok) {
            log.info('Telegram webhook registered', { component: 'gateway', webhookUrl });
          } else {
            log.error('Telegram webhook registration failed', { component: 'gateway', description: result.description ?? 'unknown error' });
          }
        }).catch((error: unknown) => {
          log.error('Telegram webhook registration error', { component: 'gateway', error: error instanceof Error ? error.message : String(error) });
        });
      }
    }
  }

  /**
   * #41 + #42: Graceful drain on SIGTERM. Closes every open SSE controller
   * and clears every heartbeat timer in one pass (so the server doesn't wait
   * for individual `request.signal.abort` events that may never fire on
   * abrupt shutdown), then awaits in-flight `learning.autoCapture` promises
   * with a 5s cap so skill captures aren't silently dropped.
   *
   * Idempotent and safe to call from a process.on('SIGTERM', ...) handler.
   * Returns a summary so the host CLI can log what was drained.
   */
  async function shutdown(timeoutMs: number = 5_000): Promise<{ ssEClosed: number; learningAwaited: number; learningPending: number; debouncerFlushed: number }> {
    // 1. Flush every open SSE subscriber. Close the controller, clear the
    //    heartbeat, and unsubscribe from the EventBus so we don't fire
    //    any further events into a closed stream.
    const ssEClosed = sseSubscribers.size;
    for (const sub of sseSubscribers) {
      clearInterval(sub.heartbeat);
      sub.unsubscribe();
      try { sub.controller.close(); } catch { /* already closed */ }
    }
    sseSubscribers.clear();

    // 2. #115: Tear down the WebSocket manager — clears its 15s heartbeat
    //    interval, unsubscribes from the EventBus, and closes every open
    //    socket with code 1001 (server going away). Without this the
    //    heartbeat keeps firing into a runtime that's been replaced and
    //    every back-to-back `createNodeRuntime()` accumulates intervals.
    try { wsManager.stop(); } catch { /* best-effort */ }

    // 3. #118: Detach the heartbeat-tracker EventBus listener so its
    //    closure (which captures `lastHeartbeatAt`) doesn't pin the
    //    runtime's locals after shutdown.
    try { unsubscribeHeartbeatTracker(); } catch { /* best-effort */ }
    try { unsubscribeRuntimeTelemetryMetrics(); } catch { /* best-effort */ }

    // 4. #119: Stop the context-engine refresh interval. Two consecutive
    //    `createNodeRuntime({ workingDirectory })` calls would otherwise
    //    leave a 60s interval ticking against the previous engine.
    if (contextRefresh) {
      clearInterval(contextRefresh);
      contextRefresh = null;
    }

    // 5. #120: Drain the gateway message debouncer. Each pending entry
    //    holds a setTimeout handle plus a resolve closure; without an
    //    explicit flush they survive past shutdown until the timer fires.
    const debouncerFlushed = gatewayDebouncer.flush();

    // 6. Await in-flight learning.autoCapture with a hang cap so a stuck
    //    extractor can't block shutdown indefinitely. Promises are wrapped
    //    in trackLearning() which swallows errors, so allSettled is safe.
    const pending = [...inFlightLearning];
    const learningAwaited = pending.length;
    if (pending.length > 0) {
      const timeout = new Promise<'timeout'>((resolve) => {
        const t = setTimeout(() => resolve('timeout'), timeoutMs);
        // Don't keep the process alive just for this timer.
        if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref(): void }).unref();
      });
      await Promise.race([
        Promise.allSettled(pending),
        timeout,
      ]);
    }

    // 7. v0.8.0 Hermes parity (#233): drain the MemoryProvider's in-flight
    //    `sync_turn` promises with the documented 10s cap. Adapters that
    //    do real post-turn work (embeddings, external sync) need this
    //    window to flush before the process exits; the default in-memory
    //    provider tracks no-op promises so this is cheap.
    if (memoryProvider.shutdown) {
      try { await memoryProvider.shutdown(); } catch { /* best-effort */ }
    }
    if (sighupListenerAttached) {
      try {
        if (processRef?.off) processRef.off('SIGHUP', reloadSecretsOnSighup);
        else processRef?.removeListener?.('SIGHUP', reloadSecretsOnSighup);
      } catch { /* best-effort */ }
    }
    if (securityAuditLog instanceof FileSecurityAuditLog) {
      try { await securityAuditLog.drainWrites(); } catch { /* best-effort */ }
    }
    return {
      ssEClosed,
      learningAwaited,
      learningPending: inFlightLearning.size,
      debouncerFlushed,
    };
  }

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
      setPersonaPrompt: (value: string | undefined) => { personaPrompt = value; },
      contextEngineResult: () => contextEngineResult,
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
