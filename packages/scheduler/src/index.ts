import { readFile, writeFile, mkdir, rename, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export {
  type CronExpression,
  parseCron,
  cronMatches,
  nextCronOccurrence,
  prevCronOccurrence,
  formatCron,
  describeCron,
} from './cron-parser.js';

export {
  type SafeTimer,
  TIMEOUT_MAX,
  safeSetTimeout,
  safeSetInterval,
  clearSafeTimer,
} from './safe-timer.js';

// #299 — assembled-prompt injection scan (cron security)
export {
  type PromptPart,
  type InjectionFinding,
  type SecurityScanner,
  type InjectionPolicy,
  ASSEMBLY_SEPARATOR,
  assemblePrompt,
  scanAssembledPrompt,
  applyInjectionPolicy,
} from './injection-scan.js';

// #309 — no-agent cron runner (script-only watchdog jobs)
export {
  type NoAgentSandboxClient,
  type NoAgentRunResult,
  type NoAgentRunnerOptions,
  type NoAgentFailureEvent,
  DEFAULT_NO_AGENT_TIMEOUT_MS,
  NoAgentRunner,
} from './no-agent-runner.js';

import type { PromptPart, SecurityScanner, InjectionPolicy } from './injection-scan.js';
import {
  scanAssembledPrompt,
  applyInjectionPolicy,
} from './injection-scan.js';
import type { NoAgentSandboxClient, NoAgentFailureEvent } from './no-agent-runner.js';
import { NoAgentRunner, DEFAULT_NO_AGENT_TIMEOUT_MS } from './no-agent-runner.js';

import {
  parseCron,
  nextCronOccurrence,
} from './cron-parser.js';

import {
  type SafeTimer,
  safeSetInterval,
  clearSafeTimer,
} from './safe-timer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Cap run-history per job so the file-backed store and in-memory store can't
 * grow unbounded. Shared by `InMemorySchedulerStore.recordRun` and
 * `FileSchedulerStore.recordRun` to keep CF / Node parity.
 */
export const RUN_HISTORY_CAP = 100;

/**
 * Default per-tool inactivity window before the scheduler considers an in-flight
 * job stalled. Five minutes mirrors the agent-side default in `@crowclaw/core`.
 */
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 5 * 60_000;

/**
 * Default hard cap for total run duration. Two hours is a backstop for cases
 * where activity heartbeats keep firing but the job is effectively wedged.
 */
export const DEFAULT_MAX_RUN_DURATION_MS = 2 * 60 * 60_000;

/**
 * Default fan-out cap for `SchedulerExecutor.tick`. Issue #101 — the executor
 * runs due jobs concurrently, but a runaway tick (e.g. 100 jobs all due
 * because the host slept) should not stampede the agent runtime. Override
 * via `SchedulerExecutorOptions.maxConcurrentJobs`.
 */
export const DEFAULT_MAX_CONCURRENT_JOBS = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeliveryTarget {
  platform: string; // 'telegram' | 'discord' | 'slack' | 'email' | 'webhook'
  config: Record<string, string>; // platform-specific (token, chatId, webhookUrl, etc.)
}

export interface JobRun {
  runId: string;
  startedAt: string;
  completedAt: string;
  success: boolean;
  response?: string;
  error?: string;
}

export interface CronJobDefinition {
  id: string;
  schedule: string;
  task: string; // The prompt/message to send to the agent
  enabled: boolean;
  nextRunAt?: string;
  metadata?: Record<string, unknown>;
  /**
   * #309 — cron job execution mode. Default `'agent'` preserves the existing
   * agent-loop dispatch. `'no_agent'` skips the agent entirely and runs
   * `command` via the configured sandbox executor, delivering stdout
   * verbatim. Empty stdout → silent; non-zero exit → emit
   * `cron:no_agent_failed`. Use-cases: certificate-expiry watchdog, disk
   * usage alerts, log tailing.
   */
  mode?: 'agent' | 'no_agent';
  /**
   * #309 — shell command to execute when `mode === 'no_agent'`. Ignored for
   * agent-mode jobs. The command runs through the host's sandbox executor
   * (same path as agent terminal calls), so resource limits and env
   * sanitization apply automatically.
   */
  command?: string;
  /**
   * #309 — per-job command timeout in ms. Falls back to
   * `DEFAULT_NO_AGENT_TIMEOUT_MS` (60s) when unset. Only used when
   * `mode === 'no_agent'`. Resource limits beyond timeout (CPU, memory) are
   * enforced by the sandbox executor itself.
   */
  commandTimeoutMs?: number;
  /**
   * #309 — what to deliver on non-zero exit when `mode === 'no_agent'`.
   *  - `'silent'` (default) — record the failure event, deliver nothing.
   *  - `'notify'`           — deliver a one-line failure notice (cron id,
   *                           exit code, stderr summary) to the configured
   *                           `deliverTo` target.
   */
  noAgentFailurePolicy?: 'silent' | 'notify';
  /**
   * #299 — per-cron injection policy applied to the assembled prompt
   * (cron config + injected skills + memory). Default `'block'` refuses
   * dispatch on any detected injection. `'warn'` logs but proceeds. `'off'`
   * skips the scan entirely (escape hatch for trusted hosts running their
   * own pre-validation). Has no effect on `mode: 'no_agent'` jobs.
   */
  injectionPolicy?: InjectionPolicy;
  // Agent execution fields
  skillSlugs?: string[];
  toolsetPreset?: string;
  /**
   * Per-job allowlist of toolset slugs to register on the agent for this run.
   * When set, the host should construct the agent with ONLY these toolsets
   * registered — caps token overhead for narrow jobs (e.g. a daily summariser
   * that only needs `web.search`). Mirrors Hermes PR #14767.
   *
   * `undefined` keeps the host's default behaviour (all toolsets from the
   * preset). An empty array means "no toolsets" — the agent runs with no tools.
   */
  enabledToolsets?: string[];
  agentPreset?: string;
  model?: string;
  deliverTo?: DeliveryTarget;
  // Run lifecycle fields
  lastRunAt?: string;
  lastRunStatus?: 'success' | 'error' | 'timeout';
  lastRunError?: string;
  lastRunResult?: string; // Truncated result
  runCount?: number;
  maxRuns?: number; // Auto-disable after N runs
  /** @deprecated Use `inactivityTimeoutMs` for activity-based or `maxRunDurationMs` for the hard cap. Falls back to inactivity timeout when set. */
  timeoutMs?: number; // Per-run timeout (default: 60000)
  /**
   * Per-job inactivity timeout. The executor aborts the run if no tool
   * activity is observed for this many ms. Mirrors agent-side
   * `lastToolActivityAt` tracking added in `@crowclaw/core`.
   * Defaults to `DEFAULT_INACTIVITY_TIMEOUT_MS` (5 min).
   */
  inactivityTimeoutMs?: number;
  /**
   * Hard cap on total run wall-clock duration regardless of activity.
   * Defaults to `DEFAULT_MAX_RUN_DURATION_MS` (2 hours).
   */
  maxRunDurationMs?: number;
  // Grace window
  graceWindowMs?: number; // Default: 300_000 (5 min). Skip job if overdue by more than this.
  // Run archival
  runs?: JobRun[];
  totalRuns?: number;
  // One-shot completion
  completedAt?: string;
}

export interface DueJob {
  job: CronJobDefinition;
  due: boolean;
}

export interface JobRunRecord {
  jobId: string;
  runId: string;
  startedAt: string;
  completedAt: string;
  ok: boolean;
  response: string;
  error?: string;
  durationMs: number;
  tokensUsed?: number;
}

export interface SchedulerStore {
  listJobs(): Promise<CronJobDefinition[]>;
  saveJob(job: CronJobDefinition): Promise<void>;
  getJob(id: string): Promise<CronJobDefinition | null>;
  deleteJob(id: string): Promise<boolean>;
  pauseJob(id: string): Promise<CronJobDefinition | null>;
  resumeJob(id: string): Promise<CronJobDefinition | null>;
  getRunHistory(jobId: string, limit?: number): Promise<JobRunRecord[]>;
  recordRun(record: JobRunRecord): Promise<void>;
}

// ---------------------------------------------------------------------------
// Agent run / delivery function signatures
// ---------------------------------------------------------------------------

export interface AgentRunFn {
  (input: {
    sessionId: string;
    userMessage: string;
    agentId: string;
    skillSlugs?: string[];
    agentPreset?: string;
    toolsetPreset?: string;
    /**
     * Per-job toolset allowlist. Hosts must register only these toolsets on
     * the agent for this run when set. See `CronJobDefinition.enabledToolsets`.
     */
    enabledToolsets?: string[];
    model?: string;
  }): Promise<{
    finalResponse: string;
    toolResults: Array<{ toolName: string; ok: boolean; output: string }>;
  }>;
}

export interface DeliveryFn {
  (
    target: DeliveryTarget,
    content: string,
  ): Promise<{ ok: boolean; error?: string }>;
}

/**
 * Probe used by the executor to decide if an in-flight job has stalled.
 * Returns the ISO timestamp of the most recent tool execution for the given
 * session, or `null` if the session has no recorded activity yet.
 *
 * Hosts wire this up against `SessionState.lastToolActivityAt` (added by
 * `@crowclaw/core`). The scheduler intentionally avoids importing
 * `@crowclaw/core` to keep the package free of cross-runtime deps; instead
 * it accepts this duck-typed probe.
 */
export interface SessionActivityProbe {
  (sessionId: string): Promise<string | null> | string | null;
}

// ---------------------------------------------------------------------------
// Tick result
// ---------------------------------------------------------------------------

export interface SchedulerTickResult {
  jobId: string;
  sessionId: string;
  ok: boolean;
  response?: string;
  error?: string;
  toolResults?: Array<{ toolName: string; ok: boolean; output: string }>;
  delivery?: { ok: boolean; error?: string };
  executedAt: string;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

export class InMemorySchedulerStore implements SchedulerStore {
  private readonly jobs = new Map<string, CronJobDefinition>();
  private readonly runHistory = new Map<string, JobRunRecord[]>();

  async listJobs(): Promise<CronJobDefinition[]> {
    return [...this.jobs.values()];
  }

  async saveJob(job: CronJobDefinition): Promise<void> {
    this.jobs.set(job.id, job);
  }

  async getJob(id: string): Promise<CronJobDefinition | null> {
    return this.jobs.get(id) ?? null;
  }

  async deleteJob(id: string): Promise<boolean> {
    return this.jobs.delete(id);
  }

  async pauseJob(id: string): Promise<CronJobDefinition | null> {
    const job = this.jobs.get(id);
    if (!job) return null;
    const updated = { ...job, enabled: false };
    this.jobs.set(id, updated);
    return updated;
  }

  async resumeJob(id: string): Promise<CronJobDefinition | null> {
    const job = this.jobs.get(id);
    if (!job) return null;
    const updated = { ...job, enabled: true };
    this.jobs.set(id, updated);
    return updated;
  }

  async getRunHistory(jobId: string, limit?: number): Promise<JobRunRecord[]> {
    const records = this.runHistory.get(jobId) ?? [];
    // Return most recent first
    const sorted = [...records].reverse();
    return limit !== undefined ? sorted.slice(0, limit) : sorted;
  }

  async recordRun(record: JobRunRecord): Promise<void> {
    const records = this.runHistory.get(record.jobId) ?? [];
    records.push(record);
    // Mirror the FileSchedulerStore cap so the in-memory store (used by CF
    // Durable Objects after serialize/deserialize) can't grow unbounded.
    if (records.length > RUN_HISTORY_CAP) {
      records.splice(0, records.length - RUN_HISTORY_CAP);
    }
    this.runHistory.set(record.jobId, records);
  }

  // -- Cross-runtime serialization (used by CF Durable Object storage) --

  /**
   * Snapshot the store state for round-tripping through external storage
   * (e.g. CF Durable Object `state.storage`). Pairs with `deserialize`.
   */
  serialize(): SerializedSchedulerStore {
    const history: Record<string, JobRunRecord[]> = {};
    for (const [jobId, records] of this.runHistory) {
      history[jobId] = [...records];
    }
    return {
      jobs: [...this.jobs.values()],
      history,
    };
  }

  /**
   * Replace the store state with a previously serialized snapshot.
   * Existing in-memory state is cleared first.
   */
  deserialize(data: SerializedSchedulerStore): void {
    this.jobs.clear();
    for (const job of data.jobs ?? []) {
      this.jobs.set(job.id, job);
    }
    this.runHistory.clear();
    for (const [jobId, records] of Object.entries(data.history ?? {})) {
      this.runHistory.set(jobId, [...records]);
    }
  }
}

/**
 * Wire-format snapshot of an `InMemorySchedulerStore`. Consumed by the CF
 * Durable Object adapter (issue #32) to persist scheduler state across
 * hibernation / restarts without re-implementing the store.
 */
export interface SerializedSchedulerStore {
  jobs: CronJobDefinition[];
  history: Record<string, JobRunRecord[]>;
}

// ---------------------------------------------------------------------------
// Schedule type detection
// ---------------------------------------------------------------------------

/** Returns true if the schedule is a one-shot format: once:<ts>, at:<ts>, after:<dur> */
export function isOneShotSchedule(schedule: string): boolean {
  const trimmed = schedule.trim().toLowerCase();
  return (
    trimmed.startsWith('once:') ||
    trimmed.startsWith('at:') ||
    trimmed.startsWith('after:')
  );
}

/** Returns true if the schedule is a cron expression or cron alias */
export function isCronSchedule(schedule: string): boolean {
  const trimmed = schedule.trim().toLowerCase();
  if (trimmed.startsWith('@')) return true;
  // 5-field cron: contains spaces and is not an interval format
  return !trimmed.startsWith('every:') && !isOneShotSchedule(trimmed) && trimmed.includes(' ');
}

// ---------------------------------------------------------------------------
// Interval helpers
// ---------------------------------------------------------------------------

export function parseIntervalMinutes(schedule: string): number {
  const match = schedule.match(/^every:(\d+)(m|h)$/);
  if (!match) return 1;
  const value = Number(match[1]);
  const unit = match[2];
  return unit === 'h' ? value * 60 : value;
}

export function computeNextIntervalRun(
  now: Date,
  intervalMinutes: number,
): string {
  return new Date(now.getTime() + intervalMinutes * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// One-shot schedule helpers
// ---------------------------------------------------------------------------

/**
 * Parse a duration string like '30m', '2h', '1d' into milliseconds.
 * Supports m (minutes), h (hours), d (days).
 */
export function parseDurationMs(duration: string): number {
  const match = duration.match(/^(\d+)(m|h|d)$/);
  if (!match) throw new Error(`Invalid duration format: ${duration}`);
  const value = Number(match[1]);
  const unit = match[2];
  switch (unit) {
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    case 'd': return value * 86_400_000;
    default: throw new Error(`Unknown duration unit: ${unit}`);
  }
}

/**
 * Parse one-shot schedule formats and return an absolute ISO timestamp.
 * - `once:<ISO timestamp>` — fire at exact time
 * - `at:<ISO timestamp>` — alias for once:
 * - `after:<duration>` — relative to `now`, e.g. `after:30m`, `after:2h`, `after:1d`
 *
 * Returns null if the schedule is not a one-shot format.
 */
export function parseOneShotSchedule(schedule: string, now = new Date()): string | null {
  const trimmed = schedule.trim();

  if (trimmed.startsWith('once:') || trimmed.startsWith('at:')) {
    const prefix = trimmed.startsWith('once:') ? 'once:' : 'at:';
    const timestamp = trimmed.slice(prefix.length).trim();
    // Validate it parses as a date
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) {
      throw new Error(`Invalid ISO timestamp in schedule: ${timestamp}`);
    }
    return d.toISOString();
  }

  if (trimmed.startsWith('after:')) {
    const durationStr = trimmed.slice('after:'.length).trim();
    const ms = parseDurationMs(durationStr);
    return new Date(now.getTime() + ms).toISOString();
  }

  return null;
}

// ---------------------------------------------------------------------------
// Cron schedule helpers
// ---------------------------------------------------------------------------

export function computeNextCronRun(schedule: string, after: Date): string {
  const cron = parseCron(schedule);
  return nextCronOccurrence(cron, after).toISOString();
}

// ---------------------------------------------------------------------------
// Job creation helpers
// ---------------------------------------------------------------------------

export function createEveryNMinutesJob(
  id: string,
  minutes: number,
  task: string,
  now = new Date(),
): CronJobDefinition {
  return {
    id,
    schedule: `every:${minutes}m`,
    task,
    enabled: true,
    nextRunAt: computeNextIntervalRun(now, minutes),
  };
}

export function createScheduledAgentJob(options: {
  id: string;
  schedule: string; // 'every:5m', 'every:1h', '0 9 * * *', '@daily', 'once:<ts>', 'at:<ts>', 'after:<dur>'
  task: string;
  skillSlugs?: string[];
  toolsetPreset?: string;
  /** Per-job toolset allowlist; see `CronJobDefinition.enabledToolsets`. */
  enabledToolsets?: string[];
  agentPreset?: string;
  model?: string;
  deliverTo?: DeliveryTarget;
  maxRuns?: number;
  /** @deprecated Prefer `inactivityTimeoutMs` and `maxRunDurationMs`. */
  timeoutMs?: number;
  inactivityTimeoutMs?: number;
  maxRunDurationMs?: number;
  graceWindowMs?: number;
}): CronJobDefinition {
  const now = new Date();

  let nextRunAt: string;
  const oneShotTs = parseOneShotSchedule(options.schedule, now);
  if (oneShotTs) {
    nextRunAt = oneShotTs;
  } else if (isCronSchedule(options.schedule)) {
    nextRunAt = computeNextCronRun(options.schedule, now);
  } else {
    nextRunAt = computeNextIntervalRun(now, parseIntervalMinutes(options.schedule));
  }

  return {
    id: options.id,
    schedule: options.schedule,
    task: options.task,
    enabled: true,
    nextRunAt,
    skillSlugs: options.skillSlugs,
    toolsetPreset: options.toolsetPreset,
    enabledToolsets: options.enabledToolsets,
    agentPreset: options.agentPreset,
    model: options.model,
    deliverTo: options.deliverTo,
    maxRuns: options.maxRuns,
    timeoutMs: options.timeoutMs,
    inactivityTimeoutMs: options.inactivityTimeoutMs,
    maxRunDurationMs: options.maxRunDurationMs,
    graceWindowMs: options.graceWindowMs,
    runCount: 0,
    totalRuns: 0,
    runs: [],
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// Due-job evaluation
// ---------------------------------------------------------------------------

/**
 * Check if a job is due. Returns 'due', 'not-due', or 'overdue' (past grace window).
 *
 * Grace window only applies when `graceWindowMs` is explicitly set on the job.
 * Jobs without a grace window configured are always 'due' once past their nextRunAt,
 * preserving backward compatibility.
 */
export function checkJobDueStatus(
  job: CronJobDefinition,
  now = new Date(),
): 'due' | 'not-due' | 'overdue' {
  if (!job.enabled || !job.nextRunAt) {
    return 'not-due';
  }
  const dueTime = new Date(job.nextRunAt).getTime();
  const nowMs = now.getTime();
  if (dueTime > nowMs) {
    return 'not-due';
  }
  // Grace window only enforced when explicitly configured
  if (job.graceWindowMs !== undefined && nowMs - dueTime > job.graceWindowMs) {
    return 'overdue';
  }
  return 'due';
}

export function isJobDue(job: CronJobDefinition, now = new Date()): boolean {
  return checkJobDueStatus(job, now) === 'due';
}

export async function collectDueJobs(
  store: SchedulerStore,
  now = new Date(),
  log?: (msg: string) => void,
): Promise<DueJob[]> {
  const jobs = await store.listJobs();
  const result: DueJob[] = [];
  for (const job of jobs) {
    const status = checkJobDueStatus(job, now);
    if (status === 'overdue') {
      log?.(`Job "${job.id}" skipped: overdue by more than grace window (${job.graceWindowMs}ms)`);
      result.push({ job, due: false });
    } else {
      result.push({ job, due: status === 'due' });
    }
  }
  return result;
}

export async function markJobRun(
  store: SchedulerStore,
  job: CronJobDefinition,
  now = new Date(),
): Promise<CronJobDefinition> {
  let nextRunAt: string | undefined;

  if (isOneShotSchedule(job.schedule)) {
    // One-shot jobs don't get a next run — they are completed after execution
    nextRunAt = undefined;
  } else if (isCronSchedule(job.schedule)) {
    nextRunAt = computeNextCronRun(job.schedule, now);
  } else {
    nextRunAt = computeNextIntervalRun(now, parseIntervalMinutes(job.schedule));
  }

  const next = { ...job, nextRunAt };
  await store.saveJob(next);
  return next;
}


// ---------------------------------------------------------------------------
// Scheduler executor
// ---------------------------------------------------------------------------

/**
 * #299 — Probe used by the executor to build the assembled prompt for a job
 * before dispatch. Hosts supply the same `[cronConfig, ...skills, ...memory]`
 * parts that the agent loop will eventually see, so the scan covers the
 * exact byte stream that reaches the model.
 *
 * Returning `null` skips the assembled-prompt scan entirely — useful for
 * hosts that haven't wired skill resolution yet (graceful degradation:
 * the cron config part still gets scanned by `scanForEnhancedInjection`
 * inside the agent loop on dispatch).
 */
export interface AssembledPromptProbe {
  (job: CronJobDefinition): Promise<PromptPart[] | null> | PromptPart[] | null;
}

/**
 * #299 — Audit event recorded when injection-scan policy blocks or warns
 * on a cron job. Distinct from the per-cron policy decision so hosts can
 * route blocks to the security audit log and the operator-notification
 * channel independently.
 */
export interface CronInjectionAuditEvent {
  type: 'cron:cron_injection_blocked' | 'cron:cron_injection_warning';
  severity: 'critical' | 'warning';
  jobId: string;
  detail: string;
  findings: Array<{
    type: string;
    description: string;
    severity: 'low' | 'medium' | 'high';
    partName: string;
    offsetInPart: number;
    offsetInAssembled: number;
  }>;
}

/**
 * #299 — Operator-notification sink. Invoked when an injection scan
 * blocks dispatch so the cron's configured channel can still surface the
 * abort to the owner (telemetry-only is not enough — operator has to know
 * the job did not run). Failure to deliver here MUST NOT propagate into a
 * job failure — the dispatch is already aborted.
 */
export interface InjectionOwnerNotifier {
  (event: CronInjectionAuditEvent, job: CronJobDefinition): Promise<void> | void;
}

export interface SchedulerExecutorOptions {
  /**
   * Optional probe that returns the most recent tool-activity timestamp for a
   * given session id. When provided, the executor uses inactivity-based
   * timeouts (`inactivityTimeoutMs`) instead of pure wall-clock timeouts.
   * Hosts read this from `SessionState.lastToolActivityAt`.
   */
  activityProbe?: SessionActivityProbe;
  /**
   * #299 — Injection scanner used to scan the assembled prompt. Hosts wire
   * this to `scanForEnhancedInjection` from @crowclaw/core. Required when
   * `assembledPromptProbe` is set; otherwise no scan runs.
   */
  injectionScanner?: SecurityScanner;
  /**
   * #299 — Resolves the assembled prompt parts for a job at dispatch time.
   * The scheduler scans the assembled buffer (not each part independently)
   * to catch threats that only manifest after concatenation.
   */
  assembledPromptProbe?: AssembledPromptProbe;
  /**
   * #299 — Default injection policy when a job omits `injectionPolicy`.
   * Defaults to `'block'`.
   */
  defaultInjectionPolicy?: InjectionPolicy;
  /**
   * #299 — Audit sink for injection events. Failures inside the sink are
   * swallowed; the scheduler still applies the policy regardless.
   */
  onInjectionEvent?: (event: CronInjectionAuditEvent) => void;
  /**
   * #299 — Owner-notification channel. Called when an injection blocks
   * dispatch so the operator hears about it even when they don't tail the
   * audit log. Best-effort; never escalates into a job failure.
   */
  notifyInjectionOwner?: InjectionOwnerNotifier;
  /**
   * #309 — Sandbox client used to run `no_agent` cron jobs. Hosts wire
   * this to a `LocalProcessExecutor`, `DockerExecutor`, or any other
   * `SandboxClient`. When unset, `mode: 'no_agent'` jobs fail with a
   * configuration error.
   */
  sandboxClient?: NoAgentSandboxClient;
  /**
   * #309 — Sink for `cron:no_agent_failed` events. Hosts wire this to the
   * security audit log. The runner emits the event when a no-agent
   * command exits non-zero or times out, regardless of whether the
   * delivery channel surfaces the failure.
   */
  onNoAgentFailure?: (event: NoAgentFailureEvent) => void;
  /**
   * Default inactivity timeout in ms applied when a job omits
   * `inactivityTimeoutMs`. Overridable per-job.
   */
  defaultInactivityTimeoutMs?: number;
  /**
   * Default hard cap on total run duration. Overridable per-job via
   * `maxRunDurationMs`.
   */
  defaultMaxRunDurationMs?: number;
  /**
   * Maximum number of due jobs the executor runs concurrently per `tick()`.
   * Defaults to `DEFAULT_MAX_CONCURRENT_JOBS` (5). Issue #101 — without a cap
   * a saturated tick can stampede the agent runtime; without concurrency
   * a single 2h job blocks every later one.
   */
  maxConcurrentJobs?: number;
}

export class SchedulerExecutor {
  private readonly options: SchedulerExecutorOptions;

  constructor(
    private readonly store: SchedulerStore,
    private readonly runAgent: AgentRunFn,
    private readonly deliver?: DeliveryFn,
    options: SchedulerExecutorOptions = {},
  ) {
    this.options = options;
  }

  /**
   * Execute all due jobs. Returns results for each executed job.
   *
   * Issue #101 — runs jobs concurrently up to `maxConcurrentJobs` (default 5).
   * Result order matches the order of due jobs returned by `collectDueJobs`,
   * not completion order, so callers can correlate by index.
   */
  async tick(now?: Date): Promise<SchedulerTickResult[]> {
    const dueJobs = await collectDueJobs(this.store, now);
    const runnable = dueJobs.filter((entry) => entry.due);
    if (runnable.length === 0) return [];

    const limit = createConcurrencyLimiter(
      this.options.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS,
    );

    const results = await Promise.all(
      runnable.map((entry) => limit(() => this.runOne(entry.job, now))),
    );

    return results;
  }

  /**
   * Execute a single due job and persist its post-run state. Extracted so
   * `tick()` can fan out across jobs while preserving the original
   * sequencing of work *within* one job (execute → recordRun → markJobRun).
   */
  private async runOne(
    job: CronJobDefinition,
    now: Date | undefined,
  ): Promise<SchedulerTickResult> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const result = await this.executeJob(job);
    const durationMs = Date.now() - startMs;

    // Record run history (store-level)
    const runRecord: JobRunRecord = {
      jobId: job.id,
      runId: result.sessionId,
      startedAt,
      completedAt: result.executedAt,
      ok: result.ok,
      response: result.response ?? '',
      error: result.error,
      durationMs,
    };
    await this.store.recordRun(runRecord);

    // Build run archival entry
    const jobRun: JobRun = {
      runId: result.sessionId,
      startedAt,
      completedAt: result.executedAt,
      success: result.ok,
      response: result.response,
      error: result.error,
    };

    // Keep last 10 runs
    const existingRuns = [...(job.runs ?? [])];
    existingRuns.push(jobRun);
    const archivedRuns = existingRuns.slice(-10);

    // Update job state
    const updated: CronJobDefinition = {
      ...job,
      lastRunAt: new Date().toISOString(),
      lastRunStatus: result.ok ? 'success' : 'error',
      lastRunError: result.error,
      lastRunResult: result.response?.slice(0, 500),
      runCount: (job.runCount ?? 0) + 1,
      runs: archivedRuns,
      totalRuns: (job.totalRuns ?? 0) + 1,
    };

    // Auto-disable if max runs reached
    if (job.maxRuns && updated.runCount! >= job.maxRuns) {
      updated.enabled = false;
    }

    // One-shot completion: disable after successful execution
    if (isOneShotSchedule(job.schedule) && result.ok) {
      updated.enabled = false;
      updated.completedAt = new Date().toISOString();
    }

    await markJobRun(this.store, updated, now);
    return result;
  }

  /** Pause a job by id. Returns the updated job or null if not found. */
  async pauseJob(id: string): Promise<CronJobDefinition | null> {
    return this.store.pauseJob(id);
  }

  /** Resume a paused job by id. Returns the updated job or null if not found. */
  async resumeJob(id: string): Promise<CronJobDefinition | null> {
    return this.store.resumeJob(id);
  }

  /** Delete a job permanently. Returns true if found and deleted. */
  async deleteJob(id: string): Promise<boolean> {
    return this.store.deleteJob(id);
  }

  /** Execute a job once without updating lastRunAt or runCount. */
  async dryRun(jobId: string): Promise<JobRunRecord> {
    const job = await this.store.getJob(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const result = await this.executeJob(job);
    const durationMs = Date.now() - startMs;

    return {
      jobId: job.id,
      runId: result.sessionId,
      startedAt,
      completedAt: result.executedAt,
      ok: result.ok,
      response: result.response ?? '',
      error: result.error,
      durationMs,
    };
  }

  private async executeJob(job: CronJobDefinition): Promise<SchedulerTickResult> {
    const sessionId = `sched-${job.id}-${Date.now()}`;

    // #309 — no-agent mode: skip the agent loop and the prompt-injection scan
    // (no LLM-bound prompt is assembled) and run the configured shell
    // command via the host's sandbox executor.
    if (job.mode === 'no_agent') {
      return this.executeNoAgentJob(job, sessionId);
    }

    // #299 — Assembled-prompt injection scan. Runs BEFORE the watchdog so
    // a blocked dispatch doesn't waste a session id or fire the activity
    // probe. The scan is best-effort: if `assembledPromptProbe` returns
    // null (host hasn't wired skill resolution) the agent loop still runs
    // its own scanner against the user message — we just lose multi-source
    // coverage. Errors inside the scanner / probe are caught and logged,
    // never propagated, so a buggy host can't bring down the cron tick.
    const injectionDecision = await this.runAssembledPromptScan(job);
    if (!injectionDecision.shouldDispatch) {
      return {
        jobId: job.id,
        sessionId,
        ok: false,
        error: injectionDecision.errorMessage ?? 'Cron dispatch blocked by injection policy',
        executedAt: new Date().toISOString(),
      };
    }

    const startMs = Date.now();
    // Resolve effective timeouts. Backward compatibility:
    //   - Legacy `timeoutMs` is honoured as the inactivity window when the
    //     newer `inactivityTimeoutMs` is omitted, since that's what existing
    //     callers semantically expected (hard timeout from start).
    //   - The hard cap (`maxRunDurationMs`) defaults to the larger 2h backstop
    //     unless explicitly overridden.
    const inactivityTimeoutMs =
      job.inactivityTimeoutMs ??
      job.timeoutMs ??
      this.options.defaultInactivityTimeoutMs ??
      DEFAULT_INACTIVITY_TIMEOUT_MS;
    const maxRunDurationMs =
      job.maxRunDurationMs ??
      this.options.defaultMaxRunDurationMs ??
      DEFAULT_MAX_RUN_DURATION_MS;
    // Preserve the legacy "Job timed out" error message when callers haven't
    // opted into the new activity-based timeout fields. This keeps existing
    // tests / log scrapers stable. New fields (`inactivityTimeoutMs`,
    // `maxRunDurationMs`) opt callers into the more descriptive messages.
    const usingLegacyTimeoutOnly =
      job.inactivityTimeoutMs === undefined &&
      job.maxRunDurationMs === undefined;
    // Track last activity locally; seed with start time so the first tick is
    // measured against the run start. The probe (when wired up by the host)
    // overrides this with `SessionState.lastToolActivityAt` from CORE.
    let lastActivityMs = startMs;

    let watchdog: SafeTimer | null = null;
    try {
      const agentPromise = this.runAgent({
        sessionId,
        userMessage: job.task,
        agentId: `scheduler-${job.id}`,
        skillSlugs: job.skillSlugs,
        agentPreset: job.agentPreset,
        toolsetPreset: job.toolsetPreset,
        enabledToolsets: job.enabledToolsets,
        model: job.model,
      });

      const watchdogPromise = new Promise<never>((_resolve, reject) => {
        // Tick at half the inactivity window (capped at 30s) so we surface a
        // stall within ~1.5x the configured timeout in the worst case.
        // `safeSetInterval` clamps user-supplied timeouts to TIMEOUT_MAX
        // (issue #76) — passing a 100-day inactivity window would otherwise
        // tight-loop at 1ms.
        const tickMs = Math.min(Math.max(inactivityTimeoutMs / 2, 1_000), 30_000);
        watchdog = safeSetInterval(tickMs, () => {
          void this.refreshLastActivity(sessionId, lastActivityMs).then((next) => {
            lastActivityMs = next;
            const now = Date.now();
            if (now - startMs > maxRunDurationMs) {
              reject(
                new Error(
                  usingLegacyTimeoutOnly
                    ? 'Job timed out'
                    : `Job exceeded max run duration (${maxRunDurationMs}ms)`,
                ),
              );
              // Issue #112 — stop the watchdog the moment we resolve the race.
              // Without this, the interval keeps firing (and querying the
              // activity probe) until the surrounding `finally` runs, which
              // can be one full tick later for long-running probes.
              clearSafeTimer(watchdog);
              watchdog = null;
              return;
            }
            if (now - lastActivityMs > inactivityTimeoutMs) {
              reject(
                new Error(
                  usingLegacyTimeoutOnly
                    ? 'Job timed out'
                    : `Job stalled: no tool activity for ${inactivityTimeoutMs}ms`,
                ),
              );
              clearSafeTimer(watchdog);
              watchdog = null;
            }
          });
        });
      });

      const agentResult = await Promise.race([agentPromise, watchdogPromise]);

      // Deliver if target configured
      let deliveryResult: { ok: boolean; error?: string } | undefined;
      if (job.deliverTo && this.deliver) {
        deliveryResult = await this.deliver(
          job.deliverTo,
          agentResult.finalResponse,
        );
      }

      return {
        jobId: job.id,
        sessionId,
        ok: true,
        response: agentResult.finalResponse,
        toolResults: agentResult.toolResults,
        delivery: deliveryResult,
        executedAt: new Date().toISOString(),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        jobId: job.id,
        sessionId,
        ok: false,
        error: msg,
        executedAt: new Date().toISOString(),
      };
    } finally {
      if (watchdog !== null) clearSafeTimer(watchdog);
    }
  }

  /**
   * Resolve the latest tool-activity timestamp for the in-flight session.
   * Falls back to the previous value when the probe is unset, returns null,
   * or throws — the watchdog must remain best-effort and never escalate
   * probe failures into job failures.
   */
  private async refreshLastActivity(
    sessionId: string,
    fallbackMs: number,
  ): Promise<number> {
    const probe = this.options.activityProbe;
    if (!probe) return fallbackMs;
    try {
      const ts = await probe(sessionId);
      if (!ts) return fallbackMs;
      const parsed = Date.parse(ts);
      return Number.isFinite(parsed) ? parsed : fallbackMs;
    } catch {
      return fallbackMs;
    }
  }

  /**
   * #299 — Run the assembled-prompt injection scan and apply the per-cron
   * policy. Returns whether dispatch should proceed and (when blocked) the
   * error message to surface. Audit events and owner notifications are
   * fired here as side effects so the call site stays small.
   *
   * Failure modes are all soft: a missing scanner / missing probe / probe
   * throw all degrade to "skip the scan and proceed", because hosts that
   * haven't wired skill resolution should not see cron jobs silently
   * break. The blocking path is reserved for actual injection findings.
   */
  private async runAssembledPromptScan(
    job: CronJobDefinition,
  ): Promise<{ shouldDispatch: boolean; errorMessage?: string }> {
    const policy: InjectionPolicy =
      job.injectionPolicy
      ?? this.options.defaultInjectionPolicy
      ?? 'block';
    if (policy === 'off') return { shouldDispatch: true };

    const scanner = this.options.injectionScanner;
    const probe = this.options.assembledPromptProbe;
    if (!scanner || !probe) {
      // Host hasn't wired the multi-source scan path. The agent loop still
      // runs `scanForEnhancedInjection` against the user message on
      // dispatch, so the cron config string itself is still covered.
      return { shouldDispatch: true };
    }

    let parts: PromptPart[] | null;
    try {
      parts = await probe(job);
    } catch {
      // Probe failure must not bring down the cron tick.
      return { shouldDispatch: true };
    }
    if (!parts || parts.length === 0) return { shouldDispatch: true };

    const findings = scanAssembledPrompt(parts, scanner);
    const decision = applyInjectionPolicy(findings, policy);

    if (decision.auditEvent) {
      const event: CronInjectionAuditEvent = {
        type: decision.auditEvent.type,
        severity: decision.auditEvent.severity,
        jobId: job.id,
        detail: decision.auditEvent.detail,
        findings: findings.map((f) => ({
          type: f.type,
          description: f.description,
          severity: f.severity,
          partName: f.partName,
          offsetInPart: f.offsetInPart,
          offsetInAssembled: f.offsetInAssembled,
        })),
      };
      try {
        this.options.onInjectionEvent?.(event);
      } catch {
        // Audit-sink errors never propagate into job state.
      }
      if (!decision.shouldDispatch && this.options.notifyInjectionOwner) {
        // Owner notification is best-effort — we already decided to abort
        // dispatch, the run will be marked as failed regardless of whether
        // the notification reaches the operator.
        try {
          await this.options.notifyInjectionOwner(event, job);
        } catch {
          // ignore
        }
      }
    }

    if (!decision.shouldDispatch) {
      return {
        shouldDispatch: false,
        errorMessage: `Cron dispatch blocked: prompt injection detected (${findings.length} finding${findings.length === 1 ? '' : 's'}). See audit log for details.`,
      };
    }
    return { shouldDispatch: true };
  }

  /**
   * #309 — Run a `mode: 'no_agent'` cron job. Skips the agent loop entirely
   * and runs the configured shell command through the host's sandbox client.
   * Empty stdout → silent (no delivery). Non-zero exit emits
   * `cron:no_agent_failed` and, when `noAgentFailurePolicy === 'notify'`,
   * delivers a one-line failure notice through the configured channel.
   */
  private async executeNoAgentJob(
    job: CronJobDefinition,
    sessionId: string,
  ): Promise<SchedulerTickResult> {
    if (!job.command || !job.command.trim()) {
      return {
        jobId: job.id,
        sessionId,
        ok: false,
        error: 'no_agent job missing command',
        executedAt: new Date().toISOString(),
      };
    }
    const client = this.options.sandboxClient;
    if (!client) {
      return {
        jobId: job.id,
        sessionId,
        ok: false,
        error: 'no_agent mode requires a sandboxClient on SchedulerExecutorOptions',
        executedAt: new Date().toISOString(),
      };
    }
    try {
      const runner = new NoAgentRunner(client);
      const onFailure: ((event: NoAgentFailureEvent) => void) | undefined =
        this.options.onNoAgentFailure;
      const result = await runner.run(job.command, {
        jobId: job.id,
        timeoutMs: job.commandTimeoutMs ?? DEFAULT_NO_AGENT_TIMEOUT_MS,
        failurePolicy: job.noAgentFailurePolicy ?? 'silent',
        ...(onFailure ? { onFailureEvent: onFailure } : {}),
      });

      let deliveryResult: { ok: boolean; error?: string } | undefined;
      if (result.shouldDeliver && result.deliveryContent && job.deliverTo && this.deliver) {
        deliveryResult = await this.deliver(job.deliverTo, result.deliveryContent);
      }

      return {
        jobId: job.id,
        sessionId,
        ok: result.ok,
        response: result.stdout,
        // Surface a synthetic tool-result row so audit / dashboard views
        // can show what the no-agent run did without inventing a new
        // shape. `toolName: 'no_agent'` is reserved for this purpose.
        toolResults: [
          {
            toolName: 'no_agent',
            ok: result.ok,
            output: result.stdout || (result.shouldDeliver ? '' : '(silent)'),
          },
        ],
        delivery: deliveryResult,
        error: result.ok ? undefined : `no_agent exit ${result.exitCode}${result.timedOut ? ' (timeout)' : ''}`,
        executedAt: new Date().toISOString(),
      };
    } catch (err: unknown) {
      return {
        jobId: job.id,
        sessionId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        executedAt: new Date().toISOString(),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Autonomous scheduler — interval-based ticking
// ---------------------------------------------------------------------------

export class AutonomousScheduler {
  private intervalTimer: SafeTimer | null = null;
  private readonly intervalMs: number;
  private _lastTick: string | null = null;
  private _lastError: string | null = null;
  private _consecutiveErrors = 0;

  constructor(
    private readonly executor: SchedulerExecutor,
    intervalMs?: number,
  ) {
    this.intervalMs = intervalMs ?? 60_000;
  }

  /**
   * Start interval-based ticking. No-op if already running.
   *
   * Issue #76 — uses `safeSetInterval` so a host that configures a
   * multi-month tick interval cannot trigger Node's `TIMEOUT_MAX`
   * tight-loop crash.
   */
  start(): void {
    if (this.intervalTimer !== null) return;
    this.intervalTimer = safeSetInterval(this.intervalMs, () => {
      void (async () => {
        try {
          await this.executor.tick();
          this._lastTick = new Date().toISOString();
          this._consecutiveErrors = 0;
          this._lastError = null;
        } catch (err: unknown) {
          this._consecutiveErrors += 1;
          this._lastError = err instanceof Error ? err.message : String(err);
        }
      })();
    });
  }

  /** Stop the interval. No-op if not running. */
  stop(): void {
    if (this.intervalTimer === null) return;
    clearSafeTimer(this.intervalTimer);
    this.intervalTimer = null;
  }

  /** Whether the autonomous scheduler is actively ticking. */
  isRunning(): boolean {
    return this.intervalTimer !== null;
  }

  /** Current interval in milliseconds. */
  get interval(): number {
    return this.intervalMs;
  }

  /** ISO timestamp of the last successful tick, or null if none. */
  get lastTick(): string | null {
    return this._lastTick;
  }

  /** Last tick error message, or null if the last tick succeeded. */
  get lastError(): string | null {
    return this._lastError;
  }

  /** Number of consecutive tick errors. Resets to 0 on success. */
  get consecutiveErrors(): number {
    return this._consecutiveErrors;
  }
}

// ---------------------------------------------------------------------------
// Persistent file-based scheduler store
// ---------------------------------------------------------------------------

interface FileStoreData {
  jobs: CronJobDefinition[];
  runHistory: Record<string, JobRunRecord[]>;
  lastSavedAt: string;
}

export class FileSchedulerStore implements SchedulerStore {
  private jobs: Map<string, CronJobDefinition> | null = null;
  private runHistoryMap: Map<string, JobRunRecord[]> | null = null;
  /**
   * Serialize persist() writes so concurrent mutators (saveJob + pauseJob + recordRun)
   * don't race on the full-file rewrite. Previously fire-and-forget `await this.persist()`
   * inside separate handlers could interleave `writeFile` calls and corrupt the file.
   */
  private persistQueue: Promise<void> = Promise.resolve();
  /**
   * Issue #111 — `mkdir(..., { recursive: true })` ran on every persist even
   * after the directory already existed. For a busy scheduler that's a syscall
   * per write; track success once and skip on subsequent persists.
   */
  private dirEnsured = false;

  constructor(private readonly filePath: string) {}

  async listJobs(): Promise<CronJobDefinition[]> {
    await this.ensureLoaded();
    return [...this.jobs!.values()];
  }

  async saveJob(job: CronJobDefinition): Promise<void> {
    await this.ensureLoaded();
    this.jobs!.set(job.id, job);
    await this.persist();
  }

  async getJob(id: string): Promise<CronJobDefinition | null> {
    await this.ensureLoaded();
    return this.jobs!.get(id) ?? null;
  }

  async deleteJob(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const deleted = this.jobs!.delete(id);
    if (deleted) {
      await this.persist();
    }
    return deleted;
  }

  async pauseJob(id: string): Promise<CronJobDefinition | null> {
    await this.ensureLoaded();
    const job = this.jobs!.get(id);
    if (!job) return null;
    const updated = { ...job, enabled: false };
    this.jobs!.set(id, updated);
    await this.persist();
    return updated;
  }

  async resumeJob(id: string): Promise<CronJobDefinition | null> {
    await this.ensureLoaded();
    const job = this.jobs!.get(id);
    if (!job) return null;
    const updated = { ...job, enabled: true };
    this.jobs!.set(id, updated);
    await this.persist();
    return updated;
  }

  async getRunHistory(jobId: string, limit?: number): Promise<JobRunRecord[]> {
    await this.ensureLoaded();
    const records = this.runHistoryMap!.get(jobId) ?? [];
    const sorted = [...records].reverse();
    return limit !== undefined ? sorted.slice(0, limit) : sorted;
  }

  async recordRun(record: JobRunRecord): Promise<void> {
    await this.ensureLoaded();
    const records = this.runHistoryMap!.get(record.jobId) ?? [];
    records.push(record);
    // Trim to prevent unbounded growth on long-running servers.
    if (records.length > RUN_HISTORY_CAP) {
      records.splice(0, records.length - RUN_HISTORY_CAP);
    }
    this.runHistoryMap!.set(record.jobId, records);
    await this.persist();
  }

  // -- Internal helpers --

  private async ensureLoaded(): Promise<void> {
    if (this.jobs !== null) return;
    this.jobs = new Map();
    this.runHistoryMap = new Map();

    // Best-effort: clean up orphaned `<file>.<pid>.<ts>.tmp` siblings that a
    // previous process crashed or was SIGKILLed before `rename()` could finish.
    // Failures here must not block startup — the store still works without it.
    await this.cleanupOrphanedTmpFiles();

    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const data: FileStoreData = JSON.parse(raw);
      for (const job of data.jobs) {
        this.jobs.set(job.id, job);
      }
      if (data.runHistory) {
        for (const [jobId, records] of Object.entries(data.runHistory)) {
          this.runHistoryMap.set(jobId, records);
        }
      }
    } catch (err: unknown) {
      // File not found is expected on first use
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw err;
    }
  }

  /**
   * Remove leftover `<filePath>.<pid>.<ts>.tmp` files from prior runs that
   * crashed between `writeFile` and `rename`. Swallows all errors — this is
   * housekeeping only and must not block scheduler startup.
   */
  private async cleanupOrphanedTmpFiles(): Promise<void> {
    try {
      const dir = dirname(this.filePath);
      const base = basename(this.filePath);
      const entries = await readdir(dir);
      const orphans = entries.filter(
        (name) => name.startsWith(`${base}.`) && name.endsWith('.tmp'),
      );
      await Promise.all(
        orphans.map((name) => unlink(join(dir, name)).catch(() => {})),
      );
    } catch {
      // Directory may not exist yet, or be unreadable; ignore.
    }
  }

  private async persist(): Promise<void> {
    // Snapshot at the moment the mutator called us; enqueue the write.
    // This matches the pattern added to `FileConfigStore` in v0.3.6 — without it,
    // two rapid `saveJob` calls could both fire-and-forget `writeFile`, leaving
    // the file truncated or corrupted.
    const history: Record<string, JobRunRecord[]> = {};
    for (const [jobId, records] of this.runHistoryMap!) {
      history[jobId] = records;
    }
    const data: FileStoreData = {
      jobs: [...this.jobs!.values()],
      runHistory: history,
      lastSavedAt: new Date().toISOString(),
    };
    const body = JSON.stringify(data, null, 2);
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    this.persistQueue = this.persistQueue.then(async () => {
      // Issue #111 — only mkdir on the first persist (or after a prior mkdir
      // failed). `mkdir(..., { recursive: true })` is idempotent but still a
      // syscall per write; on a busy scheduler we'd issue thousands per hour.
      if (!this.dirEnsured) {
        await mkdir(dirname(this.filePath), { recursive: true });
        this.dirEnsured = true;
      }
      await writeFile(tmpPath, body, 'utf-8');
      await rename(tmpPath, this.filePath);
    });
    return this.persistQueue;
  }
}

// ---------------------------------------------------------------------------
// Concurrency limiter (no external deps)
// ---------------------------------------------------------------------------

/**
 * Minimal `p-limit`-style concurrency gate. Used by `SchedulerExecutor.tick`
 * to bound how many due jobs run at once (issue #101). Kept inline so the
 * scheduler stays dependency-free across runtimes (Node + CF Workers).
 */
function createConcurrencyLimiter(
  max: number,
): <T>(fn: () => Promise<T>) => Promise<T> {
  const limit = Math.max(1, Math.floor(max));
  let active = 0;
  const queue: Array<() => void> = [];

  const next = (): void => {
    if (active >= limit) return;
    const run = queue.shift();
    if (run) run();
  };

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = (): void => {
        active += 1;
        Promise.resolve()
          .then(fn)
          .then(
            (value) => {
              active -= 1;
              resolve(value);
              next();
            },
            (err: unknown) => {
              active -= 1;
              reject(err);
              next();
            },
          );
      };
      if (active < limit) {
        start();
      } else {
        queue.push(start);
      }
    });
}
