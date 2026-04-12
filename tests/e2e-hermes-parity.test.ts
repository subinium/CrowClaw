/**
 * E2E: Hermes Parity Features
 *
 * Validates the six features that close the Hermes Agent parity gap:
 * 1. SkillRegistry — unified skill sources
 * 2. Learning loop closure — publish → inject
 * 3. Scheduler execution — agent run + delivery
 * 4. Batch/trajectory processing
 * 5. Checkpoint/rollback/replay
 * 6. Runtime skill wiring (Cloudflare + Node)
 */
import { describe, expect, it, beforeEach } from 'vitest';

// Core
import {
  AgentLoop,
  buildSystemPrompt,
  createCheckpoint,
  restoreFromCheckpoint,
  diffCheckpoints,
  createReplaySession,
  InMemoryCheckpointStore,
  type SessionState,
  type ParsedSkillFile,
  type ProviderRequest,
  type ProviderResponse,
} from '@crowclaw/core';

// Storage
import { InMemorySessionStore } from '@crowclaw/storage';

// Tools
import { ToolRegistry, createEchoTool, createTimeTool, createToolListTool } from '@crowclaw/tools';

// Learning
import {
  LearningPipeline,
  InMemorySkillStore,
  SkillRegistry,
  getBuiltInSkills,
  loadBuiltInSkills,
  detectTaskCompletion,
} from '@crowclaw/learning';
import {
  parseJsonlPrompts,
  runBatch,
} from '../packages/learning/src/batch-runner.js';
import {
  batchToTrajectories,
  exportTrajectoryJsonl,
  exportShareGpt,
  trajectoryStats,
} from '../packages/learning/src/trajectory.js';

// Scheduler
import {
  InMemorySchedulerStore,
  SchedulerExecutor,
  createScheduledAgentJob,
  createEveryNMinutesJob,
  collectDueJobs,
  markIntervalJobRun,
} from '@crowclaw/scheduler';

// Providers (EchoProvider for deterministic tests)
import { EchoProvider } from '@crowclaw/providers';

// ============================================================================
// Helpers
// ============================================================================

class InspectingProvider {
  readonly requests: ProviderRequest[] = [];

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    return {
      assistantMessage: `handled: ${request.messages.at(-1)?.content ?? ''}`,
    };
  }
}

// ============================================================================
// 1. SkillRegistry — unified skill sources
// ============================================================================

describe('E2E: SkillRegistry unified skill sources', () => {
  it('merges built-in, learned, and local skills into one resolve()', async () => {
    const skillStore = new InMemorySkillStore();
    const registry = new SkillRegistry({ skillStore });

    // Load built-in skills
    const builtIn = getBuiltInSkills();
    registry.loadBuiltIn(builtIn);

    // Publish a learned skill
    const pipeline = new LearningPipeline(skillStore);
    pipeline.setRegistry(registry);
    const draft = await pipeline.captureDraft(
      [
        { role: 'user', content: 'deploy to kubernetes', createdAt: new Date().toISOString() },
        { role: 'assistant', content: 'Running kubectl apply. All done.', createdAt: new Date().toISOString() },
      ],
      'k8s-deploy-custom',
    );
    await pipeline.publishDraft(draft.id);

    // Add a local skill
    registry.setLocalSkills([
      {
        manifest: { name: 'local-tool', description: 'A local custom skill', triggers: ['run local'] },
        instructions: 'Step 1: do the thing',
        raw: '',
      },
    ]);

    const resolved = registry.resolve();
    const names = resolved.map((s) => s.manifest.name);

    // All three sources present
    expect(names).toContain('git-commit-workflow'); // built-in
    expect(names).toContain('k8s-deploy-custom'); // learned
    expect(names).toContain('local-tool'); // local

    const stats = registry.stats();
    expect(stats.builtin).toBeGreaterThanOrEqual(50);
    expect(stats.learned).toBe(1);
    expect(stats.local).toBe(1);
  });

  it('learned skills override built-in with same slug', async () => {
    const skillStore = new InMemorySkillStore();
    const registry = new SkillRegistry({ skillStore });

    registry.loadBuiltIn(getBuiltInSkills());
    const originalSkill = registry.resolve().find((s) => s.manifest.name === 'git-commit-workflow');
    expect(originalSkill).toBeDefined();

    // Publish a learned skill with same slug
    const pipeline = new LearningPipeline(skillStore);
    pipeline.setRegistry(registry);

    const draft = await pipeline.captureDraft(
      [
        { role: 'user', content: 'git commit', createdAt: '' },
        { role: 'assistant', content: 'Custom commit workflow.', createdAt: '' },
      ],
      'git-commit-workflow',
    );
    await pipeline.publishDraft(draft.id);

    const resolved = registry.resolve();
    const gitSkill = resolved.find((s) => s.manifest.name === 'git-commit-workflow');
    expect(gitSkill!.instructions).toContain('Custom commit workflow');
  });

  it('disabled skills are filtered from resolve()', () => {
    const registry = new SkillRegistry();
    registry.loadBuiltIn(getBuiltInSkills());

    const before = registry.resolve().length;
    registry.toggleSkill('git-commit-workflow', false);
    const after = registry.resolve().length;

    expect(after).toBe(before - 1);
    expect(registry.resolve().find((s) => s.manifest.name === 'git-commit-workflow')).toBeUndefined();

    // Re-enable
    registry.toggleSkill('git-commit-workflow', true);
    expect(registry.resolve().length).toBe(before);
  });
});

// ============================================================================
// 2. Learning loop closure — publish → inject into AgentLoop
// ============================================================================

describe('E2E: closed learning loop', () => {
  it('published skill is injected into AgentLoop system prompt', async () => {
    const provider = new InspectingProvider();
    const skillStore = new InMemorySkillStore();
    const registry = new SkillRegistry({ skillStore });
    const pipeline = new LearningPipeline(skillStore);
    pipeline.setRegistry(registry);

    // Publish a skill about "deploy"
    const draft = await pipeline.captureDraft(
      [
        { role: 'user', content: 'deploy to vercel', createdAt: '' },
        { role: 'assistant', content: '1. Run vercel --prod\n2. Check status\nAll done.', createdAt: '' },
      ],
      'vercel-deploy-learned',
    );
    await pipeline.publishDraft(draft.id);

    // Create AgentLoop with registry-resolved skills
    const tools = new ToolRegistry();
    tools.register(createEchoTool());
    const sessions = new InMemorySessionStore();

    const loop = new AgentLoop(provider, tools, sessions, {
      runtimeName: 'e2e-learning',
      skills: registry.resolve(),
    });

    // Run with a query that should match the learned skill
    await loop.run({
      agentId: 'crowclaw',
      sessionId: 'learn-1',
      userMessage: 'deploy to vercel production',
    });

    // Verify the skill was injected into the system prompt
    expect(provider.requests.length).toBe(1);
    const systemPrompt = provider.requests[0].systemPrompt ?? '';
    expect(systemPrompt).toContain('vercel-deploy-learned');
  });

  it('autoCapture only captures completed tasks', async () => {
    const skillStore = new InMemorySkillStore();
    const pipeline = new LearningPipeline(skillStore);

    // Incomplete conversation (ends with question)
    const incomplete = await pipeline.autoCapture([
      { role: 'user', content: 'help me deploy', createdAt: '' },
      { role: 'assistant', content: 'Which platform would you like to deploy to?', createdAt: '' },
    ]);
    expect(incomplete).toBeNull();

    // Completed conversation
    const complete = await pipeline.autoCapture([
      { role: 'user', content: 'deploy the app', createdAt: '' },
      { role: 'assistant', content: 'Successfully deployed! All done. Here is the URL.', createdAt: '' },
    ]);
    expect(complete).toBeDefined();
    expect(complete!.status).toBe('draft');
  });

  it('unpublish removes skill from registry', async () => {
    const skillStore = new InMemorySkillStore();
    const registry = new SkillRegistry({ skillStore });
    const pipeline = new LearningPipeline(skillStore);
    pipeline.setRegistry(registry);

    const draft = await pipeline.captureDraft(
      [
        { role: 'user', content: 'test skill', createdAt: '' },
        { role: 'assistant', content: 'Done.', createdAt: '' },
      ],
      'temp-skill',
    );
    await pipeline.publishDraft(draft.id);
    expect(registry.resolve().find((s) => s.manifest.name === 'temp-skill')).toBeDefined();

    await pipeline.unpublishDraft(draft.id);
    expect(registry.resolve().find((s) => s.manifest.name === 'temp-skill')).toBeUndefined();
  });
});

// ============================================================================
// 3. Scheduler execution — agent run + delivery
// ============================================================================

describe('E2E: scheduler agent execution', () => {
  it('executes due jobs through agent and delivers results', async () => {
    const store = new InMemorySchedulerStore();
    const deliveries: Array<{ platform: string; content: string }> = [];

    const executor = new SchedulerExecutor(
      store,
      async (input) => ({
        finalResponse: `Briefing for: ${input.userMessage}`,
        toolResults: [{ toolName: 'echo', ok: true, output: 'test' }],
      }),
      async (target, content) => {
        deliveries.push({ platform: target.platform, content });
        return { ok: true };
      },
    );

    // Create a job with delivery
    const job = createScheduledAgentJob({
      id: 'daily-brief',
      schedule: 'every:1m',
      task: 'Generate daily status report',
      deliverTo: {
        platform: 'telegram',
        config: { botToken: 'test', chatId: '123' },
      },
    });
    await store.saveJob(job);

    // Force the job to be due by setting nextRunAt in the past
    const dueJob = { ...job, nextRunAt: new Date(Date.now() - 60_000).toISOString() };
    await store.saveJob(dueJob);

    // Tick
    const results = await executor.tick();

    expect(results.length).toBe(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].response).toContain('Briefing for: Generate daily status report');

    // Delivery happened
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].platform).toBe('telegram');
    expect(deliveries[0].content).toContain('Briefing');

    // Job state updated
    const updated = await store.getJob('daily-brief');
    expect(updated!.lastRunStatus).toBe('success');
    expect(updated!.runCount).toBe(1);
  });

  it('auto-disables after maxRuns', async () => {
    const store = new InMemorySchedulerStore();
    const executor = new SchedulerExecutor(
      store,
      async () => ({ finalResponse: 'done', toolResults: [] }),
    );

    const job = createScheduledAgentJob({
      id: 'limited',
      schedule: 'every:1m',
      task: 'one-shot',
      maxRuns: 1,
    });
    job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await store.saveJob(job);

    await executor.tick();

    const updated = await store.getJob('limited');
    expect(updated!.enabled).toBe(false);
    expect(updated!.runCount).toBe(1);
  });

  it('handles agent errors gracefully', async () => {
    const store = new InMemorySchedulerStore();
    const executor = new SchedulerExecutor(
      store,
      async () => { throw new Error('LLM quota exceeded'); },
    );

    const job = createScheduledAgentJob({ id: 'error-job', schedule: 'every:1m', task: 'fail' });
    job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await store.saveJob(job);

    const results = await executor.tick();

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('quota exceeded');

    const updated = await store.getJob('error-job');
    expect(updated!.lastRunStatus).toBe('error');
  });

  it('pause and resume jobs', async () => {
    const store = new InMemorySchedulerStore();
    const job = createScheduledAgentJob({ id: 'toggleable', schedule: 'every:5m', task: 'test' });
    await store.saveJob(job);

    const paused = await store.pauseJob('toggleable');
    expect(paused!.enabled).toBe(false);

    const resumed = await store.resumeJob('toggleable');
    expect(resumed!.enabled).toBe(true);
  });
});

// ============================================================================
// 4. Batch/trajectory processing
// ============================================================================

describe('E2E: batch runner and trajectory export', () => {
  it('runs a batch of prompts and exports trajectories', async () => {
    const jsonl = [
      '{"id":"p1","prompt":"What time is it?"}',
      '{"id":"p2","prompt":"Echo hello"}',
      '{"id":"p3","prompt":"Tell me a joke"}',
    ].join('\n');

    const prompts = parseJsonlPrompts(jsonl);
    expect(prompts.length).toBe(3);

    const summary = await runBatch(
      prompts,
      async (input) => ({
        finalResponse: `Response to: ${input.userMessage}`,
        toolResults: [{ toolName: 'echo', ok: true, output: 'test' }],
        session: {
          messages: [
            { role: 'user' as const, content: input.userMessage, createdAt: new Date().toISOString() },
            { role: 'assistant' as const, content: `Response to: ${input.userMessage}`, createdAt: new Date().toISOString() },
          ],
        },
      }),
      { runName: 'e2e-batch', concurrency: 2 },
    );

    expect(summary.total).toBe(3);
    expect(summary.succeeded).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.results.length).toBe(3);

    // Export trajectories
    const trajectories = batchToTrajectories(summary);
    expect(trajectories.length).toBe(3);

    const jsonlOut = exportTrajectoryJsonl(trajectories);
    const lines = jsonlOut.split('\n').filter(Boolean);
    expect(lines.length).toBe(3);

    // Each line is valid JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.id).toBeDefined();
      expect(parsed.prompt).toBeDefined();
      expect(parsed.response).toBeDefined();
    }

    // ShareGPT export
    const shareGpt = exportShareGpt(trajectories);
    const sgLines = shareGpt.split('\n').filter(Boolean);
    expect(sgLines.length).toBe(3);
    const sgParsed = JSON.parse(sgLines[0]);
    expect(sgParsed.conversations).toBeDefined();
    expect(sgParsed.conversations[0].from).toBe('human');

    // Stats
    const stats = trajectoryStats(trajectories);
    expect(stats.totalEntries).toBe(3);
    expect(stats.succeeded).toBe(3);
    expect(stats.uniqueToolsUsed).toContain('echo');
    expect(stats.totalToolCalls).toBe(3);
  });

  it('batch resume skips earlier prompts', async () => {
    const prompts = parseJsonlPrompts(
      ['{"id":"a","prompt":"first"}', '{"id":"b","prompt":"second"}', '{"id":"c","prompt":"third"}'].join('\n'),
    );

    let ran: string[] = [];
    const summary = await runBatch(
      prompts,
      async (input) => {
        ran.push(input.userMessage);
        return {
          finalResponse: input.userMessage,
          toolResults: [],
          session: { messages: [{ role: 'user' as const, content: input.userMessage, createdAt: '' }] },
        };
      },
      { runName: 'resume-test', resumeFromId: 'b' },
    );

    expect(summary.skipped).toBe(1);
    expect(summary.succeeded).toBe(2);
    expect(ran).toEqual(['second', 'third']);
  });

  it('batch handles errors without crashing', async () => {
    const prompts = parseJsonlPrompts('{"id":"fail","prompt":"crash"}');

    const summary = await runBatch(
      prompts,
      async () => { throw new Error('boom'); },
      { runName: 'error-batch' },
    );

    expect(summary.failed).toBe(1);
    expect(summary.results[0].ok).toBe(false);
    expect(summary.results[0].error).toContain('boom');
  });
});

// ============================================================================
// 5. Checkpoint / rollback / replay
// ============================================================================

describe('E2E: checkpoint, rollback, and replay', () => {
  it('full checkpoint lifecycle: save → restore → diff → replay', async () => {
    const cpStore = new InMemoryCheckpointStore();
    const sessions = new InMemorySessionStore();

    // Simulate a session with multiple iterations
    const session: SessionState = {
      agentId: 'crowclaw',
      sessionId: 'cp-test',
      messages: [
        { role: 'user', content: 'Deploy the app', createdAt: '2026-04-12T01:00:00Z' },
        { role: 'assistant', content: 'Starting deployment...', createdAt: '2026-04-12T01:00:01Z' },
      ],
      updatedAt: '2026-04-12T01:00:01Z',
    };
    await sessions.put(session);

    // Checkpoint after iteration 1
    const cp1 = createCheckpoint(session, [], 1, 'iteration', 'pre-tool');
    await cpStore.save(cp1);

    // Session progresses
    session.messages.push(
      { role: 'tool', content: 'deploy started', createdAt: '2026-04-12T01:00:02Z', name: 'terminal.exec' },
      { role: 'assistant', content: 'Deploy succeeded!', createdAt: '2026-04-12T01:00:03Z' },
    );
    session.updatedAt = '2026-04-12T01:00:03Z';

    // Checkpoint after iteration 2
    const toolResults = [{ toolName: 'terminal.exec', runtime: 'worker' as const, ok: true, output: 'deploy started' }];
    const cp2 = createCheckpoint(session, toolResults, 2, 'completion', 'post-deploy');
    await cpStore.save(cp2);

    // Verify listing
    const checkpoints = await cpStore.listBySession('cp-test');
    expect(checkpoints.length).toBe(2);
    expect(checkpoints[0].iteration).toBe(1);
    expect(checkpoints[1].iteration).toBe(2);

    // Get latest
    const latest = await cpStore.getLatest('cp-test');
    expect(latest!.iteration).toBe(2);

    // Diff
    const diff = diffCheckpoints(cp1, cp2);
    expect(diff.addedMessages).toBe(2);
    expect(diff.addedToolCalls).toBe(1);
    expect(diff.iterationRange).toEqual([1, 2]);

    // Rollback to checkpoint 1
    const restored = restoreFromCheckpoint(cp1, session);
    expect(restored.session.messages.length).toBe(2); // Only the first 2 messages
    expect(restored.session.messages.at(-1)!.content).toBe('Starting deployment...');

    // Replay from checkpoint 1
    const replaySession = createReplaySession(cp1, 'replay-1');
    expect(replaySession.sessionId).toBe('replay-1');
    expect(replaySession.messages.length).toBe(2);
    expect(replaySession.lineage!.rootSessionId).toBe('cp-test');

    // Clean up
    const deleted = await cpStore.deleteBySession('cp-test');
    expect(deleted).toBe(2);
    expect(cpStore.size).toBe(0);
  });

  it('checkpoints are isolated (deep clone)', async () => {
    const cpStore = new InMemoryCheckpointStore();

    const session: SessionState = {
      agentId: 'crowclaw',
      sessionId: 'clone-test',
      messages: [{ role: 'user', content: 'original', createdAt: '' }],
      updatedAt: '',
    };

    const cp = createCheckpoint(session, [], 1, 'manual');
    await cpStore.save(cp);

    // Mutate original session
    session.messages[0].content = 'mutated';

    // Checkpoint should be unchanged
    const retrieved = await cpStore.get(cp.id);
    expect(retrieved!.messages[0].content).toBe('original');
  });
});

// ============================================================================
// 6. Integration: Full Hermes-style workflow
// ============================================================================

describe('E2E: full Hermes-style workflow', () => {
  it('conversation → skill draft → publish → next run uses learned skill → checkpoint', async () => {
    const provider = new InspectingProvider();
    const sessionStore = new InMemorySessionStore();
    const skillStore = new InMemorySkillStore();
    const cpStore = new InMemoryCheckpointStore();
    const registry = new SkillRegistry({ skillStore });
    const pipeline = new LearningPipeline(skillStore);
    pipeline.setRegistry(registry);

    // Load built-in skills
    await loadBuiltInSkills(skillStore);
    await registry.refreshLearned();
    registry.loadBuiltIn(getBuiltInSkills());

    const tools = new ToolRegistry();
    tools.register(createEchoTool());
    tools.register(createTimeTool());

    // === Run 1: Agent handles a task ===
    const loop1 = new AgentLoop(provider, tools, sessionStore, {
      runtimeName: 'hermes-e2e',
      skills: registry.resolve(),
    });

    const r1 = await loop1.run({
      agentId: 'crowclaw',
      sessionId: 'hermes-1',
      userMessage: 'set up a new Next.js project with auth',
    });
    expect(r1.finalResponse).toBeTruthy();

    // === Checkpoint after run 1 ===
    const cp = createCheckpoint(r1.session, r1.toolResults, 1, 'completion');
    await cpStore.save(cp);

    // === Learn from conversation ===
    // Simulate a completed conversation for skill extraction
    const completedMessages = [
      { role: 'user' as const, content: 'set up nextjs with auth', createdAt: '' },
      { role: 'assistant' as const, content: 'Created Next.js app with NextAuth. All done successfully!', createdAt: '' },
    ];

    const signal = detectTaskCompletion(completedMessages);
    expect(signal.completed).toBe(true);

    const draft = await pipeline.captureDraft(completedMessages, 'nextjs-auth-setup');
    expect(draft.status).toBe('draft');

    // Publish the learned skill
    const published = await pipeline.publishDraft(draft.id);
    expect(published.status).toBe('published');

    // === Run 2: Should now use the learned skill ===
    const loop2 = new AgentLoop(provider, tools, sessionStore, {
      runtimeName: 'hermes-e2e',
      skills: registry.resolve(), // Now includes published skill
    });

    await loop2.run({
      agentId: 'crowclaw',
      sessionId: 'hermes-2',
      userMessage: 'set up nextjs with authentication',
    });

    // Verify the learned skill was in the system prompt
    const lastRequest = provider.requests.at(-1)!;
    expect(lastRequest.systemPrompt).toContain('nextjs-auth-setup');

    // === Batch processing with the learned skill ===
    const batchSummary = await runBatch(
      [{ id: 'b1', prompt: 'set up nextjs auth' }],
      async (input) => ({
        finalResponse: `Batch: ${input.userMessage}`,
        toolResults: [],
        session: {
          messages: [
            { role: 'user' as const, content: input.userMessage, createdAt: '' },
            { role: 'assistant' as const, content: `Batch: ${input.userMessage}`, createdAt: '' },
          ],
        },
      }),
      { runName: 'hermes-batch' },
    );
    expect(batchSummary.succeeded).toBe(1);

    // Export trajectory
    const trajectories = batchToTrajectories(batchSummary);
    const jsonl = exportTrajectoryJsonl(trajectories);
    expect(jsonl).toContain('set up nextjs auth');

    // === Verify checkpoint restore ===
    const restored = restoreFromCheckpoint(cp, r1.session);
    expect(restored.session.messages.length).toBe(cp.messages.length);

    // === Stats ===
    const registryStats = registry.stats();
    expect(registryStats.builtin).toBeGreaterThanOrEqual(50);
    expect(registryStats.learned).toBeGreaterThanOrEqual(1);
    expect(registryStats.total).toBeGreaterThan(registryStats.builtin);
  });
});
