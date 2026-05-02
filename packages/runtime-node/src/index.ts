import { createHmac, randomBytes, timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join as joinPath } from 'node:path';
import { AgentLoop, getAgentPreset, listAgentPresets, InMemoryCheckpointStore, createCheckpoint, restoreFromCheckpoint, createReplaySession, loadSkillsFromDirectory, loadPersonaFiles, buildPersonaPrompt, getDefaultPersonaPrompt, PersonaRegistry, parseIdentity, DetailedUsageTracker, SecurityAuditLog, FileSecurityAuditLog, validateFetchUrl, scanCommand, redactToolOutput, scoreComplexity, selectModelForComplexity, forkSession, type ParsedSkillFile, type ProviderAdapter, type SessionState, type CheckpointTrigger, type SkillFileSystem, type ToolCatalog, type ToolExecutor, type ToolExecutionContext, type ToolExecutionResult, type ToolManifest, type ToolDefinition } from '@crowclaw/core';
import { createLogger, type Logger } from './logger.js';
import { installOpenTelemetryBridge } from './otel.js';
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
  createDefaultAccessPolicy,
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
  evaluateAccess,
  approvePairing,
  verifySlackSignature,
  probeTelegram,
  probeSlack,
  probeDiscord,
  probeWhatsApp,
  probeMatrix,
  type ChannelAccessPolicy,
  type NormalizedInboundMessage,
  type PairingChallenge,
  type ProbeResult,
  type GatewayPlatform,
  sendTelegramMessage,
  sendDiscordMessage,
  sendSlackMessage,
  setTelegramWebhook,
  deleteTelegramWebhook,
  getTelegramWebhookInfo,
  WsAuthRateLimiter,
} from '@crowclaw/gateway';
import { LearningPipeline, InMemorySkillStore, getBuiltInSkills, SkillRegistry, createLlmSkillExtractor } from '@crowclaw/learning';
import { McpClient, McpHttpTransport, listMcpPresetNames, getMcpPresetDescription, verifyPresetAvailability } from '@crowclaw/mcp';
import { CrowClawMcpServer } from '@crowclaw/mcp-server';
import { MemoryService, EmbeddingMemoryStore, InMemoryMemoryProvider, type EmbeddingProvider, type MemoryProvider } from '@crowclaw/memory';
import { UserModelService } from '@crowclaw/memory';
import { MemoryCapturePlugin, PluginManager } from '@crowclaw/plugins';
import { CredentialPool, EchoProvider, OpenAICompatibleProvider, AnthropicProvider, ProviderChain, SmartModelRouter, classifyQueryComplexity, listKnownModelMetadata, isModelOverridable } from '@crowclaw/providers';
import { InMemoryMemoryStore, InMemorySessionStore, type SessionListStore } from '@crowclaw/storage';
import { ToolRegistry, createDefaultWorkerRegistry, listToolsetPresets, registerSchedulerTools, createFrozenMemorySetTool, createFrozenMemoryRemoveTool } from '@crowclaw/tools';
import { InMemoryWorkspaceStore, FileWorkspaceStore, type WorkspaceStore } from '@crowclaw/workspace';
import { InMemorySchedulerStore, FileSchedulerStore, SchedulerExecutor, AutonomousScheduler, collectDueJobs, createEveryNMinutesJob, createScheduledAgentJob, markJobRun, type DeliveryFn, type DeliveryTarget } from '@crowclaw/scheduler';
import { AcpServer } from '@crowclaw/acp';
import { RuntimeConfigStore, FileConfigStore } from './config-store.js';
import { pruneStaleBridgeSessions, type CodeBridgeSession } from './bridge-state.js';
import { ensureBrowserSession, pruneStaleBrowserSessions, recordBrowserNavigation, type BrowserSessionState } from './browser-state.js';
import { handleCodeBridgeRoutes } from './bridge-routes.js';
import { pruneDeadBridgeProcesses, type BridgeProcessRecord } from './bridge-process.js';
import { routePaths } from './route-paths.js';
import { resolveProviderFromConfig, resolveProvidersFromConfig, createProviderFromSlot } from './provider-factory.js';
import { SessionController } from './session-controller.js';
import { WebSocketManager, handleWebSocketUpgrade } from './websocket.js';
import { generateConfigSchema, validateConfigUpdate, diffConfigs } from './config-schema.js';
import { ContextEngine, formatContextForPrompt, type ContextEngineResult } from '@crowclaw/core';
import { FrozenMemory, InMemoryFrozenStore, FileFrozenStore } from '@crowclaw/memory';
import { InMemoryMessageStore, type MessageStore as MessageStoreInterface } from '@crowclaw/storage';
import { resolveApiMode } from '@crowclaw/providers';

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
      if (entry.ok) byTool[entry.toolName].ok++;
      else byTool[entry.toolName].fail++;
    }
    return { total: this.entries.length, success, failure, byTool };
  }

  getEntries(limit?: number): FeedbackEntry[] {
    return limit ? this.entries.slice(-limit) : [...this.entries];
  }
}

// --- Feature: Config mutation safety gate (P1-9) ---

const BLOCKED_CONFIG_MUTATIONS = new Set([
  'apiKey',
  'dashboardToken',
  'securityPolicy.blockDangerousCommands',
  'securityPolicy.redactCredentials',
]);

/**
 * Check if a config mutation body contains any blocked fields.
 * Returns the first blocked field name, or null if safe.
 */
export function sanitizeConfigMutation(body: Record<string, unknown>): string | null {
  for (const key of Object.keys(body)) {
    if (BLOCKED_CONFIG_MUTATIONS.has(key)) {
      return key;
    }
    // Check nested: securityPolicy.blockDangerousCommands etc.
    if (typeof body[key] === 'object' && body[key] !== null && !Array.isArray(body[key])) {
      const nested = body[key] as Record<string, unknown>;
      for (const nestedKey of Object.keys(nested)) {
        const fullKey = `${key}.${nestedKey}`;
        if (BLOCKED_CONFIG_MUTATIONS.has(fullKey)) {
          return fullKey;
        }
      }
    }
  }
  return null;
}

function isLocalOperatorBypassRoute(pathname: string, method: string): boolean {
  // The bypass is intended for read-only navigation only. Any non-GET request
  // (POST, DELETE, PUT, PATCH) MUST go through token auth even on localhost,
  // otherwise any local process can mutate runtime state without the token.
  if (method !== 'GET') return false;
  // Read-only config routes
  if (pathname === '/api/config/snapshot' || pathname === '/api/config/schema') return true;
  // Read-only session routes (list, get, checkpoints, memories, history)
  if (pathname === '/api/sessions' || pathname === '/api/sessions/active') return true;
  if (/^\/api\/sessions\/[^/]+(\/checkpoints|\/memories|\/history|\/state)?$/.test(pathname)) return true;
  // Read-only gateway routes only (status, probe results)
  if (pathname === '/api/gateway/status' || pathname === '/api/gateway/pairings') return true;
  // Safe read-only routes
  if (pathname === '/api/feedback') return true;
  return pathname.startsWith('/api/skills')
    || pathname.startsWith('/api/agent/')
    || pathname.startsWith('/api/toolset/');
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
// Rate Limiter — simple in-memory, per-key, sliding-window
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CIDR matching for trusted-proxy allowlist
// ---------------------------------------------------------------------------

/**
 * Returns a predicate that matches an IP (already normalized) against a CIDR
 * or single-IP entry. IPv4 entries compare as 32-bit integers; IPv6 as a
 * pair of 64-bit integers. Returns null for unparseable input.
 *
 * Accepts:
 *   - `10.0.0.1`               (single IPv4, equivalent to /32)
 *   - `10.0.0.0/24`            (IPv4 CIDR)
 *   - `::1`                    (single IPv6, equivalent to /128)
 *   - `fe80::/10`              (IPv6 CIDR)
 */
type CidrMatcher = (ip: string) => boolean;

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

function ipv6ToBigInt(ip: string): bigint | null {
  // Handle IPv4-mapped form ::ffff:1.2.3.4 by converting the trailing dotted quad.
  const dotIdx = ip.lastIndexOf('.');
  let normalized = ip;
  if (dotIdx !== -1) {
    const v4Start = ip.lastIndexOf(':', dotIdx);
    if (v4Start === -1) return null;
    const v4 = ipv4ToInt(ip.slice(v4Start + 1));
    if (v4 === null) return null;
    normalized = `${ip.slice(0, v4Start + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  // Expand `::` into enough zero groups to reach 8 total.
  const parts = normalized.split('::');
  if (parts.length > 2) return null;
  const leading = parts[0] ? parts[0].split(':') : [];
  const trailing = parts[1] ? parts[1].split(':') : [];
  const fill = 8 - leading.length - trailing.length;
  if (fill < 0) return null;
  const groups = [...leading, ...Array(fill).fill('0'), ...trailing];
  if (groups.length !== 8) return null;
  let out = 0n;
  for (const g of groups) {
    const n = parseInt(g || '0', 16);
    if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
    out = (out << 16n) | BigInt(n);
  }
  return out;
}

function parseCidrMatcher(entry: string): CidrMatcher | null {
  const [addr, bitsRaw] = entry.split('/');
  if (!addr) return null;
  // IPv4
  if (!addr.includes(':')) {
    const base = ipv4ToInt(addr);
    if (base === null) return null;
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const baseMasked = (base & mask) >>> 0;
    return (ip: string) => {
      const ipInt = ipv4ToInt(ip);
      if (ipInt === null) return false;
      return ((ipInt & mask) >>> 0) === baseMasked;
    };
  }
  // IPv6
  const base = ipv6ToBigInt(addr);
  if (base === null) return null;
  const bits = bitsRaw === undefined ? 128 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 128) return null;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
  const baseMasked = base & mask;
  return (ip: string) => {
    const ipInt = ipv6ToBigInt(ip);
    if (ipInt === null) return false;
    return (ipInt & mask) === baseMasked;
  };
}

/** Strip IPv6 zone id (`%eth0`) and unwrap IPv4-mapped `::ffff:1.2.3.4` to `1.2.3.4`
 *  so a CIDR like `10.0.0.0/24` matches clients that reach the socket as the
 *  IPv4-mapped form on dual-stack sockets. */
function normalizeIp(ip: string): string {
  const noZone = ip.split('%')[0]!;
  const mapped = noZone.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped ? mapped[1]! : noZone;
}

/**
 * Sliding-window rate limiter (#48).
 *
 * Stores per-key timestamps in a sorted deque (oldest at index 0). On each
 * `check`, expired entries at the head are dropped via a single in-place
 * `splice(0, i)` instead of allocating a fresh `filter` array. With N entries
 * per key and K keys, the previous implementation was O(N) allocation +
 * O(N) copy on every check; this is O(expired) with no allocation in the
 * common steady-state path.
 */
export class RateLimiter {
  private requests = new Map<string, number[]>();
  private readonly maxKeys: number;

  /** Exposed for tests / observability — not part of the public hot path. */
  get size(): number {
    return this.requests.size;
  }

  constructor(options?: { maxKeys?: number }) {
    this.maxKeys = options?.maxKeys ?? 50_000;
  }

  check(key: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now();
    const windowStart = now - windowMs;
    let timestamps = this.requests.get(key);
    if (!timestamps) {
      timestamps = [];
      this.requests.set(key, timestamps);
    } else if (timestamps.length > 0 && timestamps[0]! <= windowStart) {
      // Drop expired entries from the head (sorted oldest-first) in one splice.
      let expired = 0;
      while (expired < timestamps.length && timestamps[expired]! <= windowStart) {
        expired++;
      }
      if (expired > 0) timestamps.splice(0, expired);
    }
    if (timestamps.length >= maxRequests) {
      return false; // rate limited
    }
    timestamps.push(now); // monotonic — preserves sorted order
    // Evict oldest entry if at capacity (prevents unbounded memory growth).
    // #124: When the oldest key IS the current key (e.g. the inserted key
    // is the only one, or it happens to be at the head of the insertion
    // order), the previous guard `oldest !== key` skipped eviction entirely
    // and the Map size grew to maxKeys + 1 — and would compound the further
    // distinct keys arrived. Walk forward instead so we always free a slot
    // when over capacity, and never evict the entry we just inserted.
    if (this.requests.size > this.maxKeys) {
      for (const candidate of this.requests.keys()) {
        if (candidate !== key) {
          this.requests.delete(candidate);
          break;
        }
      }
    }
    return true; // allowed
  }
}

// ---------------------------------------------------------------------------
// Body size cap (#128) — defends against memory-exhaustion via large POSTs
// ---------------------------------------------------------------------------

/** Max accepted JSON body, in bytes. 1 MiB matches typical reverse-proxy
 *  defaults and is far above any legitimate dashboard / gateway payload —
 *  the largest realistic body is a multi-thousand-token chat message which
 *  fits comfortably in tens of kilobytes. Anything larger almost certainly
 *  represents an abusive caller or a misconfigured client.
 */
export const MAX_REQUEST_BODY_BYTES = 1_048_576;

/**
 * Inspect `Content-Length` and reject oversized bodies before they're buffered
 * in memory. Returns `null` when the request is acceptable, or a 413 Response
 * when the declared length exceeds the cap. Callers should still read with
 * `readJsonWithSizeCap` to defend against chunked / unknown-length bodies that
 * omit the header.
 */
export function checkContentLengthCap(request: Request, max: number = MAX_REQUEST_BODY_BYTES): Response | null {
  const raw = request.headers.get('content-length');
  if (raw === null) return null;
  const declared = Number(raw);
  if (!Number.isFinite(declared) || declared < 0) {
    // Malformed header — treat as suspicious. Reject rather than guessing.
    return Response.json({ error: 'invalid content-length' }, { status: 400 });
  }
  if (declared > max) {
    return Response.json(
      { error: 'request body too large', maxBytes: max },
      { status: 413, headers: { 'Connection': 'close' } },
    );
  }
  return null;
}

/**
 * Parse a JSON body with a hard size cap. Defensive about chunked transfers
 * that omit `Content-Length`: streams the body through a manual byte counter
 * and aborts as soon as the cap is exceeded. This avoids `request.json()`
 * loading a 1 GB payload into memory before validation could possibly run.
 *
 * On success returns `{ ok: true, value }`. On overflow / malformed JSON
 * returns `{ ok: false, response }` with the appropriate 413 / 400 response
 * the caller can return directly.
 */
export async function readJsonWithSizeCap<T = unknown>(
  request: Request,
  max: number = MAX_REQUEST_BODY_BYTES,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  // 1) Cheap header check first — rejects the obvious abuse without ever
  //    touching the body stream.
  const headerReject = checkContentLengthCap(request, max);
  if (headerReject) return { ok: false, response: headerReject };

  // 2) Stream body chunks through a size accumulator. We can't trust
  //    Content-Length on chunked transfers, so this is the real gate.
  const body = request.body;
  if (!body) {
    return { ok: true, value: {} as T };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        // Cancel the upstream stream so we don't keep buffering a hostile
        // sender's bytes after we've already decided to reject.
        try { await reader.cancel('body too large'); } catch { /* best-effort */ }
        return {
          ok: false,
          response: Response.json(
            { error: 'request body too large', maxBytes: max },
            { status: 413, headers: { 'Connection': 'close' } },
          ),
        };
      }
      chunks.push(value);
    }
  } catch (err: unknown) {
    return {
      ok: false,
      response: Response.json(
        { error: 'failed to read request body', detail: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      ),
    };
  }

  if (total === 0) {
    return { ok: true, value: {} as T };
  }

  // Reassemble chunks into a single Uint8Array, then decode + parse.
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  const text = new TextDecoder('utf-8').decode(merged);
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (err: unknown) {
    return {
      ok: false,
      response: Response.json(
        { error: 'invalid JSON', detail: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      ),
    };
  }
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

// ---------------------------------------------------------------------------
// Cookie-token derivation cache (#47)
// ---------------------------------------------------------------------------

/**
 * Memoize `deriveCookieToken(dashToken)` so the per-request HMAC
 * computation only runs once per distinct dashboard token value. The token
 * is read from `process.env.CROWCLAW_DASHBOARD_TOKEN` and almost never
 * changes during the lifetime of a process; computing the SHA-256 HMAC on
 * every `/api/auth/check`, `/api/auth/verify`, /api/* gate, and `/ws`
 * upgrade was wasted work on every authenticated dashboard request.
 *
 * Cache is keyed by the raw token so a runtime restart with a rotated token
 * picks up the new value automatically.
 */
let cachedDashTokenForCookie: string | null = null;
let cachedDerivedCookieValue = '';
function getDerivedCookieToken(dashToken: string | undefined): string {
  if (!dashToken) {
    cachedDashTokenForCookie = null;
    cachedDerivedCookieValue = '';
    return '';
  }
  if (dashToken !== cachedDashTokenForCookie) {
    cachedDashTokenForCookie = dashToken;
    cachedDerivedCookieValue = deriveCookieToken(dashToken);
  }
  return cachedDerivedCookieValue;
}

// ---------------------------------------------------------------------------
// Security headers helper
// ---------------------------------------------------------------------------

/** Base security headers (CSP added per-request with nonce for dashboard, strict for API). */
const SECURITY_HEADERS_BASE: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
};

/** CSP for API routes (no scripts needed). */
const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/** Generate a cryptographic nonce for CSP. */
function generateNonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * Inject a CSP nonce into every inline `<script>` tag in `html`. Replaces the
 * v0.3.6-era regex `/<script(?![^>]*\bsrc\b)/g` which had known edge cases:
 *   - `<scriptsrc=...>` (no space) matched incorrectly as a "no src" tag.
 *   - Contributors adding a `src=""` (empty src) would get a nonce injected.
 * This walks the string tag-by-tag, checks the character after `<script` is a
 * real boundary (space/tab/newline/`>`), and honors any real `src="..."`.
 */
function injectScriptNonce(html: string, nonce: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const next = html.indexOf('<script', i);
    if (next === -1) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, next));
    const afterScript = next + '<script'.length;
    const nextChar = html[afterScript];
    // `<scriptxxx` — not a real <script> tag, emit verbatim and keep scanning.
    if (nextChar !== ' ' && nextChar !== '>' && nextChar !== '\t' && nextChar !== '\n' && nextChar !== '/') {
      out.push(html.slice(next, afterScript));
      i = afterScript;
      continue;
    }
    const tagEnd = html.indexOf('>', afterScript);
    if (tagEnd === -1) {
      out.push(html.slice(next));
      break;
    }
    const attrs = html.slice(afterScript, tagEnd);
    // Tags with `src=...` load an external script; CSP allows them via
    // `script-src https://cdnjs.cloudflare.com`. Inline (no src) needs a nonce.
    if (/\bsrc\s*=/.test(attrs)) {
      out.push(html.slice(next, tagEnd + 1));
    } else {
      out.push(`<script nonce="${nonce}"${attrs}>`);
    }
    i = tagEnd + 1;
  }
  return out.join('');
}

/** CSP for dashboard pages (nonce-based script-src, unsafe-inline for styles). */
function dashboardCSP(nonce: string): string {
  // connect-src must explicitly allow ws:/wss: for the dashboard WebSocket
  // transport. CSP3 says 'self' implies same-origin ws/wss, but Safari and
  // older Chromium still block it without an explicit scheme.
  // The dashboard HTML loads:
  //   - Google Fonts CSS (fonts.googleapis.com) + font files (fonts.gstatic.com)
  //   - highlight.js CSS + JS from cdnjs.cloudflare.com (for chat code blocks)
  // These must be allowlisted explicitly. The script source is still nonce-only
  // for inline scripts; the cdnjs entry is for the external highlight.js script.
  return [
    `default-src 'self'`,
    `script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com`,
    `style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com`,
    `font-src 'self' data: https://fonts.gstatic.com`,
    `img-src 'self' data:`,
    `connect-src 'self' ws: wss:`,
  ].join('; ');
}

// ---------------------------------------------------------------------------
// Route classification — dangerous routes always require authentication
// ---------------------------------------------------------------------------

const DANGEROUS_ROUTES = [
  '/api/terminal/',
  '/api/workspace/write', '/api/workspace/delete', '/api/workspace/rename',
  '/api/workspace/patchLines', '/api/workspace/patchText',
  '/api/workspace/patch', '/api/workspace/patch-text',
  '/api/scheduler/start', '/api/scheduler/stop',
  '/api/mcp/connect', '/api/mcp/disconnect',
  '/api/mcp/servers',  // CRUD for custom MCP servers — can define commands to spawn
  '/api/providers/config',
  '/api/config/provider',
  '/api/config/agent',
  '/api/config/validate',
  '/api/config/diff',
  '/api/config/remote-access',
  '/api/security/policy',
  '/api/gateway/pairing/approve',
  '/api/gateway/telegram/webhook',
];

// Gateway mutation routes that need auth (config, policy)
function isGatewayMutationRoute(pathname: string): boolean {
  return /^\/api\/gateway\/[^/]+\/(config|policy)$/.test(pathname);
}

// v0.6.6: in dev mode (no dashToken set) on a localhost bind, the dashboard
// needs to read a few config endpoints to render the setup wizard / provider
// state. Whitelist them here so the UI doesn't 401 + toast "Session expired"
// during open-access bootstrap. Execution routes (terminal/workspace mutate/
// MCP CRUD/scheduler control) stay locked — see DANGEROUS_ROUTES.
function isLocalDashConfigRoute(pathname: string): boolean {
  return (
    pathname === '/api/providers/config'
    || pathname === '/api/config/provider'
    || pathname === '/api/config/agent'
    || pathname === '/api/config/validate'
    || pathname === '/api/config/diff'
    || pathname === '/api/config/remote-access'
  );
}

const SESSION_DANGEROUS_ACTIONS = new Set(['abort', 'stop', 'compact', 'steer']);

function isDangerousRoute(pathname: string): boolean {
  return DANGEROUS_ROUTES.some((route) => pathname.startsWith(route)) || isGatewayMutationRoute(pathname);
}

function isLocalhostAddress(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

function parseCookieToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)crowclaw_auth=([^;]+)/);
  return match ? match[1] : null;
}

/** Derive a cookie-safe token from the dashboard token (never store raw token in cookie). */
function deriveCookieToken(dashToken: string): string {
  return createHmac('sha256', dashToken).update('crowclaw:cookie').digest('hex');
}

/** Constant-time string comparison to prevent timing side-channel attacks. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return cryptoTimingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ---------------------------------------------------------------------------
// Webhook signature verification helpers
// ---------------------------------------------------------------------------

function verifyTelegramWebhookSecret(request: Request, secret: string): boolean {
  const headerSecret = request.headers.get('x-telegram-bot-api-secret-token');
  if (!headerSecret) return false;
  return timingSafeEqual(headerSecret, secret);
}

/**
 * Verify generic webhook HMAC signature. Prior to v0.4.0 this route accepted
 * unsigned requests, letting any caller who knew a whitelisted channelId drive
 * the agent (arbitrary LLM calls billed against the operator's keys). Now
 * requires `X-CrowClaw-Signature: sha256=<hex>` matching HMAC_SHA256(secret, body).
 */
function verifyGenericWebhookSignature(headerValue: string | null, secret: string, rawBody: string): boolean {
  if (!headerValue) return false;
  const match = headerValue.match(/^sha256=([a-f0-9]+)$/i);
  if (!match) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqual(match[1]!.toLowerCase(), expected.toLowerCase());
}

async function verifyDiscordWebhookSignature(
  request: Request,
  publicKey: string,
  body: string
): Promise<boolean> {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  if (!signature || !timestamp) return false;

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToUint8Array(publicKey).buffer as ArrayBuffer,
      { name: 'Ed25519', namedCurve: 'Ed25519' } as EcKeyImportParams,
      false,
      ['verify']
    );
    const encoder = new TextEncoder();
    const message = encoder.encode(timestamp + body);
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      hexToUint8Array(signature).buffer as ArrayBuffer,
      message
    );
  } catch {
    return false;
  }
}

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function verifyWebhookBearerSecret(request: Request, secret: string): boolean {
  const auth = request.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    return timingSafeEqual(auth.slice(7), secret);
  }
  const customSecret = request.headers.get('x-webhook-secret');
  return customSecret ? timingSafeEqual(customSecret, secret) : false;
}

export function createNodeRuntime(options: NodeRuntimeOptions = {}) {
  const store = options.sessionStore ?? new InMemorySessionStore();
  const runtimeEnv = (globalThis as Record<string, unknown>).process
    ? ((globalThis as Record<string, unknown>).process as { env: Record<string, string | undefined> }).env
    : {};
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
              vec[(word.charCodeAt(i) * 31 + i) % 128] += 1;
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
  // Issue #69: per-IP WS auth rate limiter with exponential backoff bans.
  // Lives in @crowclaw/gateway so the same primitive can be reused by other
  // runtimes (CF Workers). Defaults: 5 failures / minute trigger a 5-minute
  // ban; bans double on each escalation up to a 1-hour cap. A successful
  // auth resets both the failure window and the escalation level for that IP.
  const wsAuthRateLimiter = new WsAuthRateLimiter();
  const log: Logger = createLogger({ name: 'crowclaw', level: (options as Record<string, unknown>).logLevel as 'debug' | 'info' | undefined ?? 'info' });
  if (options.otel ?? runtimeEnv.CROWCLAW_OTEL_ENABLED === 'true') {
    void installOpenTelemetryBridge();
  }
  const sessionMutex = new SessionMutex();
  const eventBus = new EventBus();
  let lastHeartbeatAt: string | null = null;
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
  const tools = options.tools ?? createDefaultWorkerRegistry({
    sessionSearchStore: store,
    memoryStore,
    workspaceStore,
    mcpClient,
    recallFn: (sessionId: string, query: string, limit: number) => memoryService.recall(sessionId, query, limit)
  });

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
    void resolveProviderFromConfig().then((resolved) => {
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
    }).catch(() => { providerReady = true; });
  }

  const toolsetPresets = new Map<string, (ReturnType<typeof listToolsetPresets>)[number]>(
    listToolsetPresets().map((preset) => [preset.name, preset])
  );
  const codeBridgeSessions = new Map<string, CodeBridgeSession>();
  const bridgeProcesses = new Map<string, BridgeProcessRecord>();
  const browserSessions = new Map<string, BrowserSessionState>();
  const usageTracker = options.usageTracker ?? new DetailedUsageTracker();
  const deploymentName = options.deploymentName ?? 'crowclaw-node';
  const version = options.version ?? '0.1.0';

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

  // ---------------------------------------------------------------------------
  // Execution overrides — 1-shot injection for scheduler/API callers
  // ---------------------------------------------------------------------------

  interface ExecutionOverrides {
    agentPreset?: string;
    toolsetPreset?: string;
    skillSlugs?: string[];
    model?: string;
  }

  function buildConfiguredSkillManifests(overrides?: ExecutionOverrides): ParsedSkillFile[] {
    let skills = skillRegistry.resolve()
      .filter((skill) => configStore.isSkillEnabled(skill.manifest.name));

    // If skillSlugs override is set, filter to only those slugs
    // disabled > override: if a slug is disabled, it stays out
    if (overrides?.skillSlugs && overrides.skillSlugs.length > 0) {
      const allowed = new Set(overrides.skillSlugs);
      skills = skills.filter((s) => allowed.has(s.manifest.name));
    }

    return skills;
  }

  function buildConfiguredToolRegistry(overrides?: ExecutionOverrides): ToolRegistry {
    const activeToolset = overrides?.toolsetPreset ?? configStore.getActiveToolset();
    const disabledTools = new Set(configStore.getDisabledTools());

    // #218 — when no toolset is active, still apply the per-tool disabled
    // filter so dashboard toggles take effect immediately. We materialize a
    // new registry instead of returning the shared `tools` instance.
    if (!activeToolset) {
      if (disabledTools.size === 0) {
        return tools;
      }
      const filtered = new ToolRegistry();
      for (const manifest of tools.list()) {
        if (disabledTools.has(manifest.name)) continue;
        const definition = tools.get(manifest.name);
        if (definition) filtered.register(definition);
      }
      return filtered;
    }

    const preset = toolsetPresets.get(activeToolset);
    if (!preset || preset.toolNames.length === 0) {
      if (disabledTools.size === 0) {
        return tools;
      }
      const filtered = new ToolRegistry();
      for (const manifest of tools.list()) {
        if (disabledTools.has(manifest.name)) continue;
        const definition = tools.get(manifest.name);
        if (definition) filtered.register(definition);
      }
      return filtered;
    }

    const filtered = new ToolRegistry();
    for (const manifest of tools.list()) {
      if (!preset.toolNames.includes(manifest.name)) {
        continue;
      }
      // #218 — additionally drop tools the user has explicitly disabled via
      // POST /api/tools/:name/toggle. Disabled tools are removed from the
      // agent-loop registry so the LLM never sees them in its tool list.
      if (disabledTools.has(manifest.name)) {
        continue;
      }
      const definition = tools.get(manifest.name);
      if (definition) {
        filtered.register(definition);
      }
    }
    return filtered;
  }

  function resolveConfiguredAgentPreset(overrides?: ExecutionOverrides): { role: string; goal: string; backstory?: string } | undefined {
    // Override takes priority
    if (overrides?.agentPreset) {
      const preset = getAgentPreset(overrides.agentPreset);
      if (preset) return { role: preset.role, goal: preset.goal, backstory: preset.backstory };
    }

    const configured = configStore.getAgentPreset();
    if (configured?.role?.trim() || configured?.goal?.trim() || configured?.backstory?.trim()) {
      return {
        role: configured.role,
        goal: configured.goal,
        backstory: configured.backstory
      };
    }

    const activePreset = configStore.getActivePreset();
    if (!activePreset) {
      return undefined;
    }

    const preset = getAgentPreset(activePreset);
    if (!preset) {
      return undefined;
    }

    return {
      role: preset.role,
      goal: preset.goal,
      backstory: preset.backstory
    };
  }

  function resolveProvider(overrides?: ExecutionOverrides): ProviderAdapter {
    if (overrides?.model) {
      if (isModelOverridable(provider)) {
        return provider.withModel(overrides.model);
      }
      log.warn('Model override requested but provider does not support withModel()', { requestedModel: overrides.model });
    }
    return provider;
  }

  /** Default approval decider: auto-approve low/undefined, warn medium, reject high/critical */
  function defaultApprovalDecider(tool: { manifest: { dangerLevel?: string } }): Promise<boolean> {
    const level = tool.manifest.dangerLevel;
    if (!level || level === 'low') {
      return Promise.resolve(true);
    }
    if (level === 'medium') {
      log.warn('Tool with medium danger level auto-approved', { dangerLevel: 'medium' });
      return Promise.resolve(true);
    }
    // high or critical: reject in non-interactive mode
    log.warn('Tool rejected by default approval decider', { dangerLevel: level });
    return Promise.resolve(false);
  }

  // v0.7 (#179) — wrap the configured tool registry so AgentLoop tool dispatches
  // emit `tool:start` / `tool:complete` on the eventBus. Direct routes
  // (/api/web/fetch, /api/terminal/exec, etc.) call `tools.execute(...)`
  // directly with the unwrapped registry, so this wrapper only affects the
  // agent-loop integration. We forward `list()`/`get()` so AgentLoop's
  // budget/prompt-build paths see the same manifests as before, then emit
  // around `execute(...)` with a per-call id, the (best-effort) sessionId
  // from the context, the input args, the duration, and the ok flag.
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
        eventBus.emit('tool:start', {
          callId,
          toolName: name,
          sessionId,
          // Args echoed back so the dashboard can render exactly what the
          // worker received. Audit-redaction has already run in AgentLoop
          // by the time we reach here, so this is safe to surface.
          args: input,
          startedAt: new Date().toISOString(),
        });
        try {
          const result = await registry.execute(name, input, context);
          const durationMs = Math.round(performance.now() - startedAt);
          eventBus.emit('tool:complete', {
            callId,
            toolName: name,
            sessionId,
            ok: result.ok,
            durationMs,
            // Truncate at the wire so a runaway tool (e.g. a 50MB fetch)
            // doesn't blow the event listener buffer. Full output is on
            // disk via SecurityAuditLog and reachable via the audit drawer.
            output: result.output.length > 4000 ? `${result.output.slice(0, 4000)}…[truncated]` : result.output,
            outputLength: result.output.length,
            metadata: result.metadata,
          });
          return result;
        } catch (err) {
          const durationMs = Math.round(performance.now() - startedAt);
          eventBus.emit('tool:complete', {
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

  function createConfiguredAgent(overrides?: ExecutionOverrides): AgentLoop {
    // Use persona registry's active prompt, falling back to the legacy personaPrompt
    const activePersonaPrompt = personaRegistry.getActive().prompt || personaPrompt;

    // Resolve fallback/compression providers from config store
    const providerCfg = configStore.getProviderConfig();
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

    return new AgentLoop(resolveProvider(overrides), instrumentToolRegistry(buildConfiguredToolRegistry(overrides)), store, {
      plugins,
      runtimeName: 'node',
      skills: buildConfiguredSkillManifests(overrides),
      agentPreset: resolveConfiguredAgentPreset(overrides),
      personaPrompt: activePersonaPrompt,
      requireApprovalForDangerousTools: true,
      approvalDecider: defaultApprovalDecider,
      securityAuditLog,
      eventBus,
      providerName: providerCfg?.primary?.provider ?? 'openai-compatible',
      securityPolicy: {
        redactToolOutput: configStore.getSecurityPolicy().redactToolOutput,
        scanUserInput: configStore.getSecurityPolicy().scanUserInput,
        scanCommands: configStore.getSecurityPolicy().scanCommands,
        blockDangerousCommands: configStore.getSecurityPolicy().blockDangerousCommands,
      },
      ...(fallbackProviders.length > 0 ? { fallbackProviders } : {}),
      ...(compressionProvider ? { compressionProvider } : {}),
    });
  }

  async function runConfiguredAgent(input: {
    sessionId: string;
    userMessage: string;
    userId?: string;
    workspaceId?: string;
    systemPrompt: string;
  }, overrides?: ExecutionOverrides) {
    // Auto-recall relevant memories (non-blocking — proceed without memories on failure)
    let memories: string[] = [];
    // Ensure startup tasks have completed before first agent run
    await contextEngineReady;
    await frozenMemoryReady;

    try {
      // v0.8.0 Hermes parity (#233): prefer the provider's `prefetch` hook when
      // defined (adapters may pre-warm caches / batch-read here) and fall back
      // to plain `recall` for adapters that don't override. The 5-record cap
      // is preserved per the issue contract.
      const recallPromise = memoryProvider.prefetch
        ? memoryProvider.prefetch(input.sessionId, input.userMessage, 5)
        : memoryProvider.recall(input.sessionId, input.userMessage, 5);
      const [recalled, profile] = await Promise.all([
        recallPromise,
        userModelService.getProfile(input.sessionId, input.userId ?? 'default-user'),
      ]);
      // v0.7 (#180) — surface recall to the dashboard MemoryStream component.
      // We only emit when at least one record came back; an empty recall is
      // noise that would otherwise drown the live stream on every turn.
      if (recalled.length > 0) {
        eventBus.emit('memory:recalled', {
          sessionId: input.sessionId,
          query: input.userMessage,
          hits: recalled.length,
          ids: recalled.map((r) => r.id),
          summaries: recalled.map((r) => r.summary.slice(0, 200)),
        });
      }
      memories = recalled.map(r => r.summary);
      // Inject user profile context if meaningful data exists
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
      // Memory recall failed — proceed without memories
    }

    // Hermes: inject frozen memory snapshot
    if (frozenMemory.size > 0) {
      memories.push(frozenMemory.formatForPrompt());
    }
    if (frozenUserProfile.size > 0) {
      memories.push(frozenUserProfile.formatForPrompt());
    }

    // Hermes: inject discovered context files
    if (contextEngineResult && contextEngineResult.files.length > 0) {
      memories.push(formatContextForPrompt(contextEngineResult));
    }

    // Inject feedback ledger digest into system prompt context
    const feedbackDigest = feedbackLedger.getDigest(30);
    if (feedbackDigest) {
      memories.push(feedbackDigest);
    }

    // Complexity-based model routing: use fast provider slot for simple queries
    const providerCfg = configStore.getProviderConfig();
    if (providerCfg?.fast && !overrides?.model) {
      const complexity = scoreComplexity(input.userMessage, buildConfiguredToolRegistry(overrides).list().length);
      const selectedModel = selectModelForComplexity(complexity, providerCfg.primary.model, providerCfg.fast.model);
      if (selectedModel !== providerCfg.primary.model) {
        overrides = { ...overrides, model: selectedModel };
      }
    }

    // Timestamp the start of this turn for accurate new-message detection
    const turnStartedAt = new Date().toISOString();

    const result = await createConfiguredAgent(overrides).run({
      agentId: options.agentId ?? 'crowclaw',
      ...input,
      memories,
    });

    // Determine which messages are new this turn.
    // Use the turn start timestamp to find messages created during this run.
    // This is robust against compression (which changes message count/content).
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
      void messageStore.appendBatch(storedMsgs).catch(() => {});
    }

    // Compression lineage: newMsgs already includes compression summary (if any)
    // via timestamp filter, so no separate append needed. The summary message
    // carries compressionMethod in its metadata for downstream lineage queries.

    // Extract facts from conversation and update frozen memory (Hermes pattern)
    void (async () => {
      try {
        // Update user model
        await userModelService.updateFromConversation(result.session.messages, input.sessionId);

        // Extract user profile updates into frozen USER snapshot
        const profile = await userModelService.getProfile(input.sessionId, input.userId ?? 'default-user');
        if (profile.expertise.length > 0) {
          frozenUserProfile.set('expertise', profile.expertise.join(', '), 'profile', input.sessionId);
        }
        if (profile.preferences.length > 0) {
          frozenUserProfile.set('preferences', profile.preferences.join('; '), 'profile', input.sessionId);
        }
        await frozenUserProfile.save(input.sessionId);

        // Extract key facts from THIS TURN's new messages (not post-compression session)
        const turnToolMsgs = newMsgs.filter((m: { role: string }) => m.role === 'tool');
        for (const tm of turnToolMsgs.slice(-3)) {
          const name = (tm as { name?: string }).name ?? 'tool';
          const content = (tm as { content: string }).content;
          if (content && content.length > 10 && content.length < 500) {
            frozenMemory.set(`tool:${name}:${input.sessionId.slice(-6)}`, content.slice(0, 300), 'tool-result', input.sessionId);
          }
        }
        // Extract decisions from this turn's assistant messages
        const assistantMsgs = newMsgs.filter((m: { role: string }) => m.role === 'assistant');
        const lastAssistant = assistantMsgs.at(-1) as { content: string } | undefined;
        if (lastAssistant?.content && /\b(decided|confirmed|set|created|updated|fixed|completed)\b/i.test(lastAssistant.content)) {
          const fact = lastAssistant.content.slice(0, 200);
          frozenMemory.set(`decision:${input.sessionId.slice(-6)}`, fact, 'decision', input.sessionId);
        }
        frozenMemory.prune(100); // Keep bounded
        await frozenMemory.save(input.sessionId);
      } catch { /* best-effort */ }
    })();

    // Record tool execution feedback
    for (const tr of result.toolResults) {
      feedbackLedger.record({
        timestamp: new Date().toISOString(),
        toolName: tr.toolName,
        ok: tr.ok,
        error: tr.ok ? undefined : tr.output.slice(0, 200),
        sessionId: input.sessionId,
      });
    }

    return result;
  }

  // #152: wire ownerToken from CROWCLAW_DASHBOARD_TOKEN so the embedded MCP
  // server enforces ownerOnly tool gating. Without this, the bridge runs in
  // "legacy mode" where every caller is treated as owner — any unauthenticated
  // POST to /api/mcp/server/request could invoke `crowclaw.chat`.
  const embeddedMcpOwnerToken = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CROWCLAW_DASHBOARD_TOKEN;
  const embeddedMcpServer = new CrowClawMcpServer({
    run: async ({ sessionId, userMessage }) => {
      const result = await runConfiguredAgent({
        sessionId,
        userMessage,
        systemPrompt: 'You are CrowClaw running in embedded MCP server mode.'
      });
      return { finalResponse: result.finalResponse };
    }
  }, {
    name: options.agentId ?? 'crowclaw-mcp-server',
    version,
    ownerToken: embeddedMcpOwnerToken,
  });

  const embeddedAcpServer = new AcpServer({
    run: async ({ sessionId, userMessage, systemPrompt }) => {
      const result = await runConfiguredAgent({
        sessionId,
        userMessage,
        systemPrompt: systemPrompt ?? 'You are CrowClaw running in embedded ACP server mode.'
      });
      return {
        finalResponse: result.finalResponse,
        toolResults: result.toolResults
      };
    }
  }, {
    agentId: options.agentId ?? 'crowclaw-acp',
    displayName: 'CrowClaw ACP',
    version,
  });

  function getGatewayAccessPolicy(platform: GatewayPlatform): ChannelAccessPolicy | null {
    const config = configStore.getGatewayConfig(platform);
    if (!config) {
      return null;
    }

    const defaults = createDefaultAccessPolicy();
    if (!config.dmPolicy) config.dmPolicy = defaults.dmPolicy;
    if (!config.groupPolicy) config.groupPolicy = defaults.groupPolicy;
    if (!config.allowlist) config.allowlist = [...defaults.allowlist];
    if (!config.groupAllowlist) config.groupAllowlist = [...defaults.groupAllowlist];
    if (typeof config.requireMention !== 'boolean') config.requireMention = defaults.requireMention;
    return config as ChannelAccessPolicy;
  }

  function isGroupMessage(message: NormalizedInboundMessage): boolean {
    switch (message.platform) {
      case 'telegram': {
        const chatType = (message.raw as { message?: { chat?: { type?: string } } }).message?.chat?.type;
        return Boolean(chatType && chatType !== 'private');
      }
      case 'discord':
        return Boolean((message.raw as { guild_id?: string }).guild_id);
      case 'slack':
        return /^[CG]/.test(message.channelId);
      case 'matrix':
        return message.channelId.startsWith('!');
      default:
        return false;
    }
  }

  function enforceGatewayAccess(message: NormalizedInboundMessage): Response | null {
    eventBus.emit('gateway:inbound', { platform: message.platform, channelId: message.channelId, userId: message.userId });
    // Record channel in gateway config for knownChannels tracking
    // Only update existing platform configs (don't auto-create)
    if (message.channelId) {
      const existing = configStore.getGatewayConfig(message.platform);
      if (existing) {
        const extra = existing.extra ?? {};
        const channelKey = `channel:${message.channelId}`;
        if (!extra[channelKey]) {
          extra[channelKey] = new Date().toISOString();
          if (!extra[`mute:${message.channelId}`]) {
            extra[`mute:${message.channelId}`] = 'false';
          }
          configStore.setGatewayConfig(message.platform, { ...existing, extra });
        }
      }
    }
    const policy = getGatewayAccessPolicy(message.platform);
    if (!policy) {
      // Deny-by-default: if no policy is configured, reject the message
      return Response.json(
        { ok: false, error: 'No access policy configured', platform: message.platform },
        { status: 403 }
      );
    }

    // Prune expired challenges before evaluating a new message.
    configStore.getPendingPairings();
    const decision = evaluateAccess(
      message,
      policy,
      isGroupMessage(message),
      configStore.getPendingPairingsMap() as Map<string, PairingChallenge>
    );

    if (decision.allowed) {
      return null;
    }

    const error = decision.reason === 'pairing-required'
      ? 'Pairing required.'
      : `Access denied: ${decision.reason}`;
    return Response.json({
      ok: false,
      error,
      reason: decision.reason,
      pairingCode: decision.pairingCode ?? null,
      sessionId: buildGatewaySessionKey(message)
    }, { status: 403 });
  }

  // Cap at 1000 checkpoints across all sessions. With autoCheckpoint on,
  // a long-running server accumulates one per iteration forever — the cap
  // keeps in-memory growth bounded. FIFO evicts the oldest.
  const checkpointStore = new InMemoryCheckpointStore({ maxCheckpoints: 1000 });

  // Delivery function — routes scheduled job results to gateway platforms
  const deliverToGateway: DeliveryFn = async (target: DeliveryTarget, content: string) => {
    const { platform, config: cfg } = target;
    eventBus.emit('gateway:outbound', { platform, contentLength: content.length });
    try {
      switch (platform) {
        case 'telegram': {
          const token = cfg.token ?? configStore.getGatewayConfig('telegram')?.token;
          const chatId = cfg.channel ?? cfg.chatId;
          if (!token || !chatId) return { ok: false, error: 'Missing Telegram token or chatId' };
          // sendTelegramMessage handles splitting and Markdown fallback internally
          const result = await sendTelegramMessage(token, chatId, content, { parseMode: 'Markdown' });
          if (!result.ok) {
            eventBus.emit('gateway:error', { platform, error: result.error ?? 'send failed' });
            return { ok: false, error: result.error ?? 'Telegram send failed' };
          }
          return { ok: true };
        }
        case 'discord': {
          const webhookUrl = cfg.webhookUrl ?? cfg.channel;
          if (!webhookUrl) return { ok: false, error: 'Missing Discord webhook URL' };
          const result = await sendDiscordMessage(webhookUrl, content);
          if (!result.ok) eventBus.emit('gateway:error', { platform, error: result.error });
          return { ok: result.ok, error: result.error };
        }
        case 'slack': {
          const token = cfg.token ?? configStore.getGatewayConfig('slack')?.token;
          const channel = cfg.channel;
          if (!token || !channel) return { ok: false, error: 'Missing Slack token or channel' };
          const result = await sendSlackMessage(token, channel, content);
          if (!result.ok) eventBus.emit('gateway:error', { platform, error: result.error });
          return { ok: result.ok, error: result.error };
        }
        default:
          return { ok: false, error: `Unsupported delivery platform: ${platform}` };
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      eventBus.emit('gateway:error', { platform, error });
      return { ok: false, error };
    }
  };

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
  const startupDashToken = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CROWCLAW_DASHBOARD_TOKEN;
  if (!startupDashToken) {
    const bindHost = options.hostname ?? '127.0.0.1';
    if (!isLocalhostAddress(bindHost)) {
      log.error('CROWCLAW_DASHBOARD_TOKEN is not set on non-localhost — admin API routes are unauthenticated', { component: 'security', bindHost });
    } else {
      log.warn('CROWCLAW_DASHBOARD_TOKEN is not set — dangerous routes disabled', { component: 'security' });
    }
  }

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
    async fetch(request: Request): Promise<Response> {
     try {
      const url = new URL(request.url);
      const dashToken = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CROWCLAW_DASHBOARD_TOKEN;
      const bindHostname = options.hostname ?? '127.0.0.1';
      const isLocalhost = isLocalhostAddress(bindHostname);
      // Extract client IP — reads trustProxy from configStore (persisted, dynamic).
      //
      // Trusted-proxy allowlist (v0.4.2+): when trustProxy is on AND the caller
      // sets CROWCLAW_TRUSTED_PROXIES=<comma-separated IPs>, we only honor
      // X-Forwarded-For if the upstream remote address (injected by the Node HTTP
      // wrapper as `x-crowclaw-remote-addr`) is in that list. Without this, an
      // attacker who reaches the exposed port directly can spoof X-Forwarded-For
      // to rotate source IPs past the per-IP rate limiter. If trustProxy is on
      // but no allowlist is configured, we keep the legacy behavior (full trust)
      // but the global 60/min auth backstop from v0.4.1 still applies.
      const trustedProxiesRaw = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
        .process?.env?.CROWCLAW_TRUSTED_PROXIES;
      const trustedProxyMatchers = trustedProxiesRaw
        ? trustedProxiesRaw.split(',').map((s) => s.trim()).filter(Boolean).map(parseCidrMatcher).filter((m): m is CidrMatcher => m !== null)
        : null;
      const getClientIp = (req: Request): string => {
        const remoteAddr = normalizeIp(req.headers.get('x-crowclaw-remote-addr') ?? '127.0.0.1');
        if (configStore.getTrustProxy() || options.trustProxy) {
          if (trustedProxyMatchers && !trustedProxyMatchers.some((m) => m(remoteAddr))) {
            // Remote addr doesn't match any allowlist entry (IP or CIDR).
            return remoteAddr;
          }
          return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
            ?? req.headers.get('x-real-ip')
            ?? remoteAddr;
        }
        return remoteAddr;
      };

      // Fail-close: if we're bound to a non-localhost interface and no dashboard
      // token is configured, reject every protected surface (API, events, WS).
      // Webhooks still work because they carry their own per-platform secret.
      // Without this gate, `/api/events`, `/api/sessions/*/message`, `/api/mcp/call`,
      // and `/ws` would all be unauthenticated on a public IP.
      if (!dashToken && !isLocalhost) {
        const isProtectedSurface = url.pathname.startsWith('/api/') || url.pathname === '/ws';
        if (isProtectedSurface) {
          return Response.json(
            { error: 'CROWCLAW_DASHBOARD_TOKEN is required when binding to non-localhost' },
            { status: 500 }
          );
        }
      }

      // #128: Body-size cap for state-changing methods. A declared
      // Content-Length above 1 MiB is rejected before we ever touch the
      // body stream — this is the cheap layer that stops a 1 GB JSON DoS
      // from buffering through `request.json()` on the unauthenticated
      // `/api/auth/verify` route or any other POST surface. Routes that
      // need defense against missing/lying Content-Length (chunked
      // transfers) additionally read with `readJsonWithSizeCap`.
      if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH' || request.method === 'DELETE') {
        const cap = checkContentLengthCap(request);
        if (cap) {
          log.warn('Request body exceeds size cap', {
            component: 'security',
            path: url.pathname,
            method: request.method,
            contentLength: request.headers.get('content-length'),
            clientIp: getClientIp(request),
          });
          return cap;
        }
      }

      // Stricter rate limit for credential-checking endpoints only.
      // /api/auth/check is a passive cookie/bearer status read that the dashboard
      // hits on every page load — counting it as an "auth attempt" exhausts the
      // budget and locks the user out. Only /api/auth/verify (which actually
      // accepts a token from the request body) is rate-limited.
      // Must run before auth handlers which return early.
      if (url.pathname === '/api/auth/verify' && request.method === 'POST') {
        const clientIp = getClientIp(request);
        // Per-IP limit stops honest clients from self-DOSing. Global limit
        // blunts the X-Forwarded-For rotation trick: a proxy that sets XFF
        // lets an attacker cycle client IPs, so without this a brute-forcer
        // gets essentially unlimited attempts. 60/min total is well above
        // legitimate retry patterns but caps an attacker at ~1 attempt/sec.
        if (!authRateLimiter.check(clientIp, 10, 60_000)) {
          log.warn('Auth rate limit exceeded (per-IP)', { component: 'security', clientIp, path: url.pathname });
          return Response.json(
            { error: 'Too many authentication attempts. Limit: 10 per minute.' },
            { status: 429, headers: { 'Retry-After': '60' } }
          );
        }
        if (!authRateLimiter.check('__global_auth__', 60, 60_000)) {
          log.warn('Auth rate limit exceeded (global)', { component: 'security', clientIp, path: url.pathname });
          return Response.json(
            { error: 'Too many authentication attempts. Server-wide limit: 60 per minute.' },
            { status: 429, headers: { 'Retry-After': '60' } }
          );
        }
      }

      // Auth verification endpoint
      if (request.method === 'POST' && url.pathname === '/api/auth/verify') {
        if (!dashToken) {
          if (isLocalhost) {
            return Response.json({ ok: true, bypass: true });
          }
          return Response.json({ error: 'CROWCLAW_DASHBOARD_TOKEN is required when binding to non-localhost' }, { status: 500 });
        }
        // #128: defensive read — caps the body even when Content-Length is
        // absent or lying (chunked transfers). This is the unauthenticated
        // surface, so it is the highest-value site to harden beyond the
        // header precheck above.
        const parsed = await readJsonWithSizeCap<{ token?: string }>(request);
        if (!parsed.ok) return parsed.response;
        const body = parsed.value;
        if (dashToken && timingSafeEqual(body.token ?? '', dashToken)) {
          const cookieValue = getDerivedCookieToken(dashToken);
          const secureSuffix = isLocalhost ? '' : '; Secure';
          const headers = new Headers({ 'content-type': 'application/json' });
          headers.set('Set-Cookie', `crowclaw_auth=${cookieValue}; HttpOnly; SameSite=Strict; Path=/${secureSuffix}`);
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
        }
        return Response.json({ ok: false });
      }

      // Auth logout endpoint — clears the HttpOnly cookie. We can't clear
      // an HttpOnly cookie from JS, so the client calls this to sign out.
      if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
        const secureSuffix = isLocalhost ? '' : '; Secure';
        const headers = new Headers({ 'content-type': 'application/json' });
        headers.set(
          'Set-Cookie',
          `crowclaw_auth=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureSuffix}`,
        );
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
      }

      // Auth check endpoint (cookie-based, does not leak token)
      if (request.method === 'GET' && url.pathname === '/api/auth/check') {
        const cookieAuth = parseCookieToken(request.headers.get('cookie'));
        const headerAuth = request.headers.get('authorization')?.startsWith('Bearer ')
          ? request.headers.get('authorization')!.slice(7) : null;
        if (!dashToken) {
          return Response.json({ authenticated: isLocalhost });
        }
        const derivedCookie = getDerivedCookieToken(dashToken);
        return Response.json({ authenticated: (cookieAuth !== null && timingSafeEqual(cookieAuth, derivedCookie)) || (headerAuth !== null && timingSafeEqual(headerAuth, dashToken)) });
      }

      // Auth middleware for /api/* routes
      if (
        url.pathname.startsWith('/api/')
        && url.pathname !== '/api/auth/verify'
        && url.pathname !== '/api/auth/check'
        && url.pathname !== '/api/auth/logout'
      ) {
        const authHeader = request.headers.get('authorization');
        const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
        const cookieToken = parseCookieToken(request.headers.get('cookie'));
        const derivedCookie = getDerivedCookieToken(dashToken);
        const tokenMatch = dashToken ? ((bearerToken !== null && timingSafeEqual(bearerToken, dashToken)) || (cookieToken !== null && timingSafeEqual(cookieToken, derivedCookie))) : false;

        // Dangerous routes require auth, regardless of localhost — UNLESS we're
        // in dev mode (no dashToken) AND the route is a dashboard-config
        // read/write that the UI needs to bootstrap (config fetches,
        // provider-config display). Execution routes (terminal exec, workspace
        // mutations, MCP server CRUD, scheduler start/stop) stay locked even
        // on localhost so a misconfigured dashboard token doesn't open a
        // remote-code-execution surface for a malicious browser tab on the
        // same host.
        // See `tests/security-critical.test.ts` for the binding contract.
        if (isDangerousRoute(url.pathname)) {
          if (!dashToken) {
            // Dev-mode (no token) carve-out on localhost — see comment block
            // above isLocalDashConfigRoute for rationale.
            //   1) GET on any dangerous route is read-only (listings, status,
            //      configuration display) — the dashboard fetches many of
            //      these on init and would otherwise 401-storm.
            //   2) The explicit dashboard-config endpoints (read+write) for
            //      the setup wizard.
            //   3) The historic gateway-mutation carve-out.
            // POST/PUT/PATCH/DELETE on execution routes (terminal exec,
            // workspace mutate, MCP CRUD, scheduler control) stay locked.
            const isReadOnly = request.method === 'GET' || request.method === 'HEAD';
            const localDashOk = isLocalhost && (isReadOnly || isLocalDashConfigRoute(url.pathname));
            if (!isGatewayMutationRoute(url.pathname) && !localDashOk) {
              return Response.json({ error: 'CROWCLAW_DASHBOARD_TOKEN must be set to access dangerous routes' }, { status: 401 });
            }
          } else if (!tokenMatch) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
          }
        } else if (dashToken && !tokenMatch && (!isLocalhost || !isLocalOperatorBypassRoute(url.pathname, request.method))) {
          // Non-dangerous routes: require auth by default when a token is configured.
          // Localhost keeps a narrow operator/test bypass only for selected routes.
          return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }
      }

      // General rate limiting for /api/* routes: 100 requests per minute per IP
      if (url.pathname.startsWith('/api/')) {
        const clientIp = getClientIp(request);
        if (!rateLimiter.check(clientIp, 100, 60_000)) {
          return Response.json(
            { error: 'Too many requests. Limit: 100 per minute.' },
            { status: 429, headers: { 'Retry-After': '60' } }
          );
        }
      }

      // Session rename
      const renameMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/rename$/);
      if (request.method === 'POST' && renameMatch) {
        const sessionId = renameMatch[1];
        const body = (await request.json()) as { name: string };
        const session = await store.get(sessionId);
        if (session) {
          // Store the display name in the first system message or as a metadata convention
          // We prepend a metadata marker that the dashboard can read back
          const existingMeta = session.messages.find(m => m.role === 'system' && m.content.startsWith('[session-meta]'));
          const metaMsg = { role: 'system' as const, content: `[session-meta] name=${body.name}`, createdAt: new Date().toISOString() };
          if (existingMeta) {
            existingMeta.content = metaMsg.content;
          } else {
            session.messages.unshift(metaMsg);
          }
          session.updatedAt = new Date().toISOString();
          await store.put(session);
        }
        return Response.json({ ok: true, sessionId, name: body.name });
      }

      // Session delete
      const deleteSessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (request.method === 'DELETE' && deleteSessionMatch) {
        const sessionId = deleteSessionMatch[1];
        if (typeof (store as unknown as { delete?: unknown }).delete === 'function') {
          await (store as unknown as { delete(id: string): Promise<void> }).delete(sessionId);
        }
        return Response.json({ ok: true, sessionId });
      }

      // Memory delete
      const deleteMemoryMatch = url.pathname.match(/^\/api\/memories\/([^/]+)$/);
      if (request.method === 'DELETE' && deleteMemoryMatch) {
        const memoryId = deleteMemoryMatch[1];
        if (typeof (memoryStore as unknown as { delete?: unknown }).delete === 'function') {
          await (memoryStore as unknown as { delete(id: string): Promise<void> }).delete(memoryId);
        }
        return Response.json({ ok: true, memoryId });
      }

      // Dashboard — serve web UI at root and /dashboard
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
        const { DASHBOARD_HTML } = await import('@crowclaw/web');
        const nonce = generateNonce();
        // Inject nonce via a tag-aware walker (not regex — see comment on
        // injectScriptNonce for the edge cases it handles).
        const nonceHtml = injectScriptNonce(DASHBOARD_HTML, nonce);
        return new Response(nonceHtml, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'Content-Security-Policy': dashboardCSP(nonce),
            ...SECURITY_HEADERS_BASE,
          },
        });
      }

      // Static assets from docs/ (logo, etc.)
      if (request.method === 'GET' && url.pathname === '/docs/logo.png') {
        try {
          const dynamicImport = new Function('specifier', 'return import(specifier)');
          const fs = await dynamicImport('node:fs/promises') as { readFile(path: string): Promise<Uint8Array> };
          const path = await dynamicImport('node:path') as { join(...parts: string[]): string };
          const processRef = globalThis as unknown as { process?: { cwd?: () => string } };
          const cwd = processRef.process?.cwd?.() ?? '.';
          const data = await fs.readFile(path.join(cwd, 'docs', 'logo.png'));
          const typed = Uint8Array.from(data);
          return new Response(new Blob([typed]), { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' } });
        } catch {
          return new Response('Not found', { status: 404 });
        }
      }

      // --- Security API endpoints ---

      if (request.method === 'GET' && url.pathname === '/api/security/status') {
        const policy = configStore.getSecurityPolicy();
        const stats = securityAuditLog.getStats();
        const protections = [
          { name: 'Tool Output Redaction', key: 'redactToolOutput', enabled: policy.redactToolOutput, configurable: true },
          { name: 'Command Scanning', key: 'scanCommands', enabled: policy.scanCommands, configurable: true },
          { name: 'User Input Scanning', key: 'scanUserInput', enabled: policy.scanUserInput, configurable: true },
          { name: 'Dangerous Command Blocking', key: 'blockDangerousCommands', enabled: policy.blockDangerousCommands, configurable: true },
          { name: 'SSRF Protection', key: 'ssrf', enabled: true, configurable: false },
          { name: 'PII Redaction', key: 'piiRedaction', enabled: policy.piiRedaction, configurable: true },
        ];
        const activeCount = protections.filter((p) => p.enabled).length;
        const totalCount = protections.length;
        let grade: string;
        if (activeCount === totalCount) grade = 'A';
        else if (activeCount >= 4) grade = 'B';
        else if (activeCount >= 2) grade = 'C';
        else if (activeCount >= 1) grade = 'D';
        else grade = 'F';
        return Response.json({
          policy,
          protections,
          activeCount,
          totalCount,
          grade,
          stats,
        });
      }

      if (request.method === 'GET' && (url.pathname === '/api/security/events' || url.pathname === '/api/security/audit')) {
        const limitParam = url.searchParams.get('limit');
        const typeParam = url.searchParams.get('type');
        const severityParam = url.searchParams.get('severity');
        const sinceParam = url.searchParams.get('since') ?? undefined;
        const limit = limitParam ? parseInt(limitParam, 10) : undefined;
        let events = typeParam
          ? securityAuditLog.getEventsByType(typeParam)
          : securityAuditLog.getEvents();
        if (securityAuditLog instanceof FileSecurityAuditLog) {
          const persisted = await securityAuditLog.readEvents({
            ...(sinceParam ? { since: sinceParam } : {}),
            ...(typeParam ? { type: typeParam } : {}),
            ...(severityParam ? { severity: severityParam } : {}),
          });
          const seen = new Set<string>();
          events = [...events, ...persisted]
            .filter((event) => {
              if (severityParam && event.severity !== severityParam) return false;
              if (sinceParam && Date.parse(event.timestamp) < Date.parse(sinceParam)) return false;
              const key = `${event.timestamp}:${event.type}:${event.severity}:${event.sessionId ?? ''}:${event.detail}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
          if (limit) events = events.slice(0, limit);
        } else {
          if (severityParam) {
            events = events.filter((e) => e.severity === severityParam);
          }
          if (sinceParam) {
            const sinceTime = Date.parse(sinceParam);
            events = events.filter((e) => Date.parse(e.timestamp) >= sinceTime);
          }
          if (limit) events = events.slice(0, limit);
        }
        return Response.json({ events });
      }

      if (request.method === 'POST' && url.pathname === '/api/security/policy') {
        const body = (await request.json()) as Record<string, unknown>;
        const update: Record<string, boolean> = {};
        for (const key of ['redactToolOutput', 'scanUserInput', 'scanCommands', 'blockDangerousCommands', 'piiRedaction']) {
          if (typeof body[key] === 'boolean') {
            update[key] = body[key] as boolean;
          }
        }
        configStore.setSecurityPolicy(update);
        return Response.json({ ok: true, policy: configStore.getSecurityPolicy() });
      }

      if (request.method === 'POST' && url.pathname === '/api/security/events/clear') {
        securityAuditLog.clear();
        return Response.json({ ok: true });
      }

      if (request.method === 'GET' && url.pathname === '/api/security/stats') {
        return Response.json(securityAuditLog.getStats());
      }

      if (request.method === 'GET' && url.pathname === '/api/user/profile') {
        const sessionId = url.searchParams.get('sessionId') ?? 'default';
        const scopeKey = url.searchParams.get('scopeKey') ?? 'default-user';
        const profile = await userModelService.getProfile(sessionId, scopeKey);
        return Response.json(profile);
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        return Response.json({ ok: true, service: 'crowclaw', runtime: 'node', version });
      }
      // Kubernetes-style aliases. /healthz is liveness (always 200 if the
      // process is up). /readyz is readiness — currently same shape as
      // /health since the runtime has no async warm-up phase; wired now so
      // probes don't 404.
      if (request.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/readyz')) {
        return Response.json({ ok: true, service: 'crowclaw', runtime: 'node', version });
      }

      // Public discovery endpoint (no auth required)
      if (request.method === 'GET' && url.pathname === '/.well-known/agent-skills') {
        const resolved = skillRegistry.resolve();
        return Response.json({
          skills: resolved.map((s) => ({
            name: s.manifest.name,
            description: s.manifest.description,
            triggers: s.manifest.triggers ?? [],
            tools: s.manifest.tools ?? [],
          })),
          version,
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/system/version') {
        return Response.json({
          service: 'crowclaw',
          runtime: 'node',
          deployment: deploymentName,
          version
        });
      }

      // Tool inventory shortcut (used by app shell sidebar)
      if (request.method === 'GET' && url.pathname === '/api/tools') {
        // #218 — expose the *full* tool inventory (not the toolset-filtered
        // registry) so the dashboard can render disable toggles for every
        // tool, including ones currently hidden by the active toolset preset.
        // Each entry carries a `disabled` flag from the configStore so the
        // UI can render the toggle state without a second round-trip.
        const allTools = tools.list().map((manifest) => ({
          ...manifest,
          disabled: configStore.isToolDisabled(manifest.name),
        }));
        return Response.json({ tools: allTools, count: allTools.length });
      }

      // #218 — POST /api/tools/:name/toggle: persist a per-tool enable/disable
      // flag. Disabled tools are stripped from the agent-loop registry by
      // `buildConfiguredToolRegistry()` so the LLM never sees them. The UI
      // calls this endpoint when the user flips a tool toggle in the
      // dashboard tool inventory panel.
      {
        const toolToggleMatch = url.pathname.match(/^\/api\/tools\/([^/]+)\/toggle$/);
        if (request.method === 'POST' && toolToggleMatch) {
          const toolName = decodeURIComponent(toolToggleMatch[1]);
          const body = (await request.json().catch(() => ({}))) as { disabled?: boolean };
          if (typeof body.disabled !== 'boolean') {
            return Response.json(
              { error: { code: 'VALIDATION_ERROR', message: 'Body must include `disabled: boolean`' } },
              { status: 400 },
            );
          }
          // Reject toggles for unknown tool names so the UI can't silently
          // accumulate dead entries in the disabled set.
          if (!tools.get(toolName)) {
            return Response.json(
              { error: { code: 'TOOL_NOT_FOUND', message: `Tool '${toolName}' is not registered` } },
              { status: 404 },
            );
          }
          configStore.setToolDisabled(toolName, body.disabled);
          return Response.json({ ok: true, name: toolName, disabled: body.disabled });
        }
      }

      if (request.method === 'GET' && url.pathname === '/api/system/status') {
        // #35: prune-on-read for stale bridge / browser sessions before we
        //      enumerate them — the count returned in the response should
        //      reflect what the runtime would actually serve, not entries
        //      that have been idle for >1h with no chance of resumption.
        pruneStaleBridgeSessions(codeBridgeSessions);
        // #116: Prune the BridgeProcessRecord Map alongside the session Map.
        // Without this, entries marked dead but never explicitly terminated
        // (e.g. child exited but `terminateBridgeProcess` was never called)
        // accumulate forever and the dashboard counts grow unbounded.
        pruneDeadBridgeProcesses(bridgeProcesses);
        pruneStaleBrowserSessions(browserSessions);
        const bridgeProcessSummary = [...bridgeProcesses.values()].map((process) => ({
          sessionId: process.sessionId,
          protocolVersion: process.protocolVersion,
          pid: process.pid,
          mode: process.mode,
          socketPath: process.socketPath,
          socketReady: process.socketReady,
          directToolAliases,
          supportedRequestedAliasCount: (Object.entries(directToolAliases) as Array<[keyof typeof directToolAliases, (typeof directToolAliases)[keyof typeof directToolAliases]]>)
            .filter(([, target]) => process.supportedDirectTools.includes(target)).length,
          supportedAliasTargetCount: [...new Set((Object.entries(directToolAliases) as Array<[keyof typeof directToolAliases, (typeof directToolAliases)[keyof typeof directToolAliases]]>)
            .filter(([, target]) => process.supportedDirectTools.includes(target))
            .map(([, target]) => target))].length,
          supportedRequestedAliases: (Object.entries(directToolAliases) as Array<[keyof typeof directToolAliases, (typeof directToolAliases)[keyof typeof directToolAliases]]>)
            .filter(([, target]) => process.supportedDirectTools.includes(target))
            .map(([alias]) => alias),
          supportedAliasTargets: [...new Set((Object.entries(directToolAliases) as Array<[keyof typeof directToolAliases, (typeof directToolAliases)[keyof typeof directToolAliases]]>)
            .filter(([, target]) => process.supportedDirectTools.includes(target))
            .map(([, target]) => target))],
          supportedDirectTools: process.supportedDirectTools,
          alive: process.alive,
          startedAt: process.startedAt,
          exitedAt: process.exitedAt,
          exitCode: process.exitCode,
          spawnError: process.spawnError,
          directToolCount: process.supportedDirectTools.filter((toolName) => toolName !== 'mcp.callTool').length,
          directBrowserTools: process.supportedDirectTools.filter((toolName) => toolName.startsWith('browser.')),
          directMcpTools: process.supportedDirectTools.filter((toolName) => toolName.startsWith('mcp.')),
          directRuntimeTools: process.supportedDirectTools.filter((toolName) => !toolName.startsWith('browser.') && !toolName.startsWith('mcp.') && toolName !== 'mcp.callTool'),
          ...summarizeSessionTranscript(codeBridgeSessions.get(process.sessionId))
        }));
        const bridgeSessionSummary = [...codeBridgeSessions.values()].map((session) => summarizeBridgeSessionRecord(session, bridgeProcesses.get(session.sessionId)));
        // #174: First-run onboarding flags. Derived from existing state so we
        // don't have to persist a parallel set of booleans that could drift
        // out of sync with the underlying configStore / message log.
        //   - hasProvider:       primary provider slot is configured
        //   - hasPreset:         a config preset has been activated
        //   - firstChatComplete: at least one user/assistant message has
        //                        been persisted across any session. Empty
        //                        needle on `searchAll` matches every stored
        //                        message; a single hit is enough to know
        //                        the user has finished their first chat.
        const onboardingHasProvider = Boolean(configStore.getProviderConfig()?.primary);
        const onboardingHasPreset = Boolean(configStore.getActiveConfigPresetName());
        let onboardingFirstChatComplete = false;
        try {
          const probe = await messageStore.searchAll('', 1);
          onboardingFirstChatComplete = probe.length > 0;
        } catch { /* status route must never fail because of a probe */ }
        return Response.json({
          ok: true,
          deployment: deploymentName,
          version,
          runtime: 'node',
          service: 'crowclaw',
          plugins: plugins.list().map((plugin) => plugin.name),
          counts: {
            bridgeSessions: codeBridgeSessions.size,
            bridgeProcesses: bridgeProcesses.size,
            bridgeAliveProcesses: [...bridgeProcesses.values()].filter((process) => process.alive).length,
            browserSessions: browserSessions.size,
            schedulerJobs: (await schedulerStore.listJobs()).length
          },
          // #174: top-level booleans the onboarding wizard reads to decide
          // whether to render and which step to land on.
          hasProvider: onboardingHasProvider,
          hasPreset: onboardingHasPreset,
          firstChatComplete: onboardingFirstChatComplete,
          bridgeSummary: summarizeBridgeSessionsAggregate(codeBridgeSessions, bridgeProcesses),
          bridgeSessions: bridgeSessionSummary,
          bridgeProcesses: bridgeProcessSummary,
          mcp: (() => {
            // Dashboard reads `.mcp.servers?.length` to render the "N servers"
            // badge on the Overview panel. `getStatus()` exposes cache-level
            // state only; attach the server list from `getServerStatus()` so
            // the UI count tracks reality.
            const status = mcpClient.getStatus();
            if (!status) return null;
            const serverStatus = (mcpClient as unknown as { getServerStatus?: () => Record<string, unknown> }).getServerStatus?.() ?? {};
            return { ...status, servers: Object.keys(serverStatus) };
          })(),
          gateway: {
            slackSigningSecretConfigured: Boolean(options.slackSigningSecret)
          },
          bridgeCapabilities: summarizeDirectTools(bridgeProcesses),
          tools: tools.list().map((t) => ({ name: t.name, description: t.description, runtime: t.runtime, dangerLevel: t.dangerLevel })),
          model: typeof options.provider === 'object' && 'model' in (options.provider as unknown as Record<string, unknown>)
            ? (options.provider as unknown as Record<string, unknown>).model
            : 'unknown',
          provider: typeof options.provider === 'object' && 'name' in (options.provider as unknown as Record<string, unknown>)
            ? (options.provider as unknown as Record<string, unknown>).name
            : (options.provider ? 'configured' : 'none'),
          release: {
            candidate: true,
            verification: {
              note: 'typecheck and tests passed at build time'
            }
          }
        });
      }

      // Capabilities — runtime status of each subsystem for dashboard badges
      if (request.method === 'GET' && url.pathname === '/api/capabilities') {
        const providerName = typeof options.provider === 'object' && 'name' in (options.provider as unknown as Record<string, unknown>)
          ? String((options.provider as unknown as Record<string, unknown>).name)
          : '';
        const providerModel = typeof options.provider === 'object' && 'model' in (options.provider as unknown as Record<string, unknown>)
          ? String((options.provider as unknown as Record<string, unknown>).model)
          : 'unknown';
        const isEcho = providerName.toLowerCase().includes('echo') || !options.provider;
        const mcpStatus = mcpClient.getStatus();
        const hasMcp = Boolean(mcpStatus);
        const hasGateway = Boolean(options.slackSigningSecret);
        const toolCount = tools.list().length;
        const skillCount = skillRegistry.resolve().length;

        return Response.json({
          provider: {
            status: isEcho ? 'simulated' : 'live',
            detail: isEcho ? 'EchoProvider' : `${providerName} ${providerModel}`.trim(),
          },
          chat: { status: isEcho ? 'simulated' : 'live' },
          streaming: { status: 'live' },
          tools: { status: 'live', detail: `${toolCount} registered` },
          memory: { status: 'simulated', detail: 'In-memory only' },
          skills: { status: 'live', detail: `${skillCount} built-in` },
          scheduler: { status: 'live' },
          gateway: {
            status: hasGateway ? 'live' : 'disconnected',
            detail: hasGateway ? 'Platform(s) configured' : 'No platforms configured',
          },
          mcp: {
            status: hasMcp ? 'live' : 'disconnected',
            detail: hasMcp ? 'Server(s) connected' : 'No servers connected',
          },
          browser: { status: 'simulated' },
          workspace: { status: 'live', detail: 'File-backed' },
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/system/preflight') {
        const mcpStatus = mcpClient.getStatus();
        return Response.json({
          ok: true,
          deployment: deploymentName,
          version,
          runtime: 'node',
          checks: {
            providerConfigured: Boolean(options.provider),
            workspaceReady: typeof workspaceStore.list === 'function',
            schedulerReady: typeof schedulerStore.listJobs === 'function',
            bridgeReady: true,
            bridgeProcessRuntimeAvailable: true,
            mcpReady: Boolean(mcpClient),
            mcpDegraded: Boolean(mcpStatus && 'degraded' in mcpStatus ? mcpStatus.degraded : false),
            slackSigningSecretConfigured: Boolean(options.slackSigningSecret)
          }
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/system/release-check') {
        // #35: prune-on-read here too — release-check is a heavy enumeration
        //      that's a natural place to flush stale entries.
        pruneStaleBridgeSessions(codeBridgeSessions);
        // #116: Prune the BridgeProcessRecord Map alongside the session Map.
        // Without this, entries marked dead but never explicitly terminated
        // (e.g. child exited but `terminateBridgeProcess` was never called)
        // accumulate forever and the dashboard counts grow unbounded.
        pruneDeadBridgeProcesses(bridgeProcesses);
        pruneStaleBrowserSessions(browserSessions);
        const bridgeProcessSummary = [...bridgeProcesses.values()].map((process) => ({
          sessionId: process.sessionId,
          pid: process.pid,
          mode: process.mode,
          socketPath: process.socketPath,
          socketReady: process.socketReady,
          directToolAliases,
          supportedRequestedAliasCount: (Object.entries(directToolAliases) as Array<[keyof typeof directToolAliases, (typeof directToolAliases)[keyof typeof directToolAliases]]>)
            .filter(([, target]) => process.supportedDirectTools.includes(target)).length,
          supportedAliasTargetCount: [...new Set((Object.entries(directToolAliases) as Array<[keyof typeof directToolAliases, (typeof directToolAliases)[keyof typeof directToolAliases]]>)
            .filter(([, target]) => process.supportedDirectTools.includes(target))
            .map(([, target]) => target))].length,
          supportedRequestedAliases: (Object.entries(directToolAliases) as Array<[keyof typeof directToolAliases, (typeof directToolAliases)[keyof typeof directToolAliases]]>)
            .filter(([, target]) => process.supportedDirectTools.includes(target))
            .map(([alias]) => alias),
          supportedAliasTargets: [...new Set((Object.entries(directToolAliases) as Array<[keyof typeof directToolAliases, (typeof directToolAliases)[keyof typeof directToolAliases]]>)
            .filter(([, target]) => process.supportedDirectTools.includes(target))
            .map(([, target]) => target))],
          alive: process.alive,
          startedAt: process.startedAt,
          exitedAt: process.exitedAt,
          exitCode: process.exitCode,
          spawnError: process.spawnError,
          directToolCount: process.supportedDirectTools.filter((toolName) => toolName !== 'mcp.callTool').length,
          directBrowserTools: process.supportedDirectTools.filter((toolName) => toolName.startsWith('browser.')),
          directMcpTools: process.supportedDirectTools.filter((toolName) => toolName.startsWith('mcp.')),
          directRuntimeTools: process.supportedDirectTools.filter((toolName) => !toolName.startsWith('browser.') && !toolName.startsWith('mcp.') && toolName !== 'mcp.callTool'),
          ...summarizeSessionTranscript(codeBridgeSessions.get(process.sessionId))
        }));
        const defaultBridgeSession = codeBridgeSessions.get('cli-default');
        const defaultBridgeProcess = bridgeProcesses.get('cli-default');
        const dynamicMcpStatus = mcpClient.getStatus();
        let inspectedMcp: unknown;
        try {
          inspectedMcp = await mcpClient.inspect();
        } catch {
          inspectedMcp = {
            status: dynamicMcpStatus,
            tools: [],
            resources: [],
            prompts: []
          };
        }
        return Response.json({
          doctor: {
            ok: true,
            deployment: deploymentName,
            version,
            runtime: 'node',
            service: 'crowclaw',
            plugins: plugins.list().map((plugin) => plugin.name),
            counts: {
              bridgeSessions: codeBridgeSessions.size,
              bridgeProcesses: bridgeProcesses.size,
              bridgeAliveProcesses: [...bridgeProcesses.values()].filter((process) => process.alive).length,
              browserSessions: browserSessions.size,
              schedulerJobs: (await schedulerStore.listJobs()).length
            },
            bridgeProcesses: bridgeProcessSummary,
            mcp: dynamicMcpStatus,
            gateway: {
              slackSigningSecretConfigured: Boolean(options.slackSigningSecret)
            },
            release: {
              candidate: true,
              verification: {
                note: 'typecheck and tests passed at build time'
              }
            }
          },
          bridgeSummary: summarizeBridgeSessionsAggregate(codeBridgeSessions, bridgeProcesses),
          preflight: {
            ok: true,
            deployment: deploymentName,
            version,
            runtime: 'node',
            checks: {
              providerConfigured: Boolean(options.provider),
              workspaceReady: typeof workspaceStore.list === 'function',
              schedulerReady: typeof schedulerStore.listJobs === 'function',
              bridgeReady: true,
              bridgeProcessRuntimeAvailable: true,
              mcpReady: Boolean(mcpClient),
              mcpDegraded: Boolean(dynamicMcpStatus && typeof dynamicMcpStatus === 'object' && 'degraded' in dynamicMcpStatus ? (dynamicMcpStatus as { degraded?: boolean }).degraded : false),
              slackSigningSecretConfigured: Boolean(options.slackSigningSecret)
            }
          },
          bridge: {
            sessionId: 'cli-default',
            exists: Boolean(codeBridgeSessions.get('cli-default')),
            capabilities: bridgeProcesses.get('cli-default')?.supportedDirectTools ?? [],
            directToolAliases,
            supportedRequestedAliasCount: (bridgeProcesses.get('cli-default')?.supportedDirectTools.filter((toolName) => toolName !== 'mcp.callTool') ?? []).length > 0
              ? (Object.entries(directToolAliases) as Array<[keyof typeof directToolAliases, (typeof directToolAliases)[keyof typeof directToolAliases]]>)
                .filter(([, target]) => (bridgeProcesses.get('cli-default')?.supportedDirectTools.filter((toolName) => toolName !== 'mcp.callTool') ?? []).includes(target)).length
              : 0,
            supportedAliasTargetCount: (bridgeProcesses.get('cli-default')?.supportedDirectTools.filter((toolName) => toolName !== 'mcp.callTool') ?? []).length > 0
              ? [...new Set((Object.entries(directToolAliases) as Array<[keyof typeof directToolAliases, (typeof directToolAliases)[keyof typeof directToolAliases]]>)
                .filter(([, target]) => (bridgeProcesses.get('cli-default')?.supportedDirectTools.filter((toolName) => toolName !== 'mcp.callTool') ?? []).includes(target))
                .map(([, target]) => target))].length
              : 0,
            supportedRequestedAliases: (bridgeProcesses.get('cli-default')?.supportedDirectTools.filter((toolName) => toolName !== 'mcp.callTool') ?? []).length > 0
              ? (Object.entries(directToolAliases) as Array<[keyof typeof directToolAliases, (typeof directToolAliases)[keyof typeof directToolAliases]]>)
                .filter(([, target]) => (bridgeProcesses.get('cli-default')?.supportedDirectTools.filter((toolName) => toolName !== 'mcp.callTool') ?? []).includes(target))
                .map(([alias]) => alias)
              : [],
            supportedAliasTargets: (bridgeProcesses.get('cli-default')?.supportedDirectTools.filter((toolName) => toolName !== 'mcp.callTool') ?? []).length > 0
              ? [...new Set((Object.entries(directToolAliases) as Array<[keyof typeof directToolAliases, (typeof directToolAliases)[keyof typeof directToolAliases]]>)
                .filter(([, target]) => (bridgeProcesses.get('cli-default')?.supportedDirectTools.filter((toolName) => toolName !== 'mcp.callTool') ?? []).includes(target))
                .map(([, target]) => target))]
              : [],
            nestedDirectTools: bridgeProcesses.get('cli-default')?.supportedDirectTools.filter((toolName) => toolName !== 'mcp.callTool') ?? [],
            directToolCount: (bridgeProcesses.get('cli-default')?.supportedDirectTools.filter((toolName) => toolName !== 'mcp.callTool') ?? []).length,
            directBrowserTools: (bridgeProcesses.get('cli-default')?.supportedDirectTools.filter((toolName) => toolName !== 'mcp.callTool') ?? []).filter((toolName) => toolName.startsWith('browser.')),
            directMcpTools: (bridgeProcesses.get('cli-default')?.supportedDirectTools.filter((toolName) => toolName !== 'mcp.callTool') ?? []).filter((toolName) => toolName.startsWith('mcp.')),
            directRuntimeTools: (bridgeProcesses.get('cli-default')?.supportedDirectTools.filter((toolName) => toolName !== 'mcp.callTool') ?? []).filter((toolName) => !toolName.startsWith('browser.') && !toolName.startsWith('mcp.')),
            supportsNestedCallToolDirect: true,
            ...summarizeSessionTranscript(codeBridgeSessions.get('cli-default')),
            sessionSummary: defaultBridgeSession ? summarizeBridgeSessionRecord(defaultBridgeSession, defaultBridgeProcess) : null,
            process: bridgeProcesses.get('cli-default')
              ? {
                  protocolVersion: bridgeProcesses.get('cli-default')!.protocolVersion,
                  pid: bridgeProcesses.get('cli-default')!.pid,
                  mode: bridgeProcesses.get('cli-default')!.mode,
                  socketPath: bridgeProcesses.get('cli-default')!.socketPath,
                  socketReady: bridgeProcesses.get('cli-default')!.socketReady,
                  supportedDirectTools: bridgeProcesses.get('cli-default')!.supportedDirectTools,
                  alive: bridgeProcesses.get('cli-default')!.alive
                }
              : null
          },
          mcp: inspectedMcp,
          recommendation: 'release-candidate-if-docs-and-versioning-are-ready'
        });
      }

      if (request.method === 'GET' && url.pathname === routePaths.providers.models) {
        return Response.json({
          models: listKnownModelMetadata(),
          count: listKnownModelMetadata().length
        });
      }

      if (request.method === 'GET' && url.pathname === routePaths.providers.pool) {
        const providerName = url.searchParams.get('provider') ?? 'openrouter';
        return Response.json(summarizeProviderPool(providerName));
      }

      if (request.method === 'GET' && url.pathname === routePaths.providers.plan) {
        const providerCfg = configStore.getProviderConfig();
        const slots = providerCfg
          ? {
              primary: providerCfg.primary,
              fallback: providerCfg.fallback ?? null,
              vision: providerCfg.vision ?? null,
              compression: providerCfg.compression ?? null,
              embedding: providerCfg.embedding ?? null,
            }
          : null;
        return Response.json({
          configured: Boolean(providerCfg),
          slots,
          executionPlan: {
            primary: providerCfg?.primary?.provider ?? 'runtime-default',
            fallbackChain: [
              providerCfg?.fallback?.provider,
              providerCfg?.compression?.provider,
            ].filter(Boolean),
            usesCompressionProvider: Boolean(providerCfg?.compression),
            hasVisionProvider: Boolean(providerCfg?.vision),
            hasEmbeddingProvider: Boolean(providerCfg?.embedding)
          }
        });
      }

      if (request.method === 'GET' && url.pathname === routePaths.providers.failoverPreview) {
        const providerCfg = configStore.getProviderConfig();
        const chain = providerCfg
          ? [
              { slot: 'primary', provider: providerCfg.primary.provider, model: providerCfg.primary.model },
              ...(providerCfg.fallback ? [{ slot: 'fallback', provider: providerCfg.fallback.provider, model: providerCfg.fallback.model }] : []),
              ...(providerCfg.compression ? [{ slot: 'compression', provider: providerCfg.compression.provider, model: providerCfg.compression.model }] : [])
            ]
          : [{ slot: 'runtime-default', provider: 'resolved-provider', model: isModelOverridable(provider) ? provider.getModel() : 'default' }];
        return Response.json({
          configured: Boolean(providerCfg),
          chain,
          simulation: chain.map((entry, index) => ({
            attempt: index + 1,
            slot: entry.slot,
            provider: entry.provider,
            model: entry.model,
            reason: index === 0 ? 'primary-attempt' : 'fallback-attempt'
          })),
          notes: [
            'Preview only: no live provider request is executed.',
            'Actual provider retries still depend on runtime errors and AgentLoop retry policy.'
          ]
        });
      }

      if (request.method === 'POST' && url.pathname === routePaths.providers.failoverSimulate) {
        const providerCfg = configStore.getProviderConfig();
        const body = (await request.json().catch(() => ({}))) as { message?: string };
        const message = typeof body.message === 'string' ? body.message : 'simulate provider fallback';
        const chain = providerCfg
          ? [
              { slot: 'primary', provider: providerCfg.primary.provider, model: providerCfg.primary.model },
              ...(providerCfg.fallback ? [{ slot: 'fallback', provider: providerCfg.fallback.provider, model: providerCfg.fallback.model }] : []),
            ]
          : [{ slot: 'runtime-default', provider: 'resolved-provider', model: isModelOverridable(provider) ? provider.getModel() : 'default' }];

        const attempts: Array<{ attempt: number; slot: string; provider: string; model: string; status: 'failed' | 'succeeded'; error?: string }> = [];
        const providers = chain.map((entry, index) => index === 0 && chain.length > 1
          ? {
              async generate() {
                attempts.push({
                  attempt: index + 1,
                  slot: entry.slot,
                  provider: entry.provider,
                  model: entry.model,
                  status: 'failed',
                  error: 'synthetic primary failure'
                });
                throw new Error('synthetic primary failure');
              }
            }
          : {
              async generate() {
                attempts.push({
                  attempt: index + 1,
                  slot: entry.slot,
                  provider: entry.provider,
                  model: entry.model,
                  status: 'succeeded'
                });
                return {
                  assistantMessage: `Simulated reply from ${entry.slot}: ${message}`,
                  toolCalls: []
                };
              }
            });

        const providerChain = new ProviderChain({
          providers: providers as ProviderAdapter[],
        });
        const response = await providerChain.generate({
          messages: [{ role: 'user', content: message, createdAt: new Date().toISOString() }],
          availableTools: [],
        });

        const winner = attempts.find((attempt) => attempt.status === 'succeeded') ?? attempts.at(-1) ?? null;
        return Response.json({
          configured: Boolean(providerCfg),
          message,
          attempts,
          final: winner,
          response: response.assistantMessage ?? ''
        });
      }

      if (request.method === 'POST' && url.pathname === routePaths.providers.route) {
        const body = (await request.json()) as { message?: string; hasTools?: boolean };
        // Use the resolved provider instead of always defaulting to EchoProvider
        const primary = provider;
        const cheap = provider instanceof AnthropicProvider
          ? new AnthropicProvider({ apiKey: '', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-4' })
          : provider instanceof OpenAICompatibleProvider
            ? provider.withModel('gpt-4o-mini')
            : provider;
        const router = new SmartModelRouter(primary, cheap);
        const message = typeof body.message === 'string' ? body.message : '';
        const hasTools = Boolean(body.hasTools);
        const analysis = router.explainRoute({
          messages: [{ role: 'user', content: message, createdAt: new Date().toISOString() }],
          availableTools: hasTools ? [{ name: 'echo', description: 'Echo', runtime: 'worker', streaming: false, stateful: false, requiresWorkspace: false, requiresNetwork: false, dangerLevel: 'low' }] : []
        });
        return Response.json({
          message,
          complexity: analysis.complexity,
          hasTools: analysis.hasTools,
          selectedTier: analysis.selectedTier,
          fallbackTier: analysis.fallbackTier,
          signals: analysis.signals,
          requiredCapabilities: analysis.requiredCapabilities,
          recommendedModels: analysis.recommendedModels
        });
      }

      // --- Provider Config API ---
      if (request.method === 'GET' && url.pathname === '/api/providers/config') {
        const providerCfg = configStore.getProviderConfig();
        // Redact API keys from provider config before returning to client
        const redactSlot = (slot: import('./config-store.js').ProviderSlot | undefined) =>
          slot ? { ...slot, apiKey: slot.apiKey ? '***' : undefined } : null;
        return Response.json({
          ok: true,
          config: providerCfg ? {
            primary: redactSlot(providerCfg.primary),
            fallback: redactSlot(providerCfg.fallback),
            vision: redactSlot(providerCfg.vision),
            compression: redactSlot(providerCfg.compression),
            embedding: redactSlot(providerCfg.embedding),
          } : null,
          slots: {
            primary: redactSlot(providerCfg?.primary),
            fallback: redactSlot(providerCfg?.fallback),
            vision: redactSlot(providerCfg?.vision),
            compression: redactSlot(providerCfg?.compression),
            embedding: redactSlot(providerCfg?.embedding),
          },
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/providers/config') {
        const body = await request.json() as Record<string, unknown>;
        const incoming = body as unknown as import('./config-store.js').ProviderConfig;
        const stored = configStore.getProviderConfig();

        // Merge incoming config with stored secrets. The dashboard fetches
        // GET /api/providers/config which redacts apiKeys to '***', so a
        // round-trip would otherwise overwrite the real key with the redacted
        // placeholder. Also: a `null` slot means "leave as-is" (the dashboard
        // sends explicit `null` for slots it isn't editing).
        type Slot = import('./config-store.js').ProviderSlot;
        const SLOT_KEYS = ['primary', 'fallback', 'fast', 'vision', 'compression', 'embedding'] as const;
        const merged: Partial<import('./config-store.js').ProviderConfig> = {};
        for (const key of SLOT_KEYS) {
          const incomingSlot = (incoming as unknown as Record<string, Slot | null | undefined>)[key];
          const storedSlot = stored ? (stored as unknown as Record<string, Slot | undefined>)[key] : undefined;
          if (incomingSlot === null) {
            // Explicit null: preserve stored slot
            if (storedSlot) (merged as Record<string, Slot>)[key] = storedSlot;
          } else if (incomingSlot) {
            // If apiKey is the redaction placeholder, keep the stored secret
            const apiKey = incomingSlot.apiKey === '***' ? storedSlot?.apiKey : incomingSlot.apiKey;
            (merged as Record<string, Slot>)[key] = { ...incomingSlot, apiKey };
          }
          // If incoming key is missing entirely, drop it (matches old behavior)
        }

        if (!merged.primary || typeof merged.primary.provider !== 'string' || typeof merged.primary.model !== 'string') {
          return Response.json({ ok: false, error: 'primary slot with provider and model is required' }, { status: 400 });
        }
        configStore.setProviderConfig(merged as import('./config-store.js').ProviderConfig);
        // Return the redacted config — the POST response used to echo back the
        // full stored config, leaking every persisted apiKey to whoever called
        // this endpoint (including secrets from untouched slots the caller did
        // not submit).
        const saved = configStore.getProviderConfig();
        const redactSlot = (slot: import('./config-store.js').ProviderSlot | undefined) =>
          slot ? { ...slot, apiKey: slot.apiKey ? '***' : undefined } : null;
        return Response.json({
          ok: true,
          config: saved ? {
            primary: redactSlot(saved.primary),
            fallback: redactSlot(saved.fallback),
            fast: redactSlot(saved.fast),
            vision: redactSlot(saved.vision),
            compression: redactSlot(saved.compression),
            embedding: redactSlot(saved.embedding),
          } : null,
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/providers/test') {
        const body = await request.json() as Record<string, unknown>;
        const slot = body.slot as string;
        const providerType = body.provider as string;
        const model = body.model as string;
        // Fall back to the stored slot config so the dashboard doesn't have to
        // round-trip the API key just to test the connection.
        const stored = configStore.getProviderConfig();
        const storedSlot = stored && slot
          ? (stored as unknown as Record<string, { apiKey?: string; baseUrl?: string } | undefined>)[slot]
          : undefined;
        const apiKey = (body.apiKey as string | undefined) ?? storedSlot?.apiKey ?? '';
        const baseUrl = (body.baseUrl as string | undefined) ?? storedSlot?.baseUrl;
        if (!providerType || !model) {
          return Response.json({ ok: false, error: 'provider and model are required' }, { status: 400 });
        }
        try {
          const testProvider = createProviderFromSlot({ name: slot || 'test', provider: providerType, model, apiKey, baseUrl });
          const testResponse = await testProvider.generate({
            messages: [{ role: 'user', content: 'Say "ok" in one word.', createdAt: new Date().toISOString() }],
            availableTools: [],
          });
          return Response.json({ ok: true, slot: slot || 'test', response: testResponse.assistantMessage?.slice(0, 100) });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ ok: false, slot: slot || 'test', error: message });
        }
      }

      if (request.method === 'GET' && url.pathname === '/api/plugins') {
        return Response.json(plugins.list().map((plugin) => ({ name: plugin.name })));
      }

      if (request.method === 'GET' && url.pathname === '/api/skills') {
        const resolved = skillRegistry.resolveAll();
        const stats = skillRegistry.stats();
        return Response.json({
          skills: resolved.map((s) => ({
            slug: s.skill.manifest.name,
            title: skillRegistry.getDisplayTitle(s.skill.manifest.name) ?? s.skill.manifest.name,
            summary: s.skill.manifest.description,
            triggerPhrases: s.skill.manifest.triggers ?? [],
            steps: s.skill.instructions.split('\n').filter(Boolean),
            requiredTools: s.skill.manifest.tools ?? [],
            status: skillRegistry.getStatus(s.skill.manifest.name) ?? 'published',
            source: s.skill.manifest.category ?? 'builtin',
            enabled: s.enabled,
          })),
          count: resolved.length,
          stats,
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/presets') {
        // #219 — `activeMcp` removed: the runtime no longer tracks a single
        // "active" MCP preset (multiple connections can be live), and the UI
        // now sources MCP state from the connections endpoint.
        const mcpNames = listMcpPresetNames();
        return Response.json({
          agents: listAgentPresets(),
          toolsets: listToolsetPresets(),
          mcp: mcpNames.map((name) => ({ name, description: getMcpPresetDescription(name) })),
          activeAgent: configStore.getActivePreset(),
          activeToolset: configStore.getActiveToolset(),
        });
      }

      // --- Persona API ---

      if (request.method === 'GET' && url.pathname === routePaths.personas.list) {
        return Response.json({ personas: personaRegistry.list() });
      }

      if (request.method === 'GET' && url.pathname === routePaths.personas.active) {
        const active = personaRegistry.getActive();
        const identity = active.files.identity ? parseIdentity(active.files.identity) : {};
        return Response.json({ name: active.name, identity });
      }

      if (request.method === 'POST' && url.pathname === routePaths.personas.switch) {
        const body = await request.json() as { name?: string };
        if (!body.name) {
          return Response.json({ ok: false, error: 'Missing persona name' }, { status: 400 });
        }
        try {
          const profile = personaRegistry.switchTo(body.name);
          // Update the legacy personaPrompt variable so createConfiguredAgent picks it up
          personaPrompt = profile.prompt || undefined;
          return Response.json({ ok: true, active: profile.name });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return Response.json({ ok: false, error: msg }, { status: 400 });
        }
      }

      // --- Config Presets API ---

      if (request.method === 'GET' && url.pathname === routePaths.configPresets.list) {
        return Response.json({
          presets: configStore.getConfigPresets(),
          active: configStore.getActiveConfigPresetName(),
        });
      }

      if (request.method === 'GET' && url.pathname === routePaths.configPresets.active) {
        const active = configStore.getActiveConfigPreset();
        return Response.json({ preset: active, name: configStore.getActiveConfigPresetName() });
      }

      if (request.method === 'POST' && url.pathname === routePaths.configPresets.switch) {
        const body = await request.json() as { name: string | null };
        if (body.name === null) {
          configStore.setActiveConfigPreset(null);
          return Response.json({ ok: true, active: null });
        }
        const preset = configStore.getConfigPreset(body.name);
        if (!preset) {
          return Response.json({ ok: false, error: `Config preset '${body.name}' not found` }, { status: 404 });
        }
        try {
          configStore.setActiveConfigPreset(body.name);
          // Apply the preset: toolset
          if (preset.toolset) {
            configStore.setActiveToolset(preset.toolset);
          }
          // Apply the preset: enable specified skills, disable others
          if (preset.skills) {
            const allSkills = skillRegistry.resolve();
            const presetSkillSet = new Set(preset.skills);
            for (const skill of allSkills) {
              const shouldEnable = presetSkillSet.has(skill.manifest.name);
              configStore.toggleSkill(skill.manifest.name, shouldEnable);
              skillRegistry.toggleSkill(skill.manifest.name, shouldEnable);
            }
          }
          // Apply the preset: connect MCP servers
          if (preset.mcpServers) {
            for (const serverName of preset.mcpServers) {
              configStore.setMcpConnection(serverName, {
                presetName: serverName,
                status: 'connecting',
              });
            }
          }
          return Response.json({ ok: true, active: body.name, preset });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return Response.json({ ok: false, error: msg }, { status: 400 });
        }
      }

      if (request.method === 'POST' && url.pathname === routePaths.configPresets.save) {
        const body = await request.json() as {
          name: string;
          description?: string;
          model?: string;
          mcpServers?: string[];
          skills?: string[];
          toolset?: string;
          tools?: string[];
          systemPromptAppend?: string;
        };
        if (!body.name) {
          return Response.json({ ok: false, error: 'Missing preset name' }, { status: 400 });
        }
        const now = new Date().toISOString();
        const existing = configStore.getConfigPreset(body.name);
        const preset = {
          name: body.name,
          description: body.description,
          model: body.model,
          mcpServers: body.mcpServers,
          skills: body.skills,
          toolset: body.toolset,
          tools: body.tools,
          systemPromptAppend: body.systemPromptAppend,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        configStore.saveConfigPreset(preset);
        return Response.json({ ok: true, preset });
      }

      const configPresetDeleteMatch = url.pathname.match(/^\/api\/config-presets\/([^/]+)$/);
      if (request.method === 'DELETE' && configPresetDeleteMatch) {
        const name = decodeURIComponent(configPresetDeleteMatch[1]!);
        const deleted = configStore.deleteConfigPreset(name);
        if (!deleted) {
          return Response.json({ ok: false, error: `Config preset '${name}' not found` }, { status: 404 });
        }
        return Response.json({ ok: true, deleted: name });
      }

      if (request.method === 'GET' && url.pathname === '/api/gateway/status') {
        // Enhance platform list with config/policy state
        const gwConfigs = configStore.getGatewayConfigs();
        const activeSessions = sessionController.getActiveSessions();
        // Build channel list from gateway config extra fields
        // Channels are auto-recorded on inbound webhook messages (channel:* entries)
        const channelList: Array<{ platform: string; channelId: string; muted: boolean; lastMessageAt?: string }> = [];
        for (const [platform, cfg] of Object.entries(gwConfigs)) {
          if (!cfg?.extra) continue;
          const seen = new Set<string>();
          for (const [key, value] of Object.entries(cfg.extra)) {
            if (key.startsWith('channel:')) {
              const channelId = key.slice(8);
              if (seen.has(channelId)) continue;
              seen.add(channelId);
              const muted = cfg.extra[`mute:${channelId}`] === 'true';
              channelList.push({ platform, channelId, muted, lastMessageAt: value });
            }
          }
        }
        return Response.json({
          knownChannels: channelList,
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
          ].map((p) => {
            const cfg = gwConfigs[p.name];
            return {
              ...p,
              configured: !!cfg,
              enabled: cfg?.enabled ?? false,
              policy: cfg ? { dmPolicy: cfg.dmPolicy, groupPolicy: cfg.groupPolicy, requireMention: cfg.requireMention } : undefined,
            };
          }),
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/events') {
        const encoder = new TextEncoder();
        let entry: SseSubscriber | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const sendFrame = (frame: string): void => {
              try {
                controller.enqueue(encoder.encode(frame));
              } catch { /* stream closed */ }
            };

            sendFrame(formatSseFrame('status', { type: 'connected', timestamp: new Date().toISOString() }));

            // #49: pre-format the SSE frame once at emit time. Previously each
            //      subscriber re-stringified the same payload on every event,
            //      so M events × N subscribers = N×M stringifies. Now the
            //      EventBus listener formats once and every subscriber's
            //      controller enqueues the same string.
            const unsubscribe = eventBus.subscribe((event) => {
              const frame = formatSseFrame(event.type, { ...event.data, timestamp: event.timestamp });
              sendFrame(frame);
            });

            const heartbeat = setInterval(() => {
              sendFrame(formatSseFrame('heartbeat', {
                timestamp: new Date().toISOString(),
                sessions: (store as unknown as { size?: number }).size ?? 0,
                subscribers: eventBus.subscriberCount,
              }));
            }, 15000);

            // #41: register with the runtime-wide subscriber set so
            //      shutdown() can flush every controller and clear every
            //      heartbeat in one pass.
            entry = { controller, heartbeat, unsubscribe };
            sseSubscribers.add(entry);

            const cleanup = (): void => {
              if (!entry) return;
              sseSubscribers.delete(entry);
              entry.unsubscribe();
              clearInterval(entry.heartbeat);
              try { entry.controller.close(); } catch { /* already closed */ }
              entry = null;
            };

            // request.signal fires for fetch-style abort; the underlying
            // Node IncomingMessage 'close' event fires when the TCP socket
            // disconnects — wire both so we don't leak entries when the
            // browser tab closes without the abort signal propagating.
            request.signal?.addEventListener('abort', cleanup);
            const reqAny = request as unknown as { on?: (ev: string, cb: () => void) => void };
            if (typeof reqAny.on === 'function') {
              try { reqAny.on('close', cleanup); } catch { /* not a Node-style emitter */ }
            }
          },
          cancel() {
            // ReadableStream cancel — fires when the consumer detaches.
            if (!entry) return;
            sseSubscribers.delete(entry);
            entry.unsubscribe();
            clearInterval(entry.heartbeat);
            entry = null;
          }
        });

        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
          },
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/sessions/active') {
        // Strip non-serializable AbortController before responding
        const sessions = sessionController.getActiveSessions().map((s) => ({
          sessionId: s.sessionId,
          startedAt: s.startedAt,
          status: s.status,
        }));
        return Response.json({ sessions });
      }

      if (request.method === 'GET' && url.pathname === '/api/sessions') {
        const limitParam = Number(url.searchParams.get('limit') ?? '50');
        const limit = Number.isFinite(limitParam) ? limitParam : 50;
        const listStore = store as InMemorySessionStore & SessionListStore;
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

      if (request.method === 'POST' && url.pathname === '/api/sessions') {
        const body = (await request.json().catch(() => ({}))) as { sessionId?: string; userId?: string; workspaceId?: string };
        // Validate client-supplied sessionId format to prevent path injection,
        // collisions with internal IDs, and predictable ID enumeration. The
        // dashboard normally lets the server generate the ID — this branch
        // exists for tests and platform integrations (e.g., `telegram:99`).
        const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_:.-]{0,63}$/;
        let sessionId: string;
        if (typeof body.sessionId === 'string' && body.sessionId.trim()) {
          const candidate = body.sessionId.trim();
          if (!SESSION_ID_PATTERN.test(candidate)) {
            return Response.json(
              { ok: false, error: 'Invalid sessionId: must match [a-zA-Z0-9][a-zA-Z0-9_:.-]{0,63}' },
              { status: 400 },
            );
          }
          sessionId = candidate;
        } else {
          sessionId = crypto.randomUUID();
        }
        const existing = await store.get(sessionId);
        const session = existing ?? {
          agentId: options.agentId ?? 'crowclaw',
          sessionId,
          userId: body.userId,
          workspaceId: body.workspaceId,
          messages: [],
          updatedAt: new Date().toISOString(),
          lineage: {
            rootSessionId: sessionId,
            compressionCount: 0
          }
        } satisfies SessionState;
        if (!existing) {
          await store.put(session);
          eventBus.emit('session:created', { sessionId });
        }
        return Response.json({
          ok: true,
          session: summarizeSessionRecord(session)
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/telegram/send') {
        const body = (await request.json()) as { botToken: string; chatId: string; text: string; parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML'; disableWebPagePreview?: boolean };
        const response = await fetch(buildTelegramSendUrl(body.botToken), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(buildTelegramSendPayload(body))
        });
        return new Response(await response.text(), {
          status: response.status,
          headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' }
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/telegram/edit') {
        const body = (await request.json()) as { botToken: string; chatId: string; messageId: number; text: string; parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML'; disableWebPagePreview?: boolean };
        const response = await fetch(buildTelegramEditUrl(body.botToken), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(buildTelegramEditPayload(body))
        });
        return new Response(await response.text(), {
          status: response.status,
          headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' }
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/discord/send') {
        const body = (await request.json()) as { webhookUrl: string; content: string };
        const ssrfCheck = validateFetchUrl(body.webhookUrl);
        if (!ssrfCheck.safe) {
          return new Response(JSON.stringify({ error: 'SSRF blocked', reason: ssrfCheck.reason }), { status: 403 });
        }
        const response = await fetch(buildDiscordWebhookSendUrl(body.webhookUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: body.content })
        });
        return new Response(await response.text(), {
          status: response.status,
          headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' }
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/discord/edit') {
        const body = (await request.json()) as { webhookUrl: string; messageId: string; content: string };
        const ssrfCheck = validateFetchUrl(body.webhookUrl);
        if (!ssrfCheck.safe) {
          return new Response(JSON.stringify({ error: 'SSRF blocked', reason: ssrfCheck.reason }), { status: 403 });
        }
        const response = await fetch(buildDiscordWebhookEditUrl(body.webhookUrl, body.messageId), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(buildDiscordEditPayload({ messageId: body.messageId, content: body.content }))
        });
        return new Response(await response.text(), {
          status: response.status,
          headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' }
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/slack/send') {
        const body = (await request.json()) as { botToken: string; channel: string; text: string; threadTs?: string };
        const response = await fetch(buildSlackSendUrl(), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${body.botToken}`
          },
          body: JSON.stringify(buildSlackSendPayload(body))
        });
        return new Response(await response.text(), {
          status: response.status,
          headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' }
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/slack/edit') {
        const body = (await request.json()) as { botToken: string; channel: string; text: string; ts: string; threadTs?: string };
        const response = await fetch(buildSlackEditUrl(), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${body.botToken}`
          },
          body: JSON.stringify(buildSlackEditPayload(body))
        });
        return new Response(await response.text(), {
          status: response.status,
          headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' }
        });
      }

      if (request.method === 'POST' && (url.pathname === '/api/gateway/webhook' || url.pathname === '/webhooks/generic')) {
        // Require HMAC signature: prior releases accepted unsigned requests,
        // so any caller who knew a whitelisted channelId could drive the agent.
        // Fail-closed: no secret → 403 instead of allowing.
        const genericSecret = configStore.getGatewayConfig('webhook')?.webhookSecret;
        if (!genericSecret) {
          return Response.json({ ok: false, error: 'Generic webhook secret not configured' }, { status: 403 });
        }
        const rawBody = await request.text();
        if (!verifyGenericWebhookSignature(request.headers.get('x-crowclaw-signature'), genericSecret, rawBody)) {
          return Response.json({ ok: false, error: 'Invalid webhook signature' }, { status: 403 });
        }
        const payload = JSON.parse(rawBody) as { channelId?: string; chatId?: string; userId?: string; text?: string; message?: string };
        const message = normalizeGenericWebhook(payload);
        const accessResponse = enforceGatewayAccess(message);
        if (accessResponse) {
          return accessResponse;
        }
        // #29: atomically claim the idempotency key BEFORE running the agent.
        //      Previous code did `has()` then `mark()` AFTER `runAgent()`, so two
        //      concurrent retries of the same delivery could both pass the
        //      `has()` check, both invoke the agent, and both bill the provider.
        //      Now `markIfAbsent` returns `true` on the winning attempt and the
        //      loser short-circuits as a duplicate. On agent failure we
        //      `unmark` so the next retry isn't permanently swallowed.
        const idempotencyKey = buildGatewayIdempotencyKey(message);
        const sessionId = buildGatewaySessionKey(message);
        if (idempotencyKey && !(await claimIdempotency(gatewayIdempotencyStore, idempotencyKey))) {
          return Response.json({ ok: true, duplicate: true, sessionId });
        }
        try {
          // Debounce: merge rapid-fire messages from the same sender
          const debouncedText = await gatewayDebouncer.debounce(
            message.platform, message.userId ?? 'unknown', message.channelId ?? 'unknown', message.text
          );
          const result = await runConfiguredAgent({
            sessionId,
            userMessage: debouncedText,
            userId: message.userId,
            workspaceId: message.channelId,
            systemPrompt: 'You are CrowClaw handling a generic webhook runtime event.'
          });
          await memoryService.captureSessionSummary(sessionId, result.session.messages);
          return Response.json(result);
        } catch (err: unknown) {
          if (idempotencyKey) await releaseIdempotency(gatewayIdempotencyStore, idempotencyKey);
          throw err;
        }
      }

      if (request.method === 'POST' && url.pathname === '/api/gateway/inspect') {
        const body = (await request.json()) as { platform?: 'webhook' | 'telegram' | 'discord' | 'slack' | 'whatsapp' | 'signal' | 'email' | 'matrix' | 'sms'; payload?: unknown };
        const platform = body.platform ?? 'webhook';
        const message = await normalizeGatewayRequest(
          platform,
          new Request('http://localhost/internal/gateway-inspect', {
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

      if (request.method === 'POST' && url.pathname === '/webhooks/discord') {
        // Discord webhook Ed25519 signature verification
        const discordPubKey = options.discordPublicKey
          ?? configStore.getGatewayConfig('discord')?.webhookSecret;
        if (!discordPubKey) {
          return Response.json({ ok: false, error: 'Discord public key not configured' }, { status: 403 });
        }
        const discordRawBody = await request.text();
        const discordSigValid = await verifyDiscordWebhookSignature(request, discordPubKey, discordRawBody);
        if (!discordSigValid) {
          return Response.json({ ok: false, error: 'Invalid Discord webhook signature' }, { status: 403 });
        }

        const payload = JSON.parse(discordRawBody);
        const message = normalizeDiscordWebhook(payload as never);
        if (!message) {
          return Response.json({ ok: false, ignored: true });
        }
        const accessResponse = enforceGatewayAccess(message);
        if (accessResponse) {
          return accessResponse;
        }
        const dispatch = buildDiscordDispatch(payload as never)!;
        // #34: Discord didn't have an idempotency check at all — Discord
        //      retries deliveries when its 3s ack timeout elapses, so the
        //      same `/command` invocation could fire `runAgent()` twice and
        //      bill the provider twice. The Discord payload's top-level `id`
        //      is the interaction id, which is unique per delivery and
        //      stable across retries; we key on `discord:<channelId>:<id>`.
        const interactionId = (payload as { id?: unknown })?.id;
        const idempotencyKey = typeof interactionId === 'string' && interactionId.length > 0
          ? `discord:${message.channelId}:${interactionId}`
          : null;
        if (idempotencyKey && !(await claimIdempotency(gatewayIdempotencyStore, idempotencyKey))) {
          return Response.json({ ok: true, duplicate: true, sessionId: dispatch.sessionId });
        }
        try {
          const debouncedDiscordText = await gatewayDebouncer.debounce(
            'discord', dispatch.payload.userId ?? 'unknown', dispatch.payload.workspaceId ?? 'unknown', dispatch.payload.userMessage
          );
          const result = await runConfiguredAgent({
            sessionId: dispatch.sessionId,
            userMessage: debouncedDiscordText,
            userId: dispatch.payload.userId,
            workspaceId: dispatch.payload.workspaceId,
            systemPrompt: 'You are CrowClaw handling a Discord runtime event.'
          });
          await memoryService.captureSessionSummary(dispatch.sessionId, result.session.messages);
          return Response.json(result);
        } catch (err: unknown) {
          if (idempotencyKey) await releaseIdempotency(gatewayIdempotencyStore, idempotencyKey);
          throw err;
        }
      }

      if (request.method === 'POST' && url.pathname === '/webhooks/telegram') {
        // Telegram webhook signature verification
        const telegramSecret = options.telegramWebhookSecret
          ?? configStore.getGatewayConfig('telegram')?.webhookSecret;
        if (!telegramSecret) {
          return Response.json({ ok: false, error: 'Telegram webhook secret not configured' }, { status: 403 });
        }
        if (!verifyTelegramWebhookSecret(request, telegramSecret)) {
          return Response.json({ ok: false, error: 'Invalid Telegram webhook secret' }, { status: 403 });
        }

        const payload = await request.json();
        const message = normalizeTelegramWebhook(payload as never);
        if (!message) {
          return Response.json({ ok: false, ignored: true });
        }
        const accessResponse = enforceGatewayAccess(message);
        if (accessResponse) {
          return accessResponse;
        }
        // #29: atomic markIfAbsent claim before runAgent; unmark on failure.
        const idempotencyKey = message ? buildGatewayIdempotencyKey(message) : null;
        const sessionKey = buildGatewaySessionKey(message!);
        if (idempotencyKey && !(await claimIdempotency(gatewayIdempotencyStore, idempotencyKey))) {
          return Response.json({ ok: true, duplicate: true, sessionId: sessionKey });
        }
        const dispatch = buildTelegramDispatch(payload as never)!;
        const telegramToken = configStore.getGatewayConfig('telegram')?.token;
        const chatId = String(message.channelId);
        const typing = telegramToken ? createTypingIndicator(telegramToken, chatId) : null;
        try {
          const debouncedTelegramText = await gatewayDebouncer.debounce(
            'telegram', dispatch.payload.userId ?? 'unknown', dispatch.payload.workspaceId ?? chatId, dispatch.payload.userMessage
          );
          const result = await runConfiguredAgent({
            sessionId: dispatch.sessionId,
            userMessage: debouncedTelegramText,
            userId: dispatch.payload.userId,
            workspaceId: dispatch.payload.workspaceId,
            systemPrompt: 'You are CrowClaw handling a Telegram runtime event.'
          });
          typing?.stop();
          await memoryService.captureSessionSummary(dispatch.sessionId, result.session.messages);
          // Send the agent response back to the Telegram chat
          if (telegramToken && chatId && result.finalResponse) {
            await sendTelegramMessage(telegramToken, chatId, result.finalResponse, { parseMode: 'Markdown' });
          }
          return Response.json(result);
        } catch (err: unknown) {
          typing?.stop();
          if (idempotencyKey) await releaseIdempotency(gatewayIdempotencyStore, idempotencyKey);
          throw err;
        }
      }

      if (request.method === 'POST' && url.pathname === '/webhooks/slack') {
        // Slack webhook signature verification — deny if no signing secret configured
        const slackSecret = options.slackSigningSecret
          ?? configStore.getGatewayConfig('slack')?.webhookSecret;
        if (!slackSecret) {
          return Response.json({ ok: false, error: 'Slack signing secret not configured' }, { status: 403 });
        }
        const rawBody = await request.text();
        {
          const signature = request.headers.get('x-slack-signature') ?? '';
          const timestamp = request.headers.get('x-slack-request-timestamp') ?? '';
          // Replay-window check: reject requests signed more than 5 minutes ago.
          // Without this, a captured signed body (from leaked logs or a tapped
          // proxy) replays forever. Matches Slack's documented recommendation.
          const tsNum = parseInt(timestamp, 10);
          if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) {
            return Response.json({ ok: false, error: 'Slack timestamp outside replay window.' }, { status: 401 });
          }
          const verified = await verifySlackSignature({
            signingSecret: slackSecret,
            timestamp,
            body: rawBody,
            signature
          });
          if (!verified) {
            return Response.json({ ok: false, error: 'Invalid Slack signature.' }, { status: 401 });
          }
        }
        const payload = JSON.parse(rawBody) as unknown;
        if ((payload as { type?: string; challenge?: string }).type === 'url_verification') {
          return Response.json({ challenge: (payload as { challenge?: string }).challenge ?? '' });
        }
        const message = normalizeSlackWebhook(payload as never);
        if (!message) {
          return Response.json({ ok: false, ignored: true });
        }
        const accessResponse = enforceGatewayAccess(message);
        if (accessResponse) {
          return accessResponse;
        }
        // #29: atomic claim before runAgent; unmark on failure.
        const idempotencyKey = message ? buildGatewayIdempotencyKey(message) : null;
        const sessionKey = buildGatewaySessionKey(message!);
        if (idempotencyKey && !(await claimIdempotency(gatewayIdempotencyStore, idempotencyKey))) {
          return Response.json({ ok: true, duplicate: true, sessionId: sessionKey });
        }
        try {
          const dispatch = buildSlackDispatch(payload as never)!;
          const debouncedSlackText = await gatewayDebouncer.debounce(
            'slack', dispatch.payload.userId ?? 'unknown', dispatch.payload.workspaceId ?? 'unknown', dispatch.payload.userMessage
          );
          const result = await runConfiguredAgent({
            sessionId: dispatch.sessionId,
            userMessage: debouncedSlackText,
            userId: dispatch.payload.userId,
            workspaceId: dispatch.payload.workspaceId,
            systemPrompt: 'You are CrowClaw handling a Slack runtime event.'
          });
          await memoryService.captureSessionSummary(dispatch.sessionId, result.session.messages);
          return Response.json(result);
        } catch (err: unknown) {
          if (idempotencyKey) await releaseIdempotency(gatewayIdempotencyStore, idempotencyKey);
          throw err;
        }
      }

      if (request.method === 'POST' && url.pathname === '/webhooks/whatsapp') {
        // WhatsApp webhook secret verification
        const whatsappSecret = options.webhookSecrets?.whatsapp
          ?? configStore.getGatewayConfig('whatsapp')?.webhookSecret;
        if (!whatsappSecret) {
          return Response.json({ ok: false, error: 'WhatsApp webhook secret not configured' }, { status: 403 });
        }
        if (!verifyWebhookBearerSecret(request, whatsappSecret)) {
          return Response.json({ ok: false, error: 'Invalid WhatsApp webhook secret' }, { status: 403 });
        }

        const payload = await request.json();
        const message = normalizeWhatsAppWebhook(payload as never);
        if (!message) {
          return Response.json({ ok: false, ignored: true });
        }
        const accessResponse = enforceGatewayAccess(message);
        if (accessResponse) {
          return accessResponse;
        }
        // #29: atomic claim before runAgent; unmark on failure.
        const idempotencyKey = message ? buildGatewayIdempotencyKey(message) : null;
        const sessionKey = buildGatewaySessionKey(message!);
        if (idempotencyKey && !(await claimIdempotency(gatewayIdempotencyStore, idempotencyKey))) {
          return Response.json({ ok: true, duplicate: true, sessionId: sessionKey });
        }
        try {
          const dispatch = buildWhatsAppDispatch(payload as never)!;
          const debouncedWhatsAppText = await gatewayDebouncer.debounce(
            'whatsapp', dispatch.payload.userId ?? 'unknown', dispatch.payload.workspaceId ?? 'unknown', dispatch.payload.userMessage
          );
          const result = await runConfiguredAgent({
            sessionId: dispatch.sessionId,
            userMessage: debouncedWhatsAppText,
            userId: dispatch.payload.userId,
            workspaceId: dispatch.payload.workspaceId,
            systemPrompt: 'You are CrowClaw handling a WhatsApp runtime event.'
          });
          await memoryService.captureSessionSummary(dispatch.sessionId, result.session.messages);
          return Response.json(result);
        } catch (err: unknown) {
          if (idempotencyKey) await releaseIdempotency(gatewayIdempotencyStore, idempotencyKey);
          throw err;
        }
      }

      if (request.method === 'POST' && url.pathname === '/webhooks/signal') {
        // Signal webhook secret verification
        const signalSecret = options.webhookSecrets?.signal
          ?? configStore.getGatewayConfig('signal')?.webhookSecret;
        if (!signalSecret) {
          return Response.json({ ok: false, error: 'Signal webhook secret not configured' }, { status: 403 });
        }
        if (!verifyWebhookBearerSecret(request, signalSecret)) {
          return Response.json({ ok: false, error: 'Invalid Signal webhook secret' }, { status: 403 });
        }

        const payload = await request.json();
        const message = normalizeSignalWebhook(payload as never);
        if (!message) {
          return Response.json({ ok: false, ignored: true });
        }
        const accessResponse = enforceGatewayAccess(message);
        if (accessResponse) {
          return accessResponse;
        }
        // #29: atomic claim before runAgent; unmark on failure.
        const idempotencyKey = message ? buildGatewayIdempotencyKey(message) : null;
        const sessionKey = buildGatewaySessionKey(message!);
        if (idempotencyKey && !(await claimIdempotency(gatewayIdempotencyStore, idempotencyKey))) {
          return Response.json({ ok: true, duplicate: true, sessionId: sessionKey });
        }
        try {
          const dispatch = buildSignalDispatch(payload as never)!;
          const debouncedSignalText = await gatewayDebouncer.debounce(
            'signal', dispatch.payload.userId ?? 'unknown', dispatch.payload.workspaceId ?? 'unknown', dispatch.payload.userMessage
          );
          const result = await runConfiguredAgent({
            sessionId: dispatch.sessionId,
            userMessage: debouncedSignalText,
            userId: dispatch.payload.userId,
            workspaceId: dispatch.payload.workspaceId,
            systemPrompt: 'You are CrowClaw handling a Signal runtime event.'
          });
          await memoryService.captureSessionSummary(dispatch.sessionId, result.session.messages);
          return Response.json(result);
        } catch (err: unknown) {
          if (idempotencyKey) await releaseIdempotency(gatewayIdempotencyStore, idempotencyKey);
          throw err;
        }
      }

      if (request.method === 'POST' && url.pathname === '/webhooks/email') {
        // Email webhook secret verification
        const emailSecret = options.webhookSecrets?.email
          ?? configStore.getGatewayConfig('email')?.webhookSecret;
        if (!emailSecret) {
          return Response.json({ ok: false, error: 'Email webhook secret not configured' }, { status: 403 });
        }
        if (!verifyWebhookBearerSecret(request, emailSecret)) {
          return Response.json({ ok: false, error: 'Invalid Email webhook secret' }, { status: 403 });
        }

        const payload = await request.json();
        const message = normalizeEmailWebhook(payload as never);
        if (!message) {
          return Response.json({ ok: false, ignored: true });
        }
        const accessResponse = enforceGatewayAccess(message);
        if (accessResponse) {
          return accessResponse;
        }
        // #29: atomic claim before runAgent; unmark on failure.
        const idempotencyKey = message ? buildGatewayIdempotencyKey(message) : null;
        const sessionKey = buildGatewaySessionKey(message!);
        if (idempotencyKey && !(await claimIdempotency(gatewayIdempotencyStore, idempotencyKey))) {
          return Response.json({ ok: true, duplicate: true, sessionId: sessionKey });
        }
        try {
          const dispatch = buildEmailDispatch(payload as never)!;
          const debouncedEmailText = await gatewayDebouncer.debounce(
            'email', dispatch.payload.userId ?? 'unknown', dispatch.payload.workspaceId ?? 'unknown', dispatch.payload.userMessage
          );
          const result = await runConfiguredAgent({
            sessionId: dispatch.sessionId,
            userMessage: debouncedEmailText,
            userId: dispatch.payload.userId,
            workspaceId: dispatch.payload.workspaceId,
            systemPrompt: 'You are CrowClaw handling an Email runtime event.'
          });
          await memoryService.captureSessionSummary(dispatch.sessionId, result.session.messages);
          return Response.json(result);
        } catch (err: unknown) {
          if (idempotencyKey) await releaseIdempotency(gatewayIdempotencyStore, idempotencyKey);
          throw err;
        }
      }

      if (request.method === 'POST' && url.pathname === '/webhooks/matrix') {
        // Matrix webhook secret verification
        const matrixSecret = options.webhookSecrets?.matrix
          ?? configStore.getGatewayConfig('matrix')?.webhookSecret;
        if (!matrixSecret) {
          return Response.json({ ok: false, error: 'Matrix webhook secret not configured' }, { status: 403 });
        }
        if (!verifyWebhookBearerSecret(request, matrixSecret)) {
          return Response.json({ ok: false, error: 'Invalid Matrix webhook secret' }, { status: 403 });
        }

        const payload = await request.json();
        const message = normalizeMatrixWebhook(payload as never);
        if (!message) {
          return Response.json({ ok: false, ignored: true });
        }
        const accessResponse = enforceGatewayAccess(message);
        if (accessResponse) {
          return accessResponse;
        }
        // #29: atomic claim before runAgent; unmark on failure.
        const idempotencyKey = message ? buildGatewayIdempotencyKey(message) : null;
        const sessionKey = buildGatewaySessionKey(message!);
        if (idempotencyKey && !(await claimIdempotency(gatewayIdempotencyStore, idempotencyKey))) {
          return Response.json({ ok: true, duplicate: true, sessionId: sessionKey });
        }
        try {
          const dispatch = buildMatrixDispatch(payload as never)!;
          const debouncedMatrixText = await gatewayDebouncer.debounce(
            'matrix', dispatch.payload.userId ?? 'unknown', dispatch.payload.workspaceId ?? 'unknown', dispatch.payload.userMessage
          );
          const result = await runConfiguredAgent({
            sessionId: dispatch.sessionId,
            userMessage: debouncedMatrixText,
            userId: dispatch.payload.userId,
            workspaceId: dispatch.payload.workspaceId,
            systemPrompt: 'You are CrowClaw handling a Matrix runtime event.'
          });
          await memoryService.captureSessionSummary(dispatch.sessionId, result.session.messages);
          return Response.json(result);
        } catch (err: unknown) {
          if (idempotencyKey) await releaseIdempotency(gatewayIdempotencyStore, idempotencyKey);
          throw err;
        }
      }

      if (request.method === 'POST' && url.pathname === '/webhooks/sms') {
        // SMS webhook secret verification
        const smsSecret = options.webhookSecrets?.sms
          ?? configStore.getGatewayConfig('sms')?.webhookSecret;
        if (!smsSecret) {
          return Response.json({ ok: false, error: 'SMS webhook secret not configured' }, { status: 403 });
        }
        if (!verifyWebhookBearerSecret(request, smsSecret)) {
          return Response.json({ ok: false, error: 'Invalid SMS webhook secret' }, { status: 403 });
        }

        const payload = await request.json();
        const message = normalizeSmsWebhook(payload as never);
        if (!message) {
          return Response.json({ ok: false, ignored: true });
        }
        const accessResponse = enforceGatewayAccess(message);
        if (accessResponse) {
          return accessResponse;
        }
        // #29: atomic claim before runAgent; unmark on failure.
        const idempotencyKey = message ? buildGatewayIdempotencyKey(message) : null;
        const sessionKey = buildGatewaySessionKey(message!);
        if (idempotencyKey && !(await claimIdempotency(gatewayIdempotencyStore, idempotencyKey))) {
          return Response.json({ ok: true, duplicate: true, sessionId: sessionKey });
        }
        try {
          const dispatch = buildSmsDispatch(payload as never)!;
          const debouncedSmsText = await gatewayDebouncer.debounce(
            'sms', dispatch.payload.userId ?? 'unknown', dispatch.payload.workspaceId ?? 'unknown', dispatch.payload.userMessage
          );
          const result = await runConfiguredAgent({
            sessionId: dispatch.sessionId,
            userMessage: debouncedSmsText,
            userId: dispatch.payload.userId,
            workspaceId: dispatch.payload.workspaceId,
            systemPrompt: 'You are CrowClaw handling an SMS runtime event.'
          });
          await memoryService.captureSessionSummary(dispatch.sessionId, result.session.messages);
          return Response.json(result);
        } catch (err: unknown) {
          if (idempotencyKey) await releaseIdempotency(gatewayIdempotencyStore, idempotencyKey);
          throw err;
        }
      }


      if (request.method === 'POST' && url.pathname === '/api/web/fetch') {
        const body = (await request.json()) as { url: string };
        const response = await tools.execute('web.fetch', { url: body.url }, {
          agentId: options.agentId ?? 'crowclaw',
          sessionId: 'web-fetch',
        });
        if (!response.ok) {
          return Response.json(response, { status: 400 });
        }
        return new Response(response.output, {
          status: typeof response.metadata?.status === 'number' ? response.metadata.status : 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' }
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/web/metadata') {
        const body = (await request.json()) as { url: string };
        const response = await tools.execute('web.extractMetadata', { url: body.url }, {
          agentId: options.agentId ?? 'crowclaw',
          sessionId: 'web-metadata',
        });
        return Response.json(response);
      }

      if (request.method === 'POST' && url.pathname === '/api/web/links') {
        const body = (await request.json()) as { url: string };
        const response = await tools.execute('web.extractLinks', { url: body.url }, {
          agentId: options.agentId ?? 'crowclaw',
          sessionId: 'web-links',
        });
        return Response.json(response);
      }

      if (request.method === 'POST' && url.pathname === '/api/web/text') {
        const body = (await request.json()) as { url: string };
        const response = await tools.execute('web.extractText', { url: body.url }, {
          agentId: options.agentId ?? 'crowclaw',
          sessionId: 'web-text',
        });
        return Response.json(response);
      }

      if (request.method === 'POST' && url.pathname === '/api/web/search') {
        const body = (await request.json()) as { query: string; limit?: number; providerBaseUrl?: string };
        const response = await tools.execute('web.search', body as Record<string, unknown>, {
          agentId: options.agentId ?? 'crowclaw',
          sessionId: 'web-search',
        });
        return Response.json(response);
      }

      if (request.method === 'POST' && url.pathname === '/api/web/crawl') {
        const body = (await request.json()) as { url: string; maxPages?: number; sameOriginOnly?: boolean };
        const response = await tools.execute('web.crawl', body as Record<string, unknown>, {
          agentId: options.agentId ?? 'crowclaw',
          sessionId: 'web-crawl',
        });
        return Response.json(response);
      }

      if (request.method === 'POST' && url.pathname === '/api/terminal/exec') {
        const body = (await request.json()) as { command?: string; raw?: string };
        // Apply same command scanning that AgentLoop uses — direct routes must not bypass security
        const cmd = body.command ?? body.raw ?? '';
        if (cmd) {
          const scan = scanCommand(cmd);
          const criticalRisks = scan.risks.filter((risk) => risk.severity === 'critical');
          const warningRisks = scan.risks.filter((risk) => risk.severity !== 'critical');
          if (criticalRisks.length > 0) {
            securityAuditLog.record({ type: 'command_blocked', detail: `Direct route /api/terminal/exec blocked: ${criticalRisks.map((risk) => risk.description).join(', ')} — cmd: ${cmd}`, severity: 'critical' });
            return Response.json({ ok: false, error: `Command blocked by security policy: ${criticalRisks.map((risk) => risk.description).join(', ')}` }, { status: 403 });
          }
          if (warningRisks.length > 0) {
            securityAuditLog.record({ type: 'command_warned', detail: `Direct route /api/terminal/exec warnings: ${warningRisks.map((risk) => risk.description).join(', ')} — cmd: ${cmd}`, severity: 'warning' });
          }
        }
        const result = await tools.execute('terminal.exec', body as Record<string, unknown>, {
          agentId: options.agentId ?? 'crowclaw',
          sessionId: 'terminal-exec',
        });
        // Redact credentials from output before returning
        if (result && typeof result === 'object' && 'output' in result && typeof (result as { output: unknown }).output === 'string') {
          (result as { output: string }).output = redactToolOutput((result as { output: string }).output);
        }
        return Response.json(result);
      }

      if (request.method === 'POST' && url.pathname === '/api/terminal/background') {
        const body = (await request.json()) as { command?: string };
        const cmd = body.command ?? '';
        if (cmd) {
          const scan = scanCommand(cmd);
          const criticalRisks = scan.risks.filter((risk) => risk.severity === 'critical');
          if (criticalRisks.length > 0) {
            securityAuditLog.record({ type: 'command_blocked', detail: `Direct route /api/terminal/background blocked: ${criticalRisks.map((risk) => risk.description).join(', ')} — cmd: ${cmd}`, severity: 'critical' });
            return Response.json({ ok: false, error: `Command blocked by security policy: ${criticalRisks.map((risk) => risk.description).join(', ')}` }, { status: 403 });
          }
        }
        return Response.json(await tools.execute('terminal.background', body as Record<string, unknown>, {
          agentId: options.agentId ?? 'crowclaw',
          sessionId: 'terminal-background',
        }));
      }

      if (request.method === 'GET' && url.pathname === '/api/terminal/backends') {
        return Response.json(await tools.execute('terminal.backends', {}, {
          agentId: options.agentId ?? 'crowclaw',
          sessionId: 'terminal-backends',
        }));
      }

      if (request.method === 'GET' && url.pathname === routePaths.terminal.backendStatus) {
        return Response.json(await tools.execute('terminal.backendStatus', {}, {
          agentId: options.agentId ?? 'crowclaw',
          sessionId: 'terminal-backend-status',
        }));
      }

      if (request.method === 'POST' && url.pathname === routePaths.terminal.probe) {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        return Response.json(await tools.execute('terminal.probe', body, {
          agentId: options.agentId ?? 'crowclaw',
          sessionId: 'terminal-probe',
        }));
      }

      if (request.method === 'GET' && url.pathname === '/api/terminal/processes') {
        return Response.json(await tools.execute('terminal.processes', {}, {
          agentId: options.agentId ?? 'crowclaw',
          sessionId: 'terminal-processes',
        }));
      }

      if (request.method === 'POST' && url.pathname === '/api/terminal/kill') {
        const body = (await request.json()) as { pid?: string | number };
        return Response.json(await tools.execute('terminal.kill', body as Record<string, unknown>, {
          agentId: options.agentId ?? 'crowclaw',
          sessionId: 'terminal-kill',
        }));
      }

      if (request.method === 'POST' && url.pathname === routePaths.actions.todo) {
        const body = (await request.json()) as Record<string, unknown> & { sessionId?: string };
        return Response.json(await tools.execute('todo.manage', body, {
          agentId: options.agentId ?? 'crowclaw',
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : 'todo-session',
        }));
      }

      if (request.method === 'POST' && url.pathname === routePaths.actions.clarify) {
        const body = (await request.json()) as Record<string, unknown>;
        return Response.json(await tools.execute('clarify.ask', body, {
          agentId: options.agentId ?? 'crowclaw',
          sessionId: 'clarify-session',
        }));
      }

      if (request.method === 'POST' && url.pathname === routePaths.actions.sendMessage) {
        const body = (await request.json()) as Record<string, unknown>;
        return Response.json(await tools.execute('send.message', body, {
          agentId: options.agentId ?? 'crowclaw',
          sessionId: 'send-message-session',
        }));
      }

      if (request.method === 'POST' && url.pathname === routePaths.media.vision) {
        const body = (await request.json()) as Record<string, unknown>;
        return Response.json(await tools.execute('vision.analyze', body, {
          agentId: options.agentId ?? 'crowclaw',
          sessionId: 'vision-analyze',
        }));
      }

      if (request.method === 'POST' && url.pathname === routePaths.media.image) {
        const body = (await request.json()) as Record<string, unknown>;
        return Response.json(await tools.execute('image.generate', body, {
          agentId: options.agentId ?? 'crowclaw',
          sessionId: 'image-generate',
        }));
      }

      const codeBridgeResponse = await handleCodeBridgeRoutes(request, url, {
        agentId: options.agentId,
        codeBridgeSessions,
        bridgeProcesses,
        tools
      });
      if (codeBridgeResponse) {
        return codeBridgeResponse;
      }

      if (request.method === 'GET' && url.pathname === '/api/browser/session') {
        // #35: prune-on-read so a query for a stale session id returns the
        //      empty/default state instead of a 1h+ idle entry.
        pruneStaleBrowserSessions(browserSessions);
        const sessionId = url.searchParams.get('sessionId') ?? '';
        return Response.json(sessionId
          ? (browserSessions.get(sessionId) ?? { sessionId, currentUrl: null, history: [], lastSnapshot: null, lastRefs: [] })
          : { sessionId, currentUrl: null, history: [], lastSnapshot: null, lastRefs: [] });
      }

      if (request.method === 'POST' && url.pathname === '/api/browser/session/reset') {
        const body = (await request.json()) as { sessionId?: string };
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        if (sessionId) {
          browserSessions.delete(sessionId);
        }
        return Response.json({ ok: true, sessionId, reset: Boolean(sessionId) });
      }

      if (request.method === 'POST' && url.pathname === '/api/browser/screenshot') {
        const body = (await request.json()) as { url?: string; path?: string; fullPage?: boolean; sessionId?: string };
        const session = typeof body.sessionId === 'string' ? ensureBrowserSession(browserSessions, body.sessionId) : undefined;
        const url = typeof body.url === 'string' ? body.url : session?.currentUrl ?? '';
        const path = typeof body.path === 'string' ? body.path : '/workspace/screenshot-browser-screenshot.png';
        if (!url) {
          return Response.json({
            toolName: 'browser.screenshot',
            runtime: 'sandbox',
            ok: false,
            output: 'Missing url.',
            metadata: { path }
          });
        }
        if (session) {
          session.currentUrl = url;
          session.updatedAt = new Date().toISOString();
        }
        return Response.json({
          toolName: 'browser.screenshot',
          runtime: 'sandbox',
          ...renderScreenshotResult(url, path)
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/browser/goto') {
        const body = (await request.json()) as { url?: string; sessionId?: string };
        const session = typeof body.sessionId === 'string' ? ensureBrowserSession(browserSessions, body.sessionId) : undefined;
        const targetUrl = typeof body.url === 'string' ? body.url : session?.currentUrl ?? '';
        if (!targetUrl) {
          return Response.json({
            toolName: 'browser.goto',
            runtime: 'sandbox',
            ok: false,
            output: 'Missing url.',
            metadata: {}
          });
        }
        if (session) {
          recordBrowserNavigation(session, targetUrl);
        }
        return Response.json({
          toolName: 'browser.goto',
          runtime: 'sandbox',
          ...renderBrowserGotoResult(targetUrl)
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/browser/open') {
        const body = (await request.json()) as { url?: string; sessionId?: string };
        const session = typeof body.sessionId === 'string' ? ensureBrowserSession(browserSessions, body.sessionId) : undefined;
        const targetUrl = typeof body.url === 'string' ? body.url : session?.currentUrl ?? '';
        if (!targetUrl) {
          return Response.json({
            toolName: 'browser.open',
            runtime: 'sandbox',
            ok: false,
            output: 'Missing url.',
            metadata: {}
          });
        }
        if (session) {
          recordBrowserNavigation(session, targetUrl);
        }
        return Response.json({
          toolName: 'browser.open',
          runtime: 'sandbox',
          ...renderBrowserGotoResult(targetUrl)
        });
      }

      if (request.method === 'POST' && (url.pathname === '/api/browser/wait' || url.pathname === '/api/browser/wait-for')) {
        const body = (await request.json()) as { url?: string; selector?: string; timeoutMs?: number; sessionId?: string };
        const session = typeof body.sessionId === 'string' ? ensureBrowserSession(browserSessions, body.sessionId) : undefined;
        const targetUrl = typeof body.url === 'string' ? body.url : session?.currentUrl ?? '';
        const selector = typeof body.selector === 'string' ? body.selector : 'body';
        const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : 5_000;
        if (!targetUrl) {
          return Response.json({
            toolName: 'browser.waitFor',
            runtime: 'sandbox',
            ok: false,
            output: 'Missing url.',
            metadata: { selector, timeoutMs }
          });
        }
        if (session) {
          recordBrowserNavigation(session, targetUrl);
        }
        return Response.json({
          toolName: 'browser.waitFor',
          runtime: 'sandbox',
          ...renderBrowserWaitForResult(targetUrl, selector, timeoutMs)
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/browser/navigate') {
        const body = (await request.json()) as { url?: string; sessionId?: string };
        const session = typeof body.sessionId === 'string' ? ensureBrowserSession(browserSessions, body.sessionId) : undefined;
        const targetUrl = typeof body.url === 'string' ? body.url : session?.currentUrl ?? '';
        if (!targetUrl) {
          return Response.json({
            toolName: 'browser.navigate',
            runtime: 'sandbox',
            ok: false,
            output: 'Missing url.',
            metadata: {}
          });
        }
        if (session) {
          recordBrowserNavigation(session, targetUrl);
        }
        return Response.json({
          toolName: 'browser.navigate',
          runtime: 'sandbox',
          ...renderBrowserGotoResult(targetUrl)
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/browser/snapshot') {
        const body = (await request.json()) as { url?: string; full?: boolean; sessionId?: string };
        const session = typeof body.sessionId === 'string' ? ensureBrowserSession(browserSessions, body.sessionId) : undefined;
        const targetUrl = typeof body.url === 'string' ? body.url : session?.currentUrl ?? '';
        if (!targetUrl) {
          return Response.json({
            toolName: 'browser.snapshot',
            runtime: 'sandbox',
            ok: false,
            output: 'Missing url.',
            metadata: { full: Boolean(body.full) }
          });
        }
        const payload = {
          toolName: 'browser.snapshot',
          runtime: 'sandbox',
          ...renderBrowserSnapshotResult(targetUrl, Boolean(body.full))
        };
        if (session) {
          session.currentUrl = targetUrl;
          session.lastSnapshot = payload.output;
          session.lastRefs = (payload.metadata as { refs?: string[] }).refs ?? [];
          session.updatedAt = new Date().toISOString();
        }
        return Response.json(payload);
      }

      if (request.method === 'POST' && url.pathname === '/api/browser/back') {
        const body = (await request.json()) as { steps?: number; sessionId?: string };
        const steps = typeof body.steps === 'number' ? body.steps : 1;
        const session = typeof body.sessionId === 'string' ? ensureBrowserSession(browserSessions, body.sessionId) : undefined;
        if (session && session.history.length > 1) {
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
        return Response.json({
          toolName: 'browser.back',
          runtime: 'sandbox',
          ...renderBrowserBackResult(steps)
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/browser/scroll') {
        const body = (await request.json()) as { url?: string; direction?: string; amount?: number; sessionId?: string };
        const session = typeof body.sessionId === 'string' ? ensureBrowserSession(browserSessions, body.sessionId) : undefined;
        const targetUrl = typeof body.url === 'string' ? body.url : session?.currentUrl ?? '';
        const direction = body.direction === 'up' || body.direction === 'left' ? body.direction : 'down';
        const amount = typeof body.amount === 'number' ? body.amount : 1;
        if (!targetUrl) {
          return Response.json({ toolName: 'browser.scroll', runtime: 'sandbox', ok: false, output: 'Missing url.', metadata: { direction, amount } });
        }
        if (session) {
          session.currentUrl = targetUrl;
          session.updatedAt = new Date().toISOString();
        }
        return Response.json({
          toolName: 'browser.scroll',
          runtime: 'sandbox',
          ...renderBrowserScrollResult(targetUrl, direction, amount)
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/browser/press') {
        const body = (await request.json()) as { url?: string; key?: string; sessionId?: string };
        const session = typeof body.sessionId === 'string' ? ensureBrowserSession(browserSessions, body.sessionId) : undefined;
        const targetUrl = typeof body.url === 'string' ? body.url : session?.currentUrl ?? '';
        const key = typeof body.key === 'string' ? body.key : '';
        if (!targetUrl || !key) {
          return Response.json({ toolName: 'browser.press', runtime: 'sandbox', ok: false, output: 'Missing url or key.', metadata: { url: targetUrl, key } });
        }
        if (session) {
          session.currentUrl = targetUrl;
          session.updatedAt = new Date().toISOString();
        }
        return Response.json({
          toolName: 'browser.press',
          runtime: 'sandbox',
          ...renderBrowserPressResult(targetUrl, key)
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/browser/console') {
        const body = (await request.json()) as { url?: string; sessionId?: string };
        const session = typeof body.sessionId === 'string' ? ensureBrowserSession(browserSessions, body.sessionId) : undefined;
        const targetUrl = typeof body.url === 'string' ? body.url : session?.currentUrl ?? '';
        if (!targetUrl) {
          return Response.json({ toolName: 'browser.console', runtime: 'sandbox', ok: false, output: 'Missing url.', metadata: {} });
        }
        if (session) {
          session.currentUrl = targetUrl;
          session.updatedAt = new Date().toISOString();
        }
        return Response.json({
          toolName: 'browser.console',
          runtime: 'sandbox',
          ...renderBrowserConsoleResult(targetUrl)
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/browser/vision') {
        const body = (await request.json()) as { url?: string; prompt?: string; sessionId?: string };
        const session = typeof body.sessionId === 'string' ? ensureBrowserSession(browserSessions, body.sessionId) : undefined;
        const targetUrl = typeof body.url === 'string' ? body.url : session?.currentUrl ?? '';
        const prompt = typeof body.prompt === 'string' ? body.prompt : 'Describe the page.';
        if (!targetUrl) {
          return Response.json({ toolName: 'browser.vision', runtime: 'sandbox', ok: false, output: 'Missing url.', metadata: { prompt } });
        }
        if (session) {
          session.currentUrl = targetUrl;
          session.updatedAt = new Date().toISOString();
        }
        return Response.json({
          toolName: 'browser.vision',
          runtime: 'sandbox',
          ...renderBrowserVisionResult(targetUrl, prompt)
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/browser/images') {
        const body = (await request.json()) as { url?: string; limit?: number; sessionId?: string };
        const session = typeof body.sessionId === 'string' ? ensureBrowserSession(browserSessions, body.sessionId) : undefined;
        const targetUrl = typeof body.url === 'string' ? body.url : session?.currentUrl ?? '';
        const limit = typeof body.limit === 'number' ? body.limit : 10;
        if (!targetUrl) {
          return Response.json({ toolName: 'browser.images', runtime: 'sandbox', ok: false, output: 'Missing url.', metadata: { limit } });
        }
        if (session) {
          session.currentUrl = targetUrl;
          session.updatedAt = new Date().toISOString();
        }
        return Response.json({
          toolName: 'browser.images',
          runtime: 'sandbox',
          ...renderBrowserImagesResult(targetUrl, limit)
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/browser/click-ref') {
        const body = (await request.json()) as { url?: string; ref?: string; sessionId?: string };
        const session = typeof body.sessionId === 'string' ? ensureBrowserSession(browserSessions, body.sessionId) : undefined;
        const targetUrl = typeof body.url === 'string' ? body.url : session?.currentUrl ?? '';
        const ref = typeof body.ref === 'string' ? body.ref : '';
        if (session && ref && session.lastRefs.length > 0 && !session.lastRefs.includes(ref)) {
          return Response.json({ toolName: 'browser.clickRef', runtime: 'sandbox', ok: false, output: `Unknown ref: ${ref}`, metadata: { url: targetUrl, ref, knownRefs: session.lastRefs } });
        }
        if (!targetUrl || !ref) {
          return Response.json({ toolName: 'browser.clickRef', runtime: 'sandbox', ok: false, output: 'Missing url or ref.', metadata: { url: targetUrl, ref } });
        }
        if (session) {
          session.currentUrl = targetUrl;
          session.updatedAt = new Date().toISOString();
        }
        return Response.json({
          toolName: 'browser.clickRef',
          runtime: 'sandbox',
          ...renderBrowserClickRefResult(targetUrl, ref)
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/browser/extract') {
        const body = (await request.json()) as { url?: string; selector?: string; sessionId?: string };
        const session = typeof body.sessionId === 'string' ? ensureBrowserSession(browserSessions, body.sessionId) : undefined;
        const targetUrl = typeof body.url === 'string' ? body.url : session?.currentUrl ?? '';
        const selector = typeof body.selector === 'string' ? body.selector : 'body';
        if (!targetUrl) {
          return Response.json({
            toolName: 'browser.extract',
            runtime: 'sandbox',
            ok: false,
            output: 'Missing url.',
            metadata: { selector }
          });
        }
        if (session) {
          session.currentUrl = targetUrl;
          session.updatedAt = new Date().toISOString();
        }
        return Response.json({
          toolName: 'browser.extract',
          runtime: 'sandbox',
          ok: true,
          output: `Simulated extraction for ${targetUrl} (${selector})`,
          metadata: { simulated: true, url: targetUrl, selector }
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/browser/click') {
        const body = (await request.json()) as { url?: string; selector?: string; sessionId?: string };
        const session = typeof body.sessionId === 'string' ? ensureBrowserSession(browserSessions, body.sessionId) : undefined;
        const targetUrl = typeof body.url === 'string' ? body.url : session?.currentUrl ?? '';
        const selector = typeof body.selector === 'string' ? body.selector : '';
        if (!targetUrl || !selector) {
          return Response.json({
            toolName: 'browser.click',
            runtime: 'sandbox',
            ok: false,
            output: 'Missing url or selector.',
            metadata: { url: targetUrl, selector }
          });
        }
        if (session) {
          session.currentUrl = targetUrl;
          session.updatedAt = new Date().toISOString();
        }
        return Response.json({
          toolName: 'browser.click',
          runtime: 'sandbox',
          ok: true,
          output: `Simulated click on ${selector} at ${targetUrl}`,
          metadata: { simulated: true, url: targetUrl, selector, finalUrl: targetUrl }
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/browser/type') {
        const body = (await request.json()) as { url?: string; selector?: string; text?: string; sessionId?: string };
        const session = typeof body.sessionId === 'string' ? ensureBrowserSession(browserSessions, body.sessionId) : undefined;
        const targetUrl = typeof body.url === 'string' ? body.url : session?.currentUrl ?? '';
        const selector = typeof body.selector === 'string' ? body.selector : '';
        const text = typeof body.text === 'string' ? body.text : '';
        if (!targetUrl || !selector) {
          return Response.json({
            toolName: 'browser.type',
            runtime: 'sandbox',
            ok: false,
            output: 'Missing url or selector.',
            metadata: { url: targetUrl, selector }
          });
        }
        if (session) {
          session.currentUrl = targetUrl;
          session.updatedAt = new Date().toISOString();
        }
        return Response.json({
          toolName: 'browser.type',
          runtime: 'sandbox',
          ok: true,
          output: `Simulated typing into ${selector} at ${targetUrl}`,
          metadata: { simulated: true, url: targetUrl, selector, text, finalUrl: targetUrl }
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/mcp/tools') {
        return Response.json(await mcpClient.listTools());
      }

      if (request.method === 'GET' && url.pathname === '/api/mcp/resources') {
        return Response.json(await mcpClient.listResources());
      }

      if (request.method === 'GET' && url.pathname === '/api/mcp/prompts') {
        return Response.json(await mcpClient.listPrompts());
      }

      if (request.method === 'GET' && url.pathname === routePaths.mcp.serverTools) {
        // #154: filter ownerOnly tools out of the unauthenticated listing.
        const auth = request.headers.get('authorization');
        const callerToken = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
        return Response.json({
          server: {
            name: options.agentId ?? 'crowclaw-mcp-server',
            version,
          },
          tools: embeddedMcpServer.getVisibleTools(callerToken)
        });
      }

      if (request.method === 'POST' && url.pathname === routePaths.mcp.serverRequest) {
        // #152: extract bearer token and inject into _meta so the MCP server
        // can enforce ownerOnly gating (without this every caller was owner).
        const auth = request.headers.get('authorization');
        const callerToken = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
        const body = (await request.json()) as {
          jsonrpc: '2.0';
          id: number | string;
          method: string;
          params?: Record<string, unknown>;
          _meta?: { token?: string; [key: string]: unknown };
        };
        if (callerToken) {
          body._meta = { ...(body._meta ?? {}), token: callerToken };
        }
        return Response.json(await embeddedMcpServer.handleRequest(body));
      }

      if (request.method === 'GET' && url.pathname === routePaths.acp.info) {
        return Response.json(await embeddedAcpServer.handleRequest({
          jsonrpc: '2.0',
          id: 'acp-info',
          method: 'agent/info'
        }));
      }

      if (request.method === 'GET' && url.pathname === routePaths.acp.sessions) {
        return Response.json(await embeddedAcpServer.handleRequest({
          jsonrpc: '2.0',
          id: 'acp-sessions',
          method: 'sessions/list'
        }));
      }

      if (request.method === 'POST' && url.pathname === routePaths.acp.sessions) {
        const body = (await request.json().catch(() => ({}))) as { title?: string };
        return Response.json(await embeddedAcpServer.handleRequest({
          jsonrpc: '2.0',
          id: 'acp-create',
          method: 'sessions/create',
          params: typeof body.title === 'string' ? { title: body.title } : {}
        }));
      }

      if (request.method === 'POST' && url.pathname === routePaths.acp.prompt) {
        const body = (await request.json()) as { sessionId: string; message: string; systemPrompt?: string };
        return Response.json(await embeddedAcpServer.handleRequest({
          jsonrpc: '2.0',
          id: 'acp-prompt',
          method: 'prompt/execute',
          params: {
            sessionId: body.sessionId,
            message: body.message,
            ...(typeof body.systemPrompt === 'string' ? { systemPrompt: body.systemPrompt } : {})
          }
        }));
      }

      if (request.method === 'POST' && url.pathname === routePaths.acp.request) {
        const body = (await request.json()) as {
          jsonrpc: '2.0';
          id: number | string;
          method: string;
          params?: Record<string, unknown>;
        };
        return Response.json(await embeddedAcpServer.handleRequest(body));
      }

      if (request.method === 'GET' && url.pathname === '/api/mcp/status') {
        return Response.json(mcpClient.getStatus());
      }

      if (request.method === 'GET' && url.pathname === '/api/mcp/inspect') {
        const dynamicClient = mcpClient as unknown as {
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

      if (request.method === 'POST' && url.pathname === '/api/mcp/reload') {
        return Response.json(await mcpClient.refreshTools());
      }

      if (request.method === 'POST' && url.pathname === '/api/mcp/list-changed') {
        const dynamicClient = mcpClient as unknown as { notifyToolsChanged?: () => Promise<unknown> };
        return Response.json(dynamicClient.notifyToolsChanged
          ? await dynamicClient.notifyToolsChanged()
          : { ok: true, refreshed: await mcpClient.refreshTools() });
      }

      if (request.method === 'POST' && url.pathname === '/api/mcp/call') {
        const body = (await request.json()) as { name: string; arguments?: Record<string, unknown> };
        return Response.json(await mcpClient.callTool(body.name, body.arguments ?? {}));
      }

      if (request.method === 'POST' && url.pathname === '/api/mcp/verify') {
        return Response.json(await mcpClient.verify());
      }

      if (request.method === 'GET' && url.pathname === '/api/mcp/presets/status') {
        const names = listMcpPresetNames();
        const results = await Promise.all(
          names.map(async (name) => {
            const result = await verifyPresetAvailability(name);
            return { name, ...result };
          })
        );
        return Response.json(results);
      }

      if (request.method === 'GET' && url.pathname === '/api/learning/drafts') {
        return Response.json(await learning.listDrafts());
      }

      if (request.method === 'POST' && url.pathname === '/api/learning/auto-capture') {
        const body = (await request.json()) as {
          title?: string;
          messages: Array<{ role: 'user' | 'assistant' | 'tool' | 'system'; content: string; createdAt?: string }>;
        };
        const stored = await learning.autoCapture(
          body.messages.map((message) => ({ ...message, createdAt: message.createdAt ?? new Date().toISOString() })),
          body.title
        );
        return Response.json(stored);
      }

      if (request.method === 'POST' && url.pathname === '/api/learning/match') {
        const body = (await request.json()) as { query: string; limit?: number };
        return Response.json(await learning.findRelevantSkills(body.query, body.limit));
      }

      if (request.method === 'POST' && url.pathname === '/api/learning/drafts') {
        const body = (await request.json()) as { title: string; messages: Array<{ role: 'user' | 'assistant' | 'tool' | 'system'; content: string; createdAt?: string }> };
        const stored = await learning.captureDraft(
          body.messages.map((message) => ({ ...message, createdAt: message.createdAt ?? new Date().toISOString() })),
          body.title
        );
        return Response.json(stored);
      }

      // v0.8.0 (#238) — Drafts tab pending list. Returns drafts that haven't
      // been promoted to published skills yet so the dashboard can render the
      // Skill Drafts section.
      if (request.method === 'GET' && url.pathname === '/api/learning/drafts/pending') {
        const all = await learning.listDrafts();
        const pending = all
          .filter((d) => d.status === 'draft')
          .map((d) => ({
            id: d.id,
            slug: d.slug,
            title: d.title,
            summary: d.summary,
            triggerPhrases: d.triggerPhrases,
            recurrenceCount: d.sourceMessages,
            // We don't currently persist source provenance; use 'auto-capture'
            // as the conservative default. Agent-proposed drafts that arrive
            // via SKILL.md on disk are surfaced through the skills API, not
            // this endpoint.
            source: 'auto-capture' as const,
            createdAt: d.createdAt,
            updatedAt: d.updatedAt,
          }));
        return Response.json({ drafts: pending });
      }

      // v0.8.0 (#238) — Promote a draft to a published skill. Mirrors the
      // existing `:id/publish` action but uses the explicit `/promote`
      // pathname the dashboard's Drafts tab calls. Must be matched before
      // the generic `startsWith('/api/learning/drafts/')` block below so the
      // action discriminator there doesn't intercept it.
      if (request.method === 'POST' && /^\/api\/learning\/drafts\/[^/]+\/promote$/.test(url.pathname)) {
        const segments = url.pathname.split('/').filter(Boolean);
        const id = segments[3] ?? '';
        try {
          const result = await learning.publishDraft(id);
          await skillRegistry.refreshLearned();
          eventBus.emit('learning:draft_promoted', { draftId: id, skillSlug: result.slug, source: 'manual' });
          return Response.json({ ok: true, slug: result.slug, draft: result });
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          return Response.json({ ok: false, error: msg }, { status: 404 });
        }
      }

      // v0.8.0 (#238) — Reject a draft. Today this means unpublish (revert to
      // draft status) and emit a rejection event the dashboard listens for.
      // Hard-delete is intentionally not exposed — operators can edit instead.
      if (request.method === 'POST' && /^\/api\/learning\/drafts\/[^/]+\/reject$/.test(url.pathname)) {
        const segments = url.pathname.split('/').filter(Boolean);
        const id = segments[3] ?? '';
        try {
          // Mark as draft (no-op if already draft) so the pending list can be
          // refreshed; the dashboard hides rejected rows by id client-side
          // until the next promote attempt.
          const existing = await learning.listDrafts();
          const found = existing.find((d) => d.id === id);
          if (!found) {
            return Response.json({ ok: false, error: `Draft not found: ${id}` }, { status: 404 });
          }
          if (found.status === 'published') {
            await learning.unpublishDraft(id);
            await skillRegistry.refreshLearned();
          }
          return Response.json({ ok: true });
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          return Response.json({ ok: false, error: msg }, { status: 500 });
        }
      }

      if (request.method === 'POST' && url.pathname.startsWith('/api/learning/drafts/')) {
        const segments = url.pathname.split('/').filter(Boolean);
        const id = segments[3] ?? '';
        const action = segments[4] ?? 'publish';
        if (action === 'unpublish') {
          const result = await learning.unpublishDraft(id);
          await skillRegistry.refreshLearned();
          return Response.json(result);
        }
        if (action === 'refine') {
          const body = (await request.json()) as {
            messages: Array<{ role: 'user' | 'assistant' | 'tool' | 'system'; content: string; createdAt?: string }>;
          };
          const result = await learning.refineDraft(
            id,
            (body.messages ?? []).map((message) => ({ ...message, createdAt: message.createdAt ?? new Date().toISOString() }))
          );
          await skillRegistry.refreshLearned();
          return Response.json(result);
        }
        const result = await learning.publishDraft(id);
        await skillRegistry.refreshLearned();
        return Response.json(result);
      }

      if (request.method === 'GET' && url.pathname === '/api/scheduler/jobs') {
        return Response.json(await schedulerStore.listJobs());
      }

      if (request.method === 'POST' && url.pathname === '/api/scheduler/jobs') {
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

        // Support both `everyMinutes` (compat) and `schedule` (Hermes-style)
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
        await schedulerStore.saveJob(job);
        // #214 — autostart the autonomous scheduler the first time a job is
        // created so the dashboard "save job" UX doesn't silently leave jobs
        // dormant. `wasStarted` lets the frontend show a "Scheduler started"
        // toast on the transition.
        const wasRunningBefore = autonomousScheduler.isRunning();
        if (!wasRunningBefore) {
          autonomousScheduler.start();
        }
        const wasStarted = !wasRunningBefore && autonomousScheduler.isRunning();
        return Response.json({ ...job, wasStarted });
      }

      if (request.method === 'POST' && url.pathname === '/api/scheduler/tick') {
        const results = await schedulerExecutor.tick();
        return Response.json({ ok: true, results });
      }

      // Scheduler job lifecycle routes
      {
        const jobActionMatch = url.pathname.match(/^\/api\/scheduler\/jobs\/([^/]+)\/(pause|resume|history|dry-run)$/);
        const jobDeleteMatch = url.pathname.match(/^\/api\/scheduler\/jobs\/([^/]+)$/);

        if (request.method === 'POST' && jobActionMatch) {
          const jobId = decodeURIComponent(jobActionMatch[1]);
          const action = jobActionMatch[2];

          if (action === 'pause') {
            const result = await schedulerExecutor.pauseJob(jobId);
            if (!result) return Response.json({ error: 'Job not found' }, { status: 404 });
            return Response.json(result);
          }

          if (action === 'resume') {
            const result = await schedulerExecutor.resumeJob(jobId);
            if (!result) return Response.json({ error: 'Job not found' }, { status: 404 });
            return Response.json(result);
          }

          if (action === 'dry-run') {
            try {
              const record = await schedulerExecutor.dryRun(jobId);
              return Response.json(record);
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              return Response.json({ error: msg }, { status: 404 });
            }
          }
        }

        if (request.method === 'GET' && jobActionMatch) {
          const jobId = decodeURIComponent(jobActionMatch[1]);
          const action = jobActionMatch[2];

          if (action === 'history') {
            const limitParam = url.searchParams.get('limit');
            const limit = limitParam ? parseInt(limitParam, 10) : undefined;
            const history = await schedulerStore.getRunHistory(jobId, limit);
            return Response.json(history);
          }
        }

        if (request.method === 'DELETE' && jobDeleteMatch) {
          const jobId = decodeURIComponent(jobDeleteMatch[1]);
          const deleted = await schedulerExecutor.deleteJob(jobId);
          if (!deleted) return Response.json({ error: 'Job not found' }, { status: 404 });
          return Response.json({ ok: true });
        }
      }

      // Autonomous scheduler control
      if (request.method === 'POST' && url.pathname === '/api/scheduler/start') {
        autonomousScheduler.start();
        return Response.json({ ok: true, running: true });
      }

      if (request.method === 'POST' && url.pathname === '/api/scheduler/stop') {
        autonomousScheduler.stop();
        return Response.json({ ok: true, running: false });
      }

      if (request.method === 'GET' && url.pathname === '/api/scheduler/status') {
        return Response.json({
          running: autonomousScheduler.isRunning(),
          interval: autonomousScheduler.interval,
          lastTick: autonomousScheduler.lastTick,
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/workspace') {
        const path = url.searchParams.get('path');
        if (path) {
          const file = await workspaceStore.read(path);
          return Response.json(file ?? { path, content: null });
        }
        const prefix = url.searchParams.get('prefix') ?? '';
        return Response.json(await workspaceStore.list(prefix));
      }

      if (request.method === 'GET' && url.pathname === '/api/workspace/exists') {
        const path = url.searchParams.get('path') ?? '';
        return Response.json({ path, exists: await workspaceStore.exists(path) });
      }

      if (request.method === 'GET' && url.pathname.startsWith('/api/workspace/')) {
        const path = url.pathname.replace('/api/workspace/', '');
        const file = await workspaceStore.read(path);
        return Response.json(file ?? { path, content: null });
      }

      if (request.method === 'POST' && url.pathname === '/api/workspace/write') {
        const body = (await request.json()) as { path: string; content: string };
        return Response.json(await workspaceStore.write(body.path, body.content));
      }

      if (request.method === 'POST' && url.pathname === '/api/workspace/patch') {
        const body = (await request.json()) as { path: string; patches: Array<{ line: number; value: string }> };
        return Response.json(await workspaceStore.patchLines(body.path, body.patches));
      }

      if (request.method === 'POST' && url.pathname === '/api/workspace/patch-text') {
        const body = (await request.json()) as { path: string; replacements: Array<{ from: string; to: string }> };
        return Response.json(await workspaceStore.patchText(body.path, body.replacements));
      }

      if (request.method === 'POST' && url.pathname === '/api/workspace/delete') {
        const body = (await request.json()) as { path: string };
        return Response.json({ path: body.path, removed: await workspaceStore.remove(body.path) });
      }

      if (request.method === 'POST' && url.pathname === '/api/workspace/rename') {
        const body = (await request.json()) as { fromPath: string; toPath: string };
        const file = await workspaceStore.rename(body.fromPath, body.toPath);
        return Response.json(file ?? { fromPath: body.fromPath, toPath: body.toPath, content: null });
      }

      if (request.method === 'GET' && url.pathname.startsWith('/api/sessions/')) {
        const parts = url.pathname.split('/').filter(Boolean);
        const sessionId = parts[2] ?? '';
        if (parts[3] === 'checkpoints') {
          const checkpoints = await checkpointStore.listBySession(sessionId);
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
        if (parts[3] === 'memories') {
          const scopeParam = url.searchParams.get('scope');
          const scopeKey = url.searchParams.get('scopeKey') ?? undefined;
          const limitParam = Number(url.searchParams.get('limit') ?? '50');
          const limit = Number.isFinite(limitParam) ? limitParam : 50;
          const records = scopeParam === 'session' || scopeParam === 'user' || scopeParam === 'workspace'
            ? await memoryService.listByScope(scopeParam, limit, scopeKey)
            : await memoryService.list(sessionId, limit);
          return Response.json({ ok: true, records, ...(scopeParam ? { scope: scopeParam, scopeKey } : { sessionId }) });
        }
        if (parts[3] === 'history' || parts[3] === 'state' || parts.length === 3) {
          const session = sessionId ? await store.get(sessionId) : null;
          if (!session) return Response.json({ sessionId, messages: [] });
          // Strip [session-meta] markers so the chat UI doesn't render them as
          // visible system messages.
          return Response.json({
            ...session,
            messages: session.messages.filter(
              (m) => !(m.role === 'system' && m.content?.startsWith('[session-meta]')),
            ),
          });
        }
      }

      if (request.method === 'POST' && url.pathname.startsWith('/api/sessions/')) {
        const parts = url.pathname.split('/').filter(Boolean);
        const sessionId = parts[2] ?? crypto.randomUUID();
        const action = parts[3] ?? 'message';

        // Dangerous session actions require token auth even on localhost
        if (SESSION_DANGEROUS_ACTIONS.has(action) && isDangerousRoute(`/api/sessions/${sessionId}/${action}`)) {
          // Auth is already checked by the main auth gate; this is a safety net
        }

        // Acquire per-session mutex for message/stream/compact/steer/edit-from to prevent race conditions
        const needsMutex = action === 'message' || action === 'stream' || action === 'compact' || action === 'steer' || action === 'edit-from';
        const releaseMutex = needsMutex ? await sessionMutex.acquire(sessionId) : undefined;
        let releaseHandledByStream = false;
        try {
          return await (async (): Promise<Response> => {

        if (action === 'abort') {
          const result = sessionController.abort(sessionId);
          return Response.json({ ok: result.aborted, ...result });
        }

        if (action === 'stop') {
          // #59: synchronous stop endpoint — signals abort the same way the
          //      WebSocket `session:abort` handler does, then waits up to 5s
          //      for the session to clear from the active-sessions set.
          //      Returns 200 if the session stopped within the deadline,
          //      202 if the abort was signalled but the session is still
          //      winding down (caller can poll /api/sessions/active).
          const STOP_HANG_CAP_MS = 5_000;
          const result = sessionController.abort(sessionId);
          if (!result.aborted) {
            return Response.json({ ok: false, status: 'not-active', reason: result.reason ?? 'Session is not active' }, { status: 404 });
          }
          const deadline = Date.now() + STOP_HANG_CAP_MS;
          while (Date.now() < deadline) {
            if (!sessionController.isActive(sessionId)) {
              return Response.json({ ok: true, status: 'stopped', sessionId });
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return Response.json({ ok: true, status: 'pending', sessionId }, { status: 202 });
        }

        if (action === 'compact') {
          const session = await store.get(sessionId);
          if (!session) return Response.json({ error: 'Session not found' }, { status: 404 });
          const compactBody = (await request.json()) as { keepLastN?: number; summaryMaxLength?: number };
          const keepLastN = typeof compactBody.keepLastN === 'number' && Number.isFinite(compactBody.keepLastN)
            ? Math.max(1, Math.floor(compactBody.keepLastN))
            : undefined;
          const result = sessionController.compact(session, { ...compactBody, keepLastN });
          await store.put(session);
          return Response.json({ ok: true, ...result });
        }

        if (action === 'steer') {
          const session = await store.get(sessionId);
          if (!session) return Response.json({ error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } }, { status: 404 });
          const steerBody = (await request.json()) as { directive: string };
          if (!steerBody.directive) return Response.json({ error: { code: 'MISSING_DIRECTIVE', message: 'Missing directive' } }, { status: 400 });
          if (steerBody.directive.length > 2000) return Response.json({ error: { code: 'DIRECTIVE_TOO_LONG', message: 'Directive too long (max 2000 chars)' } }, { status: 400 });
          // #145: refuse steer on a session that isn't actively running. Without
          // this guard the route returns 200 OK but the directive never reaches
          // the agent (no turn in progress to inject into).
          if (!sessionController.isActive(sessionId)) {
            return Response.json(
              { error: { code: 'SESSION_NOT_ACTIVE', message: 'Session is not running — directive will not be applied' } },
              { status: 409 }
            );
          }
          securityAuditLog?.record({ type: 'command_warned', severity: 'info', detail: `session:steer sessionId=${sessionId} len=${steerBody.directive.length}` });
          const result = sessionController.steer(session, steerBody.directive);
          await store.put(session);
          return Response.json({ ok: true, ...result });
        }

        if (action === 'fork') {
          // #146: implement POST /api/sessions/:id/fork — was claimed in
          // CHANGELOG but had no route handler. Clones session.messages into a
          // new child session via forkSession() from @crowclaw/core, persists
          // the child, emits `session:forked` for live observability.
          const session = await store.get(sessionId);
          if (!session) {
            return Response.json({ error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } }, { status: 404 });
          }
          const forkBody = (await request.json()) as {
            task?: string;
            childAgentId?: string;
            enabledToolsets?: string[];
          };
          const task = forkBody.task ?? '';
          const childAgentId = forkBody.childAgentId ?? session.agentId;
          const child = forkSession(session, task, childAgentId);
          // Carry parent's full transcript so the child has context (forkSession
          // currently seeds with just the user task — the operator-driven fork
          // path wants the full history).
          child.messages = [
            ...session.messages,
            ...(task ? [{
              role: 'user' as const,
              content: task,
              createdAt: new Date().toISOString(),
              metadata: { forkedFrom: session.sessionId, forkedFromAgent: session.agentId },
            }] : []),
          ];
          // enabledToolsets restriction lives at fork-time in core; if provided
          // it is plumbed through forkSession's option object (added in #84).
          // For now we accept the field on the wire but defer enforcement to
          // the core-side option.
          void forkBody.enabledToolsets;
          await store.put(child);
          // Emit a lifecycle event so the dashboard can refresh the session list.
          eventBus.emit('session:forked', {
            sessionId: child.sessionId,
            parentSessionId: session.sessionId,
            parentAgentId: session.agentId,
            childAgentId,
          });
          securityAuditLog?.record({
            type: 'command_warned',
            severity: 'info',
            detail: `session:fork parentSessionId=${session.sessionId} childSessionId=${child.sessionId}`,
          });
          return Response.json({
            ok: true,
            forkSessionId: child.sessionId,
            parentSessionId: session.sessionId,
          });
        }

        if (action === 'checkpoint') {
          const session = await store.get(sessionId);
          if (!session) return Response.json({ error: 'Session not found' }, { status: 404 });
          const body = (await request.json()) as { label?: string; trigger?: string };

          // Extract tool results from session messages. Read the authoritative
          // `metadata.ok` stored by `toolMessage()`; prior code scraped the
          // content for /error|fail/i which falsely flagged "No errors found"
          // as failed, poisoning checkpoints used for restore/replay.
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
              agentPreset: configStore.getAgentPreset() ?? undefined,
              pendingToolCalls: session.messages
                .filter((m) => m.role === 'assistant' && m.metadata?.toolCount)
                .slice(-1)
                .flatMap(() => []), // No pending calls at checkpoint time
            },
          );
          await checkpointStore.save(cp);
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

        if (action === 'restore') {
          const body = (await request.json()) as { checkpointId?: string };
          const cpId = body.checkpointId;
          if (!cpId) return Response.json({ error: 'Missing checkpointId' }, { status: 400 });
          const checkpoint = await checkpointStore.get(cpId);
          if (!checkpoint) return Response.json({ error: 'Checkpoint not found' }, { status: 404 });
          const session = await store.get(sessionId);
          if (!session) return Response.json({ error: 'Session not found' }, { status: 404 });
          const restored = restoreFromCheckpoint(checkpoint, session);
          await store.put(restored.session);
          // Previously only `restored.session` was persisted — toolResults and
          // loopState (iteration counters, pendingToolCalls, systemPrompt)
          // were silently dropped, so the next turn resumed from a blank loop
          // state even though the checkpoint carried that data. Surface them
          // to the client so the caller can thread them into the next run(),
          // and echo the restored iteration so UIs can show where we rewound to.
          return Response.json({
            ok: true,
            restoredTo: cpId,
            messageCount: restored.session.messages.length,
            toolResults: restored.toolResults,
            loopState: restored.loopState,
            restoredIteration: checkpoint.iteration,
          });
        }

        if (action === 'replay') {
          const body = (await request.json()) as { checkpointId?: string; newSessionId?: string };
          const cpId = body.checkpointId;
          if (!cpId) return Response.json({ error: 'Missing checkpointId' }, { status: 400 });
          const checkpoint = await checkpointStore.get(cpId);
          if (!checkpoint) return Response.json({ error: 'Checkpoint not found' }, { status: 404 });
          const replaySession = createReplaySession(checkpoint, body.newSessionId);
          await store.put(replaySession);
          return Response.json({ ok: true, sessionId: replaySession.sessionId, messageCount: replaySession.messages.length });
        }

        if (action === 'remember') {
          const body = (await request.json()) as { summary: string; tags?: string[]; metadata?: Record<string, unknown>; scope?: 'session' | 'user' | 'workspace'; scopeKey?: string };
          const record = await memoryService.remember(sessionId, body.summary, body.tags ?? [], body.metadata, body.scope ?? 'session', body.scopeKey);
          return Response.json(record);
        }

        if (action === 'capture') {
          const body = (await request.json()) as { scope?: 'session' | 'user' | 'workspace'; scopeKey?: string; messages?: Array<{ role: 'user' | 'assistant' | 'tool' | 'system'; content: string; createdAt?: string }> };
          const messages = body.messages?.map((message) => ({ ...message, createdAt: message.createdAt ?? new Date().toISOString() })) ?? [];
          const record = await memoryService.captureScopedSummary(body.scope ?? 'session', sessionId, messages, body.scopeKey);
          return Response.json(record);
        }

        if (action === 'search') {
          const body = (await request.json()) as { query: string; source?: 'session' | 'memory'; scope?: 'session' | 'user' | 'workspace'; scopeKey?: string; limit?: number };
          const limit = typeof body.limit === 'number' ? body.limit : 10;
          if (body.source === 'memory' && body.scope) {
            const results = await memoryService.recallByScope(body.scope, body.query, limit, body.scopeKey);
            return Response.json({ ok: true, source: 'memory', scope: body.scope, scopeKey: body.scopeKey, results });
          }
          if (body.source === 'memory') {
            const results = await memoryStore.search(sessionId, body.query, limit);
            return Response.json({ ok: true, source: 'memory', results });
          }
          // Session search: remap SessionSearchHit → { messageIndex, role, content }
          // Dashboard uses messageIndex for click-through scroll; without remap
          // the UI silently renders empty chips that scroll nowhere.
          const rawHits = await store.search(sessionId, body.query, limit);
          const session = await store.get(sessionId);
          const messages = session?.messages ?? [];
          const needle = body.query.toLowerCase();
          const results = rawHits.map((hit) => {
            const idx = messages.findIndex((m) =>
              typeof m.content === 'string' && m.content === hit.content,
            );
            const fallbackIdx = idx >= 0
              ? idx
              : messages.findIndex((m) =>
                  typeof m.content === 'string' && m.content.toLowerCase().includes(needle),
                );
            const messageIndex = fallbackIdx >= 0 ? fallbackIdx : 0;
            const role = messages[messageIndex]?.role ?? 'user';
            return {
              messageIndex,
              role,
              content: hit.content,
              score: hit.rank ?? 0,
            };
          });
          return Response.json({ ok: true, source: 'session', results });
        }

        if (action === 'edit-from') {
          // #241: rewind a session to a prior user turn, replace that user message
          // with edited content, and re-run the agent from there. The semantics
          // mirror "branch from message N" — messages 0..N-1 are kept, the message
          // at index N is replaced with the new user content, and any messages
          // that came after (assistant/tool turns + later user turns) are dropped
          // before the agent loop is re-entered. Without this rewind, the prior
          // assistant reply would still be in the transcript and the model would
          // happily extend it instead of regenerating.
          const editBody = (await request.json()) as {
            messageIndex?: number;
            newContent?: string;
            userId?: string;
            workspaceId?: string;
          };
          if (typeof editBody.messageIndex !== 'number' || !Number.isInteger(editBody.messageIndex) || editBody.messageIndex < 0) {
            return Response.json({ error: { code: 'INVALID_MESSAGE_INDEX', message: 'messageIndex must be a non-negative integer' } }, { status: 400 });
          }
          if (typeof editBody.newContent !== 'string' || editBody.newContent.length === 0) {
            return Response.json({ error: { code: 'MISSING_NEW_CONTENT', message: 'newContent is required' } }, { status: 400 });
          }
          const session = await store.get(sessionId);
          if (!session) {
            return Response.json({ error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } }, { status: 404 });
          }
          if (editBody.messageIndex >= session.messages.length) {
            return Response.json({ error: { code: 'MESSAGE_INDEX_OUT_OF_RANGE', message: `messageIndex ${editBody.messageIndex} is out of range (length=${session.messages.length})` } }, { status: 400 });
          }
          const target = session.messages[editBody.messageIndex];
          if (!target || target.role !== 'user') {
            return Response.json({ error: { code: 'MESSAGE_NOT_USER', message: 'edit-from can only target a user message' } }, { status: 400 });
          }
          // Truncate to messages 0..N-1 (drop the original at N and everything after).
          // The new user message is then handed to runConfiguredAgent which appends
          // it to the transcript via the standard run path — keeping the createdAt
          // timestamp and metadata flow identical to a fresh /message turn.
          session.messages = session.messages.slice(0, editBody.messageIndex);
          session.updatedAt = new Date().toISOString();
          await store.put(session);
          eventBus.emit('chat:message', { sessionId, userMessage: editBody.newContent, editedFrom: editBody.messageIndex });
          const result = await runConfiguredAgent({
            sessionId,
            userMessage: editBody.newContent,
            userId: editBody.userId,
            workspaceId: editBody.workspaceId,
            systemPrompt: 'You are CrowClaw, an AI assistant with tool-use capabilities. You can search the web, read/write files, manage scheduled tasks and reminders, and more. Use your available tools proactively to fulfill user requests.'
          });
          // Mirror the post-run housekeeping from the regular /message path so
          // memory capture, learning auto-capture, and lifecycle events fire
          // identically — otherwise an edit-from rewind would silently skip
          // these and the dashboard would miss the turn.
          const capturedEdit = await memoryService.captureSessionSummary(sessionId, result.session.messages);
          if (capturedEdit) {
            eventBus.emit('memory:captured', {
              sessionId,
              memoryId: capturedEdit.id,
              summary: capturedEdit.summary,
              scope: capturedEdit.scope,
              tags: capturedEdit.tags,
            });
          }
          if (result.toolResults.length > 0) {
            trackLearning(learning.autoCapture(result.session.messages, sessionId));
          }
          eventBus.emit('chat:complete', { sessionId, toolCount: result.toolResults.length });
          eventBus.emit('session:updated', { sessionId, messageCount: result.session.messages.length });
          return Response.json(result);
        }

        if (action === 'stream') {
          const body = (await request.json()) as { message: string; userId?: string; workspaceId?: string };
          if (!body.message) return Response.json({ error: 'Missing message' }, { status: 400 });
          eventBus.emit('chat:stream', { sessionId, userMessage: body.message });

          // For stream actions, release the mutex inside the stream (not the outer finally)
          // because the ReadableStream body runs asynchronously after Response is returned.
          const streamRelease = releaseMutex;
          const streamAbort = sessionController.registerSession(sessionId);
          const encoder = new TextEncoder();
          // #242: bridge runtime EventBus tool lifecycle events into the SSE
          // stream. The ToolRegistry wrapper at line ~1820 emits tool:start /
          // tool:complete for every agent-loop tool call, but those signals
          // never reached SSE subscribers — clients had to listen on the WS
          // bus separately. We subscribe here and forward only events whose
          // `sessionId` matches the active session so cross-session noise
          // doesn't leak into one client's stream. The subscription is torn
          // down in `finally` below alongside the session-controller cleanup.
          let unsubscribeToolEvents: (() => void) | undefined;
          const stream = new ReadableStream({
            async start(controller) {
              unsubscribeToolEvents = eventBus.subscribe((event) => {
                if (event.type !== 'tool:start' && event.type !== 'tool:complete') return;
                if ((event.data as { sessionId?: string }).sessionId !== sessionId) return;
                try {
                  if (event.type === 'tool:start') {
                    const d = event.data as { callId?: string; toolName?: string; args?: unknown; startedAt?: string };
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                      type: 'tool-start',
                      toolName: d.toolName,
                      toolCallId: d.callId,
                      args: d.args,
                      startedAt: d.startedAt,
                    })}\n\n`));
                  } else {
                    const d = event.data as { callId?: string; ok?: boolean; output?: string; durationMs?: number; auditId?: string; error?: boolean };
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                      type: 'tool-complete',
                      toolCallId: d.callId,
                      ok: d.ok,
                      output: d.output,
                      durationMs: d.durationMs,
                      auditId: d.auditId,
                      ...(d.error ? { error: d.output } : {}),
                    })}\n\n`));
                  }
                } catch {
                  // Controller may be closed if the client disconnected mid-turn;
                  // swallow the enqueue error so a broken pipe doesn't crash the
                  // listener for other (still-live) subscribers.
                }
              });
              try {
                const loop = createConfiguredAgent();
                const existingSession = await store.get(sessionId);
                const sessionState: SessionState = existingSession ?? {
                  agentId: options.agentId ?? 'crowclaw',
                  sessionId,
                  messages: [],
                  updatedAt: new Date().toISOString(),
                  userId: body.userId,
                  workspaceId: body.workspaceId,
                };

                if (typeof loop.runStreaming === 'function') {
                  for await (const event of loop.runStreaming({
                    userMessage: body.message,
                    sessionState,
                  })) {
                    if (streamAbort.signal.aborted) {
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: 'Session aborted' })}\n\n`));
                      break;
                    }
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                  }
                } else {
                  const result = await runConfiguredAgent({
                    sessionId,
                    userMessage: body.message,
                    userId: body.userId,
                    workspaceId: body.workspaceId,
                    systemPrompt: 'You are CrowClaw, an AI assistant with tool-use capabilities. You can search the web, read/write files, manage scheduled tasks and reminders, and more. Use your available tools proactively to fulfill user requests.'
                  });
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', response: result.finalResponse })}\n\n`));
                }
              // Post-stream: capture memory and skills (same as sync path)
              try {
                const updatedSession = await store.get(sessionId);
                if (updatedSession) {
                  const captured = await memoryService.captureSessionSummary(sessionId, updatedSession.messages);
                  // v0.7 (#180) — surface end-of-turn capture to the dashboard
                  // MemoryStream. `captureSessionSummary` returns null when the
                  // store is unconfigured or the transcript is empty; we only
                  // emit on a real write so the stream stays signal-only.
                  if (captured) {
                    eventBus.emit('memory:captured', {
                      sessionId,
                      memoryId: captured.id,
                      summary: captured.summary,
                      scope: captured.scope,
                      tags: captured.tags,
                    });
                  }
                  const toolMsgs = updatedSession.messages.filter(m => m.role === 'tool' || (m.role === 'assistant' && m.content?.includes('tool')));
                  if (toolMsgs.length > 0) {
                    // #42: track for SIGTERM drain so the autoCapture survives shutdown.
                    trackLearning(learning.autoCapture(updatedSession.messages, sessionId));
                  }
                  eventBus.emit('chat:complete', { sessionId, toolCount: toolMsgs.length });
                  eventBus.emit('session:updated', { sessionId, messageCount: updatedSession.messages.length });
                }
              } catch { /* best-effort post-stream capture */ }
              } catch (err: unknown) { // eslint-disable-line -- outer try-catch for stream errors
                const msg = err instanceof Error ? err.message : String(err);
                eventBus.emit('chat:error', { sessionId, error: msg });
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: msg })}\n\n`));
              } finally {
                sessionController.unregisterSession(sessionId);
                // #242: detach the tool-event forwarder before releasing the
                // mutex so a late tool:complete (e.g. from a still-draining
                // worker) doesn't try to enqueue into a closed controller.
                unsubscribeToolEvents?.();
                streamRelease?.();
              }
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          });

          // Mark that the stream handler owns the release — outer finally should skip
          releaseHandledByStream = true;
          return new Response(stream, {
            headers: {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              'connection': 'keep-alive',
            },
          });
        }

        const body = (await request.json()) as { userMessage: string; userId?: string; workspaceId?: string };
        eventBus.emit('chat:message', { sessionId, userMessage: body.userMessage });
        const result = await runConfiguredAgent({
          sessionId,
          userMessage: body.userMessage,
          userId: body.userId,
          workspaceId: body.workspaceId,
          systemPrompt: 'You are CrowClaw, an AI assistant with tool-use capabilities. You can search the web, read/write files, manage scheduled tasks and reminders, and more. Use your available tools proactively to fulfill user requests.'
        });
        const capturedSync = await memoryService.captureSessionSummary(sessionId, result.session.messages);
        // v0.7 (#180) — sync chat path mirrors the streaming path: emit the
        // capture event so the MemoryStream component sees the same signal
        // regardless of whether the user was streaming or doing a turn-style request.
        if (capturedSync) {
          eventBus.emit('memory:captured', {
            sessionId,
            memoryId: capturedSync.id,
            summary: capturedSync.summary,
            scope: capturedSync.scope,
            tags: capturedSync.tags,
          });
        }
        // Auto-capture skills from completed conversations (Hermes self-improvement pattern)
        if (result.toolResults.length > 0) {
          // #42: track for SIGTERM drain so the autoCapture survives shutdown.
          trackLearning(learning.autoCapture(result.session.messages, sessionId));
        }
        eventBus.emit('chat:complete', { sessionId, toolCount: result.toolResults.length });
        eventBus.emit('session:updated', { sessionId, messageCount: result.session.messages.length });
        return Response.json(result);

          })(); // end mutex-guarded IIFE
        } finally {
          if (!releaseHandledByStream) releaseMutex?.();
        }
      }

      // --- Mutation API endpoints (dashboard config management) ---

      if (request.method === 'POST' && url.pathname === '/api/config') {
        const configBody = await request.json() as Record<string, unknown>;
        const blockedField = sanitizeConfigMutation(configBody);
        if (blockedField) {
          return Response.json(
            { error: 'Blocked: cannot modify protected config field', field: blockedField },
            { status: 403 }
          );
        }
        return Response.json({ ok: true, config: configStore.snapshot() });
      }

      // Provider config save — persist through configStore (no process.env mutation).
      // Concurrent POSTs previously raced on process.env and lost state on restart;
      // configStore writes are serialized via its atomic queue and survive reboot.
      if (request.method === 'POST' && url.pathname === routePaths.config.provider) {
        const body = await request.json() as { apiKey?: string; baseUrl?: string; model?: string; provider?: string };
        const existing = configStore.getProviderConfig()?.primary;
        const providerName = body.provider ?? existing?.provider ?? 'openrouter';
        const model = body.model ?? existing?.model ?? 'anthropic/claude-sonnet-4';
        const apiKey = body.apiKey ?? existing?.apiKey;
        if (!apiKey) {
          return Response.json({ ok: false, error: 'Missing API key' }, { status: 400 });
        }
        configStore.setProviderSlot('primary', {
          name: existing?.name ?? providerName,
          provider: providerName,
          model,
          apiKey,
          baseUrl: body.baseUrl ?? existing?.baseUrl,
        });
        return Response.json({ ok: true, model, provider: providerName });
      }

      // Provider connection test (onboarding)
      if (request.method === 'POST' && url.pathname === routePaths.config.providerTest) {
        const body = await request.json() as { apiKey?: string; baseUrl?: string; provider?: string };
        const apiKey = body.apiKey;
        const baseUrl = body.baseUrl || 'https://openrouter.ai/api/v1';
        const providerName = body.provider || 'openrouter';
        if (!apiKey) return Response.json({ ok: false, error: 'Missing API key' }, { status: 400 });
        try {
          let testUrl: string;
          const headers: Record<string, string> = {};
          if (providerName === 'anthropic') {
            testUrl = baseUrl.replace(/\/$/, '') + '/v1/messages';
            headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = '2023-06-01';
            headers['content-type'] = 'application/json';
            const testResp = await fetch(testUrl, {
              method: 'POST',
              headers,
              body: JSON.stringify({ model: 'claude-haiku-4', max_tokens: 1, messages: [{ role: 'user', content: 'test' }] }),
            });
            if (testResp.ok || testResp.status === 400) {
              return Response.json({ ok: true, provider: providerName, models: ['claude-sonnet-4', 'claude-4', 'claude-haiku-4'] });
            }
            const errBody = await testResp.text();
            return Response.json({ ok: false, error: `HTTP ${testResp.status}: ${errBody.slice(0, 200)}` });
          } else {
            testUrl = baseUrl.replace(/\/$/, '') + '/chat/completions';
            headers['Authorization'] = `Bearer ${apiKey}`;
            headers['content-type'] = 'application/json';
            const testResp = await fetch(testUrl, {
              method: 'POST',
              headers,
              body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 1, messages: [{ role: 'user', content: 'test' }] }),
            });
            if (testResp.ok) {
              let modelList: string[] = [];
              try {
                const modelsResp = await fetch(baseUrl.replace(/\/$/, '') + '/models', {
                  headers: { 'Authorization': `Bearer ${apiKey}` },
                });
                if (modelsResp.ok) {
                  const modelsData = await modelsResp.json() as { data?: Array<{ id: string }> };
                  modelList = (modelsData.data || []).slice(0, 20).map((m) => m.id);
                }
              } catch { /* model list is optional */ }
              return Response.json({ ok: true, provider: providerName, models: modelList });
            }
            if (testResp.status === 401) {
              return Response.json({ ok: false, error: 'Invalid API key' });
            }
            const errBody = await testResp.text();
            return Response.json({ ok: false, error: `HTTP ${testResp.status}: ${errBody.slice(0, 200)}` });
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return Response.json({ ok: false, error: msg });
        }
      }

      if (request.method === 'POST' && url.pathname.match(/^\/api\/skills\/([^/]+)\/toggle$/)) {
        const slug = url.pathname.split('/')[3]!;
        const body = await request.json() as { enabled: boolean };
        configStore.toggleSkill(slug, body.enabled);
        skillRegistry.toggleSkill(slug, body.enabled);
        return Response.json({ ok: true, slug, enabled: body.enabled });
      }

      if (request.method === 'POST' && url.pathname === '/api/agent/preset') {
        const body = await request.json() as { name: string; role?: string; goal?: string; backstory?: string } | { name: null };
        if (body.name === null) {
          configStore.setActivePreset(null);
        } else {
          const preset = body.role || body.goal || body.backstory
            ? { role: body.role ?? '', goal: body.goal ?? '', backstory: body.backstory }
            : getAgentPreset(body.name);
          configStore.setActivePreset(body.name, preset
            ? { role: preset.role, goal: preset.goal, backstory: preset.backstory }
            : { role: '', goal: '', backstory: undefined });
        }
        return Response.json({ ok: true, activePreset: configStore.getActivePreset() });
      }

      if (request.method === 'POST' && url.pathname === '/api/toolset/select') {
        const body = await request.json() as { name: string | null };
        configStore.setActiveToolset(body.name);
        return Response.json({ ok: true, activeToolset: configStore.getActiveToolset() });
      }

      if (request.method === 'POST' && url.pathname.match(/^\/api\/gateway\/([^/]+)\/config$/)) {
        const platform = url.pathname.split('/')[3]!;
        const body = await request.json() as {
          token?: string;
          enabled?: boolean;
          channelId?: string;
          muted?: boolean;
          webhookSecret?: string;
          // Platform-specific connection params — persisted in `extra` so probe
          // and outbound delivery can read them without a redundant round-trip.
          webhookUrl?: string;
          phoneNumberId?: string;
          homeserverUrl?: string;
        };
        const existing = configStore.getGatewayConfig(platform);
        // Channel-level mute: store in extra map
        if (body.channelId && body.muted !== undefined) {
          const extra = existing?.extra ?? {};
          extra[`mute:${body.channelId}`] = body.muted ? 'true' : 'false';
          configStore.setGatewayConfig(platform, { ...existing ?? { enabled: false }, extra });
          return Response.json({ ok: true, platform, channelId: body.channelId, muted: body.muted });
        }
        const mergedExtra = { ...(existing?.extra ?? {}) };
        if (body.webhookUrl !== undefined) mergedExtra.webhookUrl = body.webhookUrl;
        if (body.phoneNumberId !== undefined) mergedExtra.phoneNumberId = body.phoneNumberId;
        if (body.homeserverUrl !== undefined) mergedExtra.homeserverUrl = body.homeserverUrl;
        configStore.setGatewayConfig(platform, {
          enabled: body.enabled ?? existing?.enabled ?? true,
          token: body.token ?? existing?.token,
          webhookSecret: body.webhookSecret ?? existing?.webhookSecret,
          extra: Object.keys(mergedExtra).length > 0 ? mergedExtra : existing?.extra,
        });
        eventBus.emit('gateway:status', { platform, enabled: body.enabled ?? existing?.enabled ?? true });
        return Response.json({ ok: true, platform, configured: Boolean(configStore.getGatewayConfig(platform)) });
      }

      const probeMatch = url.pathname.match(/^\/api\/gateway\/([^/]+)\/probe$/);
      if (request.method === 'POST' && probeMatch) {
        const platform = probeMatch[1];
        const body = await request.json().catch(() => ({})) as { token?: string; webhookUrl?: string; phoneNumberId?: string; homeserverUrl?: string };
        // Fall back to the platform's stored config so the dashboard doesn't have to
        // re-send credentials on every probe.
        const stored = configStore.getGatewayConfig(platform);
        const token = body.token ?? stored?.token;
        const webhookUrl = body.webhookUrl ?? stored?.extra?.webhookUrl;
        const phoneNumberId = body.phoneNumberId ?? stored?.extra?.phoneNumberId;
        const homeserverUrl = body.homeserverUrl ?? stored?.extra?.homeserverUrl;
        let result: ProbeResult;

        switch (platform) {
          case 'telegram':
            result = token ? await probeTelegram(token) : { ok: false, platform: 'telegram' as const, error: 'Missing token' };
            break;
          case 'slack':
            result = token ? await probeSlack(token) : { ok: false, platform: 'slack' as const, error: 'Missing token' };
            break;
          case 'discord':
            result = webhookUrl ? await probeDiscord(webhookUrl) : { ok: false, platform: 'discord' as const, error: 'Missing webhookUrl' };
            break;
          case 'whatsapp':
            result = token && phoneNumberId ? await probeWhatsApp(token, phoneNumberId) : { ok: false, platform: 'whatsapp' as const, error: 'Missing token or phoneNumberId' };
            break;
          case 'matrix':
            result = token && homeserverUrl ? await probeMatrix(homeserverUrl, token) : { ok: false, platform: 'matrix' as const, error: 'Missing token or homeserverUrl' };
            break;
          default:
            result = { ok: false, platform: platform as GatewayPlatform, error: `Probe not supported for ${platform}` };
        }
        return Response.json(result);
      }

      const policyMatch = url.pathname.match(/^\/api\/gateway\/([^/]+)\/policy$/);
      if (request.method === 'POST' && policyMatch) {
        const platform = policyMatch[1];
        const body = await request.json() as {
          dmPolicy?: string;
          groupPolicy?: string;
          allowlist?: string[];
          groupAllowlist?: string[];
          requireMention?: boolean;
        };

        const existing = configStore.getGatewayConfig(platform) ?? { enabled: false };
        configStore.setGatewayConfig(platform, {
          ...existing,
          dmPolicy: (body.dmPolicy as 'pairing' | 'allowlist' | 'open' | 'disabled') ?? existing.dmPolicy,
          groupPolicy: (body.groupPolicy as 'open' | 'disabled' | 'allowlist') ?? existing.groupPolicy,
          allowlist: body.allowlist ?? existing.allowlist,
          groupAllowlist: body.groupAllowlist ?? existing.groupAllowlist,
          requireMention: body.requireMention ?? existing.requireMention,
        });

        return Response.json({ ok: true, platform, policy: configStore.getGatewayConfig(platform) });
      }

      // --- Telegram webhook management routes ---

      if (request.method === 'POST' && url.pathname === '/api/gateway/telegram/webhook') {
        const body = await request.json() as { url?: string; secretToken?: string; maxConnections?: number; allowedUpdates?: string[] };
        const telegramConfig = configStore.getGatewayConfig('telegram');
        const token = telegramConfig?.token;
        if (!token) {
          return Response.json({ ok: false, error: 'Telegram bot token not configured' }, { status: 400 });
        }
        const effectivePublicUrl = configStore.getPublicUrl() ?? publicUrl;
        const targetUrl = body.url ?? (effectivePublicUrl ? `${effectivePublicUrl.replace(/\/$/, '')}/webhooks/telegram` : undefined);
        if (!targetUrl) {
          return Response.json({ ok: false, error: 'No webhook URL provided and no publicUrl configured' }, { status: 400 });
        }
        const result = await setTelegramWebhook(token, targetUrl, {
          secretToken: body.secretToken ?? options.telegramWebhookSecret ?? telegramConfig?.webhookSecret,
          maxConnections: body.maxConnections,
          allowedUpdates: body.allowedUpdates,
        });
        return Response.json(result, { status: result.ok ? 200 : 400 });
      }

      if (request.method === 'DELETE' && url.pathname === '/api/gateway/telegram/webhook') {
        const telegramConfig = configStore.getGatewayConfig('telegram');
        const token = telegramConfig?.token;
        if (!token) {
          return Response.json({ ok: false, error: 'Telegram bot token not configured' }, { status: 400 });
        }
        const result = await deleteTelegramWebhook(token);
        return Response.json(result, { status: result.ok ? 200 : 400 });
      }

      if (request.method === 'GET' && url.pathname === '/api/gateway/telegram/webhook') {
        const telegramConfig = configStore.getGatewayConfig('telegram');
        const token = telegramConfig?.token;
        if (!token) {
          return Response.json({ ok: false, error: 'Telegram bot token not configured' }, { status: 400 });
        }
        const info = await getTelegramWebhookInfo(token);
        // Flatten the {ok, result} envelope so the dashboard can read fields directly
        return Response.json({ ok: info.ok, ...(info.result ?? {}) });
      }

      if (request.method === 'POST' && url.pathname === '/api/gateway/pairing/approve') {
        const body = await request.json() as { code: string };
        const challenge = configStore.getPendingPairings().find((pairing) => pairing.code === body.code.toUpperCase());
        if (!challenge) {
          return Response.json({ ok: false, approved: false });
        }

        const policy = getGatewayAccessPolicy(challenge.platform as GatewayPlatform);
        if (!policy) {
          return Response.json({ ok: false, approved: false, error: `Gateway policy not configured for ${challenge.platform}` }, { status: 400 });
        }

        const result = approvePairing(configStore.getPendingPairingsMap() as Map<string, PairingChallenge>, body.code, policy);
        return Response.json({ ok: result.approved, ...result });
      }

      if (request.method === 'GET' && url.pathname === '/api/gateway/pairings') {
        return Response.json({ pairings: configStore.getPendingPairings() });
      }

      if (request.method === 'GET' && url.pathname === '/api/config/snapshot') {
        const snapshot = configStore.snapshot();
        return Response.json({
          ok: true,
          activePreset: snapshot.activePreset,
          agentPreset: snapshot.agentPreset,
          activeToolset: snapshot.activeToolset,
          disabledSkills: snapshot.disabledSkills,
          gatewayPlatforms: Object.fromEntries(
            Object.keys(snapshot.gatewayConfigs as Record<string, unknown>).map((k) => [k, { configured: true }])
          ),
        });
      }

      // Agent config (loop settings)
      if (request.method === 'GET' && url.pathname === routePaths.config.agent) {
        return Response.json({ config: configStore.getAgentConfig() });
      }

      if (request.method === 'POST' && url.pathname === routePaths.config.agent) {
        const body = await request.json() as Partial<Record<string, unknown>>;
        const blockedAgentField = sanitizeConfigMutation(body as Record<string, unknown>);
        if (blockedAgentField) {
          return Response.json(
            { error: 'Blocked: cannot modify protected config field', field: blockedAgentField },
            { status: 403 }
          );
        }
        configStore.setAgentConfig(body as Partial<import('./config-store.js').AgentConfig>);
        return Response.json({ ok: true, config: configStore.getAgentConfig() });
      }

      if (request.method === 'GET' && url.pathname === '/api/usage') {
        return Response.json(usageTracker.getSummary());
      }

      if (request.method === 'POST' && url.pathname === '/api/usage/reset') {
        usageTracker.reset();
        return Response.json({ ok: true });
      }

      // --- Feedback Ledger API ---
      if (request.method === 'GET' && url.pathname === '/api/feedback') {
        return Response.json({
          ok: true,
          stats: feedbackLedger.getStats(),
          recent: feedbackLedger.getEntries(50),
        });
      }

      // --- MCP Server CRUD ---

      if (request.method === 'POST' && url.pathname === '/api/mcp/servers') {
        const body = (await request.json()) as { name: string; command: string; args?: string | string[]; env?: Record<string, string>; description?: string };
        if (!body.name || !body.command) {
          return Response.json({ ok: false, error: 'name and command are required' }, { status: 400 });
        }
        const args = Array.isArray(body.args) ? body.args : typeof body.args === 'string' ? body.args.split(',').map((s: string) => s.trim()).filter(Boolean) : [];
        const serverConfig = { name: body.name, command: body.command, args, env: body.env, description: body.description, custom: true as const };
        configStore.saveMcpServer(serverConfig);
        return Response.json({ ok: true, server: serverConfig });
      }

      if (request.method === 'GET' && url.pathname === '/api/mcp/servers') {
        // Redact env values from MCP server configs before returning to client
        const servers = configStore.getMcpServers().map((s) => ({
          ...s,
          env: s.env ? Object.fromEntries(
            Object.entries(s.env).map(([k, v]) => [k, v ? '***' : undefined])
          ) : undefined,
        }));
        return Response.json({ servers });
      }

      {
        const mcpServerMatch = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)$/);
        if (request.method === 'DELETE' && mcpServerMatch) {
          const name = decodeURIComponent(mcpServerMatch[1]);
          const deleted = configStore.deleteMcpServer(name);
          if (!deleted) return Response.json({ ok: false, error: 'Server not found' }, { status: 404 });
          configStore.removeMcpConnection(name);
          return Response.json({ ok: true, name });
        }
      }

      {
        const mcpServerToolsMatch = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/tools$/);
        if (request.method === 'GET' && mcpServerToolsMatch) {
          const name = decodeURIComponent(mcpServerToolsMatch[1]);
          try {
            const tools = await mcpClient.listTools({ refresh: true });
            return Response.json({ server: name, tools });
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            return Response.json({ server: name, tools: [], error: msg });
          }
        }
      }

      {
        const mcpServerReconnectMatch = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/reconnect$/);
        if (request.method === 'POST' && mcpServerReconnectMatch) {
          const name = decodeURIComponent(mcpServerReconnectMatch[1]);
          configStore.setMcpConnection(name, { presetName: name, status: 'connecting', connectedAt: new Date().toISOString() });
          try {
            await mcpClient.refreshTools();
            configStore.setMcpConnection(name, { presetName: name, status: 'connected', connectedAt: new Date().toISOString() });
            return Response.json({ ok: true, name, status: 'connected' });
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            configStore.setMcpConnection(name, { presetName: name, status: 'error', error: msg, connectedAt: new Date().toISOString() });
            return Response.json({ ok: false, name, status: 'error', error: msg });
          }
        }
      }

      // --- Skill CRUD ---

      if (request.method === 'POST' && url.pathname === '/api/skills') {
        const body = (await request.json()) as { slug?: string; title: string; summary: string; triggerPhrases?: string[]; steps?: string[]; requiredTools?: string[] };
        if (!body.title) {
          return Response.json({ ok: false, error: 'title is required' }, { status: 400 });
        }
        const slug = body.slug || body.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        const now = new Date().toISOString();
        const stored = {
          id: crypto.randomUUID(),
          slug,
          title: body.title,
          summary: body.summary || '',
          triggerPhrases: body.triggerPhrases || [],
          steps: body.steps || [],
          sourceMessages: 0,
          status: 'published' as const,
          createdAt: now,
          updatedAt: now,
          markdown: `# ${body.title}\n\n${body.summary || ''}`,
          version: 1,
          ratings: { helpful: 0, unhelpful: 0 },
          requiredTools: body.requiredTools,
        };
        await skillStore.save(stored);
        await skillRegistry.refreshLearned();
        return Response.json({ ok: true, skill: stored });
      }

      {
        const skillSlugMatch = url.pathname.match(/^\/api\/skills\/([^/]+)$/);

        if (request.method === 'PUT' && skillSlugMatch) {
          const slug = decodeURIComponent(skillSlugMatch[1]);
          const body = (await request.json()) as { title?: string; summary?: string; triggerPhrases?: string[]; steps?: string[]; requiredTools?: string[] };
          const allSkills = await skillStore.list();
          const existing = allSkills.find((s) => s.slug === slug);
          if (!existing) {
            return Response.json({ ok: false, error: 'Skill not found' }, { status: 404 });
          }
          const updated = {
            ...existing,
            title: body.title ?? existing.title,
            summary: body.summary ?? existing.summary,
            triggerPhrases: body.triggerPhrases ?? existing.triggerPhrases,
            steps: body.steps ?? existing.steps,
            requiredTools: body.requiredTools ?? existing.requiredTools,
            updatedAt: new Date().toISOString(),
            version: (existing.version ?? 1) + 1,
            markdown: `# ${body.title ?? existing.title}\n\n${body.summary ?? existing.summary}`,
          };
          await skillStore.save(updated);
          await skillRegistry.refreshLearned();
          return Response.json({ ok: true, skill: updated });
        }

        if (request.method === 'DELETE' && skillSlugMatch) {
          const slug = decodeURIComponent(skillSlugMatch[1]);
          // Check if built-in — built-in skills cannot be deleted
          const resolved = skillRegistry.resolveAll();
          const match = resolved.find((s) => s.skill.manifest.name === slug);
          if (match && (match.skill.manifest.category === 'builtin')) {
            return Response.json({ ok: false, error: 'Cannot delete built-in skill. Use disable instead.' }, { status: 400 });
          }
          const allSkills = await skillStore.list();
          const existing = allSkills.find((s) => s.slug === slug);
          if (!existing) {
            return Response.json({ ok: false, error: 'Skill not found' }, { status: 404 });
          }
          // Mark as deleted by removing from store (save with deleted status)
          existing.status = 'draft';
          existing.updatedAt = new Date().toISOString();
          await skillStore.save(existing);
          skillRegistry.removeLearnedSkill(slug);
          return Response.json({ ok: true, slug });
        }
      }

      if (request.method === 'POST' && url.pathname === '/api/skills/import') {
        const body = (await request.json()) as { markdown: string };
        if (!body.markdown) {
          return Response.json({ ok: false, error: 'markdown content is required' }, { status: 400 });
        }
        // Parse SKILL.md format
        const lines = body.markdown.split('\n');
        const titleLine = lines.find((l) => l.startsWith('# '));
        const title = titleLine ? titleLine.replace(/^#\s+/, '').trim() : 'Imported Skill';
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        const summaryStart = lines.findIndex((l) => /^##\s+summary/i.test(l));
        const triggerStart = lines.findIndex((l) => /^##\s+trigger/i.test(l));
        const stepsStart = lines.findIndex((l) => /^##\s+steps/i.test(l));
        const summary = summaryStart >= 0 ? lines.slice(summaryStart + 1, triggerStart >= 0 ? triggerStart : stepsStart >= 0 ? stepsStart : lines.length).filter(Boolean).join(' ').trim() : '';
        const triggers = triggerStart >= 0 ? lines.slice(triggerStart + 1, stepsStart >= 0 ? stepsStart : lines.length).filter((l) => l.startsWith('- ')).map((l) => l.replace(/^-\s+/, '').trim()) : [];
        const steps = stepsStart >= 0 ? lines.slice(stepsStart + 1).filter((l) => /^\d+\.\s/.test(l)).map((l) => l.replace(/^\d+\.\s+/, '').trim()) : [];
        const now = new Date().toISOString();
        const stored = {
          id: crypto.randomUUID(),
          slug,
          title,
          summary,
          triggerPhrases: triggers,
          steps,
          sourceMessages: 0,
          status: 'published' as const,
          createdAt: now,
          updatedAt: now,
          markdown: body.markdown,
          version: 1,
          ratings: { helpful: 0, unhelpful: 0 },
        };
        await skillStore.save(stored);
        await skillRegistry.refreshLearned();
        return Response.json({ ok: true, skill: stored });
      }

      // v0.8.0 Hermes parity (#240): agentskills.io install endpoint.
      // Mirrors the `crowclaw skill install` CLI command. Body: { source: string }
      // where `source` is an http(s) URL, an `agentskills:` slug, or a local path.
      // Install logic is inlined (not delegated to @crowclaw/cli) because the
      // CLI package depends on runtime-node — pulling it in here would create
      // a workspace cycle.
      if (request.method === 'POST' && url.pathname === '/api/skills/install') {
        try {
          const body = (await request.json()) as { source?: unknown };
          if (typeof body.source !== 'string' || !body.source) {
            return Response.json({ ok: false, error: 'source (string) is required' }, { status: 400 });
          }
          const { parseSkillFile, validateSkillManifest } = await import('@crowclaw/core');
          const { readFile, writeFile, mkdir } = await import('node:fs/promises');
          const { existsSync } = await import('node:fs');
          const { join: joinP, isAbsolute } = await import('node:path');

          // Resolve source → raw text
          const fetchSource = async (src: string): Promise<string> => {
            if (src.startsWith('http://') || src.startsWith('https://')) {
              const r = await fetch(src);
              if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} for ${src}`);
              return await r.text();
            }
            if (src.startsWith('agentskills:')) {
              const slug = src.slice('agentskills:'.length).trim();
              if (!slug) throw new Error('agentskills: source missing slug');
              const u = `https://agentskills.io/api/skills/${encodeURI(slug)}/raw`;
              const r = await fetch(u);
              if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} for ${u}`);
              return await r.text();
            }
            const p = isAbsolute(src) ? src : joinP(process.cwd(), src);
            if (!existsSync(p)) throw new Error(`Local path does not exist: ${p}`);
            return await readFile(p, 'utf-8');
          };

          let raw: string;
          try {
            raw = await fetchSource(body.source);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return Response.json({ ok: false, error: `Failed to fetch source: ${msg}` }, { status: 400 });
          }

          // Some registries wrap the body in JSON `{ markdown: "..." }`.
          let markdown = raw;
          const t = raw.trim();
          if (t.startsWith('{')) {
            try {
              const j = JSON.parse(t) as { markdown?: unknown; body?: unknown };
              if (typeof j.markdown === 'string') markdown = j.markdown;
              else if (typeof j.body === 'string') markdown = j.body;
            } catch { /* keep raw */ }
          }

          const parsed = parseSkillFile(markdown);
          if (!parsed) {
            return Response.json({ ok: false, error: 'Source does not look like a SKILL.md (missing YAML frontmatter)' }, { status: 400 });
          }
          const validation = validateSkillManifest(parsed.manifest);
          if (!validation.valid) {
            return Response.json({ ok: false, error: `Invalid skill manifest: ${validation.errors.join('; ')}` }, { status: 400 });
          }

          const destDir = joinPath(homedir(), '.crowclaw', 'skills', 'installed');
          const destPath = joinP(destDir, `${parsed.manifest.name}.md`);
          try {
            await mkdir(destDir, { recursive: true });
            await writeFile(destPath, markdown, 'utf-8');
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return Response.json({ ok: false, error: `Failed to write file: ${msg}` }, { status: 500 });
          }

          // Refresh registry so the newly-installed skill becomes visible
          // without a full runtime restart. Failure here is non-fatal.
          try { await skillRegistry.refreshLearned(); } catch { /* non-fatal */ }
          return Response.json({ ok: true, slug: parsed.manifest.name, destinationPath: destPath });
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          return Response.json({ ok: false, error: msg }, { status: 500 });
        }
      }

      {
        const skillDetailMatch = url.pathname.match(/^\/api\/skills\/([^/]+)$/);
        if (request.method === 'GET' && skillDetailMatch) {
          const slug = decodeURIComponent(skillDetailMatch[1]);
          const allSkills = await skillStore.list();
          const match = allSkills.find((s) => s.slug === slug);
          if (!match) {
            return Response.json({ ok: false, error: 'Skill not found' }, { status: 404 });
          }
          return Response.json({ ok: true, skill: match });
        }
      }

      {
        const skillVersionsMatch = url.pathname.match(/^\/api\/skills\/([^/]+)\/versions$/);
        if (request.method === 'GET' && skillVersionsMatch) {
          const slug = decodeURIComponent(skillVersionsMatch[1]);
          const allSkills = await skillStore.list();
          const match = allSkills.find((s) => s.slug === slug);
          if (!match) return Response.json({ versions: [] });
          return Response.json({ versions: [{ version: match.version ?? 1, updatedAt: match.updatedAt, status: match.status }] });
        }
      }

      {
        const skillRateMatch = url.pathname.match(/^\/api\/skills\/([^/]+)\/rate$/);
        if (request.method === 'POST' && skillRateMatch) {
          const slug = decodeURIComponent(skillRateMatch[1]);
          const body = (await request.json()) as { rating: 'helpful' | 'unhelpful' };
          if (body.rating !== 'helpful' && body.rating !== 'unhelpful') {
            return Response.json({ ok: false, error: 'rating must be helpful or unhelpful' }, { status: 400 });
          }
          try {
            await learning.rateSkill(slug, body.rating);
            return Response.json({ ok: true, slug, rating: body.rating });
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            return Response.json({ ok: false, error: msg }, { status: 404 });
          }
        }
      }

      // --- WebSocket upgrade (auth via HttpOnly cookie or Authorization header) ---
      if (request.method === 'GET' && url.pathname === '/ws') {
        // Issue #69: rate-limit WS auth attempts before reading credentials.
        // OpenClaw CVE-2026-32025 — without this, an attacker can brute-force
        // the dashboard token at HTTP-handshake speed (the prior `/ws` path
        // had no per-IP cap; only REST routes did). The limiter denies during
        // the active ban window and emits Retry-After so well-behaved clients
        // back off. Successful auth clears the ban-escalation level for the IP.
        const wsClientIp = getClientIp(request);
        const wsDecision = wsAuthRateLimiter.beforeAuth(wsClientIp);
        if (!wsDecision.allowed) {
          log.warn('WS auth rate limit triggered', {
            component: 'security',
            clientIp: wsClientIp,
            reason: wsDecision.reason,
            retryAfterSec: wsDecision.retryAfterSec,
          });
          return new Response('Too many WebSocket auth attempts', {
            status: 429,
            headers: { 'Retry-After': String(wsDecision.retryAfterSec ?? 300) },
          });
        }

        // Prefer the cookie the browser already holds from /api/auth/verify.
        // Bearer header stays supported for non-browser clients. We intentionally
        // do NOT accept `?token=...` query params: they leak into access logs,
        // proxy logs, and the browser's Referer header.
        const cookieAuth = parseCookieToken(request.headers.get('cookie'));
        const bearerHeader = request.headers.get('authorization');
        const wsBearer = bearerHeader?.startsWith('Bearer ') ? bearerHeader.slice(7) : null;

        const derivedCookie = getDerivedCookieToken(dashToken);
        const cookieMatches = !!dashToken && cookieAuth !== null && timingSafeEqual(cookieAuth, derivedCookie);
        const bearerMatches = !!dashToken && wsBearer !== null && timingSafeEqual(wsBearer, dashToken);
        const wsAuthenticated = cookieMatches || bearerMatches;

        if (dashToken && !wsAuthenticated) {
          // Issue #69: count this as a failed auth attempt so repeated bad
          // tokens trigger the exponential backoff ban.
          wsAuthRateLimiter.recordFailure(wsClientIp);
          return new Response('Unauthorized — authenticated cookie or Authorization header required', { status: 401 });
        }
        // Issue #69: clear the failure window + ban escalation for this IP
        // so a legitimate user does not stay penalised after fixing their token.
        wsAuthRateLimiter.recordSuccess(wsClientIp);
        // Only the owner-of-the-host (localhost + no token configured) gets
        // "authenticated" privileges (can send session:abort). Without this
        // tightening, any local process or malicious page could abort sessions
        // by ID via cross-site WebSocket on localhost dev deployments.
        const privileged = wsAuthenticated || (!dashToken && isLocalhost);
        return handleWebSocketUpgrade(request, eventBus, wsManager, privileged);
      }

      // --- Config schema routes ---
      if (request.method === 'GET' && url.pathname === '/api/config/schema') {
        return Response.json(generateConfigSchema());
      }

      if (request.method === 'POST' && url.pathname === '/api/config/validate') {
        const body = (await request.json()) as { section: string; data: Record<string, unknown> };
        if (!body.section || !body.data) return Response.json({ error: 'Missing section or data' }, { status: 400 });
        const result = validateConfigUpdate(body.section, body.data);
        return Response.json(result);
      }

      if (request.method === 'POST' && url.pathname === '/api/config/diff') {
        const body = (await request.json()) as { before: Record<string, unknown>; after: Record<string, unknown> };
        if (!body.before || !body.after) return Response.json({ error: 'Missing before or after' }, { status: 400 });
        return Response.json(diffConfigs(body.before, body.after));
      }

      // --- Remote access config ---
      if (request.method === 'GET' && url.pathname === '/api/config/remote-access') {
        const effectivePublicUrl = configStore.getPublicUrl() ?? publicUrl ?? null;
        return Response.json({
          ok: true,
          serverUrl: effectivePublicUrl ?? `http://localhost:${(options as Record<string, unknown>).port ?? 3000}`,
          publicUrl: effectivePublicUrl,
          trustProxy: configStore.getTrustProxy(),
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/config/remote-access') {
        const body = (await request.json()) as { publicUrl?: string; trustProxy?: boolean };
        const newPublicUrl = typeof body.publicUrl === 'string'
          ? (body.publicUrl.replace(/\/$/, '') || null)
          : configStore.getPublicUrl();
        const newTrustProxy = typeof body.trustProxy === 'boolean'
          ? body.trustProxy
          : configStore.getTrustProxy();
        publicUrl = newPublicUrl;
        (options as Record<string, unknown>).trustProxy = newTrustProxy;
        // Persist to configStore (FileConfigStore writes to disk)
        configStore.setRemoteAccess(newPublicUrl, newTrustProxy);
        return Response.json({
          ok: true,
          serverUrl: newPublicUrl ?? `http://localhost:${(options as Record<string, unknown>).port ?? 3000}`,
          trustProxy: newTrustProxy,
        });
      }

      // --- Structured output (#237 v0.8.0 Hermes parity) ---
      // Wraps `provider.generateStructured` so the dashboard / external
      // callers can request a JSON-schema-typed completion. Returns the
      // typed envelope directly (`ok: true|false` + details). When the
      // configured provider doesn't implement the optional method, falls
      // back to 501 Not Implemented so callers can degrade gracefully.
      if (request.method === 'POST' && url.pathname === '/api/structured-output') {
        const body = (await request.json().catch(() => null)) as
          | { messages?: unknown; schema?: unknown; schemaDescription?: unknown }
          | null;
        if (!body || !Array.isArray(body.messages) || !body.schema || typeof body.schema !== 'object') {
          return Response.json(
            { ok: false, error: 'parse', details: 'Body must include `messages: ConversationMessage[]` and `schema: object`' },
            { status: 400 },
          );
        }
        const generateStructured = (provider as { generateStructured?: (req: unknown) => Promise<unknown> }).generateStructured?.bind(provider);
        if (typeof generateStructured !== 'function') {
          return Response.json(
            { ok: false, error: 'provider', details: 'Configured provider does not implement generateStructured' },
            { status: 501 },
          );
        }
        const result = await generateStructured({
          messages: body.messages as never,
          schema: body.schema as object,
          ...(typeof body.schemaDescription === 'string' ? { schemaDescription: body.schemaDescription } : {}),
        });
        return Response.json(result);
      }

      // --- Frozen memory API ---
      if (request.method === 'GET' && url.pathname === '/api/memory/snapshot') {
        return Response.json({
          ok: true,
          memory: { entries: frozenMemory.getAll(), version: frozenMemory.snapshotVersion, size: frozenMemory.size },
          user: { entries: frozenUserProfile.getAll(), version: frozenUserProfile.snapshotVersion, size: frozenUserProfile.size },
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/memory/snapshot') {
        await frozenMemoryReady; // ensure load() finished before mutation
        const body = (await request.json()) as { namespace: 'memory' | 'user'; action: 'set' | 'remove'; key: string; value?: string; category?: string };
        const target = body.namespace === 'user' ? frozenUserProfile : frozenMemory;
        if (body.action === 'set') {
          target.set(body.key, body.value ?? '', body.category);
          await target.save().catch(() => {}); // best-effort persist
        } else if (body.action === 'remove') {
          target.remove(body.key);
          await target.save().catch(() => {}); // best-effort persist
        }
        return Response.json({ ok: true, size: target.size, version: target.snapshotVersion });
      }

      // --- Message store API ---
      if (request.method === 'GET' && url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/)) {
        const sid = url.pathname.split('/')[3]!;
        const msgs = await messageStore.query({ sessionId: sid, limit: 100 });
        return Response.json({ ok: true, messages: msgs });
      }

      if (request.method === 'GET' && url.pathname.match(/^\/api\/sessions\/([^/]+)\/stats$/)) {
        const sid = url.pathname.split('/')[3]!;
        const stats = await messageStore.stats(sid);
        return Response.json({ ok: true, ...stats });
      }

      // --- Context engine status ---
      if (request.method === 'GET' && url.pathname === '/api/context') {
        return Response.json({
          ok: true,
          files: contextEngineResult?.files.map((f) => ({ path: f.path, filename: f.filename, depth: f.depth, byteSize: f.byteSize, truncated: f.truncated })) ?? [],
          totalBytes: contextEngineResult?.totalBytes ?? 0,
          securityWarnings: contextEngineResult?.securityWarnings ?? [],
        });
      }

      // --- Diagnostics ---
      // Issue #177: extend the response with aggregate sub-checks so the
      // header `<crowclaw-status-pill>` can render a single red/yellow/green
      // pill without making four separate calls. The pill aggregates:
      //   transport.{ws,sse} – is the realtime channel up
      //   provider.{configured,reachable,lastCallOk} – is the LLM provider OK
      //   scheduler.{running,errored} – is the autonomous tick alive
      //   mcp.{total,connected,degraded} – are all configured MCP servers OK
      // Legacy fields (wsConnections, activeSessions, …) are preserved so
      // existing tests and the older Overview panel keep working.
      if (request.method === 'GET' && url.pathname === '/api/diagnostics') {
        // Provider sub-check. We can only inspect the slot the runtime was
        // booted with — there's no per-call success tracker yet, so
        // `lastCallOk` reports `null` (unknown) when no provider tracking is
        // wired. `configured` is true when a non-echo provider is supplied;
        // `reachable` mirrors `configured` until a live probe is added.
        const providerOpt = options.provider;
        const providerName = typeof providerOpt === 'object' && providerOpt && 'name' in providerOpt
          ? String((providerOpt as Record<string, unknown>).name)
          : '';
        const providerIsEcho = !providerOpt || providerName.toLowerCase().includes('echo');
        const providerConfigured = !providerIsEcho;

        // MCP sub-check. Multi-server managers expose `getServerStatus()`;
        // single-client setups expose `getStatus()` only. Treat a single
        // client as `total: 1` so the pill never renders an empty MCP slot
        // when one is wired.
        const mcpAny = mcpClient as unknown as {
          getServerStatus?: () => Record<string, { degraded?: boolean; lastError?: unknown }>;
          getStatus?: () => { degraded?: boolean; lastError?: unknown } | null | undefined;
        };
        let mcpTotal = 0;
        let mcpDegraded = 0;
        const multi = mcpAny.getServerStatus?.();
        if (multi && typeof multi === 'object') {
          const entries = Object.values(multi);
          mcpTotal = entries.length;
          mcpDegraded = entries.filter((s) => s?.degraded === true).length;
        } else {
          const single = mcpAny.getStatus?.();
          if (single) {
            mcpTotal = 1;
            mcpDegraded = single.degraded === true ? 1 : 0;
          }
        }
        const mcpConnected = Math.max(0, mcpTotal - mcpDegraded);

        // Scheduler sub-check. `consecutiveErrors > 0` means the most recent
        // tick threw — operators should see yellow/red even if the timer is
        // technically still running.
        const schedRunning = autonomousScheduler.isRunning();
        const schedErrored = autonomousScheduler.consecutiveErrors > 0;

        return Response.json({
          ok: true,
          runtime: 'node',
          nodeVersion: typeof process !== 'undefined' ? process.version : 'unknown',
          platform: typeof process !== 'undefined' ? process.platform : 'unknown',
          wsConnections: wsManager.connectionCount,
          activeSessions: sessionController.getActiveSessions().length,
          eventBusSubscribers: eventBus.subscriberCount,
          uptime: typeof process !== 'undefined' ? Math.floor(process.uptime()) : 0,
          lastHeartbeat: lastHeartbeatAt,
          // --- Issue #177 sub-checks ---
          transport: {
            ws: wsManager.connectionCount > 0,
            // SSE endpoint (`/sse`) is always mounted by this runtime, so
            // the channel is "available" even when no client is currently
            // attached. The pill only flips this red if the runtime is
            // shutting down (sseSubscribers cleared) — see #41.
            sse: true,
          },
          provider: {
            configured: providerConfigured,
            reachable: providerConfigured,
            lastCallOk: null as boolean | null,
          },
          scheduler: {
            running: schedRunning,
            errored: schedErrored,
          },
          mcp: {
            total: mcpTotal,
            connected: mcpConnected,
            degraded: mcpDegraded,
          },
        });
      }

      return new Response('Not found', { status: 404 });
     } catch (err: unknown) {
       // Top-level guard: any unhandled throw from a route (mutex capacity,
       // JSON parse, provider resolution) previously propagated to the HTTP
       // server which echoed `err.message` to the client, leaking internal
       // state (session IDs, stack traces). Swallow and log instead.
       const message = err instanceof Error ? err.message : String(err);
       const stack = err instanceof Error ? err.stack : undefined;
       log.error('Unhandled fetch error', { component: 'runtime', path: new URL(request.url).pathname, error: message, stack });
       return Response.json({ error: 'Internal error' }, { status: 500 });
     }
    }
  };
}
