import { describe, expect, it } from 'vitest';
import {
  InMemorySchedulerStore,
  collectDueJobs,
  computeNextIntervalRun,
  createEveryNMinutesJob,
  isJobDue,
  markJobRun,
} from '../packages/scheduler/src/index.js';

describe('scheduler foundation', () => {
  it('creates interval jobs with computed next run times', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const job = createEveryNMinutesJob('job-1', 5, 'sync memories', now);
    expect(job.schedule).toBe('every:5m');
    expect(job.nextRunAt).toBe('2026-01-01T00:05:00.000Z');
  });

  it('identifies due jobs and rolls them forward', async () => {
    const store = new InMemorySchedulerStore();
    const now = new Date('2026-01-01T00:10:00.000Z');
    await store.saveJob({
      id: 'job-1',
      schedule: 'every:5m',
      task: 'sync memories',
      enabled: true,
      nextRunAt: '2026-01-01T00:05:00.000Z'
    });

    const due = await collectDueJobs(store, now);
    expect(due[0]?.due).toBe(true);
    expect(isJobDue(due[0].job, now)).toBe(true);

    const updated = await markJobRun(store, due[0].job, now);
    expect(updated.nextRunAt).toBe('2026-01-01T00:15:00.000Z');
  });

  it('computes next interval runs directly', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(computeNextIntervalRun(now, 15)).toBe('2026-01-01T00:15:00.000Z');
  });
});
