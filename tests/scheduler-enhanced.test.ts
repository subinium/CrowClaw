import { describe, expect, it, vi } from 'vitest';
import {
  type AgentRunFn,
  type CronJobDefinition,
  InMemorySchedulerStore,
  SchedulerExecutor,
  checkJobDueStatus,
  collectDueJobs,
  createScheduledAgentJob,
  isJobDue,
  isOneShotSchedule,
  markJobRun,
  parseDurationMs,
  parseOneShotSchedule,
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
// One-shot schedule parsing
// ---------------------------------------------------------------------------

describe('one-shot schedule parsing', () => {
  it('detects once: as one-shot', () => {
    expect(isOneShotSchedule('once:2026-06-01T12:00:00.000Z')).toBe(true);
  });

  it('detects at: as one-shot', () => {
    expect(isOneShotSchedule('at:2026-06-01T12:00:00.000Z')).toBe(true);
  });

  it('detects after: as one-shot', () => {
    expect(isOneShotSchedule('after:30m')).toBe(true);
  });

  it('does not detect every: as one-shot', () => {
    expect(isOneShotSchedule('every:5m')).toBe(false);
  });

  it('does not detect cron as one-shot', () => {
    expect(isOneShotSchedule('0 9 * * *')).toBe(false);
  });

  it('parseOneShotSchedule parses once: format', () => {
    const result = parseOneShotSchedule('once:2026-06-01T12:00:00.000Z');
    expect(result).toBe('2026-06-01T12:00:00.000Z');
  });

  it('parseOneShotSchedule parses at: format (alias)', () => {
    const result = parseOneShotSchedule('at:2026-06-01T12:00:00.000Z');
    expect(result).toBe('2026-06-01T12:00:00.000Z');
  });

  it('parseOneShotSchedule parses after: with minutes', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const result = parseOneShotSchedule('after:30m', now);
    expect(result).toBe('2026-01-01T00:30:00.000Z');
  });

  it('parseOneShotSchedule parses after: with hours', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const result = parseOneShotSchedule('after:2h', now);
    expect(result).toBe('2026-01-01T02:00:00.000Z');
  });

  it('parseOneShotSchedule parses after: with days', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const result = parseOneShotSchedule('after:1d', now);
    expect(result).toBe('2026-01-02T00:00:00.000Z');
  });

  it('parseOneShotSchedule returns null for non-one-shot', () => {
    expect(parseOneShotSchedule('every:5m')).toBeNull();
    expect(parseOneShotSchedule('0 9 * * *')).toBeNull();
  });

  it('parseOneShotSchedule throws on invalid timestamp', () => {
    expect(() => parseOneShotSchedule('once:not-a-date')).toThrow('Invalid ISO timestamp');
  });
});

describe('parseDurationMs', () => {
  it('parses minutes', () => {
    expect(parseDurationMs('30m')).toBe(30 * 60_000);
  });

  it('parses hours', () => {
    expect(parseDurationMs('2h')).toBe(2 * 3_600_000);
  });

  it('parses days', () => {
    expect(parseDurationMs('1d')).toBe(86_400_000);
  });

  it('throws on invalid format', () => {
    expect(() => parseDurationMs('abc')).toThrow('Invalid duration format');
    expect(() => parseDurationMs('30x')).toThrow('Invalid duration format');
  });
});

// ---------------------------------------------------------------------------
// Grace window
// ---------------------------------------------------------------------------

describe('grace window', () => {
  it('job without graceWindowMs is always due once past nextRunAt (backward compat)', () => {
    // No graceWindowMs set — old behavior: always due
    const job = makeDueJob({ nextRunAt: '2026-01-01T00:00:00.000Z' });
    const now = new Date('2026-01-01T01:00:00.000Z'); // 1 hour later
    expect(checkJobDueStatus(job, now)).toBe('due');
    expect(isJobDue(job, now)).toBe(true);
  });

  it('job with graceWindowMs within window is due', () => {
    const job = makeDueJob({
      nextRunAt: '2026-01-01T00:00:00.000Z',
      graceWindowMs: 300_000, // 5 min
    });
    const now = new Date('2026-01-01T00:03:00.000Z'); // 3 min later
    expect(checkJobDueStatus(job, now)).toBe('due');
    expect(isJobDue(job, now)).toBe(true);
  });

  it('job with graceWindowMs past window is overdue', () => {
    const job = makeDueJob({
      nextRunAt: '2026-01-01T00:00:00.000Z',
      graceWindowMs: 300_000, // 5 min
    });
    const now = new Date('2026-01-01T00:06:00.000Z'); // 6 min later
    expect(checkJobDueStatus(job, now)).toBe('overdue');
    expect(isJobDue(job, now)).toBe(false);
  });

  it('custom grace window is respected', () => {
    // Due at T+0, checked at T+3min, grace = 2min => overdue
    const job = makeDueJob({
      nextRunAt: '2026-01-01T00:00:00.000Z',
      graceWindowMs: 120_000, // 2 minutes
    });
    const now = new Date('2026-01-01T00:03:00.000Z');
    expect(checkJobDueStatus(job, now)).toBe('overdue');
    expect(isJobDue(job, now)).toBe(false);
  });

  it('large grace window keeps jobs due longer', () => {
    // Due at T+0, checked at T+30min, grace = 1h
    const job = makeDueJob({
      nextRunAt: '2026-01-01T00:00:00.000Z',
      graceWindowMs: 3_600_000, // 1 hour
    });
    const now = new Date('2026-01-01T00:30:00.000Z');
    expect(checkJobDueStatus(job, now)).toBe('due');
    expect(isJobDue(job, now)).toBe(true);
  });

  it('collectDueJobs skips overdue jobs and calls log', async () => {
    const store = new InMemorySchedulerStore();
    const logMessages: string[] = [];
    const log = (msg: string) => logMessages.push(msg);

    // This job has a grace window and is overdue
    await store.saveJob(makeDueJob({
      id: 'overdue-job',
      nextRunAt: '2026-01-01T00:00:00.000Z',
      graceWindowMs: 300_000, // 5 min
    }));

    // This job has a grace window and is within it
    await store.saveJob(makeDueJob({
      id: 'due-job',
      nextRunAt: '2026-01-01T00:03:00.000Z',
      graceWindowMs: 300_000,
    }));

    // This job has no grace window (backward compat — always due)
    await store.saveJob(makeDueJob({
      id: 'legacy-job',
      nextRunAt: '2026-01-01T00:00:00.000Z',
    }));

    const now = new Date('2026-01-01T00:06:00.000Z');
    const result = await collectDueJobs(store, now, log);

    const overdueEntry = result.find((r) => r.job.id === 'overdue-job');
    const dueEntry = result.find((r) => r.job.id === 'due-job');
    const legacyEntry = result.find((r) => r.job.id === 'legacy-job');

    expect(overdueEntry?.due).toBe(false);
    expect(dueEntry?.due).toBe(true);
    expect(legacyEntry?.due).toBe(true); // no grace window => always due
    expect(logMessages).toHaveLength(1);
    expect(logMessages[0]).toContain('overdue-job');
    expect(logMessages[0]).toContain('skipped');
  });

  it('future jobs are not-due regardless of grace', () => {
    const job = makeDueJob({
      nextRunAt: '2099-01-01T00:00:00.000Z',
      graceWindowMs: 300_000,
    });
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(checkJobDueStatus(job, now)).toBe('not-due');
  });

  it('disabled jobs are not-due regardless of time', () => {
    const job = makeDueJob({
      enabled: false,
      nextRunAt: '2026-01-01T00:00:00.000Z',
      graceWindowMs: 300_000,
    });
    const now = new Date('2026-01-01T00:01:00.000Z');
    expect(checkJobDueStatus(job, now)).toBe('not-due');
  });
});

// ---------------------------------------------------------------------------
// Run archival
// ---------------------------------------------------------------------------

describe('run archival', () => {
  it('stores run records on the job after execution', async () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun('result-1');
    await store.saveJob(makeDueJob({ runs: [], totalRuns: 0 }));

    const executor = new SchedulerExecutor(store, run);
    await executor.tick(PAST);

    const job = await store.getJob('test-job');
    expect(job).not.toBeNull();
    expect(job!.runs).toHaveLength(1);
    expect(job!.runs![0].success).toBe(true);
    expect(job!.runs![0].response).toBe('result-1');
    expect(job!.totalRuns).toBe(1);
  });

  it('accumulates runs across multiple ticks', async () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun('ok');
    await store.saveJob(makeDueJob({ runs: [], totalRuns: 0 }));

    const executor = new SchedulerExecutor(store, run);

    // Tick 1
    await executor.tick(PAST);

    // Reset nextRunAt to make it due again
    const job1 = await store.getJob('test-job');
    await store.saveJob({ ...job1!, nextRunAt: '2026-01-01T00:04:00.000Z' });

    // Tick 2
    await executor.tick(PAST);

    const job2 = await store.getJob('test-job');
    expect(job2!.runs).toHaveLength(2);
    expect(job2!.totalRuns).toBe(2);
  });

  it('keeps only last 10 runs', async () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun('ok');

    // Seed with 9 existing runs
    const existingRuns = Array.from({ length: 9 }, (_, i) => ({
      runId: `old-run-${i}`,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      success: true,
      response: `old-${i}`,
    }));

    await store.saveJob(makeDueJob({ runs: existingRuns, totalRuns: 9 }));

    const executor = new SchedulerExecutor(store, run);

    // Tick twice to go over 10
    await executor.tick(PAST);
    const job1 = await store.getJob('test-job');
    await store.saveJob({ ...job1!, nextRunAt: '2026-01-01T00:04:00.000Z' });
    await executor.tick(PAST);

    const job2 = await store.getJob('test-job');
    expect(job2!.runs).toHaveLength(10);
    expect(job2!.totalRuns).toBe(11);
    // Oldest run should have been evicted
    expect(job2!.runs![0].runId).toBe('old-run-1');
  });

  it('records error runs in archival', async () => {
    const store = new InMemorySchedulerStore();
    const failRun: AgentRunFn = vi.fn().mockRejectedValue(new Error('boom'));
    await store.saveJob(makeDueJob({ runs: [], totalRuns: 0 }));

    const executor = new SchedulerExecutor(store, failRun);
    await executor.tick(PAST);

    const job = await store.getJob('test-job');
    expect(job!.runs).toHaveLength(1);
    expect(job!.runs![0].success).toBe(false);
    expect(job!.runs![0].error).toBe('boom');
    expect(job!.totalRuns).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// One-shot completion
// ---------------------------------------------------------------------------

describe('one-shot completion', () => {
  it('once: job is disabled after successful execution', async () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun('done');
    await store.saveJob(makeDueJob({
      id: 'once-job',
      schedule: 'once:2026-01-01T00:00:00.000Z',
      nextRunAt: '2026-01-01T00:00:00.000Z',
      runs: [],
      totalRuns: 0,
    }));

    const executor = new SchedulerExecutor(store, run);
    const results = await executor.tick(PAST);

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);

    const job = await store.getJob('once-job');
    expect(job!.enabled).toBe(false);
    expect(job!.completedAt).toBeTruthy();
    expect(job!.nextRunAt).toBeUndefined();
  });

  it('at: job (alias) is disabled after successful execution', async () => {
    const store = new InMemorySchedulerStore();
    const run = mockAgentRun('done');
    await store.saveJob(makeDueJob({
      id: 'at-job',
      schedule: 'at:2026-01-01T00:00:00.000Z',
      nextRunAt: '2026-01-01T00:00:00.000Z',
      runs: [],
      totalRuns: 0,
    }));

    const executor = new SchedulerExecutor(store, run);
    await executor.tick(PAST);

    const job = await store.getJob('at-job');
    expect(job!.enabled).toBe(false);
    expect(job!.completedAt).toBeTruthy();
  });

  it('once: job stays enabled on failed execution', async () => {
    const store = new InMemorySchedulerStore();
    const failRun: AgentRunFn = vi.fn().mockRejectedValue(new Error('fail'));
    await store.saveJob(makeDueJob({
      id: 'once-fail',
      schedule: 'once:2026-01-01T00:00:00.000Z',
      nextRunAt: '2026-01-01T00:00:00.000Z',
      runs: [],
      totalRuns: 0,
    }));

    const executor = new SchedulerExecutor(store, failRun);
    await executor.tick(PAST);

    const job = await store.getJob('once-fail');
    // Not disabled on failure — should remain enabled so it can be retried
    expect(job!.completedAt).toBeUndefined();
  });

  it('after: job computes correct nextRunAt at creation', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    // Manually simulate what createScheduledAgentJob would do
    const schedule = 'after:30m';
    const result = parseOneShotSchedule(schedule, now);
    expect(result).toBe('2026-01-01T00:30:00.000Z');
  });

  it('markJobRun clears nextRunAt for one-shot schedules', async () => {
    const store = new InMemorySchedulerStore();
    const job = makeDueJob({
      schedule: 'once:2026-01-01T00:00:00.000Z',
      nextRunAt: '2026-01-01T00:00:00.000Z',
    });
    await store.saveJob(job);

    const updated = await markJobRun(store, job, PAST);
    expect(updated.nextRunAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

describe('backward compatibility', () => {
  it('every: schedule still works as before', () => {
    expect(isOneShotSchedule('every:5m')).toBe(false);
    expect(parseIntervalMinutes('every:5m')).toBe(5);
    expect(parseIntervalMinutes('every:1h')).toBe(60);
  });

  it('cron schedule still detected correctly', () => {
    expect(isOneShotSchedule('0 9 * * *')).toBe(false);
    expect(isOneShotSchedule('@daily')).toBe(false);
  });

  it('every: job is still marked with next interval run', async () => {
    const store = new InMemorySchedulerStore();
    const job = makeDueJob({
      schedule: 'every:5m',
      nextRunAt: '2026-01-01T00:00:00.000Z',
    });
    await store.saveJob(job);

    const updated = await markJobRun(store, job, PAST);
    expect(updated.nextRunAt).toBe('2026-01-01T00:10:00.000Z');
  });

  it('isJobDue still works for regular interval jobs within grace', () => {
    const job = makeDueJob({ nextRunAt: '2026-01-01T00:04:00.000Z' });
    expect(isJobDue(job, PAST)).toBe(true);
  });

  it('createScheduledAgentJob works with every: schedules', () => {
    const job = createScheduledAgentJob({
      id: 'interval-job',
      schedule: 'every:10m',
      task: 'do stuff',
    });
    expect(job.enabled).toBe(true);
    expect(job.nextRunAt).toBeTruthy();
    expect(job.runs).toEqual([]);
    expect(job.totalRuns).toBe(0);
  });

  it('createScheduledAgentJob works with once: schedules', () => {
    const job = createScheduledAgentJob({
      id: 'one-shot',
      schedule: 'once:2026-06-01T12:00:00.000Z',
      task: 'one time task',
    });
    expect(job.enabled).toBe(true);
    expect(job.nextRunAt).toBe('2026-06-01T12:00:00.000Z');
  });

  it('existing jobs without graceWindowMs have no grace limit (backward compat)', () => {
    // Simulate an old job without graceWindowMs field
    const job: CronJobDefinition = {
      id: 'legacy',
      schedule: 'every:5m',
      task: 'old task',
      enabled: true,
      nextRunAt: '2026-01-01T00:00:00.000Z',
    };

    // 4 minutes overdue => still due (no grace window)
    const within = new Date('2026-01-01T00:04:00.000Z');
    expect(checkJobDueStatus(job, within)).toBe('due');

    // 1 hour overdue => still due (no grace window enforced)
    const wayPast = new Date('2026-01-01T01:00:00.000Z');
    expect(checkJobDueStatus(job, wayPast)).toBe('due');
  });
});
