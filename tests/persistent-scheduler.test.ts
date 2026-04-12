import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileSchedulerStore,
  InMemorySchedulerStore,
  type CronJobDefinition,
  isJobDue,
  collectDueJobs,
  markJobRun,
  createScheduledAgentJob,
  isCronSchedule,
} from '../packages/scheduler/src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    id: 'job-1',
    schedule: 'every:5m',
    task: 'test task',
    enabled: true,
    nextRunAt: '2026-01-01T00:00:00.000Z',
    runCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// FileSchedulerStore
// ---------------------------------------------------------------------------

describe('FileSchedulerStore', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scheduler-test-'));
    filePath = join(tmpDir, 'scheduler.json');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates and lists jobs', async () => {
    const store = new FileSchedulerStore(filePath);
    await store.saveJob(makeJob({ id: 'a' }));
    await store.saveJob(makeJob({ id: 'b' }));

    const jobs = await store.listJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.id).sort()).toEqual(['a', 'b']);
  });

  it('retrieves a single job by id', async () => {
    const store = new FileSchedulerStore(filePath);
    await store.saveJob(makeJob({ id: 'x', task: 'hello' }));

    const job = await store.getJob('x');
    expect(job).not.toBeNull();
    expect(job!.task).toBe('hello');
  });

  it('returns null for nonexistent job', async () => {
    const store = new FileSchedulerStore(filePath);
    expect(await store.getJob('nope')).toBeNull();
  });

  it('updates an existing job', async () => {
    const store = new FileSchedulerStore(filePath);
    await store.saveJob(makeJob({ id: 'x', task: 'v1' }));
    await store.saveJob(makeJob({ id: 'x', task: 'v2' }));

    const jobs = await store.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].task).toBe('v2');
  });

  it('deletes a job', async () => {
    const store = new FileSchedulerStore(filePath);
    await store.saveJob(makeJob({ id: 'x' }));

    expect(await store.deleteJob('x')).toBe(true);
    expect(await store.getJob('x')).toBeNull();
    expect(await store.deleteJob('x')).toBe(false);
  });

  it('pauses a job', async () => {
    const store = new FileSchedulerStore(filePath);
    await store.saveJob(makeJob({ id: 'x', enabled: true }));

    const paused = await store.pauseJob('x');
    expect(paused).not.toBeNull();
    expect(paused!.enabled).toBe(false);

    const fetched = await store.getJob('x');
    expect(fetched!.enabled).toBe(false);
  });

  it('resumes a job', async () => {
    const store = new FileSchedulerStore(filePath);
    await store.saveJob(makeJob({ id: 'x', enabled: false }));

    const resumed = await store.resumeJob('x');
    expect(resumed).not.toBeNull();
    expect(resumed!.enabled).toBe(true);
  });

  it('returns null for pause/resume on missing job', async () => {
    const store = new FileSchedulerStore(filePath);
    expect(await store.pauseJob('nope')).toBeNull();
    expect(await store.resumeJob('nope')).toBeNull();
  });

  // Persistence across instances

  it('persists data across store instances', async () => {
    const store1 = new FileSchedulerStore(filePath);
    await store1.saveJob(makeJob({ id: 'persist-1', task: 'first' }));
    await store1.saveJob(makeJob({ id: 'persist-2', task: 'second' }));

    // Create a fresh store instance pointing to the same file
    const store2 = new FileSchedulerStore(filePath);
    const jobs = await store2.listJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs.find((j) => j.id === 'persist-1')!.task).toBe('first');
    expect(jobs.find((j) => j.id === 'persist-2')!.task).toBe('second');
  });

  it('persists deletions across instances', async () => {
    const store1 = new FileSchedulerStore(filePath);
    await store1.saveJob(makeJob({ id: 'del-1' }));
    await store1.saveJob(makeJob({ id: 'del-2' }));
    await store1.deleteJob('del-1');

    const store2 = new FileSchedulerStore(filePath);
    const jobs = await store2.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('del-2');
  });

  // Graceful handling of missing file

  it('handles missing file gracefully', async () => {
    const store = new FileSchedulerStore(join(tmpDir, 'nonexistent.json'));
    const jobs = await store.listJobs();
    expect(jobs).toEqual([]);
  });

  it('creates directory structure on first write', async () => {
    const deepPath = join(tmpDir, 'nested', 'dir', 'scheduler.json');
    const store = new FileSchedulerStore(deepPath);
    await store.saveJob(makeJob({ id: 'deep' }));

    const store2 = new FileSchedulerStore(deepPath);
    const jobs = await store2.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('deep');
  });
});

// ---------------------------------------------------------------------------
// isCronSchedule detection
// ---------------------------------------------------------------------------

describe('isCronSchedule', () => {
  it('detects interval format as non-cron', () => {
    expect(isCronSchedule('every:5m')).toBe(false);
    expect(isCronSchedule('every:1h')).toBe(false);
    expect(isCronSchedule('every:24h')).toBe(false);
  });

  it('detects 5-field expressions as cron', () => {
    expect(isCronSchedule('* * * * *')).toBe(true);
    expect(isCronSchedule('0 9 * * *')).toBe(true);
    expect(isCronSchedule('*/5 * * * *')).toBe(true);
    expect(isCronSchedule('0 0 1 1 *')).toBe(true);
  });

  it('detects aliases as cron', () => {
    expect(isCronSchedule('@daily')).toBe(true);
    expect(isCronSchedule('@hourly')).toBe(true);
    expect(isCronSchedule('@weekly')).toBe(true);
    expect(isCronSchedule('@monthly')).toBe(true);
    expect(isCronSchedule('@yearly')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cron schedule integration with scheduler
// ---------------------------------------------------------------------------

describe('cron schedule integration', () => {
  it('markJobRun computes next cron occurrence for cron jobs', async () => {
    const store = new InMemorySchedulerStore();
    const job = makeJob({
      id: 'cron-1',
      schedule: '0 9 * * *',
      nextRunAt: '2026-04-13T09:00:00.000Z',
    });
    await store.saveJob(job);

    const now = new Date('2026-04-13T09:00:30.000Z');
    const updated = await markJobRun(store, job, now);

    // Next run should be tomorrow at 9:00 AM
    const nextRun = new Date(updated.nextRunAt!);
    expect(nextRun.getDate()).toBe(14);
    expect(nextRun.getHours()).toBe(9);
    expect(nextRun.getMinutes()).toBe(0);
  });

  it('markJobRun computes next interval for interval jobs', async () => {
    const store = new InMemorySchedulerStore();
    const job = makeJob({
      id: 'int-1',
      schedule: 'every:5m',
      nextRunAt: '2026-04-13T09:00:00.000Z',
    });
    await store.saveJob(job);

    const now = new Date('2026-04-13T09:05:00.000Z');
    const updated = await markJobRun(store, job, now);

    expect(updated.nextRunAt).toBe('2026-04-13T09:10:00.000Z');
  });

  it('isJobDue works for cron-scheduled jobs with nextRunAt', () => {
    const job = makeJob({
      schedule: '0 9 * * *',
      nextRunAt: '2026-04-13T09:00:00.000Z',
    });

    // At or past nextRunAt → due
    expect(isJobDue(job, new Date('2026-04-13T09:00:00.000Z'))).toBe(true);
    expect(isJobDue(job, new Date('2026-04-13T09:05:00.000Z'))).toBe(true);

    // Before nextRunAt → not due
    expect(isJobDue(job, new Date('2026-04-13T08:59:00.000Z'))).toBe(false);
  });

  it('collectDueJobs works with cron jobs', async () => {
    const store = new InMemorySchedulerStore();
    await store.saveJob(makeJob({
      id: 'cron-due',
      schedule: '0 9 * * *',
      nextRunAt: '2026-04-13T09:00:00.000Z',
    }));
    await store.saveJob(makeJob({
      id: 'cron-not-due',
      schedule: '0 17 * * *',
      nextRunAt: '2026-04-13T17:00:00.000Z',
    }));

    const now = new Date('2026-04-13T10:00:00.000Z');
    const results = await collectDueJobs(store, now);

    expect(results.find((r) => r.job.id === 'cron-due')!.due).toBe(true);
    expect(results.find((r) => r.job.id === 'cron-not-due')!.due).toBe(false);
  });

  it('createScheduledAgentJob computes nextRunAt for cron schedules', () => {
    const job = createScheduledAgentJob({
      id: 'cron-agent',
      schedule: '0 9 * * *',
      task: 'morning report',
    });

    expect(job.schedule).toBe('0 9 * * *');
    expect(job.nextRunAt).toBeTruthy();
    // nextRunAt should be a valid ISO date
    expect(new Date(job.nextRunAt!).getTime()).toBeGreaterThan(0);
    // The next run hour should be 9
    const nextRun = new Date(job.nextRunAt!);
    expect(nextRun.getHours()).toBe(9);
    expect(nextRun.getMinutes()).toBe(0);
  });

  it('createScheduledAgentJob works with cron aliases', () => {
    const job = createScheduledAgentJob({
      id: 'daily-agent',
      schedule: '@daily',
      task: 'daily sync',
    });

    expect(job.schedule).toBe('@daily');
    expect(job.nextRunAt).toBeTruthy();
    const nextRun = new Date(job.nextRunAt!);
    expect(nextRun.getHours()).toBe(0);
    expect(nextRun.getMinutes()).toBe(0);
  });

  it('FileSchedulerStore persists cron jobs correctly', async () => {
    const tmpDir = await import('node:os').then((os) => os.tmpdir());
    const { mkdtemp, rm } = await import('node:fs/promises');
    const dir = await mkdtemp(join(tmpDir, 'sched-cron-'));
    const fp = join(dir, 'jobs.json');

    try {
      const store1 = new FileSchedulerStore(fp);
      await store1.saveJob(makeJob({
        id: 'cron-persist',
        schedule: '*/15 * * * *',
        task: 'every 15 min',
      }));

      const store2 = new FileSchedulerStore(fp);
      const job = await store2.getJob('cron-persist');
      expect(job).not.toBeNull();
      expect(job!.schedule).toBe('*/15 * * * *');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
