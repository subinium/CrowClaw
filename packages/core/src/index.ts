import { PluginManager } from './plugins.js';
export {
  PluginManager,
  MemoryCapturePlugin,
} from './plugins.js';
export type {
  Plugin,
  PluginContext,
  PluginHookName,
  PluginHookPayloads,
  PluginInvocationName,
  PluginInvocationPayloads,
  PreToolCallVeto,
  ToolResultTransform,
} from './plugins.js';
import { buildSystemPrompt, buildMemoryPrefix, normalizeLocale, type PromptBuilderInput, type SupportedLocale } from './prompt-builder.js';
import { matchSkillManifests, filterAndBudgetSkills, checkSkillGates, localizeSkillFile, type ParsedSkillFile, type SkillManifest } from './skill-manifest.js';
import type { MatchedSkill } from './prompt-builder.js';
import type { StreamChunk, StreamingProviderAdapter } from './streaming.js';
import { createCheckpoint, type CheckpointStore, type SessionCheckpoint } from './checkpoint.js';
import type { DetailedUsageTracker } from './usage-tracker.js';
import { redactToolOutput as redactToolOutputFn, scanForEnhancedInjection, scanCommand, SecurityAuditLog } from './security.js';
import { splitWithPairPreservation, extractPreflightFacts } from './compression-utils.js';
import { isHardlineBlocked, HARDLINE_BLOCKLIST } from './hardline-blocklist.js';
import { stripReasoningContent } from './provider-switch.js';
// #314 — per-session pending-queue primitive. Used by ACP `acp.queue`, the
// REST/WS handlers, and the iteration-end drain in this file.
import {
  type PendingQueueStore,
  type QueuedUserMessage,
  type SerializedQueueEntry,
  createPendingQueueStore,
  enqueueMessage,
  drainPendingQueue,
  pendingQueueLength,
  peekPendingQueue,
  buildQueueAnnotation,
  serializeQueue,
  restoreQueue,
  OPERATOR_QUEUE_SEPARATOR,
} from './queue.js';

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
  /** Delegation depth propagated through child agents and sandboxed tool RPC. */
  delegateDepth?: number;
  /** Env passed to tools. Use sanitizeEnv() to strip sensitive vars before passing. */
  env?: unknown;
  signal?: AbortSignal;
}

export function normalizeDelegateDepth(delegateDepth: unknown): number {
  if (delegateDepth === undefined) return 0;
  if (
    typeof delegateDepth !== 'number'
    || !Number.isSafeInteger(delegateDepth)
    || delegateDepth < 0
  ) {
    throw new TypeError('delegateDepth must be a non-negative safe integer.');
  }
  return delegateDepth;
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
  /** Optional provider-level generation cap. Providers map this to their API-specific token field. */
  maxTokens?: number;
  /** Optional sampling temperature. Providers may drop it for models that reject temperature. */
  temperature?: number;
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
  /**
   * v0.8.0 (#231): when the response contains Hermes-style reasoning XML blocks
   * (`<plan>`, `<reasoning>`, `<reflection>`, `<thinking>`, `<think>`, etc.) the
   * provider parses them out and exposes them here. `assistantMessage` carries
   * the stripped (non-reasoning) text so existing consumers keep their
   * contract. Optional — providers that don't see any blocks omit this field.
   */
  reasoningBlocks?: import('./reasoning-blocks.js').ReasoningBlock[];
}

export interface ProviderAdapter {
  generate(request: ProviderRequest): Promise<ProviderResponse>;
  countTokens?(messages: ConversationMessage[]): number;
  /** #56 (provider contract, optional): if implemented, returns model-specific
   *  tool-use guidance text that the agent loop appends to the system prompt.
   *  Detected at runtime via `typeof provider.getToolUseGuidance === 'function'`
   *  so providers that don't implement it don't pay any cost. */
  getToolUseGuidance?(modelId: string): string | null;
  /** #237 (v0.8.0 Hermes parity): optional JSON-schema-typed generation. */
  generateStructured?<T = unknown>(req: import('./structured-output.js').StructuredOutputRequest<T>): Promise<import('./structured-output.js').StructuredOutputResponse<T>>;
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
  /** #187: number of memory records bound to this session. Populated by the
   *  runtime when serializing the session for the dashboard so operators can
   *  identify memory-heavy sessions. Storage-side persistence is optional —
   *  consumers should treat absence as "not yet measured", not zero. */
  memoryEntryCount?: number;
  /** #187: total UTF-8 byte size of the memory record summaries bound to
   *  this session. Same lifecycle/semantics as `memoryEntryCount`. */
  memoryBytes?: number;
  /**
   * #314 — Pending `/queue` messages awaiting drain into the next user turn.
   * Persisted alongside the session so a host restart preserves operator
   * follow-up messages. The AgentLoop drains this at iteration-end (after
   * the model produces text) and concatenates the entries into the next
   * user-turn message with `OPERATOR_QUEUE_SEPARATOR`. Empty when no
   * follow-ups are queued — storage adapters MAY omit the field.
   */
  pendingQueue?: import('./queue.js').QueuedUserMessage[];
  /**
   * #314 — Per-iteration reasoning blocks preserved across session restore
   * (companion to v0.6.0 reasoning-content scrub). When the provider
   * surfaces `<plan>`, `<reasoning>`, `<reflection>` blocks the AgentLoop
   * appends a trimmed record here so a restored session still sees the
   * planning context that produced its current state. Treated as
   * append-only metadata — never re-fed into the model on its own.
   */
  reasoningHistory?: import('./reasoning-blocks.js').ReasoningBlock[];
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
  /** Delegation depth propagated to all tool calls made during this run. */
  delegateDepth?: number;
  env?: unknown;
  signal?: AbortSignal;
  /** Pre-recalled memories to inject into the system prompt. */
  memories?: string[];
  /** Preferred UI/user locale for dynamic system prompt language. */
  locale?: SupportedLocale;
}

/**
 * #239 (v0.8.0 Hermes parity): why the agent loop exited.
 *  - 'natural'                          — model produced a final response with no tool calls
 *  - 'budget_exhausted_with_synthesis'  — iteration or token cap hit; loop ran one final no-tool synthesis turn
 *  - 'tool_error_terminal'              — same (tool, error code) failed 3 iterations in a row (#235)
 *  - 'aborted'                          — caller-provided AbortSignal fired
 */
export type AgentTerminationReason =
  | 'natural'
  | 'budget_exhausted_with_synthesis'
  | 'tool_error_terminal'
  | 'aborted';

export interface AgentRunResult {
  session: SessionState;
  finalResponse: string;
  toolResults: ToolExecutionResult[];
  /** #239: classification of why the loop exited. Always set on a successful return. */
  terminationReason: AgentTerminationReason;
}

/**
 * #239: companion type for the streaming variant. Surfaced via the final
 * `done` event so downstream consumers can branch on the same exit reasons
 * as the non-streaming `run()`.
 */
export interface AgentStreamResult {
  response: string;
  usage?: ProviderResponseUsage;
  terminationReason: AgentTerminationReason;
}

export type AgentStreamEvent =
  | { type: 'text-delta'; content: string }
  | { type: 'tool-start'; toolName: string; toolCallId: string; input?: Record<string, unknown> }
  | { type: 'tool-end'; toolName: string; toolCallId: string; result: string; ok: boolean; durationMs?: number }
  | { type: 'iteration-start'; iteration: number }
  | { type: 'iteration-end'; iteration: number }
  | { type: 'done'; response: string; usage?: ProviderResponseUsage; terminationReason?: AgentTerminationReason }
  | { type: 'error'; error: string };

/**
 * #235 / #239 (v0.8.0): structural interface compatible with runtime-node's
 * `EventBus`. Core does not import runtime-node (one-way dependency), so we
 * accept any object with this shape. The orchestrator passes the live
 * EventBus when constructing the AgentLoop; tests can pass a fake.
 */
export interface AgentEventEmitter {
  emit(type: string, data: Record<string, unknown>): void;
}

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
  /** #79: Workspace bootstrap injection mode.
   *  - 'auto' (default): inject runtime context (Runtime / Session / Workspace
   *    / User) and the tool list into the system prompt.
   *  - 'never': caller owns the entire prompt lifecycle. The bootstrap block
   *    is suppressed; only `personaPrompt`, `basePrompt`, `agentPreset`, and
   *    `matchedSkills` go into the system prompt. Tool-use guidance is also
   *    suppressed. Used by external orchestrators that build their own prompt.
   *  Mirrors OpenClaw v2026.4.24 `agents.defaults.contextInjection`. */
  contextInjection?: 'auto' | 'never';
  /** #83: identifier of the active primary provider (e.g. "deepseek",
   *  "anthropic", "kimi"). Used to scrub reasoning_content / <think> blocks
   *  on provider switches (fallback, fork, steer). Optional; if unset the
   *  scrubber treats every switch as foreign and always strips. */
  providerName?: string;
  /** #83: identifiers of fallback providers, parallel to `fallbackProviders`.
   *  When the loop trips into a fallback we use this to detect that the
   *  active provider has changed and trigger reasoning-content scrubbing. */
  fallbackProviderNames?: string[];
  /** #235 / #239 (v0.8.0): runtime event emitter (structurally compatible with
   *  the runtime-node EventBus) used for `tool:validation_failed`,
   *  `tool:repeated_failure`, and `agent:terminated`. Optional — when absent,
   *  the agent loop runs unchanged but the runtime cannot observe these
   *  lifecycle moments. */
  eventBus?: AgentEventEmitter;
  /** #235 (v0.8.0): consecutive identical (toolName, errorCode) failures that
   *  trigger a terminal exit. Default: 3 (Hermes pattern). */
  toolFailureStreakLimit?: number;
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

/**
 * #235 (v0.8.0 Hermes parity): build a structured tool-error envelope.
 * The agent loop injects this as the `content` of a `role:'tool'` message so
 * the model sees a machine-readable failure payload (with explicit retry
 * instructions) instead of a free-text "Tool failed:" string. Truncation is
 * applied to the error message only — the envelope schema is fixed.
 */
export function buildToolErrorEnvelope(
  toolName: string,
  error: unknown,
  inputSchema?: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error ? error.constructor.name : 'UnknownError';
  const truncated = message.length > 2000 ? message.slice(0, 2000) + '\n…[truncated]' : message;
  const schemaHint = inputSchema ? `\nUse this schema: ${JSON.stringify(inputSchema)}` : '';
  return JSON.stringify({
    name: toolName,
    ok: false,
    error: { code, message: truncated },
    retry_instruction: `Call ${toolName} again with corrected arguments.${schemaHint}`,
  });
}

/**
 * #235 (v0.8.0): tiny inline validator. Checks `required` keys exist and
 * top-level types match. Sufficient for "did the model send the right shape"
 * — we deliberately do not pull in Ajv. Only checks the top-level schema:
 * nested object validation is the tool's job.
 *
 * Returns `null` when the input passes (or no schema is provided), or an
 * Error with a description when validation fails.
 */
export function validateToolInputAgainstSchema(
  input: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): Error | null {
  if (!schema || typeof schema !== 'object') return null;
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
  for (const key of required) {
    if (typeof key !== 'string') continue;
    if (!(key in input)) {
      return new Error(`Missing required property: "${key}"`);
    }
  }
  const properties = (schema.properties && typeof schema.properties === 'object')
    ? schema.properties as Record<string, { type?: string }>
    : null;
  if (!properties) return null;
  for (const [key, propSchema] of Object.entries(properties)) {
    if (!(key in input)) continue;
    const expectedType = propSchema?.type;
    if (typeof expectedType !== 'string') continue;
    const actual = input[key];
    const actualType = Array.isArray(actual) ? 'array' : typeof actual;
    // JSON Schema 'integer' is a refinement of 'number' — accept both as numbers.
    const ok = expectedType === 'integer'
      ? actualType === 'number' && Number.isInteger(actual as number)
      : actualType === expectedType;
    if (!ok) {
      return new Error(`Property "${key}" expected type "${expectedType}" but got "${actualType}"`);
    }
  }
  return null;
}

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
  /** #314: queue of pending /queue follow-up user messages per session. Distinct
   *  from `pendingSteers`: queue entries are drained at iteration *end* and
   *  concatenated into the next user-turn message via `OPERATOR_QUEUE_SEPARATOR`.
   *  Persisted with the session (atomic-rename) so a host restart preserves
   *  operator follow-ups. ACP `acp.queue`, REST, and WS handlers all push here. */
  private readonly pendingQueue: PendingQueueStore = createPendingQueueStore();
  /** #53: extra hardline patterns supplied by the operator at construction
   *  time (e.g., loaded from env config). Merged with the static defaults. */
  private readonly hardlineBlocklist: ReadonlyArray<{ pattern: RegExp; description: string }>;
  /** #79: 'never' suppresses workspace bootstrap injection in system prompt. */
  private readonly contextInjection: 'auto' | 'never';
  /** #83: name of the primary provider, used to detect cross-provider
   *  switches in the fallback chain so we can scrub reasoning content. */
  private readonly providerName?: string;
  private readonly fallbackProviderNames: string[];
  /** #235 / #239 (v0.8.0): structural emitter for harness-level lifecycle. */
  private readonly eventBus?: AgentEventEmitter;
  /** #235 (v0.8.0): consecutive identical (toolName, errorCode) cap. */
  private readonly toolFailureStreakLimit: number;

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
    this.contextInjection = options.contextInjection ?? 'auto';
    this.providerName = options.providerName;
    this.fallbackProviderNames = options.fallbackProviderNames ?? [];
    this.eventBus = options.eventBus;
    this.toolFailureStreakLimit = options.toolFailureStreakLimit ?? 3;
  }

  private auditProvenance(input?: { agentId?: string; sessionId?: string }): {
    agentId?: string;
    sessionId?: string;
    model?: string;
    provider?: string;
    presetId?: string;
  } {
    const providerWithModel = this.provider as ProviderAdapter & { getModel?: () => string };
    const model = typeof providerWithModel.getModel === 'function' ? providerWithModel.getModel() : undefined;
    const presetId = this.agentPreset?.role;
    return {
      ...(input?.agentId ? { agentId: input.agentId } : {}),
      ...(input?.sessionId ? { sessionId: input.sessionId } : {}),
      ...(model ? { model } : {}),
      ...(this.providerName ? { provider: this.providerName } : {}),
      ...(presetId ? { presetId } : {}),
    };
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

  // -------------------------------------------------------------------------
  // #314 — `/queue` follow-up messages
  //
  // Distinct from `/steer`:
  //  - `/steer` fires at iteration *start* as a one-shot system nudge.
  //  - `/queue` fires at iteration *end* and concatenates into the *next*
  //    user-turn message so the model sees the follow-up as part of the
  //    user conversation, not as an out-of-band override.
  //
  // The queue MUST be persisted with the session so a host restart preserves
  // operator follow-ups. Storage adapters call `serializePendingQueue` /
  // `restorePendingQueue` at the same boundary they persist session state.
  // -------------------------------------------------------------------------

  /**
   * Queue a follow-up user message for the next iteration. Mirrors `steer`
   * but the entry lands in the next *user-turn* content, not as a system
   * nudge. Empty content is dropped; returns `true` when the message was
   * actually queued.
   */
  queue(sessionId: string, message: string, options?: { source?: string; id?: string }): boolean {
    return enqueueMessage(this.pendingQueue, sessionId, {
      content: message,
      queuedAt: nowIso(),
      ...(options?.source ? { source: options.source } : {}),
      ...(options?.id ? { id: options.id } : {}),
    });
  }

  /**
   * Peek at the current pending queue for a session without draining. Used
   * by the dashboard "in-flight session" view and the ACP `acp.queue.list`
   * method.
   */
  peekQueue(sessionId: string): QueuedUserMessage[] {
    return peekPendingQueue(this.pendingQueue, sessionId);
  }

  /** Number of pending queue messages for the session. O(1) check. */
  queueLength(sessionId: string): number {
    return pendingQueueLength(this.pendingQueue, sessionId);
  }

  /**
   * Drain and return the current pending queue for `sessionId`. Called from
   * the iteration-end drain block in `run`/`runStream` — exposed publicly so
   * the ACP server can also drain on operator request (`acp.queue.flush`).
   */
  drainQueue(sessionId: string): QueuedUserMessage[] {
    return drainPendingQueue(this.pendingQueue, sessionId);
  }

  /**
   * Serialize the pending queue across all sessions. Storage adapters call
   * this when snapshotting state to disk / Durable Object storage. Pairs
   * with `restorePendingQueue` on rehydrate.
   */
  serializePendingQueue(): SerializedQueueEntry[] {
    return serializeQueue(this.pendingQueue);
  }

  /**
   * Restore the pending queue from a previously serialized snapshot. Called
   * on session-store rehydrate. Idempotent — existing in-memory entries for
   * a session ARE overwritten, so callers should restore before any new
   * `queue()` call lands.
   */
  restorePendingQueue(data: SerializedQueueEntry[] | null | undefined): void {
    restoreQueue(this.pendingQueue, data);
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
    locale?: SupportedLocale;
  }): string | undefined {
    // #79: When contextInjection is 'never', the caller owns the whole prompt
    // lifecycle. We strip the runtime/workspace/tools bootstrap that
    // buildSystemPrompt would otherwise add. PersonaPrompt + basePrompt +
    // agentPreset + skills still flow through (they are caller-supplied or
    // skill-driven, not bootstrap).
    const effective: PromptBuilderInput = this.contextInjection === 'never'
      ? {
          basePrompt: promptParams.basePrompt,
          personaPrompt: promptParams.personaPrompt,
          agentPreset: promptParams.agentPreset,
          matchedSkills: promptParams.matchedSkills,
          locale: promptParams.locale,
          // No runtimeName/sessionId/workspaceId/userId/availableTools/memories.
          // No reasoningGuidance (suppressed by absence of availableTools).
        }
      : promptParams;
    const prompt = buildSystemPrompt(effective);
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
    const providerNames = [this.providerName, ...this.fallbackProviderNames].slice(0, this.maxProviderAttempts);
    let lastError: unknown;
    // #83: track which provider we last sent to so a switch into a fallback
    // can scrub any <think>/reasoning_content carried by the prior response.
    let prevProviderName: string | undefined = undefined;

    for (const [providerIndex, provider] of providers.entries()) {
      ensureNotAborted(request.signal);
      const currentName = providerNames[providerIndex];
      // #83: if we just switched away from the primary into a fallback (or
      // between two named fallbacks), scrub reasoning content before this
      // provider sees the message history. Idempotent — a same-named retry
      // is a no-op.
      if (prevProviderName !== currentName && providerIndex > 0) {
        const scrubbed = stripReasoningContent(request.messages, prevProviderName, currentName ?? 'unknown');
        if (scrubbed !== request.messages) {
          request = { ...request, messages: scrubbed };
        }
      }
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
          prevProviderName = currentName;
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
  private scanToolCommandInput(toolCall: ToolCall, input?: { agentId?: string; sessionId?: string }): { blocked: boolean; warnings: string[] } {
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
        ...this.auditProvenance(input),
      });
    }
    return { blocked, warnings };
  }

  /** Apply redaction to tool output if security policy requires it */
  private redactToolResult(result: ToolExecutionResult, input?: { agentId?: string; sessionId?: string }): ToolExecutionResult {
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
        ...this.auditProvenance(input),
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
        ...this.auditProvenance(input),
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
    const delegateDepth = normalizeDelegateDepth(input.delegateDepth);
    const context: ToolExecutionContext = {
      agentId: input.agentId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      delegateDepth,
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

    // #95: pre-tool-call veto. Plugins can block a tool call before it runs.
    // OR-aggregated across plugins; first veto short-circuits.
    const pluginCtx = {
      runtime: this.runtimeName,
      sessionId: input.sessionId,
      agentId: input.agentId,
    };
    if (this.plugins) {
      const verdict = await this.plugins.preToolCall({
        toolName: toolCall.name,
        input: toolCall.input,
        sessionId: input.sessionId,
        agentId: input.agentId,
      }, pluginCtx);
      if (verdict.veto) {
        this.securityAuditLog?.record({
          type: 'command_blocked',
          severity: 'warning',
          detail: `plugin-veto: ${verdict.reason ?? 'no reason given'}`,
          ...this.auditProvenance(input),
        });
        const def = this.tools.get(toolCall.name);
        return {
          toolName: toolCall.name,
          runtime: def?.manifest.runtime === 'sandbox' ? 'sandbox' : 'worker',
          ok: false,
          output: `Tool call vetoed by plugin: ${verdict.reason ?? 'no reason given'}`,
          metadata: { vetoedByPlugin: true, vetoReason: verdict.reason },
        };
      }
    }

    const definition = this.tools.get(toolCall.name);
    if (!definition) {
      const rawResult = await this.tools.execute(toolCall.name, toolCall.input, context);
      return this.applyResultPipeline(toolCall, rawResult, input);
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
        ...this.auditProvenance(input),
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
    const commandScan = this.scanToolCommandInput(toolCall, input);
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
        ...this.auditProvenance(input),
      });
      const approved = this.approvalDecider
        ? await this.approvalDecider(definition, toolCall.input, context)
        : false;

      if (!approved) {
        this.securityAuditLog?.record({
          type: 'approval_denied',
          severity: 'critical',
          detail: `Approval denied for tool "${definition.manifest.name}"`,
          ...this.auditProvenance(input),
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
      return this.applyResultPipeline(toolCall, warned, input);
    }

    return this.applyResultPipeline(toolCall, rawResult, input);
  }

  /**
   * #95: Result post-processing pipeline.
   * Order matters:
   *   1. Core redaction (credentials/PII + injection wrap) — security-critical,
   *      runs FIRST so plugins can never see raw secrets.
   *   2. Plugin transform_tool_result hooks — cosmetic / domain-specific
   *      adjustments (rewrite paths, attach annotations, override `ok`).
   *      Plugins see redacted output, never the original bytes.
   */
  private async applyResultPipeline(
    toolCall: ToolCall,
    rawResult: ToolExecutionResult,
    input: AgentRunInput,
  ): Promise<ToolExecutionResult> {
    const redacted = this.redactToolResult(rawResult, input);
    if (!this.plugins) return redacted;

    const transformed = await this.plugins.transformToolResult({
      toolName: toolCall.name,
      input: toolCall.input,
      result: {
        toolName: redacted.toolName,
        ok: redacted.ok,
        output: redacted.output,
        metadata: redacted.metadata,
      },
      sessionId: input.sessionId,
      agentId: input.agentId,
    }, {
      runtime: this.runtimeName,
      sessionId: input.sessionId,
      agentId: input.agentId,
    });

    if (
      transformed.output === redacted.output &&
      transformed.ok === redacted.ok &&
      transformed.metadata === redacted.metadata
    ) {
      return redacted;
    }
    return {
      ...redacted,
      ok: transformed.ok,
      output: transformed.output,
      metadata: transformed.metadata,
    };
  }

  /**
   * #235 (v0.8.0): execute a single tool call, but FIRST validate its input
   * against the tool's `inputSchema` (if declared). On validation failure,
   * skip execution entirely, emit `tool:validation_failed`, and return a
   * synthetic `!ok` ToolExecutionResult whose output is the structured error
   * envelope. The agent loop appends this as a `role:'tool'` message so the
   * model gets a clear retry instruction without a real tool ever running.
   */
  private async runToolCallWithValidation(
    toolCall: ToolCall,
    input: AgentRunInput,
  ): Promise<ToolExecutionResult> {
    const def = this.tools.get(toolCall.name);
    const schema = def?.manifest.inputSchema;
    if (schema) {
      const err = validateToolInputAgainstSchema(toolCall.input, schema);
      if (err) {
        const envelope = buildToolErrorEnvelope(toolCall.name, err, schema);
        this.eventBus?.emit('tool:validation_failed', {
          sessionId: input.sessionId,
          agentId: input.agentId,
          toolName: toolCall.name,
          errorCode: err.constructor.name,
          message: err.message,
        });
        return {
          toolName: toolCall.name,
          runtime: def?.manifest.runtime === 'sandbox' ? 'sandbox' : 'worker',
          ok: false,
          output: envelope,
          metadata: {
            validationFailed: true,
            errorCode: err.constructor.name,
            envelope: true,
          },
        };
      }
    }
    return this.executeToolCall(toolCall, input);
  }

  /**
   * #235 (v0.8.0): rewrite a failing tool result so its `output` is the
   * structured error envelope. Successful results are returned unchanged.
   * This runs AFTER plugin transforms / redaction so plugins still see the
   * raw error text and can override `ok` if needed before envelope wrapping.
   * If a result is already enveloped (validation path) we keep it as-is.
   */
  private wrapFailureAsEnvelope(result: ToolExecutionResult): ToolExecutionResult {
    if (result.ok) return result;
    if (result.metadata?.envelope === true) return result;
    const def = this.tools.get(result.toolName);
    const schema = def?.manifest.inputSchema;
    const errorCode = (result.metadata?.errorCode as string | undefined) ?? 'ToolError';
    const message = result.output ?? 'Tool failed.';
    const truncated = message.length > 2000 ? message.slice(0, 2000) + '\n…[truncated]' : message;
    const schemaHint = schema ? `\nUse this schema: ${JSON.stringify(schema)}` : '';
    const envelope = JSON.stringify({
      name: result.toolName,
      ok: false,
      error: { code: errorCode, message: truncated },
      retry_instruction: `Call ${result.toolName} again with corrected arguments.${schemaHint}`,
    });
    return {
      ...result,
      output: envelope,
      metadata: { ...(result.metadata ?? {}), envelope: true, errorCode },
    };
  }

  /**
   * #230 (v0.8.0): build the synthetic user-role message that carries matched
   * skills. Returns `undefined` when no skills are matched. The returned
   * message is flagged ephemeral so persistence skips it (recordTurn filter).
   */
  private buildSkillInjectionMessage(matchedSkills?: MatchedSkill[]): ConversationMessage | undefined {
    if (!matchedSkills || matchedSkills.length === 0) return undefined;
    const inner = matchedSkills.map((s) => {
      const tools = s.tools?.length ? s.tools.join(',') : '';
      return `<skill name="${s.name}" tools="${tools}"><description>${s.description}</description><instructions>${s.instructions}</instructions></skill>`;
    }).join('\n');
    return {
      role: 'user',
      content: `<crowclaw-skills>${inner}</crowclaw-skills>`,
      createdAt: nowIso(),
      metadata: { ephemeral: true, kind: 'skill-injection' },
    };
  }

  /**
   * #239 (v0.8.0): single exit point for `agent:terminated` emission. Captures
   * the duration relative to the run start so observability can compute
   * tail latency.
   */
  private emitTerminated(
    sessionId: string,
    reason: AgentTerminationReason,
    iterations: number,
    runStartMs: number,
  ): void {
    this.eventBus?.emit('agent:terminated', {
      reason,
      sessionId,
      iterations,
      durationMs: Date.now() - runStartMs,
    });
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    // #239: capture run-start so `agent:terminated` carries an honest durationMs.
    const runStartMs = Date.now();
    normalizeDelegateDepth(input.delegateDepth);

    // #239: AbortSignal handling for the 'aborted' termination reason.
    // ensureNotAborted throws synchronously; wrap so we can emit before rethrow.
    try {
      ensureNotAborted(input.signal);
    } catch (err) {
      this.emitTerminated(input.sessionId, 'aborted', 0, runStartMs);
      throw err;
    }

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

    // #314: rehydrate the in-memory pending queue from the persisted session.
    // Skipped when in-memory entries already exist for this session — runtime
    // calls (`acp.queue`, REST, WS) that landed before `run()` was invoked
    // must not be clobbered by the stored snapshot. We only seed when the
    // in-memory store is empty for this session.
    if (
      session.pendingQueue
      && session.pendingQueue.length > 0
      && pendingQueueLength(this.pendingQueue, input.sessionId) === 0
    ) {
      for (const queued of session.pendingQueue) {
        enqueueMessage(this.pendingQueue, input.sessionId, queued);
      }
    }

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

    // #230 (Hermes parity): the skill-injection user message is appended
    // BELOW (after skill matching) via splice — we know the user-message
    // index because the user message is the last entry inserted here.
    const nextMessages: ConversationMessage[] = [
      ...cleanedSessionMessages,
      ...memoryMessages,
      {
        role: 'user',
        content: input.userMessage,
        createdAt: nowIso(),
      } satisfies ConversationMessage,
    ];

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
          ...this.auditProvenance(input),
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
        matchedSkills = skillMatches.map(({ skill }) => {
          const localized = localizeSkillFile(skill, normalizeLocale(input.locale));
          return {
            name: localized.name,
            description: localized.description,
            instructions: localized.instructions,
            tools: skill.manifest.tools,
          };
        });

        // #181 (v0.8.4): publish per-match explanation so the dashboard can
        // render a "why this skill fired" chip row above the next assistant
        // message and aggregate per-skill activation counters. Best-effort —
        // listener errors are swallowed by EventBus.emit.
        this.eventBus?.emit('skill:matched', {
          sessionId: input.sessionId,
          agentId: input.agentId,
          query: input.userMessage,
          matches: skillMatches.map(({ skill, score, matchedTriggers, matchedTools, reasons }) => ({
            skillSlug: skill.manifest.name,
            name: skill.manifest.name,
            score,
            matchedTriggers,
            matchedTools,
            reasons,
          })),
        });

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

    // #230 (Hermes parity): inject the matched skills as a synthetic
    // ephemeral user-role message immediately BEFORE the actual user message.
    // The system prompt no longer carries skill content (see prompt-builder),
    // so the prefix-cache key for the system prompt stays stable across turns
    // even when skill matches change. Persistence will skip this message.
    const skillInjectionMsg = this.buildSkillInjectionMessage(matchedSkills);
    if (skillInjectionMsg) {
      // Insert just before the latest user message (which we appended last).
      const userIdx = nextMessages.length - 1;
      nextMessages.splice(userIdx, 0, skillInjectionMsg);
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
      locale: input.locale,
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
    // #235: per-(toolName, errorCode) consecutive-failure counter. Hitting
    // toolFailureStreakLimit (default 3) emits `tool:repeated_failure` and
    // sets terminationReason to 'tool_error_terminal'.
    const toolFailureStreak = new Map<string, number>();
    // #239: classify why we exit the loop. Defaults to 'natural' (model
    // produced final text without further tool calls). Mutated below.
    let terminationReason: AgentTerminationReason = 'natural';
    // #235/#239: signal a hard exit from the iteration loop (e.g. repeated
    // tool failures). The for-loop checks this and breaks before the next
    // provider round-trip.
    let toolErrorTerminal = false;

    for (let iteration = 0; iteration < this.maxToolIterations; iteration += 1) {
      this.eventBus?.emit('iteration:start', { sessionId: input.sessionId, agentId: input.agentId, iteration });
      try {
        ensureNotAborted(input.signal);
      } catch (err) {
        terminationReason = 'aborted';
        this.emitTerminated(input.sessionId, terminationReason, iterationsCompleted, runStartMs);
        throw err;
      }

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
        this.eventBus?.emit('iteration:end', { sessionId: input.sessionId, agentId: input.agentId, iteration, toolCount: 0 });
        break;
      }

      if (!currentResponse.toolCalls || currentResponse.toolCalls.length === 0) {
        finalResponse = currentResponse.assistantMessage ?? finalResponse;
        this.eventBus?.emit('iteration:end', { sessionId: input.sessionId, agentId: input.agentId, iteration, toolCount: 0 });
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
      // #235: route ALL tool calls through runToolCallWithValidation so the
      // input-schema gate runs before any work. The wrapper short-circuits
      // with an enveloped failure result on schema violations.
      if (this.concurrentToolCalls && currentResponse.toolCalls.length > 1) {
        const safetyPartition = this.partitionToolCallsBySafety(currentResponse.toolCalls);
        if (safetyPartition) {
          // Safety-aware execution: parallel first, then destructive sequentially
          const parallelResults = safetyPartition.parallel.length > 0
            ? await Promise.allSettled(safetyPartition.parallel.map((toolCall) => this.runToolCallWithValidation(toolCall, input)))
                .then((settled) => settled.map((s, i) =>
                  s.status === 'fulfilled'
                    ? s.value
                    : {
                        toolName: safetyPartition.parallel[i]?.name ?? 'unknown',
                        runtime: 'worker' as Exclude<ToolRuntime, 'either'>,
                        ok: false,
                        output: s.reason instanceof Error ? s.reason.message : String(s.reason),
                        metadata: { errorCode: s.reason instanceof Error ? s.reason.constructor.name : 'UnknownError' },
                      }
                ))
            : [];
          const destructiveResults: ToolExecutionResult[] = [];
          for (const toolCall of safetyPartition.destructive) {
            const result = await this.runToolCallWithValidation(toolCall, input);
            destructiveResults.push(result);
          }
          iterationResults = [...parallelResults, ...destructiveResults];
        } else {
          // No safety annotations: fall back to all-parallel
          iterationResults = await Promise.allSettled(currentResponse.toolCalls.map((toolCall) => this.runToolCallWithValidation(toolCall, input)))
            .then((settled) => settled.map((s, i) =>
              s.status === 'fulfilled'
                ? s.value
                : {
                    toolName: currentResponse.toolCalls![i]?.name ?? 'unknown',
                    runtime: 'worker' as Exclude<ToolRuntime, 'either'>,
                    ok: false,
                    output: s.reason instanceof Error ? s.reason.message : String(s.reason),
                    metadata: { errorCode: s.reason instanceof Error ? s.reason.constructor.name : 'UnknownError' },
                  }
            ));
        }
      } else {
        iterationResults = await currentResponse.toolCalls.reduce<Promise<ToolExecutionResult[]>>(async (accPromise, toolCall) => {
            const acc = await accPromise;
            // #235: catch tool throws here too (mirrors the Promise.allSettled
            // paths above). The original sequential reduce let exceptions
            // propagate, which masked retryable tool failures as catastrophic
            // run failures. With the structured envelope contract, every
            // tool failure is now observable as a `role:'tool'` message.
            try {
              const result = await this.runToolCallWithValidation(toolCall, input);
              acc.push(result);
            } catch (err) {
              acc.push({
                toolName: toolCall.name,
                runtime: 'worker' as Exclude<ToolRuntime, 'either'>,
                ok: false,
                output: err instanceof Error ? err.message : String(err),
                metadata: { errorCode: err instanceof Error ? err.constructor.name : 'UnknownError' },
              });
            }
            return acc;
          }, Promise.resolve([]));
      }

      // #235: rewrite every failing result so its `output` carries the
      // structured Hermes-style envelope. Validation failures already arrive
      // enveloped (metadata.envelope === true) and are passed through.
      iterationResults = iterationResults.map((r) => this.wrapFailureAsEnvelope(r));

      const encounteredToolError = iterationResults.some((result) => !result.ok);

      // #57 (scheduler contract): record tool activity timestamp on the
      // session. The scheduler reads this to detect stalled sessions for
      // idle-shutdown. Only update if at least one tool actually ran.
      if (iterationResults.length > 0) {
        session.lastToolActivityAt = Date.now();
      }
      this.eventBus?.emit('iteration:end', {
        sessionId: input.sessionId,
        agentId: input.agentId,
        iteration,
        toolCount: iterationResults.length,
      });

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

      // #235: update per-(toolName, errorCode) consecutive-failure counters.
      // A successful run for the same tool resets the streak for that tool.
      // When ANY (tool, errorCode) hits toolFailureStreakLimit, we emit
      // `tool:repeated_failure` and break the loop with a terminal exit.
      const successfulToolNamesThisIter = new Set<string>();
      for (const r of iterationResults) {
        if (r.ok) {
          successfulToolNamesThisIter.add(r.toolName);
          continue;
        }
        const errorCode = (r.metadata?.errorCode as string | undefined) ?? 'ToolError';
        const key = `${r.toolName}|${errorCode}`;
        const next = (toolFailureStreak.get(key) ?? 0) + 1;
        toolFailureStreak.set(key, next);
        if (next >= this.toolFailureStreakLimit) {
          this.eventBus?.emit('tool:repeated_failure', {
            sessionId: input.sessionId,
            agentId: input.agentId,
            toolName: r.toolName,
            errorCode,
            consecutiveFailures: next,
          });
          toolErrorTerminal = true;
        }
      }
      // Reset streak for any tool that succeeded in this iteration. This is
      // intentional per-tool: a different tool failing keeps its own streak.
      for (const k of Array.from(toolFailureStreak.keys())) {
        const toolName = k.split('|')[0];
        if (toolName && successfulToolNamesThisIter.has(toolName)) {
          toolFailureStreak.delete(k);
        }
      }

      if (toolErrorTerminal) {
        terminationReason = 'tool_error_terminal';
        finalResponse = 'Stopped after tool failure (3 consecutive identical errors).';
        // #239: include the iteration in which the streak hit its limit so
        // observers can correlate `agent:terminated` durationMs with the
        // failed iteration, not the previous one.
        iterationsCompleted = iteration + 1;
        break;
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

      // #314: iteration-end drain of `/queue` follow-up messages. Distinct
      // from the steer drain (line ~1730) which fires at iteration START as
      // a one-shot system nudge. Queue entries land in the *next user turn*
      // so the model sees them as conversational follow-ups, not as
      // out-of-band overrides. The drain happens AFTER the budget hint so
      // the operator's queued text appears closest to the next LLM call.
      // Section boundary — Agent A owns redactToolOutput, Agent C owns the
      // applyResultPipeline / response-merge section further below.
      const drainedQueueMessages = this.drainQueue(input.sessionId);
      if (drainedQueueMessages.length > 0) {
        const annotation = buildQueueAnnotation(drainedQueueMessages);
        if (annotation) nextMessages.push(annotation);
        nextMessages.push({
          role: 'user',
          content: drainedQueueMessages
            .map((m) => `${OPERATOR_QUEUE_SEPARATOR}${m.content.trim()}`)
            .join('')
            .trimStart(),
          createdAt: nowIso(),
          metadata: {
            kind: 'queue-drain',
            count: drainedQueueMessages.length,
          },
        });
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

      // #314: preserve reasoning metadata across restore. Append to the
      // session's `reasoningHistory` so a host restart can still surface
      // the planning blocks that led to the current state. Append-only;
      // we never re-feed history into the model on its own.
      if (currentResponse.reasoningBlocks && currentResponse.reasoningBlocks.length > 0) {
        if (!session.reasoningHistory) session.reasoningHistory = [];
        session.reasoningHistory.push(...currentResponse.reasoningBlocks);
      }

      // Track 1.2: Record usage from subsequent provider calls
      totalTokensConsumed = this.recordUsage(currentResponse);
      finalResponse = currentResponse.assistantMessage ?? finalResponse;
      iterationsCompleted = iteration + 1;
    }

    // #239 (Hermes parity): graceful soft-landing on budget exhaustion. The
    // synthesis turn now begins with an explicit `<budget_exhausted>` system
    // envelope so the model knows WHY it is being asked to wrap up. Both
    // iteration-cap and token-budget paths converge here. When
    // synthesizeOnExhaustion is false we fall back to the legacy "Reached
    // maximum tool iterations." string for backward compatibility.
    const iterationCapHit = !tokenBudgetExceeded
      && !!currentResponse.toolCalls
      && currentResponse.toolCalls.length > 0
      && iterationsCompleted >= this.maxToolIterations;
    if (iterationCapHit || tokenBudgetExceeded) {
      if (this.synthesizeOnExhaustion) {
        const reason = tokenBudgetExceeded ? 'token_budget' : 'iteration_cap';
        const envelopeAttr = tokenBudgetExceeded
          ? `tokens="${totalTokensConsumed}"`
          : `iterations="${iterationsCompleted}"`;
        // Ephemeral system envelope — flagged so persistence skips it. The
        // same envelope is recognised downstream by both human and tooling
        // observers as "harness-asked-for-wrap-up".
        nextMessages.push({
          role: 'system',
          content: `<budget_exhausted reason="${reason}" ${envelopeAttr} />`,
          createdAt: nowIso(),
          metadata: { ephemeral: true, kind: 'budget-exhausted', reason },
        });
        const synthesisResponse = await this.generateWithFallbacks({
          systemPrompt: this.buildSystemPromptForRequest({
            basePrompt: input.systemPrompt, runtimeName: this.runtimeName,
            sessionId: input.sessionId, availableTools: [],
            agentPreset: this.agentPreset,
          }),
          messages: nextMessages,
          availableTools: [], // No tools — force text response
          signal: input.signal,
        }, { sessionId: input.sessionId, agentId: input.agentId });
        finalResponse = synthesisResponse.assistantMessage ?? finalResponse ?? 'Reached maximum tool iterations.';
        terminationReason = 'budget_exhausted_with_synthesis';
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

    // Strip transient messages before persisting session.
    //  - Memory-prefix system messages: re-injected fresh each turn from the
    //    memory service.
    //  - #230: ephemeral skill-injection user messages — they are re-derived
    //    every turn from the live skill catalog.
    //  - #239: ephemeral `<budget_exhausted>` envelopes — only meaningful for
    //    the synthesis turn that produced them.
    const persistMessages = nextMessages.filter(m =>
      !(m.role === 'system' && m.content.includes('<recalled-context'))
      && m.metadata?.ephemeral !== true
    );

    // Track 2.2: Use LLM compression if provider is available, else heuristic
    const compression = this.compressionProvider
      ? await this.compressWithLLM(persistMessages)
      : compressMessages(persistMessages, this.compressAfterMessageCount, this.protectLastMessages);
    const baseLineage = session.lineage ?? {
      rootSessionId: session.sessionId,
      compressionCount: 0
    };

    // #314: snapshot the still-pending queue (after the iteration-end drain,
    // any messages arriving during the *current* turn remain unprocessed).
    // The atomic SessionStore put pairs the queue snapshot with the rest of
    // session state so a host restart cannot drop or duplicate queued
    // messages — same atomic-rename pattern as checkpoint persistence.
    const persistedPendingQueue = peekPendingQueue(this.pendingQueue, input.sessionId);

    const nextSession: SessionState = {
      ...session,
      userId: input.userId ?? session.userId,
      workspaceId: input.workspaceId ?? session.workspaceId,
      messages: compression.messages,
      updatedAt: nowIso(),
      // #57: forward lastToolActivityAt so persisted session reflects when
      // the agent last did real tool work (not just when it last responded).
      lastToolActivityAt: session.lastToolActivityAt,
      // #314: persist pending queue + reasoning history across restore.
      // The queue field is omitted entirely when empty so storage adapters
      // don't have to special-case empty arrays vs absent fields.
      ...(persistedPendingQueue.length > 0 ? { pendingQueue: persistedPendingQueue } : {}),
      ...(session.reasoningHistory && session.reasoningHistory.length > 0
        ? { reasoningHistory: session.reasoningHistory }
        : {}),
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

    const result: AgentRunResult = { session: nextSession, finalResponse, toolResults, terminationReason };
    await this.plugins?.emit('agent:afterRun', {
      input: input as unknown as { agentId: string; sessionId: string; [key: string]: unknown },
      result: result as unknown as { finalResponse: string; toolResults: Array<{ toolName: string; ok: boolean }> },
    }, {
      runtime: this.runtimeName,
      sessionId: input.sessionId,
      agentId: input.agentId,
    });

    // #239: emit `agent:terminated` once at every successful exit. Aborts
    // and the per-iteration AbortSignal path emit before throwing.
    this.emitTerminated(input.sessionId, terminationReason, iterationsCompleted, runStartMs);

    return result;
  }

  /** Track 1.3: Streaming variant of run(). Yields events as they arrive. */
  async *runStreaming(input: {
    userMessage: string;
    sessionState: SessionState;
    delegateDepth?: number;
    signal?: AbortSignal;
    locale?: SupportedLocale;
  }): AsyncGenerator<AgentStreamEvent> {
    const { userMessage, sessionState: session, signal } = input;
    normalizeDelegateDepth(input.delegateDepth);
    // #239: capture run-start so `agent:terminated` carries an honest durationMs.
    const streamStartMs = Date.now();

    const streamingProvider = this.provider as Partial<StreamingProviderAdapter>;
    if (!streamingProvider.generateStream) {
      // Fall back to non-streaming: run the full loop and yield a done event
      const runInput: AgentRunInput = {
        agentId: session.agentId,
        sessionId: session.sessionId,
        userMessage,
        delegateDepth: input.delegateDepth,
        signal,
        locale: input.locale,
      };
      try {
        const result = await this.run(runInput);
        yield { type: 'done', response: result.finalResponse, terminationReason: result.terminationReason };
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
          ...this.auditProvenance(session),
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
        matchedSkills = skillMatches.map(({ skill }) => {
          const localized = localizeSkillFile(skill, normalizeLocale(input.locale));
          return {
            name: localized.name,
            description: localized.description,
            instructions: localized.instructions,
            tools: skill.manifest.tools,
          };
        });

        // #181 (v0.8.4): publish per-match explanation (streaming path).
        this.eventBus?.emit('skill:matched', {
          sessionId: session.sessionId,
          agentId: session.agentId,
          query: userMessage,
          matches: skillMatches.map(({ skill, score, matchedTriggers, matchedTools, reasons }) => ({
            skillSlug: skill.manifest.name,
            name: skill.manifest.name,
            score,
            matchedTriggers,
            matchedTools,
            reasons,
          })),
        });

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

    // #230 (Hermes parity, streaming): mirror run() — inject the matched
    // skills as a synthetic ephemeral user-role message right BEFORE the
    // active user message. The system prompt no longer carries skill
    // content, preserving its prefix-cache key across turns.
    const streamSkillInjectionMsg = this.buildSkillInjectionMessage(matchedSkills);
    if (streamSkillInjectionMsg) {
      const userIdx = nextMessages.length - 1;
      nextMessages.splice(userIdx, 0, streamSkillInjectionMsg);
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
      locale: input.locale,
    });

    let streamErrorReflectionCount = 0;
    let streamIterationsCompleted = 0;
    let lastStreamHadToolCalls = false;
    // #235 / #239 (streaming): mirrors run()'s tracking.
    const streamToolFailureStreak = new Map<string, number>();
    let streamTerminationReason: AgentTerminationReason = 'natural';
    let streamToolErrorTerminal = false;
    let streamTokenBudgetExceeded = false;

    try {
      for (let iteration = 0; iteration < this.maxToolIterations; iteration += 1) {
        ensureNotAborted(signal);
        yield { type: 'iteration-start', iteration };
        this.eventBus?.emit('iteration:start', { sessionId: session.sessionId, agentId: session.agentId, iteration });

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
          if (!candidateProvider || !candidateProvider.generateStream) continue;

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
          // #239: surface token-budget exhaustion to the soft-landing path.
          streamTokenBudgetExceeded = true;
          yield { type: 'iteration-end', iteration };
          this.eventBus?.emit('iteration:end', { sessionId: session.sessionId, agentId: session.agentId, iteration, toolCount: 0 });
          break;
        }

        // If no tool calls, we're done
        if (streamToolCalls.length === 0) {
          lastStreamHadToolCalls = false;
          yield { type: 'iteration-end', iteration };
          this.eventBus?.emit('iteration:end', { sessionId: session.sessionId, agentId: session.agentId, iteration, toolCount: 0 });
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
                // #235: validation gate before each parallel tool call.
                safetyPartition.parallel.map((tc) => this.runToolCallWithValidation(tc, runInput))
              );
              for (const [i, tc] of safetyPartition.parallel.entries()) {
                const s = settled[i];
                if (!s) continue;
                const toolCallId = resolvedIds.get(tc) ?? `tc-${tc.name}`;
                const rawResult: ToolExecutionResult = s.status === 'fulfilled'
                  ? s.value
                  : {
                      toolName: tc.name,
                      runtime: 'worker' as Exclude<ToolRuntime, 'either'>,
                      ok: false,
                      output: s.reason instanceof Error ? s.reason.message : String(s.reason),
                      metadata: { errorCode: s.reason instanceof Error ? s.reason.constructor.name : 'UnknownError' },
                    };
                const result = this.wrapFailureAsEnvelope(rawResult);
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
              const rawResult = await this.runToolCallWithValidation(tc, runInput);
              const result = this.wrapFailureAsEnvelope(rawResult);
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
              // #235: validation gate before each tool call.
              streamToolCalls.map((tc) => this.runToolCallWithValidation(tc, runInput))
            );
            for (const [i, tc] of streamToolCalls.entries()) {
              const s = settled[i];
              if (!s) continue;
              const toolCallId = resolvedIds.get(tc) ?? `tc-${tc.name}`;
              const rawResult: ToolExecutionResult = s.status === 'fulfilled'
                ? s.value
                : {
                    toolName: tc.name,
                    runtime: 'worker' as Exclude<ToolRuntime, 'either'>,
                    ok: false,
                    output: s.reason instanceof Error ? s.reason.message : String(s.reason),
                    metadata: { errorCode: s.reason instanceof Error ? s.reason.constructor.name : 'UnknownError' },
                  };
              const result = this.wrapFailureAsEnvelope(rawResult);
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
                ...this.auditProvenance(session),
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
            const streamCmdScan = this.scanToolCommandInput({ name: tc.name, input: tc.input }, session);
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
                workspaceId: session.workspaceId,
                delegateDepth: normalizeDelegateDepth(input.delegateDepth),
                signal,
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

            // #235: validate args against the tool's input schema before
            // executing. On failure we skip execution entirely and emit
            // `tool:validation_failed`.
            const validationError = def?.manifest.inputSchema
              ? validateToolInputAgainstSchema(tc.input, def.manifest.inputSchema)
              : null;
            if (validationError) {
              this.eventBus?.emit('tool:validation_failed', {
                sessionId: session.sessionId,
                agentId: session.agentId,
                toolName: tc.name,
                errorCode: validationError.constructor.name,
                message: validationError.message,
              });
              const validationResult: ToolExecutionResult = this.wrapFailureAsEnvelope({
                toolName: tc.name,
                runtime: def?.manifest.runtime === 'sandbox' ? 'sandbox' : 'worker',
                ok: false,
                output: validationError.message,
                metadata: { validationFailed: true, errorCode: validationError.constructor.name },
              });
              toolResults.push(validationResult);
              iterationToolResults.push(validationResult);
              nextMessages.push(toolMessage(validationResult, this.maxToolResultLength));
              yield { type: 'tool-end', toolName: tc.name, toolCallId, result: validationResult.output, ok: false, durationMs: Date.now() - toolStartTime };
              encounteredToolError = true;
              continue;
            }

            const context: ToolExecutionContext = {
              agentId: session.agentId,
              sessionId: session.sessionId,
              workspaceId: session.workspaceId,
              delegateDepth: normalizeDelegateDepth(input.delegateDepth),
              signal,
            };
            let toolResult = await this.tools.execute(tc.name, tc.input, context);

            // Security: append command scan warnings
            if (streamCmdScan.warnings.length > 0) {
              toolResult = { ...toolResult, output: `${toolResult.output}\n${streamCmdScan.warnings.join('\n')}` };
            }

            // Security: redact tool output in streaming path
            toolResult = this.redactToolResult(toolResult, session);

            // #235: structured envelope on failure.
            toolResult = this.wrapFailureAsEnvelope(toolResult);

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
                this.eventBus?.emit('iteration:end', { sessionId: session.sessionId, agentId: session.agentId, iteration, toolCount: iterationToolResults.length });
                streamTerminationReason = 'tool_error_terminal';
                this.emitTerminated(session.sessionId, streamTerminationReason, streamIterationsCompleted, streamStartMs);
                yield { type: 'done', response: finalResponse, usage: accumulatedUsage, terminationReason: streamTerminationReason };
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

        // #235 (streaming): per-(toolName, errorCode) consecutive-failure
        // counter. On hitting the limit we emit `tool:repeated_failure` and
        // exit the iteration loop with `tool_error_terminal`.
        const successfulStreamToolNames = new Set<string>();
        for (const r of iterationToolResults) {
          if (r.ok) {
            successfulStreamToolNames.add(r.toolName);
            continue;
          }
          const errorCode = (r.metadata?.errorCode as string | undefined) ?? 'ToolError';
          const key = `${r.toolName}|${errorCode}`;
          const next = (streamToolFailureStreak.get(key) ?? 0) + 1;
          streamToolFailureStreak.set(key, next);
          if (next >= this.toolFailureStreakLimit) {
            this.eventBus?.emit('tool:repeated_failure', {
              sessionId: session.sessionId,
              agentId: session.agentId,
              toolName: r.toolName,
              errorCode,
              consecutiveFailures: next,
            });
            streamToolErrorTerminal = true;
          }
        }
        for (const k of Array.from(streamToolFailureStreak.keys())) {
          const toolName = k.split('|')[0];
          if (toolName && successfulStreamToolNames.has(toolName)) {
            streamToolFailureStreak.delete(k);
          }
        }

        if (streamToolErrorTerminal) {
          streamTerminationReason = 'tool_error_terminal';
          finalResponse = 'Stopped after tool failure (3 consecutive identical errors).';
          yield { type: 'iteration-end', iteration };
          this.eventBus?.emit('iteration:end', { sessionId: session.sessionId, agentId: session.agentId, iteration, toolCount: iterationToolResults.length });
          this.emitTerminated(session.sessionId, streamTerminationReason, streamIterationsCompleted, streamStartMs);
          yield { type: 'done', response: finalResponse, usage: accumulatedUsage, terminationReason: streamTerminationReason };
          return;
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
            this.eventBus?.emit('iteration:end', { sessionId: session.sessionId, agentId: session.agentId, iteration, toolCount: iterationToolResults.length });
            streamTerminationReason = 'tool_error_terminal';
            this.emitTerminated(session.sessionId, streamTerminationReason, streamIterationsCompleted, streamStartMs);
            yield { type: 'done', response: finalResponse, usage: accumulatedUsage, terminationReason: streamTerminationReason };
            return;
          }
        }

        // Track 1.4: Auto-checkpoint at end of iteration
        if (this.autoCheckpoint && this.checkpointStore) {
          await this.checkpointStore.save(createCheckpoint({ ...session, messages: nextMessages }, toolResults, iteration, 'iteration'));
        }

        streamIterationsCompleted = iteration + 1;
        yield { type: 'iteration-end', iteration };
        this.eventBus?.emit('iteration:end', { sessionId: session.sessionId, agentId: session.agentId, iteration, toolCount: iterationToolResults.length });
      }

      // #239 (streaming, Hermes parity): graceful soft-landing on budget
      // exhaustion. Mirrors run(): inject `<budget_exhausted>` envelope and
      // mark terminationReason. Both iteration-cap and token-budget paths
      // converge here.
      const streamIterationCapHit = lastStreamHadToolCalls
        && streamIterationsCompleted >= this.maxToolIterations
        && !streamTokenBudgetExceeded;
      if ((streamIterationCapHit || streamTokenBudgetExceeded) && this.synthesizeOnExhaustion) {
        const reason = streamTokenBudgetExceeded ? 'token_budget' : 'iteration_cap';
        const totalTokensSnapshot = this.usageTracker?.getSummary().totalTokens ?? 0;
        const envelopeAttr = streamTokenBudgetExceeded
          ? `tokens="${totalTokensSnapshot}"`
          : `iterations="${streamIterationsCompleted}"`;
        nextMessages.push({
          role: 'system',
          content: `<budget_exhausted reason="${reason}" ${envelopeAttr} />`,
          createdAt: nowIso(),
          metadata: { ephemeral: true, kind: 'budget-exhausted', reason },
        });
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
        streamTerminationReason = 'budget_exhausted_with_synthesis';
      }

      // Save completion checkpoint
      if (this.autoCheckpoint && this.checkpointStore) {
        await this.checkpointStore.save(
          createCheckpoint({ ...session, messages: nextMessages }, toolResults, this.maxToolIterations, 'completion')
        );
      }
      this.emitTerminated(session.sessionId, streamTerminationReason, streamIterationsCompleted, streamStartMs);
      yield { type: 'done', response: finalResponse, usage: accumulatedUsage, terminationReason: streamTerminationReason };
    } catch (error: unknown) {
      // #239: classify abort distinctly from a stream-internal error so the
      // dashboard can show "user cancelled" vs "provider blew up".
      const isAbort = (error instanceof Error && error.message === 'Agent run aborted.')
        || (signal?.aborted ?? false);
      if (isAbort) {
        this.emitTerminated(session.sessionId, 'aborted', streamIterationsCompleted, streamStartMs);
      }
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
export interface ForkSessionOptions {
  /**
   * Suffix appended to the parent's `sessionId` to form the child's session
   * id. Defaults to a random `child-<rand>` value.
   */
  childSessionIdSuffix?: string;
  /**
   * #84: Restrict the child's tool surface to a whitelist of tool names or
   * toolset prefixes (e.g. `['memory', 'skills']` or fully-qualified names
   * like `['memory.recall', 'skills.match']`).
   *
   * The TOOLS package reads this from the child's seed-message metadata
   * (or via `getForkEnabledToolsets()`) and wraps the parent registry in a
   * `FilteredToolCatalogExecutor` so the child literally cannot call
   * anything outside the list. Mirrors Hermes PR #16569 (background review
   * forks couldn't reach `terminal.*`).
   *
   * `undefined` = no restriction (legacy behavior, full inheritance).
   * `[]`        = no tools at all (locked-down review fork).
   */
  enabledToolsets?: string[];
  /**
   * #84: Optional human-readable purpose stored on the child session for
   * audit. Helps the privileged-context warning identify which forks should
   * have been restricted.
   */
  purpose?: string;
}

export function forkSession(
  parent: SessionState,
  task: string,
  childAgentId: string,
  optionsOrSuffix?: ForkSessionOptions | string,
): SessionState {
  // Backward-compat: legacy callers passed a bare suffix string. Detect and
  // normalize so v0.5.0 callers keep working.
  const opts: ForkSessionOptions = typeof optionsOrSuffix === 'string'
    ? { childSessionIdSuffix: optionsOrSuffix }
    : (optionsOrSuffix ?? {});
  const suffix = opts.childSessionIdSuffix
    ?? `child-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  // #84: lint-style warning when a fork is created without restriction.
  // We can't fully detect privilege here (we don't see the parent's tool
  // catalog), but a missing restriction is the riskier default and worth a
  // single console.warn so operators notice. Suppressed when an explicit
  // empty array is passed (lockdown).
  if (opts.enabledToolsets === undefined && typeof console !== 'undefined') {
    console.warn(
      `[CrowClaw] forkSession created without enabledToolsets restriction (parent=${parent.sessionId} child-agent=${childAgentId}). ` +
      `Child will inherit the parent's full tool surface. Pass { enabledToolsets: [...] } to scope the fork.`,
    );
  }

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
        // #84: restriction is recorded on the seed message so the runtime
        // (which wires the child's catalog) can read it without a separate
        // out-of-band channel.
        ...(opts.enabledToolsets !== undefined ? { enabledToolsets: [...opts.enabledToolsets] } : {}),
        ...(opts.purpose ? { forkPurpose: opts.purpose } : {}),
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

/**
 * #84: Read the `enabledToolsets` restriction off a child session produced
 * by `forkSession()`. Returns `undefined` when no restriction was applied
 * (full inheritance).
 *
 * Tool runtimes call this to decide whether to wrap the parent's tool
 * registry in a filter. Match logic (exact name vs. prefix) is left to the
 * caller; this helper just returns the raw whitelist.
 */
export function getForkEnabledToolsets(session: SessionState): string[] | undefined {
  const seed = session.messages[0];
  if (!seed || seed.role !== 'user') return undefined;
  const raw = seed.metadata?.enabledToolsets;
  return Array.isArray(raw) && raw.every((x) => typeof x === 'string') ? (raw as string[]) : undefined;
}

/**
 * #84: Decide whether a tool name should be visible to a child fork given
 * its `enabledToolsets` whitelist. A toolset entry matches:
 *   - exactly (`memory.recall === memory.recall`)
 *   - or as a `<namespace>.` prefix (`memory` matches `memory.recall`,
 *     `memory.store`, ...)
 * Returns `true` when there is no restriction on the session.
 */
export function isToolAllowedForFork(session: SessionState, toolName: string): boolean {
  const whitelist = getForkEnabledToolsets(session);
  if (whitelist === undefined) return true; // unrestricted
  return whitelist.some((entry) => entry === toolName || toolName.startsWith(`${entry}.`));
}

export { buildSystemPrompt, buildMemoryPrefix, normalizeLocale, type MatchedSkill, type PromptBuilderInput, type SupportedLocale } from './prompt-builder.js';

// #314 — pending-queue primitive (ACP `acp.queue`, REST, WS, dashboard share it).
export {
  type QueuedUserMessage,
  type SerializedQueueEntry,
  type PendingQueueStore,
  OPERATOR_QUEUE_SEPARATOR,
  createPendingQueueStore,
  enqueueMessage,
  drainPendingQueue,
  peekPendingQueue,
  pendingQueueLength,
  assembleNextUserMessage,
  buildQueueAnnotation,
  serializeQueue,
  restoreQueue,
} from './queue.js';

export {
  isPrivateUrl,
  isPrivateIpAddress,
  validateFetchUrl,
  resolveAndValidateUrl,
  scanForInjection,
  sanitizeText,
  redactPII,
  containsSecrets,
  redactCredentials,
  redactToolOutput,
  redactStructuredData,
  scanForEnhancedInjection,
  // #299 — assembled-prompt injection scan with per-part attribution.
  // Used by the cron runner to catch poisoned skill content even when the
  // cron config itself is clean. Sibling to `scanForEnhancedInjection`.
  scanAssembledPrompt,
  type AssembledPromptPart,
  type AssembledInjectionFinding,
  scanCommand,
  type InjectionScanResult,
  type RedactionResult,
  type InjectionThreat,
  type EnhancedInjectionScanResult,
  type CommandRisk,
  type CommandScanResult,
  SecurityAuditLog,
  FileSecurityAuditLog,
  type SecurityEvent,
  type SecurityEventType,
  type SecurityEventSeverity,
  type FileSecurityAuditLogOptions,
  // v0.8.0 (#234) — code.execute audit hook. The helper appends a
  // `tool.code-execute` entry tagged with the truncated source + allowed-tool
  // list. Called from packages/tools/src/code-execute.ts at the call site so
  // a runaway sandbox can't suppress its own audit row.
  recordCodeExecuteAudit,
  type CodeExecuteAuditPayload,
} from './security.js';

export { UsageTracker, type TokenUsage, type UsageRecord, type SessionUsageSummary } from './usage.js';
export { DetailedUsageTracker, type UsageEntry, type UsageSummary } from './usage-tracker.js';
export { setTelemetryHooks, getTelemetryHooks, type TelemetryHooks, type TelemetrySpan } from './telemetry.js';
export { ConversationTree, type ConversationBranch, type BranchComparison } from './branching.js';

export { parseSkillFile, renderSkillFile, loadSkillsFromDirectory, matchSkillManifests, filterAndBudgetSkills, checkSkillGates, validateSkillManifest, localizeSkillFile, type SkillManifest, type ParsedSkillFile, type SkillFileSystem, type SkillDirectoryEntry, type SkillConfigRequirements, type SkillValidationResult, type SkillMatchExplanation } from './skill-manifest.js';

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

// #83: provider-switch hygiene — scrub <think>/reasoning_content on switch.
export { stripReasoningContent, hasReasoningContent, type StripReasoningOptions } from './provider-switch.js';

// #66: immutable approved-command value object — TOCTOU mitigation for the
// approval → exec handoff. Sandbox-executor will accept only ApprovedCommand
// and verify the hash before spawn (out-of-scope for this package).
export {
  freezeCommand,
  verifyCommand,
  isApprovedCommand,
  CommandTamperedError,
  type ApprovedCommand,
  type ApprovedCommandShape,
} from './approved-command.js';

// #237 (v0.8.0 Hermes parity): generateStructured contract types.
export type { StructuredOutputRequest, StructuredOutputResponse } from './structured-output.js';
