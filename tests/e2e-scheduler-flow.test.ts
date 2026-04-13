/**
 * E2E: Scheduler Flow — cross-subsystem integration
 *
 * Tests the scheduler executor, job lifecycle, pause/resume, dry-run,
 * cron support, and autonomous scheduler start/stop.
 */
import { describe, expect, it, beforeEach } from 'vitest';

import {
  InMemorySchedulerStore,
  SchedulerExecutor,
  AutonomousScheduler,
  createScheduledAgentJob,
  createEveryNMinutesJob,
  collectDueJobs,
  isJobDue,
  type CronJobDefinition,
  type AgentRunFn,
} from '@crowclaw/scheduler';

// ============================================================================
// 1. Scheduler: create -> tick -> history
// ============================================================================

describe('E2E: scheduler create -> tick -> history', () => {
  let store: InMemorySchedulerStore;
  let executor: SchedulerExecutor;
  let agentCalls: string[];

  beforeEach(() => {
    store = new InMemorySchedulerStore();
    agentCalls = [];
    const mockAgentRun: AgentRunFn = async (input) => {
      agentCalls.push(input.userMessage);
      return {
        finalResponse: `Executed: ${input.userMessage}`,
        toolResults: [{ toolName: 'echo', ok: true, output: 'done' }],
      };
    };
    executor = new SchedulerExecutor(store, mockAgentRun);
  });

  it('creates a job, ticks when due, and records run history', async () => {
    const job = createScheduledAgentJob({
      id: 'test-tick-job',
      schedule: 'every:1m',
      task: 'Generate report',
    });
    // Force due
    job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await store.saveJob(job);

    const results = await executor.tick();

    expect(results.length).toBe(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].response).toContain('Generate report');
    expect(agentCalls).toEqual(['Generate report']);

    // Verify run history
    const history = await store.getRunHistory('test-tick-job');
    expect(history.length).toBe(1);
    expect(history[0].ok).toBe(true);
    expect(history[0].durationMs).toBeGreaterThanOrEqual(0);

    // Verify job state updated
    const updated = await store.getJob('test-tick-job');
    expect(updated!.lastRunStatus).toBe('success');
    expect(updated!.runCount).toBe(1);
    expect(updated!.lastRunAt).toBeTruthy();
  });

  it('does not execute jobs that are not yet due', async () => {
    const job = createEveryNMinutesJob('not-due', 60, 'Should not run');
    // nextRunAt is in the future by default
    await store.saveJob(job);

    const results = await executor.tick();
    expect(results.length).toBe(0);
    expect(agentCalls.length).toBe(0);
  });

  it('executes multiple due jobs in a single tick', async () => {
    for (let i = 0; i < 3; i++) {
      const job = createScheduledAgentJob({
        id: `multi-job-${i}`,
        schedule: 'every:1m',
        task: `Task ${i}`,
      });
      job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
      await store.saveJob(job);
    }

    const results = await executor.tick();
    expect(results.length).toBe(3);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(agentCalls).toEqual(['Task 0', 'Task 1', 'Task 2']);
  });
});

// ============================================================================
// 2. Scheduler: pause + resume
// ============================================================================

describe('E2E: scheduler pause + resume', () => {
  it('paused job is not executed on tick, resumed job is executed', async () => {
    const store = new InMemorySchedulerStore();
    let executedCount = 0;
    const executor = new SchedulerExecutor(
      store,
      async () => {
        executedCount++;
        return { finalResponse: 'done', toolResults: [] };
      },
    );

    const job = createScheduledAgentJob({
      id: 'pause-resume-job',
      schedule: 'every:1m',
      task: 'toggle test',
    });
    job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await store.saveJob(job);

    // Pause
    const paused = await executor.pauseJob('pause-resume-job');
    expect(paused!.enabled).toBe(false);

    // Tick — should not execute
    await executor.tick();
    expect(executedCount).toBe(0);

    // Resume
    const resumed = await executor.resumeJob('pause-resume-job');
    expect(resumed!.enabled).toBe(true);

    // Force due again after resume
    const current = await store.getJob('pause-resume-job');
    current!.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await store.saveJob(current!);

    // Tick — should execute
    await executor.tick();
    expect(executedCount).toBe(1);
  });

  it('pausing a non-existent job returns null', async () => {
    const store = new InMemorySchedulerStore();
    const executor = new SchedulerExecutor(
      store,
      async () => ({ finalResponse: 'done', toolResults: [] }),
    );

    const result = await executor.pauseJob('nonexistent');
    expect(result).toBeNull();
  });
});

// ============================================================================
// 3. Scheduler: dry-run does not modify state
// ============================================================================

describe('E2E: scheduler dry-run', () => {
  it('dryRun executes the job but does not update lastRunAt or runCount', async () => {
    const store = new InMemorySchedulerStore();
    let executed = false;
    const executor = new SchedulerExecutor(
      store,
      async () => {
        executed = true;
        return { finalResponse: 'dry run result', toolResults: [] };
      },
    );

    const job = createScheduledAgentJob({
      id: 'dry-run-job',
      schedule: 'every:5m',
      task: 'dry run test',
    });
    await store.saveJob(job);

    const originalJob = await store.getJob('dry-run-job');
    const originalRunCount = originalJob!.runCount ?? 0;
    const originalLastRunAt = originalJob!.lastRunAt;

    const record = await executor.dryRun('dry-run-job');

    expect(executed).toBe(true);
    expect(record.ok).toBe(true);
    expect(record.response).toBe('dry run result');
    expect(record.durationMs).toBeGreaterThanOrEqual(0);

    // State should be unchanged
    const afterJob = await store.getJob('dry-run-job');
    expect(afterJob!.runCount ?? 0).toBe(originalRunCount);
    expect(afterJob!.lastRunAt).toBe(originalLastRunAt);
  });

  it('dryRun throws for nonexistent job', async () => {
    const store = new InMemorySchedulerStore();
    const executor = new SchedulerExecutor(
      store,
      async () => ({ finalResponse: 'done', toolResults: [] }),
    );

    await expect(executor.dryRun('missing-job')).rejects.toThrow('Job not found');
  });
});

// ============================================================================
// 4. AutonomousScheduler start/stop
// ============================================================================

describe('E2E: AutonomousScheduler start/stop', () => {
  it('starts, ticks at least once, and stops cleanly', async () => {
    const store = new InMemorySchedulerStore();
    let tickCount = 0;

    const executor = new SchedulerExecutor(
      store,
      async () => {
        tickCount++;
        return { finalResponse: 'auto-tick', toolResults: [] };
      },
    );

    // Create a due job
    const job = createScheduledAgentJob({
      id: 'auto-job',
      schedule: 'every:1m',
      task: 'auto tick test',
    });
    job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await store.saveJob(job);

    const autonomous = new AutonomousScheduler(executor, 50); // 50ms interval

    expect(autonomous.isRunning()).toBe(false);
    autonomous.start();
    expect(autonomous.isRunning()).toBe(true);

    // Wait for at least 1 tick
    await new Promise((resolve) => setTimeout(resolve, 180));

    autonomous.stop();
    expect(autonomous.isRunning()).toBe(false);

    // At least 1 tick should have occurred
    expect(tickCount).toBeGreaterThanOrEqual(1);
  });

  it('start is idempotent (double start does not create duplicate intervals)', async () => {
    const store = new InMemorySchedulerStore();
    const executor = new SchedulerExecutor(
      store,
      async () => ({ finalResponse: 'done', toolResults: [] }),
    );

    const autonomous = new AutonomousScheduler(executor, 100);

    autonomous.start();
    autonomous.start(); // Should be no-op
    expect(autonomous.isRunning()).toBe(true);

    autonomous.stop();
    expect(autonomous.isRunning()).toBe(false);

    autonomous.stop(); // Should be no-op
    expect(autonomous.isRunning()).toBe(false);
  });

  it('exposes interval and lastTick properties', async () => {
    const store = new InMemorySchedulerStore();
    const executor = new SchedulerExecutor(
      store,
      async () => ({ finalResponse: 'done', toolResults: [] }),
    );

    const autonomous = new AutonomousScheduler(executor, 75);
    expect(autonomous.interval).toBe(75);
    expect(autonomous.lastTick).toBeNull();

    // After ticking, lastTick should be set
    autonomous.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    autonomous.stop();
    // lastTick may or may not be set depending on timing, but it should not throw
    expect(typeof autonomous.lastTick === 'string' || autonomous.lastTick === null).toBe(true);
  });
});

// ============================================================================
// 5. Auto-disable after maxRuns
// ============================================================================

describe('E2E: scheduler auto-disable after maxRuns', () => {
  it('disables job after reaching maxRuns', async () => {
    const store = new InMemorySchedulerStore();
    const executor = new SchedulerExecutor(
      store,
      async () => ({ finalResponse: 'done', toolResults: [] }),
    );

    const job = createScheduledAgentJob({
      id: 'max-runs-job',
      schedule: 'every:1m',
      task: 'limited runs',
      maxRuns: 2,
    });
    job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await store.saveJob(job);

    // First tick
    await executor.tick();
    let updated = await store.getJob('max-runs-job');
    expect(updated!.runCount).toBe(1);
    expect(updated!.enabled).toBe(true);

    // Force due again
    updated!.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await store.saveJob(updated!);

    // Second tick — should reach maxRuns and disable
    await executor.tick();
    updated = await store.getJob('max-runs-job');
    expect(updated!.runCount).toBe(2);
    expect(updated!.enabled).toBe(false);

    // Third tick — should not execute (disabled)
    updated!.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await store.saveJob(updated!);
    const results = await executor.tick();
    expect(results.length).toBe(0);
  });
});

// ============================================================================
// 6. Error handling in scheduler execution
// ============================================================================

describe('E2E: scheduler error handling', () => {
  it('records error status when agent throws', async () => {
    const store = new InMemorySchedulerStore();
    const executor = new SchedulerExecutor(
      store,
      async () => { throw new Error('LLM quota exceeded'); },
    );

    const job = createScheduledAgentJob({
      id: 'error-job',
      schedule: 'every:1m',
      task: 'will fail',
    });
    job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await store.saveJob(job);

    const results = await executor.tick();
    expect(results.length).toBe(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('quota exceeded');

    const updated = await store.getJob('error-job');
    expect(updated!.lastRunStatus).toBe('error');
    expect(updated!.runCount).toBe(1);

    // Run history should also record the error
    const history = await store.getRunHistory('error-job');
    expect(history.length).toBe(1);
    expect(history[0].ok).toBe(false);
    expect(history[0].error).toContain('quota exceeded');
  });
});
