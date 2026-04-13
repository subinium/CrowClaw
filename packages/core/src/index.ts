import { PluginManager } from '@crowclaw/plugins';
import { buildSystemPrompt } from './prompt-builder.js';
import { matchSkillManifests, filterAndBudgetSkills, checkSkillGates, type ParsedSkillFile, type SkillManifest } from './skill-manifest.js';
import type { MatchedSkill } from './prompt-builder.js';
import type { StreamChunk, StreamingProviderAdapter } from './streaming.js';
import { createCheckpoint, type CheckpointStore, type SessionCheckpoint } from './checkpoint.js';
import type { DetailedUsageTracker } from './usage-tracker.js';
import { redactToolOutput as redactToolOutputFn, scanForEnhancedInjection, scanCommand, SecurityAuditLog } from './security.js';

export type Role = 'system' | 'user' | 'assistant' | 'tool';
export type ToolRuntime = 'worker' | 'sandbox' | 'either';
export type ToolDangerLevel = 'low' | 'medium' | 'high';

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
  env?: unknown;
  signal?: AbortSignal;
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
    metadata: result.metadata
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

  constructor(
    private readonly provider: ProviderAdapter,
    private readonly tools: ToolCatalog & ToolExecutor,
    private readonly sessions: SessionStore,
    options: AgentLoopOptions = {}
  ) {
    this.maxToolIterations = options.maxToolIterations ?? 4;
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

  /** Track 2.2: Compress using LLM provider if available, else fall back to heuristic */
  private async compressWithLLM(
    messages: ConversationMessage[],
  ): Promise<{ messages: ConversationMessage[]; compressedCount: number }> {
    // Determine how many messages to protect
    const protectedCount = Math.min(this.protectLastMessages, messages.length);
    const preserved = messages.slice(-protectedCount);
    const middle = messages.slice(0, messages.length - protectedCount);

    if (middle.length === 0) {
      return { messages, compressedCount: 0 };
    }

    if (!this.compressionProvider) {
      // Fall back to heuristic compression
      return compressMessages(messages, this.compressAfterMessageCount, this.protectLastMessages);
    }

    // Build compression prompt
    const middleText = middle.map(m => `[${m.role}] ${m.content}`).join('\n\n');
    const compressionPrompt = 'Summarize this conversation, preserving key facts, decisions, and tool results. Be concise.';

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
        // Empty response fallback
        return compressMessages(messages, this.compressAfterMessageCount, this.protectLastMessages);
      }

      return {
        messages: [
          {
            role: 'system' as Role,
            content: `Compressed conversation summary (${middle.length} messages, LLM-summarized):\n\n${summary}`,
            createdAt: nowIso(),
            metadata: { compressedCount: middle.length, compressionMethod: 'llm-summary' }
          },
          ...preserved
        ],
        compressedCount: middle.length
      };
    } catch {
      // LLM compression failed, fall back to heuristic
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
    const redacted = redactToolOutputFn(result.output);
    if (redacted === result.output) return result;
    this.securityAuditLog?.record({
      type: 'credential_redacted',
      severity: 'info',
      detail: `Credentials/PII redacted in output from tool "${result.toolName}"`,
    });
    return { ...result, output: redacted, metadata: { ...result.metadata, securityRedacted: true } };
  }

  private async executeToolCall(toolCall: ToolCall, input: AgentRunInput): Promise<ToolExecutionResult> {
    const context: ToolExecutionContext = {
      agentId: input.agentId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      env: input.env,
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

    const nextMessages = [...session.messages, {
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
        const registeredToolNames = new Set(this.tools.list().map(t => t.name));
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
    const baseSystemPrompt = input.systemPrompt
      ? (injectionWarning ? `${input.systemPrompt}\n\n${injectionWarning}` : input.systemPrompt)
      : injectionWarning;

    // Track 2.3: Use prompt caching-aware system prompt builder
    let currentResponse = await this.generateWithFallbacks({
      systemPrompt: this.buildSystemPromptForRequest({
        personaPrompt: this.personaPrompt,
        basePrompt: baseSystemPrompt,
        runtimeName: this.runtimeName,
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        availableTools: this.tools.list(),
        matchedSkills,
        agentPreset: this.agentPreset,
      }),
      messages: nextMessages,
      availableTools: this.tools.list(),
      signal: input.signal
    }, {
      sessionId: input.sessionId,
      agentId: input.agentId
    });

    // Track 1.2: Record usage from initial provider call
    let totalTokensConsumed = this.recordUsage(currentResponse);

    // Track 2.3: Track cache hits in session metadata
    if (this.enablePromptCaching && currentResponse.usage?.cachedTokens && currentResponse.usage.cachedTokens > 0) {
      session.lineage = {
        ...(session.lineage ?? { rootSessionId: session.sessionId, compressionCount: 0 }),
      };
    }

    for (let iteration = 0; iteration < this.maxToolIterations; iteration += 1) {
      ensureNotAborted(input.signal);

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
            await this.checkpointStore.save(createCheckpoint({ ...session, messages: [...nextMessages] }, toolResults, iteration, 'pre-dangerous'));
            break; // Only one pre-dangerous checkpoint per iteration
          }
        }
      }

      const iterationResults = this.concurrentToolCalls && currentResponse.toolCalls.length > 1
        ? await Promise.allSettled(currentResponse.toolCalls.map((toolCall) => this.executeToolCall(toolCall, input)))
            .then((settled) => settled.map((s, i) =>
              s.status === 'fulfilled'
                ? s.value
                : {
                    toolName: currentResponse.toolCalls![i]?.name ?? 'unknown',
                    runtime: 'worker' as Exclude<ToolRuntime, 'either'>,
                    ok: false,
                    output: s.reason instanceof Error ? s.reason.message : String(s.reason),
                  }
            ))
        : await currentResponse.toolCalls.reduce<Promise<ToolExecutionResult[]>>(async (accPromise, toolCall) => {
            const acc = await accPromise;
            const result = await this.executeToolCall(toolCall, input);
            acc.push(result);
            return acc;
          }, Promise.resolve([]));

      const encounteredToolError = iterationResults.some((result) => !result.ok);
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

      if (encounteredToolError && this.stopOnToolError) {
        finalResponse = 'Stopped after tool failure.';
        break;
      }

      // Track 2.1: Token-aware compression trigger
      if (this.shouldCompressTokenAware(nextMessages)) {
        const compression = this.compressionProvider
          ? await this.compressWithLLM(nextMessages)
          : compressMessages(nextMessages, nextMessages.length, this.protectLastMessages);
        if (compression.compressedCount > 0) {
          nextMessages.length = 0;
          nextMessages.push(...compression.messages);
        }
      }

      // Track 1.4: Auto-checkpoint at end of iteration
      if (this.autoCheckpoint && this.checkpointStore) {
        await this.checkpointStore.save(createCheckpoint({ ...session, messages: [...nextMessages] }, toolResults, iteration, 'iteration'));
      }

      // Tiered budget warnings (Hermes pattern) — inject ephemeral hints
      const budgetHint = this.getBudgetHint(iteration, this.maxToolIterations);
      if (budgetHint) {
        nextMessages.push({ role: 'system', content: budgetHint, createdAt: nowIso(), metadata: { budgetHint: true } });
      }

      currentResponse = await this.generateWithFallbacks({
        systemPrompt: this.buildSystemPromptForRequest({
          basePrompt: input.systemPrompt,
          runtimeName: this.runtimeName,
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          userId: input.userId,
          availableTools: this.tools.list(),
          matchedSkills,
          agentPreset: this.agentPreset,
        }),
        messages: nextMessages,
        availableTools: this.tools.list(),
        signal: input.signal
      }, {
        sessionId: input.sessionId,
        agentId: input.agentId
      });

      // Track 1.2: Record usage from subsequent provider calls
      totalTokensConsumed = this.recordUsage(currentResponse);
      finalResponse = currentResponse.assistantMessage ?? finalResponse;
    }

    if (!tokenBudgetExceeded && currentResponse.toolCalls && currentResponse.toolCalls.length > 0 && toolResults.length >= this.maxToolIterations) {
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

    // Track 2.2: Use LLM compression if provider is available, else heuristic
    const compression = this.compressionProvider
      ? await this.compressWithLLM(nextMessages)
      : compressMessages(nextMessages, this.compressAfterMessageCount, this.protectLastMessages);
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

    const nextMessages: ConversationMessage[] = [...session.messages, {
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
        const registeredToolNames = new Set(this.tools.list().map(t => t.name));
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

    try {
      for (let iteration = 0; iteration < this.maxToolIterations; iteration += 1) {
        ensureNotAborted(signal);
        yield { type: 'iteration-start', iteration };

        // Stream from provider
        const systemPrompt = this.buildSystemPromptForRequest({
          basePrompt: streamInjectionWarning,
          runtimeName: this.runtimeName,
          sessionId: session.sessionId,
          workspaceId: session.workspaceId,
          userId: session.userId,
          availableTools: this.tools.list(),
          matchedSkills,
          agentPreset: this.agentPreset,
        });

        const request: ProviderRequest = {
          systemPrompt,
          messages: nextMessages,
          availableTools: this.tools.list(),
          signal,
        };

        // Collect stream chunks and yield text deltas
        let text = '';
        const streamToolCalls: Array<{ name: string; input: Record<string, unknown>; id?: string }> = [];
        let currentTool: { name: string; input: string; id?: string } | null = null;

        for await (const chunk of streamingProvider.generateStream(request)) {
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
              yield { type: 'error', error: chunk.error ?? 'Stream error' };
              return;
            case 'done':
              break;
          }
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
          yield { type: 'iteration-end', iteration };
          break;
        }

        // Push assistant message
        nextMessages.push({
          role: 'assistant',
          content: text || 'Running requested tools.',
          createdAt: nowIso(),
        });

        // Execute tool calls
        let encounteredToolError = false;
        if (this.concurrentToolCalls && streamToolCalls.length > 1) {
          // Emit all tool-start events
          const concurrentStartTime = Date.now();
          for (const tc of streamToolCalls) {
            const toolCallId = tc.id ?? `tc-${Date.now().toString(36)}-${tc.name}`;
            (tc as any)._resolvedId = toolCallId;
            yield { type: 'tool-start' as const, toolName: tc.name, toolCallId, input: tc.input };
          }
          // Execute all in parallel
          const runInput: AgentRunInput = {
            agentId: session.agentId,
            sessionId: session.sessionId,
            userMessage,
            signal,
          };
          const settled = await Promise.allSettled(
            streamToolCalls.map((tc) => this.executeToolCall(tc, runInput))
          );
          // Emit all tool-end events and collect results
          for (let i = 0; i < settled.length; i++) {
            const tc = streamToolCalls[i];
            const toolCallId = (tc as any)._resolvedId ?? `tc-${tc.name}`;
            const s = settled[i];
            const result: ToolExecutionResult = s.status === 'fulfilled'
              ? s.value
              : { toolName: tc.name, runtime: 'worker' as Exclude<ToolRuntime, 'either'>, ok: false, output: s.reason instanceof Error ? s.reason.message : String(s.reason) };

            toolResults.push(result);
            nextMessages.push(toolMessage(result, this.maxToolResultLength));
            yield { type: 'tool-end' as const, toolName: tc.name, toolCallId, result: result.output, ok: result.ok, durationMs: Date.now() - concurrentStartTime };

            if (!result.ok) encounteredToolError = true;
          }
        } else {
          for (const tc of streamToolCalls) {
            const toolCallId = tc.id ?? `tc-${Date.now().toString(36)}-${tc.name}`;
            const toolStartTime = Date.now();
            yield { type: 'tool-start', toolName: tc.name, toolCallId, input: tc.input };

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
                await this.checkpointStore.save(createCheckpoint({ ...session, messages: [...nextMessages] }, toolResults, iteration, 'pre-dangerous'));
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
            nextMessages.push(toolMessage(toolResult, this.maxToolResultLength));
            yield { type: 'tool-end', toolName: tc.name, toolCallId, result: toolResult.output, ok: toolResult.ok, durationMs: Date.now() - toolStartTime };

            if (!toolResult.ok && this.stopOnToolError) {
              finalResponse = 'Stopped after tool failure.';
              yield { type: 'iteration-end', iteration };
              yield { type: 'done', response: finalResponse, usage: accumulatedUsage };
              return;
            }
          }
        }

        if (encounteredToolError && this.stopOnToolError) {
          finalResponse = 'Stopped after tool failure.';
          yield { type: 'iteration-end', iteration };
          yield { type: 'done', response: finalResponse, usage: accumulatedUsage };
          return;
        }

        // Track 1.4: Auto-checkpoint at end of iteration
        if (this.autoCheckpoint && this.checkpointStore) {
          await this.checkpointStore.save(createCheckpoint({ ...session, messages: [...nextMessages] }, toolResults, iteration, 'iteration'));
        }

        yield { type: 'iteration-end', iteration };
      }

      // Save completion checkpoint
      if (this.autoCheckpoint && this.checkpointStore) {
        await this.checkpointStore.save(
          createCheckpoint({ ...session, messages: [...nextMessages] }, toolResults, this.maxToolIterations, 'completion')
        );
      }
      yield { type: 'done', response: finalResponse, usage: accumulatedUsage };
    } catch (error: unknown) {
      yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
    }
  }
}

export { buildSystemPrompt, type MatchedSkill, type PromptBuilderInput } from './prompt-builder.js';

export {
  isPrivateUrl,
  validateFetchUrl,
  scanForInjection,
  sanitizeText,
  redactPII,
  containsSecrets,
  redactCredentials,
  redactToolOutput,
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
