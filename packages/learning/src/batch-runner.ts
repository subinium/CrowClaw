import type { ConversationMessage } from '@crowclaw/core';

export interface BatchPrompt {
  id: string;
  prompt: string;
  expected?: BatchExpectedOutput;
  metadata?: Record<string, unknown>;
  systemPrompt?: string;
  agentPreset?: string;
  toolset?: string;
  skillSlugs?: string[];
  model?: string;
}

export type BatchExpectedOutput =
  | string
  | string[]
  | {
      equals?: string;
      contains?: string | string[];
      regex?: string;
    };

export interface BatchRunConfig {
  runName: string;
  maxTurns?: number;           // Max tool iterations per prompt (default: 8)
  concurrency?: number;        // Parallel runs (default: 1)
  timeoutMs?: number;          // Per-prompt timeout (default: 120000)
  resumeFromId?: string;       // Resume from this prompt ID (skip earlier ones)
  onProgress?: (progress: BatchProgress) => void;
}

export interface BatchProgress {
  completed: number;
  total: number;
  currentId: string;
  status: 'running' | 'completed' | 'error' | 'skipped';
  error?: string;
}

export interface BatchRunResult {
  promptId: string;
  sessionId: string;
  ok: boolean;
  response: string;
  toolCalls: Array<{ toolName: string; ok: boolean; output: string }>;
  messages: ConversationMessage[];
  durationMs: number;
  assertions?: BatchAssertionResult;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface BatchAssertionResult {
  evaluated: boolean;
  passed: boolean;
  failures: string[];
}

export interface BatchRunSummary {
  runName: string;
  startedAt: string;
  completedAt: string;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  totalDurationMs: number;
  avgDurationMs: number;
  accuracy?: number;
  results: BatchRunResult[];
}

export type AgentRunFn = (input: {
  agentId: string;
  sessionId: string;
  userMessage: string;
  systemPrompt?: string;
  signal?: AbortSignal;
  maxToolIterations?: number;
  agentPreset?: string;
  toolset?: string;
  skillSlugs?: string[];
  model?: string;
}) => Promise<{
  finalResponse: string;
  toolResults: Array<{ toolName: string; ok: boolean; output: string }>;
  session: { messages: ConversationMessage[] };
}>;

/** Parse JSONL string into BatchPrompt[] */
export function parseJsonlPrompts(jsonl: string): BatchPrompt[] {
  return jsonl
    .split('\n')
    .filter(line => line.trim())
    .map((line, idx) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return {
        id: (parsed.id as string) ?? `prompt-${idx}`,
        prompt: (parsed.prompt as string) ?? (parsed.text as string) ?? (parsed.message as string) ?? '',
        metadata: parsed.metadata as Record<string, unknown> | undefined,
        expected: (parsed.expected ?? parsed.expectedOutput) as BatchExpectedOutput | undefined,
        systemPrompt: parsed.systemPrompt as string | undefined,
        agentPreset: parsed.agentPreset as string | undefined,
        toolset: parsed.toolset as string | undefined,
        skillSlugs: Array.isArray(parsed.skillSlugs) ? (parsed.skillSlugs as string[]) : undefined,
        model: parsed.model as string | undefined,
      };
    })
    .filter(p => p.prompt);
}

/** Run a batch of prompts through an agent */
export async function runBatch(
  prompts: BatchPrompt[],
  runAgent: AgentRunFn,
  config: BatchRunConfig,
): Promise<BatchRunSummary> {
  const startedAt = new Date().toISOString();
  const results: BatchRunResult[] = [];
  let skipped = 0;

  // Resume support: skip prompts before resumeFromId
  let resuming = !!config.resumeFromId;
  const toRun: BatchPrompt[] = [];
  for (const p of prompts) {
    if (resuming) {
      if (p.id === config.resumeFromId) resuming = false;
      else { skipped++; continue; }
    }
    toRun.push(p);
  }

  const concurrency = config.concurrency ?? 1;
  const timeoutMs = config.timeoutMs ?? 120_000;
  let completed = 0;

  // Process in batches of `concurrency`
  for (let i = 0; i < toRun.length; i += concurrency) {
    const chunk = toRun.slice(i, i + concurrency);
    const chunkResults = await Promise.all(
      chunk.map(async (prompt) => {
        const sessionId = `batch-${config.runName}-${prompt.id}`;
        const start = Date.now();

        config.onProgress?.({
          completed,
          total: prompts.length,
          currentId: prompt.id,
          status: 'running',
        });

        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);

          const agentResult = await runAgent({
            agentId: `batch-${config.runName}`,
            sessionId,
            userMessage: prompt.prompt,
            systemPrompt: prompt.systemPrompt,
            signal: controller.signal,
            maxToolIterations: config.maxTurns,
            agentPreset: prompt.agentPreset,
            toolset: prompt.toolset,
            skillSlugs: prompt.skillSlugs,
            model: prompt.model,
          });

          clearTimeout(timer);
          const durationMs = Date.now() - start;
          const assertions = evaluateExpectedOutput(agentResult.finalResponse, prompt.expected);
          const ok = assertions ? assertions.passed : true;
          completed++;

          config.onProgress?.({
            completed,
            total: prompts.length,
            currentId: prompt.id,
            status: 'completed',
          });

          return {
            promptId: prompt.id,
            sessionId,
            ok,
            response: agentResult.finalResponse,
            toolCalls: agentResult.toolResults,
            messages: agentResult.session.messages,
            durationMs,
            assertions,
            metadata: prompt.metadata,
          } satisfies BatchRunResult;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          completed++;

          config.onProgress?.({
            completed,
            total: prompts.length,
            currentId: prompt.id,
            status: 'error',
            error: msg,
          });

          return {
            promptId: prompt.id,
            sessionId,
            ok: false,
            response: '',
            toolCalls: [],
            messages: [],
            durationMs: Date.now() - start,
            assertions: evaluateExpectedOutput('', prompt.expected),
            error: msg,
            metadata: prompt.metadata,
          } satisfies BatchRunResult;
        }
      })
    );
    results.push(...chunkResults);
  }

  const completedAt = new Date().toISOString();
  const totalDurationMs = results.reduce((sum, r) => sum + r.durationMs, 0);
  const evaluated = results.filter((result) => result.assertions?.evaluated);
  const accuracy = evaluated.length > 0
    ? Math.round((evaluated.filter((result) => result.assertions?.passed).length / evaluated.length) * 1000) / 1000
    : undefined;

  return {
    runName: config.runName,
    startedAt,
    completedAt,
    total: prompts.length,
    succeeded: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    skipped,
    totalDurationMs,
    avgDurationMs: results.length > 0 ? Math.round(totalDurationMs / results.length) : 0,
    accuracy,
    results,
  };
}

function normalizeForComparison(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function evaluateExpectedOutput(
  response: string,
  expected?: BatchExpectedOutput
): BatchAssertionResult | undefined {
  if (expected === undefined) return undefined;
  const failures: string[] = [];
  const normalizedResponse = normalizeForComparison(response);

  const requireContains = (needle: string): void => {
    if (!normalizedResponse.includes(normalizeForComparison(needle))) {
      failures.push(`missing expected text: ${needle}`);
    }
  };

  if (typeof expected === 'string') {
    requireContains(expected);
  } else if (Array.isArray(expected)) {
    for (const item of expected) requireContains(item);
  } else {
    if (expected.equals !== undefined && normalizedResponse !== normalizeForComparison(expected.equals)) {
      failures.push('response did not equal expected output');
    }
    const contains = expected.contains;
    if (typeof contains === 'string') {
      requireContains(contains);
    } else if (Array.isArray(contains)) {
      for (const item of contains) requireContains(item);
    }
    if (expected.regex !== undefined) {
      try {
        const regex = new RegExp(expected.regex, 'i');
        if (!regex.test(response)) {
          failures.push(`response did not match regex: ${expected.regex}`);
        }
      } catch {
        failures.push(`invalid expected regex: ${expected.regex}`);
      }
    }
  }

  return {
    evaluated: true,
    passed: failures.length === 0,
    failures,
  };
}
