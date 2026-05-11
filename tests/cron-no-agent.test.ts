// ---------------------------------------------------------------------------
// #309 — no_agent cron mode: script-only watchdog jobs
//
// Acceptance criteria from the issue:
//   - [x] `no_agent` cron with `echo "ok"` delivers "ok"; with `true` (empty
//         stdout) stays silent
//   - [x] Non-zero exit triggers configured failure handling
//   - [x] Resource limits enforced (timeout, CPU, memory) — same as
//         agent-mode terminal calls (timeout verified; CPU/memory are
//         delegated to the sandbox executor)
//   - [x] Per-job script timeout configurable
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import {
  type AgentRunFn,
  type CronJobDefinition,
  type DeliveryFn,
  type DeliveryTarget,
  type NoAgentSandboxClient,
  type NoAgentFailureEvent,
  InMemorySchedulerStore,
  SchedulerExecutor,
  NoAgentRunner,
  DEFAULT_NO_AGENT_TIMEOUT_MS,
} from '../packages/scheduler/src/index.js';

// ---------------------------------------------------------------------------
// Mock sandbox client (deterministic in-memory replay of executeCommand)
// ---------------------------------------------------------------------------

interface StubResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
}

function makeSandboxClient(result: StubResult): NoAgentSandboxClient {
  return {
    executeCommand: vi.fn().mockResolvedValue(result),
  };
}

function makeJob(overrides: Partial<CronJobDefinition> = {}): CronJobDefinition {
  return {
    id: 'watchdog-1',
    schedule: 'every:5m',
    task: 'unused for no_agent',
    enabled: true,
    nextRunAt: '2026-01-01T00:00:00.000Z',
    runCount: 0,
    mode: 'no_agent',
    command: 'echo "ok"',
    ...overrides,
  };
}

const PAST = new Date('2026-01-01T00:05:00.000Z');

// Stub agent runner — should NEVER fire for no_agent jobs.
const failingAgent: AgentRunFn = vi.fn().mockImplementation(() => {
  throw new Error('agent runner must not fire for no_agent jobs');
});

// ---------------------------------------------------------------------------
// NoAgentRunner unit tests (pure)
// ---------------------------------------------------------------------------

describe('NoAgentRunner (#309)', () => {
  it('delivers non-empty stdout verbatim', async () => {
    const client = makeSandboxClient({ stdout: 'ok\n', stderr: '', exitCode: 0 });
    const runner = new NoAgentRunner(client);
    const result = await runner.run('echo ok', { jobId: 'j1' });
    expect(result.ok).toBe(true);
    expect(result.shouldDeliver).toBe(true);
    expect(result.deliveryContent).toBe('ok');
    expect(result.stdout).toBe('ok');
  });

  it('stays silent when stdout is empty (success path)', async () => {
    const client = makeSandboxClient({ stdout: '', stderr: '', exitCode: 0 });
    const runner = new NoAgentRunner(client);
    const result = await runner.run('true', { jobId: 'j1' });
    expect(result.ok).toBe(true);
    expect(result.shouldDeliver).toBe(false);
    expect(result.deliveryContent).toBeUndefined();
  });

  it('treats whitespace-only stdout as silent', async () => {
    const client = makeSandboxClient({ stdout: '   \n  \t\n', stderr: '', exitCode: 0 });
    const runner = new NoAgentRunner(client);
    const result = await runner.run('printf "  "', { jobId: 'j1' });
    expect(result.ok).toBe(true);
    expect(result.shouldDeliver).toBe(false);
  });

  it('emits failure event on non-zero exit code', async () => {
    const client = makeSandboxClient({
      stdout: '',
      stderr: 'boom',
      exitCode: 1,
    });
    const events: NoAgentFailureEvent[] = [];
    const runner = new NoAgentRunner(client);
    const result = await runner.run('false', {
      jobId: 'j1',
      onFailureEvent: (e) => events.push(e),
    });
    expect(result.ok).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('cron:no_agent_failed');
    expect(events[0].exitCode).toBe(1);
    expect(events[0].stderrSummary).toBe('boom');
  });

  it('silent failure policy delivers nothing on non-zero exit', async () => {
    const client = makeSandboxClient({ stdout: '', stderr: 'oh', exitCode: 2 });
    const runner = new NoAgentRunner(client);
    const result = await runner.run('false', { jobId: 'j1', failurePolicy: 'silent' });
    expect(result.shouldDeliver).toBe(false);
    expect(result.deliveryContent).toBeUndefined();
  });

  it('notify failure policy delivers a one-line summary', async () => {
    const client = makeSandboxClient({
      stdout: '',
      stderr: 'connection refused',
      exitCode: 1,
    });
    const runner = new NoAgentRunner(client);
    const result = await runner.run('curl http://down', {
      jobId: 'cert-watch',
      failurePolicy: 'notify',
    });
    expect(result.shouldDeliver).toBe(true);
    expect(result.deliveryContent).toContain('cert-watch');
    expect(result.deliveryContent).toContain('exit code 1');
    expect(result.deliveryContent).toContain('connection refused');
  });

  it('captures timeout in failure event', async () => {
    const client = makeSandboxClient({
      stdout: '',
      stderr: '',
      exitCode: 124,
      timedOut: true,
    });
    const events: NoAgentFailureEvent[] = [];
    const runner = new NoAgentRunner(client);
    const result = await runner.run('sleep 99', {
      jobId: 'slow-job',
      timeoutMs: 500,
      failurePolicy: 'notify',
      onFailureEvent: (e) => events.push(e),
    });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(events[0].timedOut).toBe(true);
    // notify message mentions the timeout
    expect(result.deliveryContent).toContain('timed out after 500ms');
  });

  it('passes timeout option to the sandbox client', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    const client: NoAgentSandboxClient = { executeCommand: exec };
    const runner = new NoAgentRunner(client);
    await runner.run('ls', { jobId: 'j1', timeoutMs: 3_000, cwd: '/tmp' });
    expect(exec).toHaveBeenCalledWith('ls', '/tmp', { timeoutMs: 3_000 });
  });

  it('truncates very large stderr in failure event summary', async () => {
    const giantStderr = 'x'.repeat(10_000);
    const client = makeSandboxClient({ stdout: '', stderr: giantStderr, exitCode: 1 });
    const events: NoAgentFailureEvent[] = [];
    const runner = new NoAgentRunner(client);
    await runner.run('false', { jobId: 'j1', onFailureEvent: (e) => events.push(e) });
    expect(events).toHaveLength(1);
    // Summary capped to 2 KB + truncation marker
    expect(events[0].stderrSummary.length).toBeLessThan(giantStderr.length);
    expect(events[0].stderrSummary).toContain('truncated');
  });

  it('default timeout is 60s when none configured', () => {
    expect(DEFAULT_NO_AGENT_TIMEOUT_MS).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// SchedulerExecutor integration tests for no_agent mode
// ---------------------------------------------------------------------------

describe('SchedulerExecutor no_agent integration (#309)', () => {
  it('delivers stdout via the configured channel when shouldDeliver=true', async () => {
    const target: DeliveryTarget = {
      platform: 'telegram',
      config: { chatId: '1', token: 't' },
    };
    const store = new InMemorySchedulerStore();
    const client = makeSandboxClient({
      stdout: 'cert expires in 3 days',
      stderr: '',
      exitCode: 0,
    });
    const deliver: DeliveryFn = vi.fn().mockResolvedValue({ ok: true });
    await store.saveJob(makeJob({ deliverTo: target }));

    const executor = new SchedulerExecutor(store, failingAgent, deliver, {
      sandboxClient: client,
    });
    const results = await executor.tick(PAST);

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].response).toBe('cert expires in 3 days');
    expect(deliver).toHaveBeenCalledWith(target, 'cert expires in 3 days');
    // Agent runner must not have fired
    expect(failingAgent).not.toHaveBeenCalled();
  });

  it('stays silent (no delivery) when stdout is empty', async () => {
    const target: DeliveryTarget = {
      platform: 'webhook',
      config: { url: 'https://hooks.example/x' },
    };
    const store = new InMemorySchedulerStore();
    const client = makeSandboxClient({ stdout: '', stderr: '', exitCode: 0 });
    const deliver: DeliveryFn = vi.fn().mockResolvedValue({ ok: true });
    await store.saveJob(makeJob({ deliverTo: target, command: 'true' }));

    const executor = new SchedulerExecutor(store, failingAgent, deliver, {
      sandboxClient: client,
    });
    const results = await executor.tick(PAST);

    expect(results[0].ok).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('emits cron:no_agent_failed on non-zero exit', async () => {
    const store = new InMemorySchedulerStore();
    const client = makeSandboxClient({
      stdout: '',
      stderr: 'disk full',
      exitCode: 1,
    });
    const events: NoAgentFailureEvent[] = [];
    await store.saveJob(makeJob({ command: 'df -h' }));

    const executor = new SchedulerExecutor(store, failingAgent, undefined, {
      sandboxClient: client,
      onNoAgentFailure: (e) => events.push(e),
    });
    const results = await executor.tick(PAST);

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('no_agent exit 1');
    expect(events).toHaveLength(1);
    expect(events[0].jobId).toBe('watchdog-1');
    expect(events[0].exitCode).toBe(1);
  });

  it('honours per-job commandTimeoutMs', async () => {
    const store = new InMemorySchedulerStore();
    const exec = vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });
    const client: NoAgentSandboxClient = { executeCommand: exec };
    await store.saveJob(makeJob({ commandTimeoutMs: 250 }));

    const executor = new SchedulerExecutor(store, failingAgent, undefined, {
      sandboxClient: client,
    });
    await executor.tick(PAST);

    expect(exec).toHaveBeenCalledWith('echo "ok"', undefined, { timeoutMs: 250 });
  });

  it('returns config error when no_agent job omits command', async () => {
    const store = new InMemorySchedulerStore();
    const client = makeSandboxClient({ stdout: '', stderr: '', exitCode: 0 });
    await store.saveJob(makeJob({ command: undefined }));

    const executor = new SchedulerExecutor(store, failingAgent, undefined, {
      sandboxClient: client,
    });
    const results = await executor.tick(PAST);

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('missing command');
  });

  it('returns config error when sandboxClient is unwired', async () => {
    const store = new InMemorySchedulerStore();
    await store.saveJob(makeJob());

    const executor = new SchedulerExecutor(store, failingAgent, undefined, {
      // sandboxClient missing
    });
    const results = await executor.tick(PAST);

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('sandboxClient');
  });

  it('notify policy delivers a failure summary through the channel', async () => {
    const target: DeliveryTarget = {
      platform: 'telegram',
      config: { chatId: '1', token: 't' },
    };
    const store = new InMemorySchedulerStore();
    const client = makeSandboxClient({
      stdout: '',
      stderr: 'broke',
      exitCode: 2,
    });
    const deliver: DeliveryFn = vi.fn().mockResolvedValue({ ok: true });
    await store.saveJob(
      makeJob({
        deliverTo: target,
        noAgentFailurePolicy: 'notify',
        command: 'false',
      }),
    );

    const executor = new SchedulerExecutor(store, failingAgent, deliver, {
      sandboxClient: client,
    });
    const results = await executor.tick(PAST);

    expect(results[0].ok).toBe(false);
    expect(deliver).toHaveBeenCalledOnce();
    const [, content] = deliver.mock.calls[0];
    expect(content).toContain('exit code 2');
    expect(content).toContain('watchdog-1');
  });

  it('agent-mode jobs are unaffected (regression)', async () => {
    const store = new InMemorySchedulerStore();
    const run: AgentRunFn = vi.fn().mockResolvedValue({
      finalResponse: 'agent ran',
      toolResults: [],
    });
    await store.saveJob(
      makeJob({ mode: 'agent', command: undefined, task: 'do agent work' }),
    );

    const executor = new SchedulerExecutor(store, run, undefined, {});
    const results = await executor.tick(PAST);

    expect(results[0].ok).toBe(true);
    expect(results[0].response).toBe('agent ran');
    expect(run).toHaveBeenCalledOnce();
  });
});
