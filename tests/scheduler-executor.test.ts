import { describe, expect, it, vi } from 'vitest';
import {
  type AgentRunFn,
  type CronJobDefinition,
  type DeliveryFn,
  type DeliveryTarget,
  InMemorySchedulerStore,
  SchedulerExecutor,
  createScheduledAgentJob,
  parseIntervalMinutes,
} from '../packages/scheduler/src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockAgentRun(response = 'done'): AgentRunFn {
  return vi.fn().mockResolvedValue({
    finalResponse: response,
    toolResults: [{ toolName: 'echo', ok: true, output: response }],
  });
}

function mockDelivery(ok = true): DeliveryFn {
  return vi.fn().mockResolvedValue({ ok, error: ok ? undefined : 'send failed' });
}

function makeDueJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    id: 'test-job',
    schedule: 'every:5m',
    task: 'do something',
    enabled: true,
    nextRunAt: '2026-01-01T00:00:00.000Z', // already past
    runCount: 0,
    ...overrides,
  };
}

const PAST = new Date('2026-01-01T00:05:00.000Z');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SchedulerExecutor', () => {
  it('tick() executes due jobs via agent runner', async () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun('hello world');
    await store.saveJob(makeDueJob());

    const executor = new SchedulerExecutor(store, run);
    const results = await executor.tick(PAST);

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].response).toBe('hello world');
    expect(results[0].jobId).toBe('test-job');
    expect(run).toHaveBeenCalledOnce();
  });

  it('updates job state after run (lastRunAt, lastRunStatus, runCount)', async () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun();
    await store.saveJob(makeDueJob());

    const executor = new SchedulerExecutor(store, run);
    await executor.tick(PAST);

    const updated = await store.getJob('test-job');
    expect(updated).not.toBeNull();
    expect(updated!.lastRunStatus).toBe('success');
    expect(updated!.lastRunAt).toBeTruthy();
    expect(updated!.runCount).toBe(1);
  });

  it('auto-disables after maxRuns', async () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun();
    await store.saveJob(makeDueJob({ maxRuns: 1, runCount: 0 }));

    const executor = new SchedulerExecutor(store, run);
    await executor.tick(PAST);

    const updated = await store.getJob('test-job');
    expect(updated!.enabled).toBe(false);
    expect(updated!.runCount).toBe(1);
  });

  it('calls delivery when deliverTo is configured', async () => {
    const target: DeliveryTarget = {
      platform: 'telegram',
      config: { chatId: '123', token: 'abc' },
    };
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun('report content');
    const deliver = mockDelivery();
    await store.saveJob(makeDueJob({ deliverTo: target }));

    const executor = new SchedulerExecutor(store, run, deliver);
    const results = await executor.tick(PAST);

    expect(deliver).toHaveBeenCalledWith(target, 'report content');
    expect(results[0].delivery).toEqual({ ok: true, error: undefined });
  });

  it('handles timeout', async () => {
    const store = new InMemorySchedulerStore();
    const slowRun: AgentRunFn = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 5000)),
    );
    await store.saveJob(makeDueJob({ timeoutMs: 50 }));

    const executor = new SchedulerExecutor(store, slowRun);
    const results = await executor.tick(PAST);

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toBe('Job timed out');
  });

  it('handles agent run failure', async () => {
    const store = new InMemorySchedulerStore();
    const failRun: AgentRunFn = vi.fn().mockRejectedValue(new Error('agent crashed'));
    await store.saveJob(makeDueJob());

    const executor = new SchedulerExecutor(store, failRun);
    const results = await executor.tick(PAST);

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toBe('agent crashed');

    const updated = await store.getJob('test-job');
    expect(updated!.lastRunStatus).toBe('error');
    expect(updated!.lastRunError).toBe('agent crashed');
  });

  it('skips non-due jobs', async () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun();
    await store.saveJob(
      makeDueJob({ nextRunAt: '2099-01-01T00:00:00.000Z' }),
    );

    const executor = new SchedulerExecutor(store, run);
    const results = await executor.tick(PAST);

    expect(results).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('skips disabled jobs', async () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun();
    await store.saveJob(makeDueJob({ enabled: false }));

    const executor = new SchedulerExecutor(store, run);
    const results = await executor.tick(PAST);

    expect(results).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('truncates lastRunResult to 500 characters', async () => {
    const store = new InMemorySchedulerStore();
    const longResponse = 'x'.repeat(1000);
    const run = mockAgentRun(longResponse);
    await store.saveJob(makeDueJob());

    const executor = new SchedulerExecutor(store, run);
    await executor.tick(PAST);

    const updated = await store.getJob('test-job');
    expect(updated!.lastRunResult).toHaveLength(500);
  });
});

describe('InMemorySchedulerStore lifecycle methods', () => {
  it('getJob returns job or null', async () => {
    const store = new InMemorySchedulerStore();
    expect(await store.getJob('nope')).toBeNull();

    await store.saveJob(makeDueJob({ id: 'j1' }));
    const job = await store.getJob('j1');
    expect(job).not.toBeNull();
    expect(job!.id).toBe('j1');
  });

  it('deleteJob removes from store', async () => {
    const store = new InMemorySchedulerStore();
    await store.saveJob(makeDueJob({ id: 'j1' }));

    expect(await store.deleteJob('j1')).toBe(true);
    expect(await store.getJob('j1')).toBeNull();
    expect(await store.deleteJob('j1')).toBe(false);
  });

  it('pauseJob sets enabled to false', async () => {
    const store = new InMemorySchedulerStore();
    await store.saveJob(makeDueJob({ id: 'j1', enabled: true }));

    const paused = await store.pauseJob('j1');
    expect(paused).not.toBeNull();
    expect(paused!.enabled).toBe(false);

    // Verify persisted
    const fetched = await store.getJob('j1');
    expect(fetched!.enabled).toBe(false);
  });

  it('resumeJob sets enabled to true', async () => {
    const store = new InMemorySchedulerStore();
    await store.saveJob(makeDueJob({ id: 'j1', enabled: false }));

    const resumed = await store.resumeJob('j1');
    expect(resumed).not.toBeNull();
    expect(resumed!.enabled).toBe(true);

    const fetched = await store.getJob('j1');
    expect(fetched!.enabled).toBe(true);
  });

  it('pauseJob/resumeJob return null for missing jobs', async () => {
    const store = new InMemorySchedulerStore();
    expect(await store.pauseJob('nope')).toBeNull();
    expect(await store.resumeJob('nope')).toBeNull();
  });
});

describe('parseIntervalMinutes', () => {
  it('parses minute intervals', () => {
    expect(parseIntervalMinutes('every:5m')).toBe(5);
    expect(parseIntervalMinutes('every:30m')).toBe(30);
  });

  it('parses hour intervals', () => {
    expect(parseIntervalMinutes('every:1h')).toBe(60);
    expect(parseIntervalMinutes('every:24h')).toBe(1440);
  });

  it('returns 1 for unrecognized format', () => {
    expect(parseIntervalMinutes('cron:* * * * *')).toBe(1);
    expect(parseIntervalMinutes('invalid')).toBe(1);
  });
});

describe('createScheduledAgentJob', () => {
  it('creates a fully-populated job definition', () => {
    const target: DeliveryTarget = {
      platform: 'webhook',
      config: { url: 'https://example.com/hook' },
    };

    const job = createScheduledAgentJob({
      id: 'daily-report',
      schedule: 'every:24h',
      task: 'Generate daily summary',
      skillSlugs: ['summarize'],
      agentPreset: 'reporter',
      deliverTo: target,
      maxRuns: 30,
      timeoutMs: 120_000,
    });

    expect(job.id).toBe('daily-report');
    expect(job.schedule).toBe('every:24h');
    expect(job.task).toBe('Generate daily summary');
    expect(job.enabled).toBe(true);
    expect(job.skillSlugs).toEqual(['summarize']);
    expect(job.agentPreset).toBe('reporter');
    expect(job.deliverTo).toEqual(target);
    expect(job.maxRuns).toBe(30);
    expect(job.timeoutMs).toBe(120_000);
    expect(job.runCount).toBe(0);
    expect(job.metadata).toEqual({});
    expect(job.nextRunAt).toBeTruthy();
  });
});
