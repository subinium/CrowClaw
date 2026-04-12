import type {
  ToolCatalog,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolExecutor,
} from '@crowclaw/core';

export interface PipelineStep {
  tool: string;
  input: Record<string, unknown>;
  /** Map previous step's output fields into this step's input. */
  inputMapping?: Record<string, string>; // e.g., { "url": "$prev.output" }
  /** Condition to skip this step. */
  condition?: 'always' | 'if_prev_ok' | 'if_prev_failed';
  /** Label for this step. */
  label?: string;
}

export interface PipelineDefinition {
  name: string;
  description: string;
  steps: PipelineStep[];
  /** Variables that must be provided when running. */
  parameters?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface PipelineStepResult {
  step: number;
  label?: string;
  toolName: string;
  ok: boolean;
  output: string;
  skipped: boolean;
  durationMs: number;
}

export interface PipelineResult {
  name: string;
  ok: boolean;
  steps: PipelineStepResult[];
  totalDurationMs: number;
  finalOutput: string;
}

/**
 * Execute a pipeline — a sequence of tool calls with data flowing between them.
 */
export async function executePipeline(
  pipeline: PipelineDefinition,
  tools: ToolCatalog & ToolExecutor,
  context: ToolExecutionContext,
  variables?: Record<string, unknown>,
): Promise<PipelineResult> {
  const stepResults: PipelineStepResult[] = [];
  const startTime = Date.now();
  let prevResult: ToolExecutionResult | null = null;

  for (let i = 0; i < pipeline.steps.length; i++) {
    const step = pipeline.steps[i];
    const condition = step.condition ?? 'always';

    // Check condition
    const shouldSkip =
      (condition === 'if_prev_ok' && prevResult && !prevResult.ok) ||
      (condition === 'if_prev_failed' && prevResult && prevResult.ok);

    if (shouldSkip) {
      stepResults.push({
        step: i,
        label: step.label,
        toolName: step.tool,
        ok: true,
        output: 'Skipped (condition not met)',
        skipped: true,
        durationMs: 0,
      });
      continue;
    }

    // Build input with variable substitution and mapping
    const resolvedInput = resolveInput(step.input, step.inputMapping, prevResult, variables);

    const stepStart = Date.now();
    const result = await tools.execute(step.tool, resolvedInput, context);
    const durationMs = Date.now() - stepStart;

    stepResults.push({
      step: i,
      label: step.label,
      toolName: step.tool,
      ok: result.ok,
      output: result.output,
      skipped: false,
      durationMs,
    });

    prevResult = result;
  }

  const totalDurationMs = Date.now() - startTime;
  const allOk = stepResults.every(s => s.ok || s.skipped);
  const finalOutput = stepResults.filter(s => !s.skipped).at(-1)?.output ?? '';

  return {
    name: pipeline.name,
    ok: allOk,
    steps: stepResults,
    totalDurationMs,
    finalOutput,
  };
}

function resolveInput(
  input: Record<string, unknown>,
  mapping: Record<string, string> | undefined,
  prevResult: ToolExecutionResult | null,
  variables: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...input };

  // Apply variable substitution
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value === 'string' && value.startsWith('$var.') && variables) {
      const varName = value.slice(5);
      resolved[key] = variables[varName] ?? value;
    }
    if (typeof value === 'string' && value === '$prev.output' && prevResult) {
      resolved[key] = prevResult.output;
    }
  }

  // Apply input mapping
  if (mapping && prevResult) {
    for (const [targetKey, sourceExpr] of Object.entries(mapping)) {
      if (sourceExpr === '$prev.output') {
        resolved[targetKey] = prevResult.output;
      } else if (sourceExpr === '$prev.ok') {
        resolved[targetKey] = prevResult.ok;
      } else if (sourceExpr.startsWith('$prev.metadata.') && prevResult.metadata) {
        const metaKey = sourceExpr.slice('$prev.metadata.'.length);
        resolved[targetKey] = (prevResult.metadata as Record<string, unknown>)[metaKey];
      }
    }
  }

  return resolved;
}

/**
 * Create a tool that wraps a pipeline definition, making it callable like any other tool.
 */
export function createPipelineTool(
  pipeline: PipelineDefinition,
  tools: ToolCatalog & ToolExecutor,
): ToolDefinition {
  return {
    manifest: {
      name: `pipeline.${pipeline.name}`,
      description: pipeline.description,
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: false,
      requiresNetwork: true,
      dangerLevel: 'medium',
    },
    async execute(input, context) {
      const result = await executePipeline(pipeline, tools, context, input);
      return {
        toolName: `pipeline.${pipeline.name}`,
        runtime: 'worker',
        ok: result.ok,
        output: JSON.stringify(
          {
            pipeline: result.name,
            ok: result.ok,
            steps: result.steps.map(s => ({
              step: s.step,
              tool: s.toolName,
              label: s.label,
              ok: s.ok,
              skipped: s.skipped,
              durationMs: s.durationMs,
              outputPreview: s.output.slice(0, 200),
            })),
            totalDurationMs: result.totalDurationMs,
            finalOutput: result.finalOutput.slice(0, 2000),
          },
          null,
          2,
        ),
        metadata: {
          pipelineName: result.name,
          stepCount: result.steps.length,
          totalDurationMs: result.totalDurationMs,
          allOk: result.ok,
        },
      };
    },
  };
}

/** Pre-built pipeline templates. */
export const BUILT_IN_PIPELINES: PipelineDefinition[] = [
  {
    name: 'web-research',
    description: 'Search the web, fetch top result, and extract readable text.',
    steps: [
      { tool: 'web.search', input: { query: '$var.query' }, label: 'Search' },
      {
        tool: 'web.extractText',
        input: { url: '$prev.output' },
        label: 'Extract',
        condition: 'if_prev_ok',
        inputMapping: { url: '$prev.metadata.url' },
      },
    ],
    parameters: [{ name: 'query', description: 'Search query', required: true }],
  },
  {
    name: 'file-backup',
    description: 'Read a file and write a backup copy.',
    steps: [
      { tool: 'workspace.read', input: { path: '$var.path' }, label: 'Read original' },
      {
        tool: 'workspace.write',
        input: { path: '$var.backupPath', content: '$prev.output' },
        label: 'Write backup',
        condition: 'if_prev_ok',
      },
    ],
    parameters: [
      { name: 'path', description: 'Source file path', required: true },
      { name: 'backupPath', description: 'Backup file path', required: true },
    ],
  },
];
