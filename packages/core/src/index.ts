import { PluginManager } from '@crowclaw/plugins';
import { buildSystemPrompt } from './prompt-builder.js';
import { matchSkillManifests, type ParsedSkillFile, type SkillManifest } from './skill-manifest.js';
import type { MatchedSkill } from './prompt-builder.js';

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

export interface ProviderResponse {
  assistantMessage?: string;
  toolCalls?: ToolCall[];
}

export interface ProviderAdapter {
  generate(request: ProviderRequest): Promise<ProviderResponse>;
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

function toolMessage(result: ToolExecutionResult): ConversationMessage {
  return {
    role: 'tool',
    name: result.toolName,
    content: result.output,
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
    this.skills = options.skills ?? [];
    this.agentPreset = options.agentPreset;
    this.personaPrompt = options.personaPrompt;
  }

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
      return this.tools.execute(toolCall.name, toolCall.input, context);
    }

    const dangerousSignals = collectDangerousInputSignals(toolCall.input);
    const needsApproval = this.requireApprovalForDangerousTools
      && (definition.manifest.dangerLevel === 'high' || dangerousSignals.length > 0);
    if (needsApproval) {
      const approved = this.approvalDecider
        ? await this.approvalDecider(definition, toolCall.input, context)
        : false;

      if (!approved) {
        return {
          toolName: definition.manifest.name,
          runtime: definition.manifest.runtime === 'sandbox' ? 'sandbox' : 'worker',
          ok: false,
          output: `Tool requires approval: ${definition.manifest.name}`,
          metadata: { blockedByApproval: true, dangerousSignals }
        };
      }
    }

    return this.tools.execute(toolCall.name, toolCall.input, context);
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

    const toolResults: ToolExecutionResult[] = [];
    let finalResponse: string | undefined;

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
      }
    }

    let currentResponse = await this.generateWithFallbacks({
      systemPrompt: buildSystemPrompt({
        personaPrompt: this.personaPrompt,
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

    for (let iteration = 0; iteration < this.maxToolIterations; iteration += 1) {
      ensureNotAborted(input.signal);

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

      const iterationResults = this.concurrentToolCalls && currentResponse.toolCalls.length > 1
        ? await Promise.all(currentResponse.toolCalls.map((toolCall) => this.executeToolCall(toolCall, input)))
        : await currentResponse.toolCalls.reduce<Promise<ToolExecutionResult[]>>(async (accPromise, toolCall) => {
            const acc = await accPromise;
            const result = await this.executeToolCall(toolCall, input);
            acc.push(result);
            return acc;
          }, Promise.resolve([]));

      const encounteredToolError = iterationResults.some((result) => !result.ok);
      const warning = budgetStatus(iteration + 1, this.maxToolIterations, this.budgetWarningThreshold, this.budgetCriticalThreshold);
      for (const rawResult of iterationResults) {
        const result = warning
          ? {
              ...rawResult,
              output: `${rawResult.output}\n${warning}`,
              metadata: { ...(rawResult.metadata ?? {}), budgetWarning: warning }
            }
          : rawResult;
        toolResults.push(result);
        nextMessages.push(toolMessage(result));
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

      currentResponse = await this.generateWithFallbacks({
        systemPrompt: buildSystemPrompt({
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
      finalResponse = currentResponse.assistantMessage ?? finalResponse;
    }

    if (currentResponse.toolCalls && currentResponse.toolCalls.length > 0 && toolResults.length >= this.maxToolIterations) {
      finalResponse = finalResponse
        ? `${finalResponse}\nReached maximum tool iterations.`
        : 'Reached maximum tool iterations.';
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

    const compression = compressMessages(nextMessages, this.compressAfterMessageCount, this.protectLastMessages);
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
}

export { buildSystemPrompt, type MatchedSkill, type PromptBuilderInput } from './prompt-builder.js';

export {
  isPrivateUrl,
  validateFetchUrl,
  scanForInjection,
  sanitizeText,
  redactPII,
  containsSecrets,
  type InjectionScanResult,
  type RedactionResult
} from './security.js';

export { UsageTracker, type TokenUsage, type UsageRecord, type SessionUsageSummary } from './usage.js';
export { ConversationTree, type ConversationBranch, type BranchComparison } from './branching.js';

export { parseSkillFile, renderSkillFile, loadSkillsFromDirectory, matchSkillManifests, type SkillManifest, type ParsedSkillFile, type SkillFileSystem, type SkillDirectoryEntry } from './skill-manifest.js';

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
  type PersonaFiles,
  type PersonaConfig,
} from './persona.js';
