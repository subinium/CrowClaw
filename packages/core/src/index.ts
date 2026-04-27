import { PluginManager } from '@crowclaw/plugins';
import { buildSystemPrompt, buildMemoryPrefix } from './prompt-builder.js';
import { matchSkillManifests, filterAndBudgetSkills, checkSkillGates, type ParsedSkillFile, type SkillManifest } from './skill-manifest.js';
import type { MatchedSkill } from './prompt-builder.js';
import type { StreamChunk, StreamingProviderAdapter } from './streaming.js';
import { createCheckpoint, type CheckpointStore, type SessionCheckpoint } from './checkpoint.js';
import type { DetailedUsageTracker } from './usage-tracker.js';
import { redactToolOutput as redactToolOutputFn, scanForEnhancedInjection, scanCommand, SecurityAuditLog } from './security.js';
import { splitWithPairPreservation, extractPreflightFacts } from './compression-utils.js';
import { isHardlineBlocked, HARDLINE_BLOCKLIST } from './hardline-blocklist.js';

export type Role = 'system' | 'user' | 'assistant' | 'tool';
export type ToolRuntime = 'worker' | 'sandbox' | 'either';
export type ToolDangerLevel = 'low' | 'medium' | 'high';
export type ToolSafetyLevel = 'read-only' | 'destructive' | 'idempotent';

export interface ConversationMessage {
  role: Role;
  content: string;
  createdAt: string;
  name?: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolManifest {
  name: string;
  description: string;
  runtime: ToolRuntime;
  streaming: boolean;
  stateful: boolean;
  requiresWorkspace: boolean;
  requiresNetwork: boolean;
  dangerLevel: ToolDangerLevel;
  safety?: ToolSafetyLevel;
  inputSchema?: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface ToolExecutionContext {
  agentId: string;
  sessionId: string;
  workspaceId?: string;
  /** Env passed to tools. Use sanitizeEnv() to strip sensitive vars before passing. */
  env?: unknown;
  signal?: AbortSignal;
}

/** Env var patterns that should never be exposed to tools. */
const SENSITIVE_ENV_PATTERNS = [
  /api[_-]?key/i, /secret/i, /token/i, /password/i, /credential/i,
  /private[_-]?key/i, /signing[_-]?key/i, /encryption[_-]?key/i,
  /^OPENAI_/, /^ANTHROPIC_/, /^OPENROUTER_/, /^CROWCLAW_DASHBOARD_TOKEN$/,
  /^AWS_/, /^GH_TOKEN$/, /^GITHUB_TOKEN$/, /^npm_config_/,
  /^DATABASE_URL$/i, /^REDIS_URL$/i, /^MONGO_URI$/i,
  /^SUPABASE_/, /^FIREBASE_/, /^STRIPE_/,
];

/** Strip sensitive environment variables before passing to tools. */
export function sanitizeEnv(env?: unknown): Record<string, string> | undefined {
  if (!env || typeof env !== 'object') return undefined;
  const raw = env as Record<string, string>;
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue;
    if (SENSITIVE_ENV_PATTERNS.some(p => p.test(key))) continue;
    sanitized[key] = value;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export interface ToolExecutionResult {
  toolName: string;
  runtime: Exclude<ToolRuntime, 'either'>;
  ok: boolean;
  output: string;
  metadata?: Record<string, unknown>;
}

export interface ToolDefinition {
  manifest: ToolManifest;
  execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}

export interface ToolCatalog {
  list(): ToolManifest[];
  get(name: string): ToolDefinition | undefined;
}

export interface ToolExecutor {
  execute(name: string, input: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}

export interface ProviderRequest {
  systemPrompt?: string;
  messages: ConversationMessage[];
  availableTools: ToolManifest[];
  signal?: AbortSignal;
}

export interface ProviderResponseUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number;
}

export interface ProviderResponse {
  assistantMessage?: string;
  toolCalls?: ToolCall[];
  usage?: ProviderResponseUsage;
}

export interface ProviderAdapter {
  generate(request: ProviderRequest): Promise<ProviderResponse>;
  countTokens?(messages: ConversationMessage[]): number;
  /** #56 (provider contract, optional): if implemented, returns model-specific
   *  tool-use guidance text that the agent loop appends to the system prompt.
   *  Detected at runtime via `typeof provider.getToolUseGuidance === 'function'`
   *  so providers that don't implement it don't pay any cost. */
  getToolUseGuidance?(modelId: string): string | null;
}

export interface SessionLineage {
  rootSessionId: string;
  compressionCount: number;
  lastCompressedAt?: string;
  compressedMessageCount?: number;
}

export interface SessionState {
  agentId: string;
  sessionId: string;
  userId?: string;
  workspaceId?: string;
  messages: ConversationMessage[];
  updatedAt: string;
  lineage?: SessionLineage;
  /** #57 (scheduler contract): millisecond timestamp of the most recent tool
   *  execution in this session. AgentLoop updates this after every tool call;
   *  the scheduler reads it to detect stalled sessions for idle-shutdown. */
  lastToolActivityAt?: number;
}

export interface SessionStore {
  get(sessionId: string): Promise<SessionState | null>;
  put(session: SessionState): Promise<void>;
}

export interface AgentRunInput {
  agentId: string;
  sessionId: string;
  userMessage: string;
  systemPrompt?: string;
  workspaceId?: string;
  userId?: string;
  env?: unknown;
  signal?: AbortSignal;
  /** Pre-recalled memories to inject into the system prompt. */
  memories?: string[];
}

export interface AgentRunResult {
  session: SessionState;
  finalResponse: string;
  toolResults: ToolExecutionResult[];
}

export type AgentStreamEvent =
  | { type: 'text-delta'; content: string }
  | { type: 'tool-start'; toolName: string; toolCallId: string; input?: Record<string, unknown> }
  | { type: 'tool-end'; toolName: string; toolCallId: string; result: string; ok: boolean; durationMs?: number }
  | { type: 'iteration-start'; iteration: number }
  | { type: 'iteration-end'; iteration: number }
  | { type: 'done'; response: string; usage?: ProviderResponseUsage }
  | { type: 'error'; error: string };

export interface SecurityPolicy {
  /** Redact credentials and PII from tool output before adding to conversation. Default: true */
  redactToolOutput?: boolean;
  /** Scan user input for prompt injection and add warnings to system context. Default: false */
  scanUserInput?: boolean;
  /** Scan commands before execution for dangerous patterns. Default: true */
  scanCommands?: boolean;
  /** Block tool calls when critical command risks are detected. Default: false (warn only) */
  blockDangerousCommands?: boolean;
}

export interface AgentLoopOptions {
  maxToolIterations?: number;
  stopOnToolError?: boolean;
  concurrentToolCalls?: boolean;
  requireApprovalForDangerousTools?: boolean;
  approvalDecider?: (tool: ToolDefinition, input: Record<string, unknown>, context: ToolExecutionContext) => Promise<boolean>;
  fallbackProviders?: ProviderAdapter[];
  maxProviderAttempts?: number;
  retryDelaysMs?: number[];
  shouldRetryProviderError?: (error: unknown) => boolean;
  budgetWarningThreshold?: number;
  budgetCriticalThreshold?: number;
  compressAfterMessageCount?: number;
  protectLastMessages?: number;
  plugins?: PluginManager;
  runtimeName?: string;
  skills?: ParsedSkillFile[];
  agentPreset?: { role: string; goal: string; backstory?: string };
  personaPrompt?: string;
  /** Max total tokens per run (context window budget). Track 1.2 */
  maxTokens?: number;
  /** Optional detailed usage tracker. Track 1.2 */
  usageTracker?: DetailedUsageTracker;
  /** Checkpoint store for auto-checkpointing. Track 1.4 */
  checkpointStore?: CheckpointStore;
  /** Enable automatic checkpointing at each iteration. Track 1.4 */
  autoCheckpoint?: boolean;
  /** Separate provider for LLM-powered compression. Track 2.2 */
  compressionProvider?: ProviderAdapter;
  /** Enable Anthropic prompt caching metadata. Track 2.3 */
  enablePromptCaching?: boolean;
  /** Context window size for token-aware compression trigger. Track 2.1 */
  contextWindowSize?: number;
  /** Security policy for runtime enforcement of credential redaction, injection scanning, and command scanning */
  securityPolicy?: SecurityPolicy;
  /** Security audit log for recording security events */
  securityAuditLog?: SecurityAuditLog;
  /** Make a final synthesis call when the loop exhausts maxToolIterations. Default: true */
  synthesizeOnExhaustion?: boolean;
  /** Max characters per tool result before truncation. Default: 2000 */
  maxToolResultLength?: number;
  /** Max approximate tokens for all skills in system prompt. Default: 4000 */
  skillTokenBudget?: number;
  /** Inject error reflection prompt on tool failure instead of stopping immediately. Default: true */
  errorReflection?: boolean;
  /** Max number of error reflections before stopping. Default: 3 */
  maxErrorReflections?: number;
  /** Enable plan-before-act: inject planning instructions and replan on failure. Default: false */
  planBeforeAct?: boolean;
  /** #53: extra hardline patterns appended to the static defaults. Matched
   *  *before* the approval gate; matches short-circuit with no human prompt. */
  hardlineBlocklist?: ReadonlyArray<{ pattern: RegExp; description: string }>;
}

export function parseSlashToolCall(input: string): ToolCall | null {
  if (!input.startsWith('/tool ')) {
    return null;
  }

  const [name, ...rest] = input.replace('/tool ', '').split(' ');
  if (!name) {
    return null;
  }

  const raw = rest.join(' ').trim();
  if (!raw) {
    return { name, input: {} };
  }

  try {
    return { name, input: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    return { name, input: { raw } };
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function toolMessage(result: ToolExecutionResult, maxLength?: number): ConversationMessage {
  let content = result.output;
  if (maxLength && content.length > maxLength) {
    content = content.slice(0, maxLength) + `\n\n[Truncated — ${content.length} chars total, showing first ${maxLength}]`;
  }
  return {
    role: 'tool',
    name: result.toolName,
    content,
    createdAt: nowIso(),
    // Preserve the authoritative ok flag — checkpoint + restore flows that
    // previously scraped content for /error|fail/i now read this directly.
    metadata: { ...(result.metadata ?? {}), ok: result.ok },
  };
}

function budgetStatus(iteration: number, maxIterations: number, warningThreshold: number, criticalThreshold: number): string | null {
  const usedPct = maxIterations === 0 ? 100 : (iteration / maxIterations) * 100;
  const remaining = Math.max(maxIterations - iteration, 0);
  if (usedPct >= criticalThreshold) {
    return `[BUDGET WARNING: iteration ${iteration}/${maxIterations}. Only ${remaining} iteration(s) left.]`;
  }
  if (usedPct >= warningThreshold) {
    return `[BUDGET: iteration ${iteration}/${maxIterations}. ${remaining} iteration(s) left.]`;
  }
  return null;
}

function compressMessages(
  messages: ConversationMessage[],
  compressAfterMessageCount: number,
  protectLastMessages: number
): { messages: ConversationMessage[]; compressedCount: number } {
  if (messages.length <= compressAfterMessageCount) {
    return { messages, compressedCount: 0 };
  }

  const protectedCount = Math.min(protectLastMessages, messages.length);
  const preserved = messages.slice(-protectedCount);
  const compressed = messages.slice(0, messages.length - protectedCount);

  // Phase 1: Prune tool output (keep first 200 chars of each tool result)
  const prunedMessages = compressed.map((msg) => {
    if (msg.role === 'tool') {
      const truncated = msg.content.length > 200
        ? msg.content.slice(0, 200) + '... [truncated]'
        : msg.content;
      return { ...msg, content: truncated };
    }
    return msg;
  });

  // Phase 2: Build structured summary by role
  const userMessages = prunedMessages.filter(m => m.role === 'user').map(m => m.content);
  const assistantMessages = prunedMessages.filter(m => m.role === 'assistant').map(m => m.content);
  const toolMessages = prunedMessages.filter(m => m.role === 'tool');

  const sections: string[] = [];

  if (userMessages.length > 0) {
    sections.push(`User requests (${userMessages.length}):\n${userMessages.map((m, i) => `${i + 1}. ${m.slice(0, 150)}`).join('\n')}`);
  }

  if (assistantMessages.length > 0) {
    sections.push(`Assistant responses (${assistantMessages.length}):\n${assistantMessages.map((m, i) => `${i + 1}. ${m.slice(0, 150)}`).join('\n')}`);
  }

  if (toolMessages.length > 0) {
    const toolSummary = toolMessages
      .map(m => `- ${m.name ?? 'tool'}: ${m.content.slice(0, 80)}`)
      .join('\n');
    sections.push(`Tool results (${toolMessages.length}):\n${toolSummary}`);
  }

  // Phase 3: Apply token budget (estimate ~4 chars/token, budget = 2000 tokens = 8000 chars)
  const TOKEN_BUDGET_CHARS = 8000;
  let summary = sections.join('\n\n');
  if (summary.length > TOKEN_BUDGET_CHARS) {
    summary = summary.slice(0, TOKEN_BUDGET_CHARS) + '\n[... summary truncated to fit token budget]';
  }

  return {
    messages: [
      {
        role: 'system',
        content: `Compressed conversation summary (${compressed.length} messages):\n\n${summary}`,
        createdAt: nowIso(),
        metadata: { compressedCount: compressed.length, compressionMethod: 'structured-summary' }
      },
      ...preserved
    ],
    compressedCount: compressed.length
  };
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Agent run aborted.');
  }
}

function waitMs(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Agent run aborted.'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

const dangerousInputPatterns = [
  /\brm\s+-rf\b/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bchmod\s+777\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  />\s*\/etc\//i,
  /\bcurl\s+.*localhost/i,
  /\bwget\s+.*127\./i,
  /\bfetch\s*\(\s*['"]http:\/\/localhost/i,
  /\bfetch\s*\(\s*['"]http:\/\/127\./i,
  /DROP\s+TABLE/i,
  /DELETE\s+FROM/i,
  /UPDATE\s+.*SET\s+/i,
  /INSERT\s+INTO/i,
  /TRUNCATE\s+TABLE/i,
  /;\s*--/
];

function collectDangerousInputSignals(input: Record<string, unknown>): string[] {
  const values = Object.values(input).flatMap((value) => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
    return [];
  });
  return values.flatMap((value) => dangerousInputPatterns
    .filter((pattern) => pattern.test(value))
    .map((pattern) => pattern.source));
}

export class AgentLoop {
  private readonly maxToolIterations: number;
  private readonly stopOnToolError: boolean;
  private readonly concurrentToolCalls: boolean;
  private readonly requireApprovalForDangerousTools: boolean;
  private readonly approvalDecider?: AgentLoopOptions['approvalDecider'];
  private readonly fallbackProviders: ProviderAdapter[];
  private readonly maxProviderAttempts: number;
  private readonly retryDelaysMs: number[];
  private readonly shouldRetryProviderError: (error: unknown) => boolean;
  private readonly budgetWarningThreshold: number;
  private readonly budgetCriticalThreshold: number;
  private readonly compressAfterMessageCount: number;
  private readonly protectLastMessages: number;
  private readonly plugins?: PluginManager;
  private readonly runtimeName: string;
  private readonly skills: ParsedSkillFile[];
  private readonly agentPreset?: { role: string; goal: string; backstory?: string };
  private readonly personaPrompt?: string;
  private readonly maxTokens?: number;
  private readonly usageTracker?: DetailedUsageTracker;
  private readonly checkpointStore?: CheckpointStore;
  private readonly autoCheckpoint: boolean;
  private readonly compressionProvider?: ProviderAdapter;
  private readonly enablePromptCaching: boolean;
  private readonly contextWindowSize?: number;
  private readonly securityPolicy: Required<SecurityPolicy>;
  private readonly securityAuditLog?: SecurityAuditLog;
  private readonly synthesizeOnExhaustion: boolean;
  private readonly maxToolResultLength: number;
  private readonly errorReflection: boolean;
  private readonly maxErrorReflections: number;
  private readonly planBeforeAct: boolean;
  /** #54: queue of pending /steer guidance per session. Drained at the top of
   *  every loop iteration and prepended as a one-shot system message — never
   *  written to session.messages, so the same nudge isn't replayed on restore. */
  private readonly pendingSteers = new Map<string, string[]>();
  /** #53: extra hardline patterns supplied by the operator at construction
   *  time (e.g., loaded from env config). Merged with the static defaults. */
  private readonly hardlineBlocklist: ReadonlyArray<{ pattern: RegExp; description: string }>;

  constructor(
    private readonly provider: ProviderAdapter,
    private readonly tools: ToolCatalog & ToolExecutor,
    private readonly sessions: SessionStore,
    options: AgentLoopOptions = {}
  ) {
    this.maxToolIterations = options.maxToolIterations ?? 12;
    this.stopOnToolError = options.stopOnToolError ?? true;
    this.concurrentToolCalls = options.concurrentToolCalls ?? true;
    this.requireApprovalForDangerousTools = options.requireApprovalForDangerousTools ?? false;
    this.approvalDecider = options.approvalDecider;
    this.fallbackProviders = options.fallbackProviders ?? [];
    this.maxProviderAttempts = options.maxProviderAttempts ?? (1 + this.fallbackProviders.length);
    this.retryDelaysMs = options.retryDelaysMs ?? [];
    this.shouldRetryProviderError = options.shouldRetryProviderError ?? (() => true);
    this.budgetWarningThreshold = options.budgetWarningThreshold ?? 70;
    this.budgetCriticalThreshold = options.budgetCriticalThreshold ?? 90;
    this.compressAfterMessageCount = options.compressAfterMessageCount ?? 40;
    this.protectLastMessages = options.protectLastMessages ?? 12;
    this.plugins = options.plugins;
    this.runtimeName = options.runtimeName ?? 'unknown';
    // OpenClaw pattern: filter skills by activation gates + apply token budget
    this.skills = filterAndBudgetSkills(options.skills ?? [], {
      availableToolNames: this.tools.list().map(t => t.name),
      maxTokenBudget: options.skillTokenBudget ?? 16000,
    });
    this.agentPreset = options.agentPreset;
    this.personaPrompt = options.personaPrompt;
    this.maxTokens = options.maxTokens;
    this.usageTracker = options.usageTracker;
    this.checkpointStore = options.checkpointStore;
    this.autoCheckpoint = options.autoCheckpoint ?? false;
    this.compressionProvider = options.compressionProvider;
    this.enablePromptCaching = options.enablePromptCaching ?? false;
    this.contextWindowSize = options.contextWindowSize;
    this.securityPolicy = {
      redactToolOutput: options.securityPolicy?.redactToolOutput ?? true,
      scanUserInput: options.securityPolicy?.scanUserInput ?? false,
      scanCommands: options.securityPolicy?.scanCommands ?? true,
      blockDangerousCommands: options.securityPolicy?.blockDangerousCommands ?? false,
    };
    this.securityAuditLog = options.securityAuditLog;
    this.synthesizeOnExhaustion = options.synthesizeOnExhaustion ?? true;
    this.maxToolResultLength = options.maxToolResultLength ?? 2000;
    this.errorReflection = options.errorReflection ?? true;
    this.maxErrorReflections = options.maxErrorReflections ?? 3;
    this.planBeforeAct = options.planBeforeAct ?? false;
    this.hardlineBlocklist = options.hardlineBlocklist ?? [];
  }

  /**
   * #54: Mid-run course correction. Operator submits guidance via the control
   * channel (WS / REST); the next loop iteration drains pending steers and
   * prepends them as a one-shot system message before the next LLM call.
   * Steer text is never written to session.messages — restore replay should
   * not re-apply old nudges, and the LLM's response captures the actual
   * behavior change in the assistant message it produces.
   */
  steer(sessionId: string, guidance: string): void {
    if (!guidance || !guidance.trim()) return;
    const queue = this.pendingSteers.get(sessionId);
    if (queue) {
      queue.push(guidance);
    } else {
      this.pendingSteers.set(sessionId, [guidance]);
    }
  }

  /** #54: Pop and return any pending steer guidance for this session. Called
   *  at the top of each loop iteration. */
  private drainPendingSteers(sessionId: string): string[] {
    const queue = this.pendingSteers.get(sessionId);
    if (!queue || queue.length === 0) return [];
    this.pendingSteers.delete(sessionId);
    return queue;
  }

  /** Tiered budget hints (Hermes pattern) — returns an ephemeral message at 50%, 75%, and last iteration */
  private getBudgetHint(iteration: number, maxIterations: number): string | null {
    if (maxIterations <= 2) return null; // Too few iterations for tiered hints
    const remaining = maxIterations - iteration - 1;
    const ratio = (iteration + 1) / maxIterations;
    if (remaining === 0) {
      return 'This is your final tool iteration. Provide your best answer with what you have gathered so far.';
    }
    if (ratio >= 0.75) {
      return `You have ${remaining} tool iteration(s) remaining. Start synthesizing your findings into a clear answer.`;
    }
    if (ratio >= 0.5) {
      return 'You are halfway through your tool budget. Focus on the most important remaining steps.';
    }
    return null;
  }

  /** Track 1.2: Record usage from a provider response and return total tokens consumed so far */
  private recordUsage(response: ProviderResponse): number {
    if (response.usage && this.usageTracker) {
      this.usageTracker.record({
        model: 'unknown',
        provider: 'primary',
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        totalTokens: response.usage.totalTokens,
        cachedTokens: response.usage.cachedTokens ?? 0,
        costUsd: 0,
        latencyMs: 0,
      });
    }
    return this.usageTracker?.getSummary().totalTokens ?? 0;
  }

  /** Track 1.2: Check if token budget is approaching or exceeded */
  private checkTokenBudget(totalConsumed: number): { exceeded: boolean; warning: string | null } {
    if (!this.maxTokens) return { exceeded: false, warning: null };
    if (totalConsumed >= this.maxTokens) {
      return { exceeded: true, warning: `[TOKEN BUDGET EXCEEDED: ${totalConsumed}/${this.maxTokens} tokens used.]` };
    }
    const usedPct = (totalConsumed / this.maxTokens) * 100;
    if (usedPct >= 90) {
      return { exceeded: false, warning: `[TOKEN BUDGET WARNING: ${totalConsumed}/${this.maxTokens} tokens used (${Math.round(usedPct)}%).]` };
    }
    return { exceeded: false, warning: null };
  }

  /** Track 2.1: Determine if compression should trigger based on token count */
  private shouldCompressTokenAware(messages: ConversationMessage[]): boolean {
    if (this.provider.countTokens && this.contextWindowSize) {
      const tokenCount = this.provider.countTokens(messages);
      return tokenCount > this.contextWindowSize * 0.7;
    }
    // Fall back to message count threshold
    return messages.length > this.compressAfterMessageCount;
  }

  /** Track 2.2: Compress using LLM provider if available, else fall back to heuristic.
   *  Uses pair-preserving split to never break tool-call/tool-result pairs. */
  private async compressWithLLM(
    messages: ConversationMessage[],
  ): Promise<{ messages: ConversationMessage[]; compressedCount: number; preflightFacts?: string[] }> {
    // Use pair-preserving split to ensure tool-call/result pairs stay together
    const { toCompress, toKeep } = splitWithPairPreservation(messages, this.protectLastMessages);

    if (toCompress.length === 0) {
      return { messages, compressedCount: 0 };
    }

    // Extract key facts before compression (preflight flush)
    const preflightFacts = extractPreflightFacts(toCompress);

    if (!this.compressionProvider) {
      // Fall back to heuristic compression (still using pair-preserving split)
      const systemMsg = messages.find(m => m.role === 'system');
      const heuristicSummary = toCompress
        .map(m => `[${m.role}] ${(m.content ?? '').slice(0, 100)}`)
        .join('\n');
      const summaryContent = `Compressed conversation summary (${toCompress.length} messages):\n${heuristicSummary}`;
      return {
        messages: [
          ...(systemMsg && !toKeep.includes(systemMsg) ? [systemMsg] : []),
          {
            role: 'system' as Role,
            content: summaryContent.slice(0, 2000),
            createdAt: nowIso(),
            metadata: { compressedCount: toCompress.length, compressionMethod: 'heuristic-pair-safe' }
          },
          ...toKeep
        ],
        compressedCount: toCompress.length,
        preflightFacts,
      };
    }

    // Build compression prompt with preflight facts context
    const middleText = toCompress.map(m => `[${m.role}] ${m.content}`).join('\n\n');
    const factsContext = preflightFacts.length > 0
      ? `\n\nKey facts to preserve:\n${preflightFacts.map(f => `- ${f}`).join('\n')}`
      : '';
    const compressionPrompt = `Summarize this conversation, preserving key facts, decisions, and tool results. Be concise.${factsContext}`;

    try {
      const response = await this.compressionProvider.generate({
        systemPrompt: compressionPrompt,
        messages: [{
          role: 'user',
          content: middleText,
          createdAt: nowIso(),
        }],
        availableTools: [],
      });

      const summary = response.assistantMessage ?? '';
      if (!summary) {
        return compressMessages(messages, this.compressAfterMessageCount, this.protectLastMessages);
      }

      const systemMsg = messages.find(m => m.role === 'system');
      return {
        messages: [
          ...(systemMsg && !toKeep.includes(systemMsg) ? [systemMsg] : []),
          {
            role: 'system' as Role,
            content: `Compressed conversation summary (${toCompress.length} messages, LLM-summarized):\n\n${summary}`,
            createdAt: nowIso(),
            metadata: { compressedCount: toCompress.length, compressionMethod: 'llm-summary', preflightFacts }
          },
          ...toKeep
        ],
        compressedCount: toCompress.length,
        preflightFacts,
      };
    } catch {
      return compressMessages(messages, this.compressAfterMessageCount, this.protectLastMessages);
    }
  }

  /** Track 2.3: Add prompt caching metadata to system prompt */
  private buildSystemPromptForRequest(promptParams: {
    basePrompt?: string;
    runtimeName: string;
    sessionId: string;
    workspaceId?: string;
    userId?: string;
    availableTools: ToolManifest[];
    matchedSkills?: MatchedSkill[];
    agentPreset?: { role: string; goal: string; backstory?: string };
    personaPrompt?: string;
    memories?: string[];
  }): string | undefined {
    const prompt = buildSystemPrompt(promptParams);
    if (!prompt) return prompt;
    if (this.enablePromptCaching) {
      // Annotate system prompt for Anthropic prompt caching.
      // The actual cache_control metadata is signalled via a marker that
      // the Anthropic provider adapter can detect and convert.
      return `${prompt}\n<!-- cache_control: {"type":"ephemeral"} -->`;
    }
    return prompt;
  }

  /** Detect if an error is a context window overflow / token limit error. */
  private isContextOverflowError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const msg = error.message.toLowerCase();
    return (
      msg.includes('context_length_exceeded') ||
      msg.includes('maximum context length') ||
      msg.includes('token limit') ||
      msg.includes('too many tokens') ||
      msg.includes('context window') ||
      msg.includes('prompt is too long') || // Anthropic
      msg.includes('request too large') || // Generic
      msg.includes('input is too long') // Google
    );
  }

  /** Auto-compact messages on context overflow and retry the request. */
  private async recoverFromContextOverflow(
    request: ProviderRequest,
    pluginContext?: { sessionId: string; agentId: string },
  ): Promise<{ response: ProviderResponse; compactedMessages: ConversationMessage[] } | null> {
    // Try to compact messages
    const messages = request.messages;
    if (messages.length < 4) return null; // Too few to compact

    let compactedMessages: ConversationMessage[];
    if (this.compressionProvider) {
      const result = await this.compressWithLLM(messages);
      compactedMessages = result.messages;
    } else {
      // Force compression by passing threshold=0 (not messages.length which is a no-op)
      const result = compressMessages(messages, 0, this.protectLastMessages);
      compactedMessages = result.messages;
    }

    if (compactedMessages.length >= messages.length) return null; // Compression didn't help

    try {
      const response = await this.generateWithFallbacks(
        { ...request, messages: compactedMessages },
        pluginContext,
      );
      return { response, compactedMessages };
    } catch {
      return null; // Retry also failed
    }
  }

  /** Track 1.4: Create a checkpoint if auto-checkpointing is enabled */
  private async generateWithFallbacks(
    request: ProviderRequest,
    pluginContext?: { sessionId: string; agentId: string }
  ): Promise<ProviderResponse> {
    const providers = [this.provider, ...this.fallbackProviders].slice(0, this.maxProviderAttempts);
    let lastError: unknown;

    for (const [providerIndex, provider] of providers.entries()) {
      ensureNotAborted(request.signal);
      let attempt = 0;
      while (true) {
        try {
          await this.plugins?.emit('provider:beforeGenerate', {
            attempt: attempt + 1,
            providerIndex,
            messageCount: request.messages.length
          }, {
            runtime: this.runtimeName,
            sessionId: pluginContext?.sessionId ?? 'unknown',
            agentId: pluginContext?.agentId ?? 'unknown',
          });

          const response = await provider.generate(request);
          await this.plugins?.emit('provider:afterGenerate', {
            attempt: attempt + 1,
            providerIndex,
            messageCount: request.messages.length,
            toolCallCount: response.toolCalls?.length ?? 0,
            assistantMessage: response.assistantMessage
          }, {
            runtime: this.runtimeName,
            sessionId: pluginContext?.sessionId ?? 'unknown',
            agentId: pluginContext?.agentId ?? 'unknown',
          });
          return response;
        } catch (error) {
          await this.plugins?.emit('provider:error', {
            attempt: attempt + 1,
            providerIndex,
            messageCount: request.messages.length,
            error: error instanceof Error ? error.message : String(error)
          }, {
            runtime: this.runtimeName,
            sessionId: pluginContext?.sessionId ?? 'unknown',
            agentId: pluginContext?.agentId ?? 'unknown',
          });
          lastError = error;
          const shouldRetry = attempt < this.retryDelaysMs.length && this.shouldRetryProviderError(error);
          if (!shouldRetry) {
            break;
          }
          const delay = this.retryDelaysMs[attempt] ?? 0;
          attempt += 1;
          await waitMs(delay, request.signal);
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Provider generation failed.'));
  }

  /** Scan a command string in tool input for dangerous patterns */
  private scanToolCommandInput(toolCall: ToolCall): { blocked: boolean; warnings: string[] } {
    if (!this.securityPolicy.scanCommands) return { blocked: false, warnings: [] };

    const commandFields = ['command', 'cmd', 'script', 'code', 'shell', 'exec'];
    const warnings: string[] = [];
    let hasCritical = false;

    for (const field of commandFields) {
      const value = toolCall.input[field];
      if (typeof value !== 'string') continue;

      const result = scanCommand(value);
      if (!result.safe) {
        for (const risk of result.risks) {
          warnings.push(`[SECURITY] Command risk (${risk.severity}): ${risk.description}`);
          if (risk.severity === 'critical') hasCritical = true;
        }
      }
    }

    const blocked = hasCritical && this.securityPolicy.blockDangerousCommands;
    if (warnings.length > 0) {
      this.securityAuditLog?.record({
        type: blocked ? 'command_blocked' : 'command_warned',
        severity: blocked ? 'critical' : 'warning',
        detail: warnings.join('; '),
      });
    }
    return { blocked, warnings };
  }

  /** Apply redaction to tool output if security policy requires it */
  private redactToolResult(result: ToolExecutionResult): ToolExecutionResult {
    if (!this.securityPolicy.redactToolOutput) return result;
    let output = result.output;
    let mutated = false;
    // Credential + PII redaction (existing).
    const redacted = redactToolOutputFn(output);
    if (redacted !== output) {
      output = redacted;
      mutated = true;
      this.securityAuditLog?.record({
        type: 'credential_redacted',
        severity: 'info',
        detail: `Credentials/PII redacted in output from tool "${result.toolName}"`,
      });
    }
    // Second-order prompt-injection scan. Indirect injection (malicious HTML
    // in a fetched page, poisoned file contents) is the #1 mitigation gap in
    // agent frameworks — before v0.4.1 tool output flowed back into the LLM
    // unchecked. When we detect it, wrap the output in <untrusted-content>
    // tags so the LLM is primed to treat it as data, not instructions.
    const injectionScan = scanForEnhancedInjection(output);
    if (injectionScan.detected) {
      const threatCount = injectionScan.threats.length;
      output = `<untrusted-content source="tool:${result.toolName}" reason="prompt-injection-detected:threats=${threatCount}">\n${output}\n</untrusted-content>`;
      mutated = true;
      const topThreats = injectionScan.threats
        .slice(0, 2)
        .map((t) => (typeof t === 'string' ? t : (t as { description?: string }).description ?? 'unknown'))
        .join('; ');
      this.securityAuditLog?.record({
        type: 'injection_detected',
        severity: threatCount >= 3 ? 'critical' : 'warning',
        detail: `Prompt injection in output from tool "${result.toolName}" (threats=${threatCount}: ${topThreats})`,
      });
    }
    if (!mutated) return result;
    return { ...result, output, metadata: { ...result.metadata, securityRedacted: true } };
  }

  /**
   * Partition tool calls by safety level for controlled concurrent execution.
   * - read-only and idempotent/undefined tools run in parallel first
   * - destructive tools run sequentially after
   * Returns null if no tools have safety annotations (caller should use default behavior).
   */
  private partitionToolCallsBySafety(toolCalls: ToolCall[]): {
    parallel: ToolCall[];
    destructive: ToolCall[];
  } | null {
    let hasAnySafety = false;
    const parallel: ToolCall[] = [];
    const destructive: ToolCall[] = [];

    for (const tc of toolCalls) {
      const def = this.tools.get(tc.name);
      const safety = def?.manifest.safety;
      if (safety) hasAnySafety = true;

      if (safety === 'destructive') {
        destructive.push(tc);
      } else {
        parallel.push(tc);
      }
    }

    if (!hasAnySafety) return null;
    return { parallel, destructive };
  }

  private async executeToolCall(toolCall: ToolCall, input: AgentRunInput): Promise<ToolExecutionResult> {
    const context: ToolExecutionContext = {
      agentId: input.agentId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      env: sanitizeEnv(input.env),
      signal: input.signal
    };

    ensureNotAborted(input.signal);

    await this.plugins?.emit('tool:beforeExecute', {
      toolName: toolCall.name,
      input: toolCall.input,
      sessionId: input.sessionId,
      agentId: input.agentId,
    }, {
      runtime: this.runtimeName,
      sessionId: input.sessionId,
      agentId: input.agentId,
    });

    const definition = this.tools.get(toolCall.name);
    if (!definition) {
      const rawResult = await this.tools.execute(toolCall.name, toolCall.input, context);
      return this.redactToolResult(rawResult);
    }

    // #53: Hardline blocklist — sits *before* the approval gate. Matches are
    // unrecoverable (whole-disk wipes, fork bombs, force-push to protected
    // branches, etc.). No operator prompt is shown — preventing consent
    // fatigue from repeated adversarial suggestions.
    const hardline = isHardlineBlocked(toolCall, this.hardlineBlocklist);
    if (hardline.blocked) {
      this.securityAuditLog?.record({
        type: 'command_blocked',
        severity: 'critical',
        detail: `hardline-blocked: ${hardline.description} (pattern: ${hardline.pattern})`,
        sessionId: input.sessionId,
      });
      return {
        toolName: definition.manifest.name,
        runtime: definition.manifest.runtime === 'sandbox' ? 'sandbox' : 'worker',
        ok: false,
        output: `Tool call rejected by hardline blocklist: ${hardline.description}`,
        metadata: {
          blockedByHardline: true,
          hardlinePattern: hardline.pattern,
          hardlineDescription: hardline.description,
        },
      };
    }

    // Command scanning: check tool input for dangerous commands
    const commandScan = this.scanToolCommandInput(toolCall);
    if (commandScan.blocked) {
      return {
        toolName: definition.manifest.name,
        runtime: definition.manifest.runtime === 'sandbox' ? 'sandbox' : 'worker',
        ok: false,
        output: `Tool call blocked by security policy: ${commandScan.warnings.join('; ')}`,
        metadata: { blockedBySecurity: true, securityWarnings: commandScan.warnings }
      };
    }

    const dangerousSignals = collectDangerousInputSignals(toolCall.input);
    const needsApproval = this.requireApprovalForDangerousTools
      && (definition.manifest.dangerLevel === 'high' || dangerousSignals.length > 0);
    if (needsApproval) {
      this.securityAuditLog?.record({
        type: 'approval_required',
        severity: 'warning',
        detail: `Approval required for tool "${definition.manifest.name}" (danger: ${definition.manifest.dangerLevel})`,
        sessionId: input.sessionId,
      });
      const approved = this.approvalDecider
        ? await this.approvalDecider(definition, toolCall.input, context)
        : false;

      if (!approved) {
        this.securityAuditLog?.record({
          type: 'approval_denied',
          severity: 'critical',
          detail: `Approval denied for tool "${definition.manifest.name}"`,
          sessionId: input.sessionId,
        });
        return {
          toolName: definition.manifest.name,
          runtime: definition.manifest.runtime === 'sandbox' ? 'sandbox' : 'worker',
          ok: false,
          output: `Tool requires approval: ${definition.manifest.name}`,
          metadata: { blockedByApproval: true, dangerousSignals }
        };
      }
    }

    const rawResult = await this.tools.execute(toolCall.name, toolCall.input, context);

    // Append command scan warnings to output if present
    if (commandScan.warnings.length > 0) {
      const warned = { ...rawResult, output: `${rawResult.output}\n${commandScan.warnings.join('\n')}` };
      return this.redactToolResult(warned);
    }

    return this.redactToolResult(rawResult);
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    ensureNotAborted(input.signal);

    await this.plugins?.emit('agent:beforeRun', {
      input: input as unknown as { agentId: string; sessionId: string; [key: string]: unknown },
    }, {
      runtime: this.runtimeName,
      sessionId: input.sessionId,
      agentId: input.agentId,
    });

    const session = (await this.sessions.get(input.sessionId)) ?? {
      agentId: input.agentId,
      sessionId: input.sessionId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      messages: [],
      updatedAt: nowIso(),
      lineage: {
        rootSessionId: input.sessionId,
        compressionCount: 0
      }
    } satisfies SessionState;

    // Inject recalled memories as untrusted context prefix (not in system prompt)
    const memoryPrefix = buildMemoryPrefix(input.memories ?? []);
    const memoryMessages: ConversationMessage[] = memoryPrefix
      ? [{ role: 'system', content: memoryPrefix, createdAt: nowIso() }]
      : [];

    // Strip out [session-meta] dashboard markers so they never reach the LLM.
    // These are added by /api/sessions/:id/rename and are display-only metadata.
    const cleanedSessionMessages = session.messages.filter(
      (m) => !(m.role === 'system' && m.content?.startsWith('[session-meta]')),
    );

    const nextMessages = [...cleanedSessionMessages, ...memoryMessages, {
      role: 'user',
      content: input.userMessage,
      createdAt: nowIso()
    } satisfies ConversationMessage];

    // Security: scan user input for prompt injection
    let injectionWarning: string | undefined;
    if (this.securityPolicy.scanUserInput) {
      const injectionScan = scanForEnhancedInjection(input.userMessage);
      if (injectionScan.detected) {
        const threatSummary = injectionScan.threats
          .map(t => `${t.severity}: ${t.description}`)
          .join('; ');
        injectionWarning = `[SECURITY WARNING] Potential prompt injection detected in user input: ${threatSummary}`;
        this.securityAuditLog?.record({
          type: 'injection_detected',
          severity: injectionScan.threats.some(t => t.severity === 'high') ? 'critical' : 'warning',
          detail: threatSummary,
          sessionId: input.sessionId,
        });
      }
    }

    const toolResults: ToolExecutionResult[] = [];
    let finalResponse: string | undefined;
    let tokenBudgetExceeded = false;

    // #44 perf: snapshot tool catalog once per run. ToolRegistry.list() is
    // memoized but still crosses a method boundary; the loop reads it twice
    // per iteration (system prompt + provider request). Tools registered
    // mid-run are out of scope by design — we want a stable contract for
    // the duration of a single user-facing run.
    const toolList = this.tools.list();

    // Match skills against user query
    let matchedSkills: MatchedSkill[] | undefined;
    if (this.skills.length > 0) {
      const skillMatches = matchSkillManifests(input.userMessage, this.skills, 3);
      if (skillMatches.length > 0) {
        matchedSkills = skillMatches.map(({ skill }) => ({
          name: skill.manifest.name,
          description: skill.manifest.description,
          instructions: skill.instructions,
          tools: skill.manifest.tools,
        }));

        // Warn about required tools that aren't registered
        const registeredToolNames = new Set(toolList.map(t => t.name));
        for (const ms of matchedSkills) {
          if (ms.tools) {
            for (const toolName of ms.tools) {
              if (!registeredToolNames.has(toolName)) {
                console.warn(`[CrowClaw] Skill "${ms.name}" requires tool "${toolName}" which is not registered.`);
              }
            }
          }
        }
      }
    }

    // Security: build base system prompt, then append injection warning if present
    let baseSystemPrompt = input.systemPrompt
      ? (injectionWarning ? `${input.systemPrompt}\n\n${injectionWarning}` : input.systemPrompt)
      : injectionWarning;

    // Plan-before-act: inject planning instructions into the system prompt BEFORE the first LLM call
    if (this.planBeforeAct) {
      const planningDirective = '\n\nBefore executing any tools, outline a brief plan: (1) what you intend to accomplish, (2) which tools you will use and in what order, (3) how you will handle potential failures. State your plan first, then proceed.';
      baseSystemPrompt = baseSystemPrompt ? `${baseSystemPrompt}${planningDirective}` : planningDirective;
    }

    // #56 (provider contract): if the provider exposes getToolUseGuidance,
    // append the model-specific tool-use guidance to the base system prompt.
    // Detected by duck-typing — providers that don't implement it pay nothing.
    const providerWithGuidance = this.provider as { getToolUseGuidance?: (modelId: string) => string | null };
    if (typeof providerWithGuidance.getToolUseGuidance === 'function') {
      const guidance = providerWithGuidance.getToolUseGuidance('unknown');
      if (guidance) {
        baseSystemPrompt = baseSystemPrompt ? `${baseSystemPrompt}\n\n${guidance}` : guidance;
      }
    }

    // #43 perf: build the system prompt once. Inputs (toolList, personaPrompt,
    // basePrompt, agentPreset, matchedSkills, memories) are invariant across
    // iterations within a single run — buildSystemPromptForRequest internally
    // sorts the tool list and concatenates several string sections. At
    // maxToolIterations: 12 with 20+ tools, this saves ~12-24 rebuilds per
    // run. If a future feature mutates matchedSkills mid-run, gate this with
    // a `dirty` flag and recompute on demand.
    const cachedSystemPrompt = this.buildSystemPromptForRequest({
      personaPrompt: this.personaPrompt,
      basePrompt: baseSystemPrompt,
      runtimeName: this.runtimeName,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      availableTools: toolList,
      matchedSkills,
      agentPreset: this.agentPreset,
      memories: input.memories,
    });

    // Track 2.3: Use prompt caching-aware system prompt builder
    const buildRequest = (msgs: ConversationMessage[]): ProviderRequest => ({
      systemPrompt: cachedSystemPrompt,
      messages: msgs,
      availableTools: toolList,
      signal: input.signal,
    });

    const pluginCtx = { sessionId: input.sessionId, agentId: input.agentId };
    let currentResponse: ProviderResponse;
    try {
      currentResponse = await this.generateWithFallbacks(buildRequest(nextMessages), pluginCtx);
    } catch (error: unknown) {
      // Context overflow recovery: compact and retry once
      if (this.isContextOverflowError(error)) {
        const recovery = await this.recoverFromContextOverflow(buildRequest(nextMessages), pluginCtx);
        if (recovery) {
          currentResponse = recovery.response;
          nextMessages.length = 0;
          nextMessages.push(...recovery.compactedMessages);
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }

    // Track 1.2: Record usage from initial provider call
    let totalTokensConsumed = this.recordUsage(currentResponse);

    // Track 2.3: Track cache hits in session metadata
    if (this.enablePromptCaching && currentResponse.usage?.cachedTokens && currentResponse.usage.cachedTokens > 0) {
      session.lineage = {
        ...(session.lineage ?? { rootSessionId: session.sessionId, compressionCount: 0 }),
      };
    }

    let errorReflectionCount = 0;
    let iterationsCompleted = 0;

    for (let iteration = 0; iteration < this.maxToolIterations; iteration += 1) {
      ensureNotAborted(input.signal);

      // #54: Drain pending /steer guidance — operator submitted via control
      // channel since the last iteration. Inject as a one-shot system
      // message *for this turn only*; never persist into nextMessages so
      // that on session restore the same nudge isn't replayed against
      // historical conversation state.
      const steerMessages = this.drainPendingSteers(input.sessionId);
      const turnExtraMessages: ConversationMessage[] = steerMessages.map(g => ({
        role: 'system',
        content: `[OPERATOR STEER] ${g}`,
        createdAt: nowIso(),
        metadata: { steer: true },
      }));

      // Track 1.2: Check token budget before continuing
      const budgetCheck = this.checkTokenBudget(totalTokensConsumed);
      if (budgetCheck.exceeded) {
        tokenBudgetExceeded = true;
        finalResponse = currentResponse.assistantMessage ?? 'Token budget exceeded.';
        break;
      }

      if (!currentResponse.toolCalls || currentResponse.toolCalls.length === 0) {
        finalResponse = currentResponse.assistantMessage ?? finalResponse;
        break;
      }

      nextMessages.push({
        role: 'assistant',
        content: currentResponse.assistantMessage ?? 'Running requested tools.',
        createdAt: nowIso(),
        metadata: {
          toolCount: currentResponse.toolCalls.length,
          iteration: iteration + 1,
          concurrent: this.concurrentToolCalls
        }
      });

      // Track 1.4: Checkpoint before executing dangerous tools
      if (this.autoCheckpoint && this.checkpointStore && currentResponse.toolCalls) {
        for (const tc of currentResponse.toolCalls) {
          const def = this.tools.get(tc.name);
          const dangerousSignals = collectDangerousInputSignals(tc.input);
          if (def?.manifest.dangerLevel === 'high' || dangerousSignals.length > 0) {
            await this.checkpointStore.save(createCheckpoint({ ...session, messages: nextMessages }, toolResults, iteration, 'pre-dangerous'));
            break; // Only one pre-dangerous checkpoint per iteration
          }
        }
      }

      let iterationResults: ToolExecutionResult[];
      if (this.concurrentToolCalls && currentResponse.toolCalls.length > 1) {
        const safetyPartition = this.partitionToolCallsBySafety(currentResponse.toolCalls);
        if (safetyPartition) {
          // Safety-aware execution: parallel first, then destructive sequentially
          const parallelResults = safetyPartition.parallel.length > 0
            ? await Promise.allSettled(safetyPartition.parallel.map((toolCall) => this.executeToolCall(toolCall, input)))
                .then((settled) => settled.map((s, i) =>
                  s.status === 'fulfilled'
                    ? s.value
                    : {
                        toolName: safetyPartition.parallel[i]?.name ?? 'unknown',
                        runtime: 'worker' as Exclude<ToolRuntime, 'either'>,
                        ok: false,
                        output: s.reason instanceof Error ? s.reason.message : String(s.reason),
                      }
                ))
            : [];
          const destructiveResults: ToolExecutionResult[] = [];
          for (const toolCall of safetyPartition.destructive) {
            const result = await this.executeToolCall(toolCall, input);
            destructiveResults.push(result);
          }
          iterationResults = [...parallelResults, ...destructiveResults];
        } else {
          // No safety annotations: fall back to all-parallel
          iterationResults = await Promise.allSettled(currentResponse.toolCalls.map((toolCall) => this.executeToolCall(toolCall, input)))
            .then((settled) => settled.map((s, i) =>
              s.status === 'fulfilled'
                ? s.value
                : {
                    toolName: currentResponse.toolCalls![i]?.name ?? 'unknown',
                    runtime: 'worker' as Exclude<ToolRuntime, 'either'>,
                    ok: false,
                    output: s.reason instanceof Error ? s.reason.message : String(s.reason),
                  }
            ));
        }
      } else {
        iterationResults = await currentResponse.toolCalls.reduce<Promise<ToolExecutionResult[]>>(async (accPromise, toolCall) => {
            const acc = await accPromise;
            const result = await this.executeToolCall(toolCall, input);
            acc.push(result);
            return acc;
          }, Promise.resolve([]));
      }

      const encounteredToolError = iterationResults.some((result) => !result.ok);

      // #57 (scheduler contract): record tool activity timestamp on the
      // session. The scheduler reads this to detect stalled sessions for
      // idle-shutdown. Only update if at least one tool actually ran.
      if (iterationResults.length > 0) {
        session.lastToolActivityAt = Date.now();
      }

      const iterationWarning = budgetStatus(iteration + 1, this.maxToolIterations, this.budgetWarningThreshold, this.budgetCriticalThreshold);

      // Track 1.2: Merge token budget warning with iteration budget warning
      const tokenWarning = budgetCheck.warning;
      const combinedWarning = [iterationWarning, tokenWarning].filter(Boolean).join('\n') || null;

      for (const rawResult of iterationResults) {
        const result = combinedWarning
          ? {
              ...rawResult,
              output: `${rawResult.output}\n${combinedWarning}`,
              metadata: { ...(rawResult.metadata ?? {}), budgetWarning: combinedWarning }
            }
          : rawResult;
        toolResults.push(result);
        nextMessages.push(toolMessage(result, this.maxToolResultLength));
        if (!result.ok) {
          await this.plugins?.emit('tool:error', {
            result,
            sessionId: input.sessionId,
            agentId: input.agentId,
          }, {
            runtime: this.runtimeName,
            sessionId: input.sessionId,
            agentId: input.agentId,
          });
        }
        await this.plugins?.emit('tool:result', {
          result,
          sessionId: input.sessionId,
          agentId: input.agentId,
        }, {
          runtime: this.runtimeName,
          sessionId: input.sessionId,
          agentId: input.agentId,
        });
      }

      if (encounteredToolError) {
        if (this.errorReflection && errorReflectionCount < this.maxErrorReflections) {
          errorReflectionCount++;
          const failedResults = iterationResults.filter(r => !r.ok);
          const errorSummary = failedResults
            .map(r => `- ${r.toolName}: ${r.output?.slice(0, 500) ?? 'unknown error'}`)
            .join('\n');
          const reflectionContent = this.planBeforeAct
            ? `Tool execution failed (reflection ${errorReflectionCount}/${this.maxErrorReflections}):\n${errorSummary}\n\nReplan your approach: (1) analyze what went wrong, (2) devise an alternative strategy, (3) proceed with different parameters or tools. Do not retry the exact same call.`
            : `Tool execution failed (reflection ${errorReflectionCount}/${this.maxErrorReflections}):\n${errorSummary}\n\nAnalyze what went wrong and try a different approach. Do not retry the exact same operation.`;
          nextMessages.push({
            role: 'system',
            content: reflectionContent,
            createdAt: nowIso(),
            metadata: { errorReflection: true, reflectionCount: errorReflectionCount },
          });
        } else if (this.stopOnToolError) {
          finalResponse = 'Stopped after tool failure.';
          break;
        }
      }

      // Track 2.1: Token-aware compression trigger
      if (this.shouldCompressTokenAware(nextMessages)) {
        const compression = this.compressionProvider
          ? await this.compressWithLLM(nextMessages)
          : compressMessages(nextMessages, 0, this.protectLastMessages);
        if (compression.compressedCount > 0) {
          nextMessages.length = 0;
          nextMessages.push(...compression.messages);
        }
      }

      // Track 1.4: Auto-checkpoint at end of iteration
      if (this.autoCheckpoint && this.checkpointStore) {
        await this.checkpointStore.save(createCheckpoint({ ...session, messages: nextMessages }, toolResults, iteration, 'iteration'));
      }

      // Tiered budget warnings (Hermes pattern) — inject ephemeral hints
      const budgetHint = this.getBudgetHint(iteration, this.maxToolIterations);
      if (budgetHint) {
        nextMessages.push({ role: 'system', content: budgetHint, createdAt: nowIso(), metadata: { budgetHint: true } });
      }

      // #43/#44 perf: reuse cachedSystemPrompt + toolList instead of rebuilding.
      // #54: prepend any drained steer messages for *this turn only*.
      currentResponse = await this.generateWithFallbacks({
        systemPrompt: cachedSystemPrompt,
        messages: turnExtraMessages.length > 0 ? [...turnExtraMessages, ...nextMessages] : nextMessages,
        availableTools: toolList,
        signal: input.signal
      }, {
        sessionId: input.sessionId,
        agentId: input.agentId
      });

      // Track 1.2: Record usage from subsequent provider calls
      totalTokensConsumed = this.recordUsage(currentResponse);
      finalResponse = currentResponse.assistantMessage ?? finalResponse;
      iterationsCompleted = iteration + 1;
    }

    if (!tokenBudgetExceeded && currentResponse.toolCalls && currentResponse.toolCalls.length > 0 && iterationsCompleted >= this.maxToolIterations) {
      if (this.synthesizeOnExhaustion) {
        // Exhaustion synthesis: one final call with no tools to force a text answer
        nextMessages.push({ role: 'system', content: 'You have used all available tool iterations. Based on all the information gathered so far, provide the best possible answer to the user\'s question. Synthesize your findings clearly and concisely.', createdAt: nowIso() });
        const synthesisResponse = await this.generateWithFallbacks({
          systemPrompt: this.buildSystemPromptForRequest({
            basePrompt: input.systemPrompt, runtimeName: this.runtimeName,
            sessionId: input.sessionId, availableTools: [],
            agentPreset: this.agentPreset,
          }),
          messages: nextMessages,
          availableTools: [], // No tools — force text response
          signal: input.signal
        }, { sessionId: input.sessionId, agentId: input.agentId });
        finalResponse = synthesisResponse.assistantMessage ?? finalResponse ?? 'Reached maximum tool iterations.';
      } else {
        finalResponse = finalResponse
          ? `${finalResponse}\nReached maximum tool iterations.`
          : 'Reached maximum tool iterations.';
      }
    }

    if (!finalResponse) {
      finalResponse = toolResults.length > 0
        ? `Executed ${toolResults.length} tool(s).`
        : `CrowClaw received: ${input.userMessage}`;
    }

    nextMessages.push({
      role: 'assistant',
      content: finalResponse,
      createdAt: nowIso(),
      metadata: toolResults.length > 0 ? { toolCount: toolResults.length } : undefined
    });

    // Strip transient memory prefix messages before persisting session
    // (they are re-injected fresh each turn from the memory service)
    const persistMessages = nextMessages.filter(m =>
      !(m.role === 'system' && m.content.includes('<recalled-context'))
    );

    // Track 2.2: Use LLM compression if provider is available, else heuristic
    const compression = this.compressionProvider
      ? await this.compressWithLLM(persistMessages)
      : compressMessages(persistMessages, this.compressAfterMessageCount, this.protectLastMessages);
    const baseLineage = session.lineage ?? {
      rootSessionId: session.sessionId,
      compressionCount: 0
    };

    const nextSession: SessionState = {
      ...session,
      userId: input.userId ?? session.userId,
      workspaceId: input.workspaceId ?? session.workspaceId,
      messages: compression.messages,
      updatedAt: nowIso(),
      // #57: forward lastToolActivityAt so persisted session reflects when
      // the agent last did real tool work (not just when it last responded).
      lastToolActivityAt: session.lastToolActivityAt,
      lineage: compression.compressedCount > 0
        ? {
            ...baseLineage,
            compressionCount: baseLineage.compressionCount + 1,
            lastCompressedAt: nowIso(),
            compressedMessageCount: compression.compressedCount
          }
        : baseLineage
    };

    await this.sessions.put(nextSession);

    // Track 1.4: Completion checkpoint
    if (this.autoCheckpoint && this.checkpointStore) {
      await this.checkpointStore.save(createCheckpoint(nextSession, toolResults, this.maxToolIterations, 'completion'));
    }

    const result: AgentRunResult = { session: nextSession, finalResponse, toolResults };
    await this.plugins?.emit('agent:afterRun', {
      input: input as unknown as { agentId: string; sessionId: string; [key: string]: unknown },
      result: result as unknown as { finalResponse: string; toolResults: Array<{ toolName: string; ok: boolean }> },
    }, {
      runtime: this.runtimeName,
      sessionId: input.sessionId,
      agentId: input.agentId,
    });

    return result;
  }

  /** Track 1.3: Streaming variant of run(). Yields events as they arrive. */
  async *runStreaming(input: {
    userMessage: string;
    sessionState: SessionState;
    signal?: AbortSignal;
  }): AsyncGenerator<AgentStreamEvent> {
    const { userMessage, sessionState: session, signal } = input;

    const streamingProvider = this.provider as Partial<StreamingProviderAdapter>;
    if (!streamingProvider.generateStream) {
      // Fall back to non-streaming: run the full loop and yield a done event
      const runInput: AgentRunInput = {
        agentId: session.agentId,
        sessionId: session.sessionId,
        userMessage,
        signal,
      };
      try {
        const result = await this.run(runInput);
        yield { type: 'done', response: result.finalResponse };
      } catch (error: unknown) {
        yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
      }
      return;
    }

    // Strip out [session-meta] dashboard markers so they never reach the LLM.
    // These are added by /api/sessions/:id/rename and are display-only metadata.
    // (Mirrors the same filter in run().)
    const cleanedStreamMessages = session.messages.filter(
      (m) => !(m.role === 'system' && m.content?.startsWith('[session-meta]')),
    );

    const nextMessages: ConversationMessage[] = [...cleanedStreamMessages, {
      role: 'user' as Role,
      content: userMessage,
      createdAt: nowIso(),
    }];

    // Security: scan user input for prompt injection in streaming mode
    let streamInjectionWarning: string | undefined;
    if (this.securityPolicy.scanUserInput) {
      const injectionScan = scanForEnhancedInjection(userMessage);
      if (injectionScan.detected) {
        const threatSummary = injectionScan.threats
          .map(t => `${t.severity}: ${t.description}`)
          .join('; ');
        streamInjectionWarning = `[SECURITY WARNING] Potential prompt injection detected in user input: ${threatSummary}`;
        this.securityAuditLog?.record({
          type: 'injection_detected',
          severity: injectionScan.threats.some(t => t.severity === 'high') ? 'critical' : 'warning',
          detail: threatSummary,
        });
      }
    }

    let finalResponse = '';
    let accumulatedUsage: ProviderResponseUsage | undefined;
    const toolResults: ToolExecutionResult[] = [];

    // #44 perf: snapshot tool catalog once for the duration of this stream.
    const streamToolList = this.tools.list();

    // Match skills
    let matchedSkills: MatchedSkill[] | undefined;
    if (this.skills.length > 0) {
      const skillMatches = matchSkillManifests(userMessage, this.skills, 3);
      if (skillMatches.length > 0) {
        matchedSkills = skillMatches.map(({ skill }) => ({
          name: skill.manifest.name,
          description: skill.manifest.description,
          instructions: skill.instructions,
          tools: skill.manifest.tools,
        }));

        // Warn about required tools that aren't registered
        const registeredToolNames = new Set(streamToolList.map(t => t.name));
        for (const ms of matchedSkills) {
          if (ms.tools) {
            for (const toolName of ms.tools) {
              if (!registeredToolNames.has(toolName)) {
                console.warn(`[CrowClaw] Skill "${ms.name}" requires tool "${toolName}" which is not registered.`);
              }
            }
          }
        }
      }
    }

    // #56 (provider contract): apply tool-use guidance for streaming path too.
    let streamBasePrompt: string | undefined = streamInjectionWarning;
    const streamProviderWithGuidance = this.provider as { getToolUseGuidance?: (modelId: string) => string | null };
    if (typeof streamProviderWithGuidance.getToolUseGuidance === 'function') {
      const guidance = streamProviderWithGuidance.getToolUseGuidance('unknown');
      if (guidance) {
        streamBasePrompt = streamBasePrompt ? `${streamBasePrompt}\n\n${guidance}` : guidance;
      }
    }

    // #43 perf: cache the system prompt once for the stream.
    const cachedStreamSystemPrompt = this.buildSystemPromptForRequest({
      basePrompt: streamBasePrompt,
      runtimeName: this.runtimeName,
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      userId: session.userId,
      availableTools: streamToolList,
      matchedSkills,
      agentPreset: this.agentPreset,
    });

    let streamErrorReflectionCount = 0;
    let streamIterationsCompleted = 0;
    let lastStreamHadToolCalls = false;

    try {
      for (let iteration = 0; iteration < this.maxToolIterations; iteration += 1) {
        ensureNotAborted(signal);
        yield { type: 'iteration-start', iteration };

        // #54: drain pending /steer guidance for this turn (streaming path).
        const streamSteers = this.drainPendingSteers(session.sessionId);
        const streamTurnExtra: ConversationMessage[] = streamSteers.map(g => ({
          role: 'system',
          content: `[OPERATOR STEER] ${g}`,
          createdAt: nowIso(),
          metadata: { steer: true },
        }));

        const request: ProviderRequest = {
          systemPrompt: cachedStreamSystemPrompt,
          messages: streamTurnExtra.length > 0 ? [...streamTurnExtra, ...nextMessages] : nextMessages,
          availableTools: streamToolList,
          signal,
        };

        // Collect stream chunks and yield text deltas (with stream-drop fallback)
        let text = '';
        const streamToolCalls: Array<{ name: string; input: Record<string, unknown>; id?: string }> = [];
        let currentTool: { name: string; input: string; id?: string } | null = null;

        // Build provider candidates: primary streaming provider + fallbacks that support streaming
        const streamProviderCandidates: Array<Partial<StreamingProviderAdapter>> = [
          streamingProvider,
          ...this.fallbackProviders
            .filter((p): p is ProviderAdapter & Partial<StreamingProviderAdapter> =>
              typeof (p as Partial<StreamingProviderAdapter>).generateStream === 'function')
        ];

        let streamConsumed = false;
        for (let providerIdx = 0; providerIdx < streamProviderCandidates.length; providerIdx++) {
          const candidateProvider = streamProviderCandidates[providerIdx];
          if (!candidateProvider.generateStream) continue;

          try {
            const rawStream = candidateProvider.generateStream(request);

            for await (const chunk of rawStream) {
              switch (chunk.type) {
                case 'text':
                  if (chunk.text) {
                    text += chunk.text;
                    yield { type: 'text-delta', content: chunk.text };
                  }
                  break;
                case 'tool_use_start':
                  currentTool = { name: chunk.toolName ?? '', input: '', id: chunk.toolCallId };
                  break;
                case 'tool_use_delta':
                  if (currentTool) currentTool.input += chunk.toolInput ?? '';
                  break;
                case 'tool_use_end':
                  if (currentTool) {
                    let parsedInput: Record<string, unknown>;
                    try {
                      parsedInput = JSON.parse(currentTool.input || '{}') as Record<string, unknown>;
                    } catch {
                      parsedInput = { raw: currentTool.input };
                    }
                    streamToolCalls.push({ name: currentTool.name, input: parsedInput, id: currentTool.id });
                    currentTool = null;
                  }
                  break;
                case 'error':
                  // Stream-level error from provider — attempt fallback
                  throw new Error(chunk.error ?? 'Stream error');
                case 'done':
                  break;
              }
            }

            // Stream completed successfully
            streamConsumed = true;
            break;
          } catch (streamError: unknown) {
            const errorMsg = streamError instanceof Error ? streamError.message : String(streamError);
            const isLastProvider = providerIdx === streamProviderCandidates.length - 1;

            if (isLastProvider) {
              // No more fallbacks — yield error and abort
              yield { type: 'error', error: errorMsg };
              return;
            }

            // Notify caller about the fallback and reset state for the next provider
            yield { type: 'error', error: `Provider stream dropped, falling back... (${errorMsg})` };
            text = '';
            streamToolCalls.length = 0;
            currentTool = null;
          }
        }

        if (!streamConsumed) {
          yield { type: 'error', error: 'No streaming provider available' };
          return;
        }

        finalResponse = text || finalResponse;

        // Track 1.2: Token budget check
        const totalTokens = this.usageTracker?.getSummary().totalTokens ?? 0;
        const budgetCheck = this.checkTokenBudget(totalTokens);
        if (budgetCheck.exceeded) {
          yield { type: 'iteration-end', iteration };
          break;
        }

        // If no tool calls, we're done
        if (streamToolCalls.length === 0) {
          lastStreamHadToolCalls = false;
          yield { type: 'iteration-end', iteration };
          break;
        }

        lastStreamHadToolCalls = true;

        // Push assistant message
        nextMessages.push({
          role: 'assistant',
          content: text || 'Running requested tools.',
          createdAt: nowIso(),
        });

        // Execute tool calls
        let encounteredToolError = false;
        const iterationToolResults: ToolExecutionResult[] = [];
        if (this.concurrentToolCalls && streamToolCalls.length > 1) {
          const runInput: AgentRunInput = {
            agentId: session.agentId,
            sessionId: session.sessionId,
            userMessage,
            signal,
          };
          const safetyPartition = this.partitionToolCallsBySafety(streamToolCalls);
          if (safetyPartition) {
            // Safety-aware streaming execution.
            // Track tool-call → id via a Map so we don't mutate incoming objects
            // (providers may return frozen/pooled instances where property
            // assignment is a silent no-op, dropping the id).
            const resolvedIds = new Map<ToolCall, string>();
            const concurrentStartTime = Date.now();
            // Emit tool-start for parallel tools, execute in parallel
            for (const tc of safetyPartition.parallel) {
              const toolCallId = (tc as ToolCall & { id?: string }).id ?? `tc-${Date.now().toString(36)}-${tc.name}`;
              resolvedIds.set(tc, toolCallId);
              yield { type: 'tool-start' as const, toolName: tc.name, toolCallId, input: tc.input };
            }
            if (safetyPartition.parallel.length > 0) {
              const settled = await Promise.allSettled(
                safetyPartition.parallel.map((tc) => this.executeToolCall(tc, runInput))
              );
              for (let i = 0; i < settled.length; i++) {
                const tc = safetyPartition.parallel[i];
                const toolCallId = resolvedIds.get(tc) ?? `tc-${tc.name}`;
                const s = settled[i];
                const result: ToolExecutionResult = s.status === 'fulfilled'
                  ? s.value
                  : { toolName: tc.name, runtime: 'worker' as Exclude<ToolRuntime, 'either'>, ok: false, output: s.reason instanceof Error ? s.reason.message : String(s.reason) };
                toolResults.push(result);
                iterationToolResults.push(result);
                nextMessages.push(toolMessage(result, this.maxToolResultLength));
                yield { type: 'tool-end' as const, toolName: tc.name, toolCallId, result: result.output, ok: result.ok, durationMs: Date.now() - concurrentStartTime };
                if (!result.ok) encounteredToolError = true;
              }
            }
            // Execute destructive tools sequentially
            for (const tc of safetyPartition.destructive) {
              const toolCallId = (tc as ToolCall & { id?: string }).id ?? `tc-${Date.now().toString(36)}-${tc.name}`;
              const toolStartTime = Date.now();
              yield { type: 'tool-start' as const, toolName: tc.name, toolCallId, input: tc.input };
              const result = await this.executeToolCall(tc, runInput);
              toolResults.push(result);
              iterationToolResults.push(result);
              nextMessages.push(toolMessage(result, this.maxToolResultLength));
              yield { type: 'tool-end' as const, toolName: tc.name, toolCallId, result: result.output, ok: result.ok, durationMs: Date.now() - toolStartTime };
              if (!result.ok) encounteredToolError = true;
            }
          } else {
            // No safety annotations: fall back to all-parallel
            const concurrentStartTime = Date.now();
            const resolvedIds = new Map<ToolCall, string>();
            for (const tc of streamToolCalls) {
              const toolCallId = tc.id ?? `tc-${Date.now().toString(36)}-${tc.name}`;
              resolvedIds.set(tc, toolCallId);
              yield { type: 'tool-start' as const, toolName: tc.name, toolCallId, input: tc.input };
            }
            const settled = await Promise.allSettled(
              streamToolCalls.map((tc) => this.executeToolCall(tc, runInput))
            );
            for (let i = 0; i < settled.length; i++) {
              const tc = streamToolCalls[i];
              const toolCallId = resolvedIds.get(tc) ?? `tc-${tc.name}`;
              const s = settled[i];
              const result: ToolExecutionResult = s.status === 'fulfilled'
                ? s.value
                : { toolName: tc.name, runtime: 'worker' as Exclude<ToolRuntime, 'either'>, ok: false, output: s.reason instanceof Error ? s.reason.message : String(s.reason) };
              toolResults.push(result);
              iterationToolResults.push(result);
              nextMessages.push(toolMessage(result, this.maxToolResultLength));
              yield { type: 'tool-end' as const, toolName: tc.name, toolCallId, result: result.output, ok: result.ok, durationMs: Date.now() - concurrentStartTime };
              if (!result.ok) encounteredToolError = true;
            }
          }
        } else {
          for (const tc of streamToolCalls) {
            const toolCallId = tc.id ?? `tc-${Date.now().toString(36)}-${tc.name}`;
            const toolStartTime = Date.now();
            yield { type: 'tool-start', toolName: tc.name, toolCallId, input: tc.input };

            // #53: Hardline blocklist in streaming path — before approval.
            const streamHardline = isHardlineBlocked({ name: tc.name, input: tc.input }, this.hardlineBlocklist);
            if (streamHardline.blocked) {
              this.securityAuditLog?.record({
                type: 'command_blocked',
                severity: 'critical',
                detail: `hardline-blocked: ${streamHardline.description} (pattern: ${streamHardline.pattern})`,
                sessionId: session.sessionId,
              });
              const blockedResult: ToolExecutionResult = {
                toolName: tc.name,
                runtime: 'worker',
                ok: false,
                output: `Tool call rejected by hardline blocklist: ${streamHardline.description}`,
                metadata: {
                  blockedByHardline: true,
                  hardlinePattern: streamHardline.pattern,
                  hardlineDescription: streamHardline.description,
                },
              };
              toolResults.push(blockedResult);
              nextMessages.push(toolMessage(blockedResult, this.maxToolResultLength));
              yield { type: 'tool-end', toolName: tc.name, toolCallId, result: blockedResult.output, ok: false, durationMs: Date.now() - toolStartTime };
              continue;
            }

            // Security: command scanning in streaming path
            const streamCmdScan = this.scanToolCommandInput({ name: tc.name, input: tc.input });
            if (streamCmdScan.blocked) {
              const blockedResult: ToolExecutionResult = {
                toolName: tc.name,
                runtime: 'worker',
                ok: false,
                output: `Tool call blocked by security policy: ${streamCmdScan.warnings.join('; ')}`,
                metadata: { blockedBySecurity: true, securityWarnings: streamCmdScan.warnings },
              };
              toolResults.push(blockedResult);
              nextMessages.push(toolMessage(blockedResult, this.maxToolResultLength));
              yield { type: 'tool-end', toolName: tc.name, toolCallId, result: blockedResult.output, ok: false, durationMs: Date.now() - toolStartTime };
              continue;
            }

            // Check approval gate
            const def = this.tools.get(tc.name);
            const dangerousSignals = collectDangerousInputSignals(tc.input);
            const needsApproval = this.requireApprovalForDangerousTools
              && def && (def.manifest.dangerLevel === 'high' || dangerousSignals.length > 0);

            if (needsApproval) {
              // Track 1.4: Checkpoint before dangerous tool
              if (this.autoCheckpoint && this.checkpointStore) {
                await this.checkpointStore.save(createCheckpoint({ ...session, messages: nextMessages }, toolResults, iteration, 'pre-dangerous'));
              }

              const context: ToolExecutionContext = {
                agentId: session.agentId,
                sessionId: session.sessionId,
              };
              const approved = this.approvalDecider
                ? await this.approvalDecider(def!, tc.input, context)
                : false;

              if (!approved) {
                const blockedResult: ToolExecutionResult = {
                  toolName: tc.name,
                  runtime: 'worker',
                  ok: false,
                  output: `Tool requires approval: ${tc.name}`,
                };
                toolResults.push(blockedResult);
                nextMessages.push(toolMessage(blockedResult, this.maxToolResultLength));
                yield { type: 'tool-end', toolName: tc.name, toolCallId, result: blockedResult.output, ok: false, durationMs: Date.now() - toolStartTime };
                continue;
              }
            }

            const context: ToolExecutionContext = {
              agentId: session.agentId,
              sessionId: session.sessionId,
              signal,
            };
            let toolResult = await this.tools.execute(tc.name, tc.input, context);

            // Security: append command scan warnings
            if (streamCmdScan.warnings.length > 0) {
              toolResult = { ...toolResult, output: `${toolResult.output}\n${streamCmdScan.warnings.join('\n')}` };
            }

            // Security: redact tool output in streaming path
            toolResult = this.redactToolResult(toolResult);

            toolResults.push(toolResult);
            iterationToolResults.push(toolResult);
            nextMessages.push(toolMessage(toolResult, this.maxToolResultLength));
            yield { type: 'tool-end', toolName: tc.name, toolCallId, result: toolResult.output, ok: toolResult.ok, durationMs: Date.now() - toolStartTime };

            if (!toolResult.ok) {
              encounteredToolError = true;
              if (this.errorReflection && streamErrorReflectionCount < this.maxErrorReflections) {
                // Will be handled after all sequential tool calls complete
              } else if (this.stopOnToolError) {
                finalResponse = 'Stopped after tool failure.';
                yield { type: 'iteration-end', iteration };
                yield { type: 'done', response: finalResponse, usage: accumulatedUsage };
                return;
              }
            }
          }
        }

        // #57 (scheduler contract): record tool activity timestamp on the
        // session whenever any tool ran in this iteration.
        if (iterationToolResults.length > 0) {
          session.lastToolActivityAt = Date.now();
        }

        if (encounteredToolError) {
          if (this.errorReflection && streamErrorReflectionCount < this.maxErrorReflections) {
            streamErrorReflectionCount++;
            const failedResults = iterationToolResults.filter(r => !r.ok);
            const errorSummary = failedResults
              .map(r => `- ${r.toolName}: ${r.output?.slice(0, 500) ?? 'unknown error'}`)
              .join('\n');
            nextMessages.push({
              role: 'system',
              content: `Tool execution failed (reflection ${streamErrorReflectionCount}/${this.maxErrorReflections}):\n${errorSummary}\n\nAnalyze what went wrong and try a different approach. Do not retry the exact same operation.`,
              createdAt: nowIso(),
              metadata: { errorReflection: true, reflectionCount: streamErrorReflectionCount },
            });
          } else if (this.stopOnToolError) {
            finalResponse = 'Stopped after tool failure.';
            yield { type: 'iteration-end', iteration };
            yield { type: 'done', response: finalResponse, usage: accumulatedUsage };
            return;
          }
        }

        // Track 1.4: Auto-checkpoint at end of iteration
        if (this.autoCheckpoint && this.checkpointStore) {
          await this.checkpointStore.save(createCheckpoint({ ...session, messages: nextMessages }, toolResults, iteration, 'iteration'));
        }

        streamIterationsCompleted = iteration + 1;
        yield { type: 'iteration-end', iteration };
      }

      // Synthesize on exhaustion (mirrors run() behavior).
      // Synthesis runs once with no tools available — must rebuild the system
      // prompt because availableTools differs from the cached version.
      if (lastStreamHadToolCalls && streamIterationsCompleted >= this.maxToolIterations && this.synthesizeOnExhaustion) {
        nextMessages.push({ role: 'system', content: 'You have used all available tool iterations. Based on all the information gathered so far, provide the best possible answer to the user\'s question. Synthesize your findings clearly and concisely.', createdAt: nowIso() });
        const synthesisRequest: ProviderRequest = {
          systemPrompt: this.buildSystemPromptForRequest({
            basePrompt: userMessage,
            runtimeName: this.runtimeName,
            sessionId: session.sessionId,
            availableTools: [],
            agentPreset: this.agentPreset,
          }),
          messages: nextMessages,
          availableTools: [],
          signal,
        };
        if (streamingProvider) {
          let synthesisText = '';
          for await (const chunk of streamingProvider.generateStream(synthesisRequest)) {
            if (chunk.type === 'text' && chunk.text) {
              synthesisText += chunk.text;
              yield { type: 'text-delta', content: chunk.text };
            }
          }
          if (synthesisText) finalResponse = synthesisText;
        }
      }

      // Save completion checkpoint
      if (this.autoCheckpoint && this.checkpointStore) {
        await this.checkpointStore.save(
          createCheckpoint({ ...session, messages: nextMessages }, toolResults, this.maxToolIterations, 'completion')
        );
      }
      yield { type: 'done', response: finalResponse, usage: accumulatedUsage };
    } catch (error: unknown) {
      yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
    }
  }
}

/**
 * #55: Forked-context child session helper.
 *
 * When a parent agent delegates to a child via `delegate.task` (or similar)
 * with `forkContext: true`, the child should start with a clean conversation
 * history seeded only with the delegated task. The previous behavior shared
 * `parent.messages` directly, which contaminated the child's reasoning with
 * parent-specific context and forced the child to re-derive intent from
 * conversation it didn't author.
 *
 * Tool output flows back to the parent as a single tool result, just like a
 * sandboxed call. Children get a unique sessionId nested under the parent so
 * trace UIs can reconstruct the call tree.
 *
 * The TOOLS package owns the delegation tool itself and is responsible for
 * calling this helper when its `forkContext` option is enabled.
 */
export function forkSession(
  parent: SessionState,
  task: string,
  childAgentId: string,
  childSessionIdSuffix?: string,
): SessionState {
  const suffix = childSessionIdSuffix
    ?? `child-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    agentId: childAgentId,
    sessionId: `${parent.sessionId}/${suffix}`,
    userId: parent.userId,
    workspaceId: parent.workspaceId,
    messages: [{
      role: 'user',
      content: task,
      createdAt: new Date().toISOString(),
      metadata: {
        forkedFrom: parent.sessionId,
        forkedFromAgent: parent.agentId,
      },
    }],
    updatedAt: new Date().toISOString(),
    lineage: {
      // Trace back to the original root so observability can reconstruct
      // the full call tree even when delegation nests several levels deep.
      rootSessionId: parent.lineage?.rootSessionId ?? parent.sessionId,
      compressionCount: 0,
    },
  };
}

export { buildSystemPrompt, buildMemoryPrefix, type MatchedSkill, type PromptBuilderInput } from './prompt-builder.js';

export {
  isPrivateUrl,
  validateFetchUrl,
  scanForInjection,
  sanitizeText,
  redactPII,
  containsSecrets,
  redactCredentials,
  redactToolOutput,
  redactStructuredData,
  scanForEnhancedInjection,
  scanCommand,
  type InjectionScanResult,
  type RedactionResult,
  type InjectionThreat,
  type EnhancedInjectionScanResult,
  type CommandRisk,
  type CommandScanResult,
  SecurityAuditLog,
  type SecurityEvent,
  type SecurityEventType,
  type SecurityEventSeverity,
} from './security.js';

export { UsageTracker, type TokenUsage, type UsageRecord, type SessionUsageSummary } from './usage.js';
export { DetailedUsageTracker, type UsageEntry, type UsageSummary } from './usage-tracker.js';
export { ConversationTree, type ConversationBranch, type BranchComparison } from './branching.js';

export { parseSkillFile, renderSkillFile, loadSkillsFromDirectory, matchSkillManifests, filterAndBudgetSkills, checkSkillGates, type SkillManifest, type ParsedSkillFile, type SkillFileSystem, type SkillDirectoryEntry } from './skill-manifest.js';

export { agentPresets, getAgentPreset, listAgentPresets, listAgentPresetNames, type AgentPreset } from './agent-presets.js';

export {
  createCheckpoint,
  restoreFromCheckpoint,
  diffCheckpoints,
  createReplaySession,
  InMemoryCheckpointStore,
  type SessionCheckpoint,
  type CheckpointTrigger,
  type CheckpointStore,
  type CheckpointDiff,
  type RestoredSession,
} from './checkpoint.js';

export {
  parseIdentity,
  buildPersonaPrompt,
  loadPersonaFiles,
  getDefaultPersonaPrompt,
  PersonaRegistry,
  scanPersonaDirectories,
  type PersonaFiles,
  type PersonaConfig,
  type PersonaProfile,
} from './persona.js';

export { collectStream, textStream, type StreamChunk, type StreamingProviderAdapter } from './streaming.js';

export { compressWithStructure, mergeStructuredSummaries, formatStructuredSummary, type StructuredSummary, type StructuredCompressionResult, type StructuredCompressionOptions } from './structured-compression.js';

export { ContextEngine, loadContextFiles, formatContextForPrompt, type ContextFile, type ContextEngineOptions, type ContextEngineResult } from './context-engine.js';

export { identifyToolPairs, splitWithPairPreservation, extractPreflightFacts, createCompressionChild, type ToolCallPair, type ChildSessionResult } from './compression-utils.js';

export { scoreComplexity, selectModelForComplexity, type ComplexityLevel, type ComplexityScore } from './complexity-router.js';

export { HARDLINE_BLOCKLIST, isHardlineBlocked, type HardlineBlockResult } from './hardline-blocklist.js';
