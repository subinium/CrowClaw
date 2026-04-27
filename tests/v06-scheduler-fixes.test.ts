import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentRunFn,
  type CronJobDefinition,
  DEFAULT_MAX_CONCURRENT_JOBS,
  FileSchedulerStore,
  InMemorySchedulerStore,
  SchedulerExecutor,
  TIMEOUT_MAX,
  clearSafeTimer,
  createScheduledAgentJob,
  safeSetInterval,
  safeSetTimeout,
} from '../packages/scheduler/src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDueJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    id: 'job-' + Math.random().toString(36).slice(2, 8),
    schedule: 'every:5m',
    task: 'do something',
    enabled: true,
    nextRunAt: '2026-01-01T00:00:00.000Z', // already past
    runCount: 0,
    ...overrides,
  };
}

function mockAgentRun(): AgentRunFn {
  return vi.fn().mockResolvedValue({
    finalResponse: 'ok',
    toolResults: [],
  });
}

const PAST = new Date('2026-01-01T00:05:00.000Z');

// ---------------------------------------------------------------------------
// #76 — safe-timer
// ---------------------------------------------------------------------------

describe('#76 safe-timer clamps to TIMEOUT_MAX', () => {
  it('TIMEOUT_MAX equals Node documented bound', () => {
    expect(TIMEOUT_MAX).toBe(2_147_483_647);
  });

  it('safeSetTimeout fires for short delay (no chaining)', async () => {
    const fn = vi.fn();
    const timer = safeSetTimeout(20, fn);
    await new Promise((r) => setTimeout(r, 60));
    expect(fn).toHaveBeenCalledOnce();
    clearSafeTimer(timer);
  });

  it('safeSetTimeout does NOT tight-loop for delay above TIMEOUT_MAX (100 days)', async () => {
    // Regression for OpenClaw issue #71414: a value above TIMEOUT_MAX would
    // silently coerce to 1ms in Node, firing the callback in a tight loop.
    // With the safe wrapper, the callback must NOT fire within 100ms.
    const fn = vi.fn();
    const hundredDaysMs = 100 * 24 * 60 * 60 * 1000; // > TIMEOUT_MAX
    const timer = safeSetTimeout(hundredDaysMs, fn);
    await new Promise((r) => setTimeout(r, 100));
    expect(fn).not.toHaveBeenCalled();
    clearSafeTimer(timer);
  });

  it('safeSetInterval does NOT tight-loop for period above TIMEOUT_MAX', async () => {
    const fn = vi.fn();
    const hundredDaysMs = 100 * 24 * 60 * 60 * 1000;
    const timer = safeSetInterval(hundredDaysMs, fn);
    await new Promise((r) => setTimeout(r, 150));
    expect(fn).not.toHaveBeenCalled();
    clearSafeTimer(timer);
  });

  it('safeSetInterval fires repeatedly for normal period', async () => {
    const fn = vi.fn();
    const timer = safeSetInterval(15, fn);
    await new Promise((r) => setTimeout(r, 80));
    clearSafeTimer(timer);
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('cancel before fire is a no-op', async () => {
    const fn = vi.fn();
    const timer = safeSetTimeout(40, fn);
    clearSafeTimer(timer);
    await new Promise((r) => setTimeout(r, 80));
    expect(fn).not.toHaveBeenCalled();
  });

  it('treats non-finite/negative delay as 0', async () => {
    const fn = vi.fn();
    const timer = safeSetTimeout(-1, fn);
    await new Promise((r) => setTimeout(r, 30));
    expect(fn).toHaveBeenCalledOnce();
    clearSafeTimer(timer);
  });
});

// ---------------------------------------------------------------------------
// #101 — concurrent execution with cap
// ---------------------------------------------------------------------------

describe('#101 SchedulerExecutor.tick runs jobs concurrently', () => {
  it('exposes a default concurrency cap of 5', () => {
    expect(DEFAULT_MAX_CONCURRENT_JOBS).toBe(5);
  });

  it('runs 5 due jobs in parallel (not serial)', async () => {
    const store = new InMemorySchedulerStore();
    let inFlight = 0;
    let peak = 0;

    const slowAgent: AgentRunFn = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 50));
      inFlight -= 1;
      return { finalResponse: 'ok', toolResults: [] };
    });

    for (let i = 0; i < 5; i += 1) {
      await store.saveJob(makeDueJob({ id: `j-${i}` }));
    }

    const executor = new SchedulerExecutor(store, slowAgent);
    const start = Date.now();
    const results = await executor.tick(PAST);
    const elapsed = Date.now() - start;

    expect(results).toHaveLength(5);
    // Serial would take >= 5 * 50ms = 250ms. Concurrent should be ~50–100ms.
    expect(elapsed).toBeLessThan(200);
    expect(peak).toBeGreaterThanOrEqual(2); // proof of concurrency
  });

  it('caps concurrency at maxConcurrentJobs', async () => {
    const store = new InMemorySchedulerStore();
    let inFlight = 0;
    let peak = 0;

    const slowAgent: AgentRunFn = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight -= 1;
      return { finalResponse: 'ok', toolResults: [] };
    });

    for (let i = 0; i < 10; i += 1) {
      await store.saveJob(makeDueJob({ id: `j-${i}` }));
    }

    const executor = new SchedulerExecutor(store, slowAgent, undefined, {
      maxConcurrentJobs: 2,
    });
    await executor.tick(PAST);

    expect(peak).toBeLessThanOrEqual(2);
  });

  it('preserves result order matching due-job order', async () => {
    const store = new InMemorySchedulerStore();
    const agent: AgentRunFn = vi.fn(async (input) => {
      // Stagger so order would scramble if we returned by completion order.
      const delay = input.agentId.endsWith('a') ? 60 : 10;
      await new Promise((r) => setTimeout(r, delay));
      return { finalResponse: input.agentId, toolResults: [] };
    });

    await store.saveJob(makeDueJob({ id: 'a' }));
    await store.saveJob(makeDueJob({ id: 'b' }));

    const executor = new SchedulerExecutor(store, agent);
    const results = await executor.tick(PAST);

    expect(results.map((r) => r.jobId)).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// #111 — FileSchedulerStore mkdir once
// ---------------------------------------------------------------------------

describe('#111 FileSchedulerStore persists mkdir once', () => {
  it('reuses cached directory after first persist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crowclaw-sched-'));
    try {
      const filePath = join(dir, 'nested', 'jobs.json');
      const store = new FileSchedulerStore(filePath);

      await store.saveJob(makeDueJob({ id: 'a' }));
      await store.saveJob(makeDueJob({ id: 'b' }));
      await store.saveJob(makeDueJob({ id: 'c' }));

      // The nested directory must exist (proof mkdir ran at least once).
      const s = await stat(join(dir, 'nested'));
      expect(s.isDirectory()).toBe(true);

      // All three jobs persisted.
      const raw = JSON.parse(await readFile(filePath, 'utf-8')) as {
        jobs: CronJobDefinition[];
      };
      expect(raw.jobs.map((j) => j.id).sort()).toEqual(['a', 'b', 'c']);

      // dirEnsured is private; assert via reflection that it flipped.
      // Using bracket access avoids exporting an internal flag for test-only.
      expect((store as unknown as { dirEnsured: boolean }).dirEnsured).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #112 — watchdog clears interval immediately after race resolves
// ---------------------------------------------------------------------------

describe('#112 watchdog clears interval after rejection', () => {
  it('reports timeout error and stops invoking probe after rejection', async () => {
    const store = new InMemorySchedulerStore();

    // Agent that never resolves — forces watchdog to win the race.
    const hangingAgent: AgentRunFn = () => new Promise(() => {
      /* never resolves */
    });

    let probeCalls = 0;
    const probe = (_id: string): string | null => {
      probeCalls += 1;
      // Always return the same old timestamp so inactivity threshold trips.
      return new Date(0).toISOString();
    };

    await store.saveJob(
      makeDueJob({
        id: 'hang',
        // Force an immediate stall: 1ms inactivity window, generous max-run cap.
        inactivityTimeoutMs: 1,
        maxRunDurationMs: 60_000,
      }),
    );

    const executor = new SchedulerExecutor(store, hangingAgent, undefined, {
      activityProbe: probe,
    });

    const results = await executor.tick(PAST);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error ?? '').toMatch(/stall|exceeded|timed out/i);

    const probeCallsAfterReject = probeCalls;
    // Give any zombie watchdog ~80ms to fire spuriously.
    await new Promise((r) => setTimeout(r, 80));
    // No additional probe calls should occur — watchdog was cleared inline.
    expect(probeCalls).toBe(probeCallsAfterReject);
  });
});

// ---------------------------------------------------------------------------
// #94 — per-job enabledToolsets
// ---------------------------------------------------------------------------

describe('#94 per-cron-job enabledToolsets', () => {
  it('createScheduledAgentJob carries enabledToolsets through', () => {
    const job = createScheduledAgentJob({
      id: 'narrow',
      schedule: 'every:5m',
      task: 'summarise',
      enabledToolsets: ['web', 'memory'],
    });
    expect(job.enabledToolsets).toEqual(['web', 'memory']);
  });

  it('executor passes enabledToolsets to AgentRunFn', async () => {
    const store = new InMemorySchedulerStore();
    const agent = mockAgentRun();
    await store.saveJob(
      makeDueJob({
        id: 'tool-cap',
        enabledToolsets: ['web.search'],
      }),
    );

    const executor = new SchedulerExecutor(store, agent);
    await executor.tick(PAST);

    expect(agent).toHaveBeenCalledOnce();
    const args = (agent as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      enabledToolsets?: string[];
    };
    expect(args.enabledToolsets).toEqual(['web.search']);
  });

  it('omits enabledToolsets when not set on job (host default behaviour)', async () => {
    const store = new InMemorySchedulerStore();
    const agent = mockAgentRun();
    await store.saveJob(makeDueJob({ id: 'no-cap' }));

    const executor = new SchedulerExecutor(store, agent);
    await executor.tick(PAST);

    const args = (agent as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      enabledToolsets?: string[];
    };
    expect(args.enabledToolsets).toBeUndefined();
  });

  it('empty array means "no toolsets" (passes through as [])', async () => {
    const store = new InMemorySchedulerStore();
    const agent = mockAgentRun();
    await store.saveJob(makeDueJob({ id: 'zero', enabledToolsets: [] }));

    const executor = new SchedulerExecutor(store, agent);
    await executor.tick(PAST);

    const args = (agent as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      enabledToolsets?: string[];
    };
    expect(args.enabledToolsets).toEqual([]);
  });
});
