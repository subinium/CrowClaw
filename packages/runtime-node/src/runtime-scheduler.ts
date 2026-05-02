import { AutonomousScheduler, SchedulerExecutor } from '@crowclaw/scheduler';
import type { ExecutionOverrides } from './agent-bootstrap.js';
import type { EventBus } from './event-bus.js';

interface ConfiguredAgent {
  run(input: {
    agentId: string;
    sessionId: string;
    userMessage: string;
    systemPrompt: string;
  }): Promise<{
    finalResponse: string;
    toolResults: Array<{ toolName: string; ok: boolean; output: string }>;
  }>;
}

export function createRuntimeScheduler(ctx: {
  schedulerStore: ConstructorParameters<typeof SchedulerExecutor>[0];
  eventBus: EventBus;
  createConfiguredAgent: (overrides?: ExecutionOverrides) => ConfiguredAgent;
  deliverToGateway: ConstructorParameters<typeof SchedulerExecutor>[2];
}) {
  const schedulerExecutor = new SchedulerExecutor(
    ctx.schedulerStore,
    async (input) => {
      ctx.eventBus.emit('job:start', { sessionId: input.sessionId, agentId: input.agentId });
      const overrides: ExecutionOverrides = {
        agentPreset: input.agentPreset,
        toolsetPreset: input.toolsetPreset,
        skillSlugs: input.skillSlugs,
        model: input.model,
      };

      try {
        const result = await ctx.createConfiguredAgent(overrides).run({
          agentId: input.agentId,
          sessionId: input.sessionId,
          userMessage: input.userMessage,
          systemPrompt: 'You are CrowClaw executing a scheduled task.',
        });

        ctx.eventBus.emit('job:complete', { sessionId: input.sessionId, toolCount: result.toolResults.length });
        return {
          finalResponse: result.finalResponse,
          toolResults: result.toolResults.map((r) => ({
            toolName: r.toolName,
            ok: r.ok,
            output: r.output,
          })),
        };
      } catch (err: unknown) {
        ctx.eventBus.emit('job:error', { sessionId: input.sessionId, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    },
    ctx.deliverToGateway,
  );

  return {
    schedulerExecutor,
    autonomousScheduler: new AutonomousScheduler(schedulerExecutor),
  };
}
