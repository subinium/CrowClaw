import type { CheckpointStore, CheckpointTrigger, DetailedUsageTracker, ProviderAdapter, SessionState, SkillFileSystem, SupportedLocale } from '@crowclaw/core';
import type { InMemoryGatewayIdempotencyStore } from '@crowclaw/gateway';
import type { InMemorySkillStore } from '@crowclaw/learning';
import type { McpClient } from '@crowclaw/mcp';
import type { MemoryProvider } from '@crowclaw/memory';
import type { PluginManager } from '@crowclaw/plugins';
import type { InMemorySchedulerStore } from '@crowclaw/scheduler';
import type { InMemoryMemoryStore, InMemorySessionStore } from '@crowclaw/storage';
import type { ToolRegistry } from '@crowclaw/tools';
import type { WorkspaceStore } from '@crowclaw/workspace';
import type { BridgeProcessRecord } from './bridge-process.js';
import type { CodeBridgeSession } from './bridge-state.js';

export function normalizeRequestLocale(value: unknown): SupportedLocale | undefined {
  if (value === 'ko' || value === 'en') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower.startsWith('ko')) return 'ko';
    if (lower.startsWith('en')) return 'en';
  }
  return undefined;
}

export function getRequestLocale(request: Request, body?: { locale?: unknown }): SupportedLocale | undefined {
  return normalizeRequestLocale(body?.locale)
    ?? normalizeRequestLocale(request.headers.get('x-crowclaw-locale'))
    ?? normalizeRequestLocale(request.headers.get('accept-language'));
}

export const directToolAliases = {
  'browser.wait': 'browser.waitFor',
  'browser.wait-for': 'browser.waitFor',
  'browser.click-ref': 'browser.clickRef'
} as const;

export function normalizeCheckpointTrigger(value: unknown): CheckpointTrigger {
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

export function summarizeDirectTools(bridgeProcesses: Map<string, BridgeProcessRecord>) {
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

export function summarizeSessionRecord(session: SessionState) {
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

export function summarizeSessionTranscript(session?: CodeBridgeSession) {
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

export function summarizeSupportedDirectTools(supportedDirectTools: string[]) {
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

export function summarizeBridgeSessionRecord(session: CodeBridgeSession, process?: BridgeProcessRecord) {
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

export function summarizeBridgeSessionsAggregate(
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

export function renderScreenshotResult(url: string, path: string): { ok: true; output: string; metadata: { simulated: true; path: string; url: string } } {
  return {
    ok: true,
    output: `Simulated screenshot for ${url}`,
    metadata: { simulated: true, path, url }
  };
}

export function renderBrowserGotoResult(url: string): { ok: true; output: string; metadata: { simulated: true; url: string; finalUrl: string } } {
  return {
    ok: true,
    output: `Simulated browser navigation to ${url}`,
    metadata: { simulated: true, url, finalUrl: url }
  };
}

export function renderBrowserWaitForResult(url: string, selector: string, timeoutMs: number) {
  return {
    ok: true,
    output: `Simulated wait for ${selector} at ${url}`,
    metadata: { simulated: true, url, selector, timeoutMs, matched: true, finalUrl: url }
  };
}

export function renderBrowserSnapshotResult(url: string, full: boolean) {
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

export function renderBrowserBackResult(steps: number) {
  return {
    ok: true,
    output: `Simulated browser back (${steps})`,
    metadata: { simulated: true, steps, finalUrl: 'about:blank' }
  };
}

export function renderBrowserScrollResult(url: string, direction: string, amount: number) {
  return {
    ok: true,
    output: `Simulated scroll ${direction} (${amount}) at ${url}`,
    metadata: { simulated: true, url, direction, amount, finalUrl: url }
  };
}

export function renderBrowserPressResult(url: string, key: string) {
  return {
    ok: true,
    output: `Simulated key press ${key} at ${url}`,
    metadata: { simulated: true, url, key, finalUrl: url }
  };
}

export function renderBrowserConsoleResult(url: string) {
  const logs = [{ level: 'info', message: `Simulated console log for ${url}` }];
  return {
    ok: true,
    output: JSON.stringify(logs, null, 2),
    metadata: { simulated: true, url, count: logs.length }
  };
}

export function renderBrowserVisionResult(url: string, prompt: string) {
  return {
    ok: true,
    output: `Simulated vision analysis for ${url}: ${prompt}`,
    metadata: { simulated: true, url, prompt }
  };
}

export function renderBrowserImagesResult(url: string, limit: number) {
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

export function renderBrowserClickRefResult(url: string, ref: string) {
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
export async function claimIdempotency(
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
export async function releaseIdempotency(
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
export interface SseSubscriber {
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
export function formatSseFrame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}
