import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  type AgentRunFn,
  type CronJobDefinition,
  type JobRunRecord,
  InMemorySchedulerStore,
  SchedulerExecutor,
  AutonomousScheduler,
  createScheduledAgentJob,
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

function makeDueJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    id: 'test-job',
    schedule: 'every:5m',
    task: 'do something',
    enabled: true,
    nextRunAt: '2026-01-01T00:00:00.000Z',
    runCount: 0,
    ...overrides,
  };
}

const PAST = new Date('2026-01-01T00:05:00.000Z');

// ---------------------------------------------------------------------------
// Pause / Resume / Delete lifecycle
// ---------------------------------------------------------------------------

describe('SchedulerExecutor job lifecycle', () => {
  it('pauseJob sets job enabled to false', async () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun();
    await store.saveJob(makeDueJob({ id: 'j1', enabled: true }));
    const executor = new SchedulerExecutor(store, run);

    const paused = await executor.pauseJob('j1');
    expect(paused).not.toBeNull();
    expect(paused!.enabled).toBe(false);

    const fetched = await store.getJob('j1');
    expect(fetched!.enabled).toBe(false);
  });

  it('resumeJob sets job enabled to true', async () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun();
    await store.saveJob(makeDueJob({ id: 'j1', enabled: false }));
    const executor = new SchedulerExecutor(store, run);

    const resumed = await executor.resumeJob('j1');
    expect(resumed).not.toBeNull();
    expect(resumed!.enabled).toBe(true);

    const fetched = await store.getJob('j1');
    expect(fetched!.enabled).toBe(true);
  });

  it('paused job is skipped in next tick', async () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun();
    await store.saveJob(makeDueJob({ id: 'j1', enabled: true }));
    const executor = new SchedulerExecutor(store, run);

    await executor.pauseJob('j1');
    const results = await executor.tick(PAST);

    expect(results).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('resumed job runs in next tick', async () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun('resumed result');
    await store.saveJob(makeDueJob({ id: 'j1', enabled: false }));
    const executor = new SchedulerExecutor(store, run);

    await executor.resumeJob('j1');
    const results = await executor.tick(PAST);

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].response).toBe('resumed result');
  });

  it('pauseJob/resumeJob return null for missing jobs', async () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun();
    const executor = new SchedulerExecutor(store, run);

    expect(await executor.pauseJob('missing')).toBeNull();
    expect(await executor.resumeJob('missing')).toBeNull();
  });

  it('deleteJob removes job permanently', async () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun();
    await store.saveJob(makeDueJob({ id: 'j1' }));
    const executor = new SchedulerExecutor(store, run);

    const deleted = await executor.deleteJob('j1');
    expect(deleted).toBe(true);

    const fetched = await store.getJob('j1');
    expect(fetched).toBeNull();

    const again = await executor.deleteJob('j1');
    expect(again).toBe(false);
  });

  it('deleted job does not appear in next tick', async () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun();
    await store.saveJob(makeDueJob({ id: 'j1' }));
    const executor = new SchedulerExecutor(store, run);

    await executor.deleteJob('j1');
    const results = await executor.tick(PAST);

    expect(results).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Run history
// ---------------------------------------------------------------------------

describe('Run history', () => {
  it('records run history after tick', async () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun('hello');
    await store.saveJob(makeDueJob({ id: 'j1' }));
    const executor = new SchedulerExecutor(store, run);

    await executor.tick(PAST);

    const history = await store.getRunHistory('j1');
    expect(history).toHaveLength(1);
    expect(history[0].jobId).toBe('j1');
    expect(history[0].ok).toBe(true);
    expect(history[0].response).toBe('hello');
    expect(typeof history[0].durationMs).toBe('number');
    expect(history[0].startedAt).toBeTruthy();
    expect(history[0].completedAt).toBeTruthy();
    expect(history[0].runId).toBeTruthy();
  });

  it('records error runs in history', async () => {
    const store = new InMemorySchedulerStore();
    const failRun: AgentRunFn = vi.fn().mockRejectedValue(new Error('agent crashed'));
    await store.saveJob(makeDueJob({ id: 'j1' }));
    const executor = new SchedulerExecutor(store, failRun);

    await executor.tick(PAST);

    const history = await store.getRunHistory('j1');
    expect(history).toHaveLength(1);
    expect(history[0].ok).toBe(false);
    expect(history[0].error).toBe('agent crashed');
  });

  it('run history limit parameter works', async () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun('ok');
    const executor = new SchedulerExecutor(store, run);

    for (let i = 0; i < 5; i++) {
      await store.recordRun({
        jobId: 'j1',
        runId: `run-${i}`,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        ok: true,
        response: `result-${i}`,
        durationMs: 100 + i,
      });
    }

    const all = await store.getRunHistory('j1');
    expect(all).toHaveLength(5);

    const limited = await store.getRunHistory('j1', 3);
    expect(limited).toHaveLength(3);
    expect(limited[0].runId).toBe('run-4');
    expect(limited[2].runId).toBe('run-2');
  });

  it('run history returns empty for unknown job', async () => {
    const store = new InMemorySchedulerStore();
    const history = await store.getRunHistory('nonexistent');
    expect(history).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe('Dry run', () => {
  it('dry run does not update lastRunAt or runCount', async () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun('dry result');
    await store.saveJob(makeDueJob({ id: 'j1', runCount: 3, lastRunAt: '2025-01-01T00:00:00.000Z' }));
    const executor = new SchedulerExecutor(store, run);

    const record = await executor.dryRun('j1');

    expect(record.ok).toBe(true);
    expect(record.response).toBe('dry result');
    expect(record.jobId).toBe('j1');
    expect(typeof record.durationMs).toBe('number');

    const job = await store.getJob('j1');
    expect(job!.runCount).toBe(3);
    expect(job!.lastRunAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('dry run throws for missing job', async () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun();
    const executor = new SchedulerExecutor(store, run);

    await expect(executor.dryRun('nonexistent')).rejects.toThrow('Job not found: nonexistent');
  });

  it('dry run captures errors', async () => {
    const store = new InMemorySchedulerStore();
    const failRun: AgentRunFn = vi.fn().mockRejectedValue(new Error('dry fail'));
    await store.saveJob(makeDueJob({ id: 'j1' }));
    const executor = new SchedulerExecutor(store, failRun);

    const record = await executor.dryRun('j1');
    expect(record.ok).toBe(false);
    expect(record.error).toBe('dry fail');
  });
});

// ---------------------------------------------------------------------------
// AutonomousScheduler
// ---------------------------------------------------------------------------

describe('AutonomousScheduler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('start/stop/isRunning lifecycle', () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun();
    const executor = new SchedulerExecutor(store, run);
    const auto = new AutonomousScheduler(executor, 1000);

    expect(auto.isRunning()).toBe(false);

    auto.start();
    expect(auto.isRunning()).toBe(true);

    auto.start();
    expect(auto.isRunning()).toBe(true);

    auto.stop();
    expect(auto.isRunning()).toBe(false);

    auto.stop();
    expect(auto.isRunning()).toBe(false);
  });

  it('uses default interval of 60000ms', () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun();
    const executor = new SchedulerExecutor(store, run);
    const auto = new AutonomousScheduler(executor);

    expect(auto.interval).toBe(60000);
  });

  it('uses custom interval', () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun();
    const executor = new SchedulerExecutor(store, run);
    const auto = new AutonomousScheduler(executor, 5000);

    expect(auto.interval).toBe(5000);
  });

  it('calls executor.tick() on interval', async () => {
    vi.useFakeTimers();
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun();
    const executor = new SchedulerExecutor(store, run);
    const tickSpy = vi.spyOn(executor, 'tick').mockResolvedValue([]);
    const auto = new AutonomousScheduler(executor, 100);

    auto.start();

    await vi.advanceTimersByTimeAsync(150);
    expect(tickSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(tickSpy).toHaveBeenCalledTimes(2);

    auto.stop();
    vi.useRealTimers();
  });

  it('lastTick is null before any tick', () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun();
    const executor = new SchedulerExecutor(store, run);
    const auto = new AutonomousScheduler(executor, 100);

    expect(auto.lastTick).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// API endpoint response shapes
// ---------------------------------------------------------------------------

describe('API endpoint response shapes', () => {
  it('JobRunRecord has required fields', () => {
    const record: JobRunRecord = {
      jobId: 'j1',
      runId: 'run-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      ok: true,
      response: 'result',
      durationMs: 1000,
    };

    expect(record.jobId).toBe('j1');
    expect(record.runId).toBe('run-1');
    expect(record.ok).toBe(true);
    expect(record.durationMs).toBe(1000);
    expect(record.error).toBeUndefined();
    expect(record.tokensUsed).toBeUndefined();
  });

  it('JobRunRecord with optional fields', () => {
    const record: JobRunRecord = {
      jobId: 'j1',
      runId: 'run-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      ok: false,
      response: '',
      error: 'something broke',
      durationMs: 500,
      tokensUsed: 1234,
    };

    expect(record.error).toBe('something broke');
    expect(record.tokensUsed).toBe(1234);
  });
});

// ---------------------------------------------------------------------------
// Dashboard HTML contains lifecycle UI elements
// ---------------------------------------------------------------------------

describe('Dashboard HTML lifecycle UI', () => {
  let DASHBOARD_HTML: string;

  it('loads dashboard HTML', async () => {
    const web = await import('../packages/web/src/index.js');
    DASHBOARD_HTML = web.DASHBOARD_HTML;
    expect(typeof DASHBOARD_HTML).toBe('string');
    expect(DASHBOARD_HTML.length).toBeGreaterThan(0);
  });

  it('contains crowclaw-automate-view for scheduler', async () => {
    const web = await import('../packages/web/src/index.js');
    DASHBOARD_HTML = web.DASHBOARD_HTML;

    expect(DASHBOARD_HTML).toContain('crowclaw-automate-view');
  });

  it('contains scheduler API endpoints', async () => {
    const web = await import('../packages/web/src/index.js');
    DASHBOARD_HTML = web.DASHBOARD_HTML;

    expect(DASHBOARD_HTML).toContain('/api/scheduler/jobs');
    expect(DASHBOARD_HTML).toContain('/api/scheduler/start');
    expect(DASHBOARD_HTML).toContain('/api/scheduler/stop');
  });

  it('contains scheduler history endpoint', async () => {
    const web = await import('../packages/web/src/index.js');
    DASHBOARD_HTML = web.DASHBOARD_HTML;

    expect(DASHBOARD_HTML).toContain('/api/scheduler/history');
    expect(DASHBOARD_HTML).toContain('/api/scheduler/tick');
  });

  it('contains Pause/Resume/Delete button text', async () => {
    const web = await import('../packages/web/src/index.js');
    DASHBOARD_HTML = web.DASHBOARD_HTML;

    expect(DASHBOARD_HTML).toContain('Pause');
    expect(DASHBOARD_HTML).toContain('Resume');
    expect(DASHBOARD_HTML).toContain('Delete');
    expect(DASHBOARD_HTML).toContain('History');
  });

  it('contains Create Job text', async () => {
    const web = await import('../packages/web/src/index.js');
    DASHBOARD_HTML = web.DASHBOARD_HTML;

    expect(DASHBOARD_HTML).toContain('Create Job');
  });
});
