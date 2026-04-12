import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export {
  type CronExpression,
  parseCron,
  cronMatches,
  nextCronOccurrence,
  prevCronOccurrence,
  formatCron,
  describeCron,
} from './cron-parser.js';

import {
  parseCron,
  nextCronOccurrence,
} from './cron-parser.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeliveryTarget {
  platform: string; // 'telegram' | 'discord' | 'slack' | 'email' | 'webhook'
  config: Record<string, string>; // platform-specific (token, chatId, webhookUrl, etc.)
}

export interface CronJobDefinition {
  id: string;
  schedule: string;
  task: string; // The prompt/message to send to the agent
  enabled: boolean;
  nextRunAt?: string;
  metadata?: Record<string, unknown>;
  // Agent execution fields
  skillSlugs?: string[];
  toolsetPreset?: string;
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
  timeoutMs?: number; // Per-run timeout (default: 60000)
}

export interface DueJob {
  job: CronJobDefinition;
  due: boolean;
}

export interface SchedulerStore {
  listJobs(): Promise<CronJobDefinition[]>;
  saveJob(job: CronJobDefinition): Promise<void>;
  getJob(id: string): Promise<CronJobDefinition | null>;
  deleteJob(id: string): Promise<boolean>;
  pauseJob(id: string): Promise<CronJobDefinition | null>;
  resumeJob(id: string): Promise<CronJobDefinition | null>;
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
}

// ---------------------------------------------------------------------------
// Schedule type detection
// ---------------------------------------------------------------------------

/** Returns true if the schedule is a cron expression or cron alias */
export function isCronSchedule(schedule: string): boolean {
  const trimmed = schedule.trim().toLowerCase();
  if (trimmed.startsWith('@')) return true;
  // 5-field cron: contains spaces and is not an interval format
  return !trimmed.startsWith('every:') && trimmed.includes(' ');
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
  schedule: string; // 'every:5m', 'every:1h', '0 9 * * *', '@daily'
  task: string;
  skillSlugs?: string[];
  toolsetPreset?: string;
  agentPreset?: string;
  model?: string;
  deliverTo?: DeliveryTarget;
  maxRuns?: number;
  timeoutMs?: number;
}): CronJobDefinition {
  const now = new Date();
  const nextRunAt = isCronSchedule(options.schedule)
    ? computeNextCronRun(options.schedule, now)
    : computeNextIntervalRun(now, parseIntervalMinutes(options.schedule));

  return {
    id: options.id,
    schedule: options.schedule,
    task: options.task,
    enabled: true,
    nextRunAt,
    skillSlugs: options.skillSlugs,
    toolsetPreset: options.toolsetPreset,
    agentPreset: options.agentPreset,
    model: options.model,
    deliverTo: options.deliverTo,
    maxRuns: options.maxRuns,
    timeoutMs: options.timeoutMs,
    runCount: 0,
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// Due-job evaluation
// ---------------------------------------------------------------------------

export function isJobDue(job: CronJobDefinition, now = new Date()): boolean {
  if (!job.enabled || !job.nextRunAt) {
    return false;
  }
  return new Date(job.nextRunAt).getTime() <= now.getTime();
}

export async function collectDueJobs(
  store: SchedulerStore,
  now = new Date(),
): Promise<DueJob[]> {
  const jobs = await store.listJobs();
  return jobs.map((job) => ({ job, due: isJobDue(job, now) }));
}

export async function markJobRun(
  store: SchedulerStore,
  job: CronJobDefinition,
  now = new Date(),
): Promise<CronJobDefinition> {
  const nextRunAt = isCronSchedule(job.schedule)
    ? computeNextCronRun(job.schedule, now)
    : computeNextIntervalRun(now, parseIntervalMinutes(job.schedule));

  const next = { ...job, nextRunAt };
  await store.saveJob(next);
  return next;
}

/** @deprecated Use markJobRun instead */
export const markIntervalJobRun = markJobRun;

// ---------------------------------------------------------------------------
// Scheduler executor
// ---------------------------------------------------------------------------

export class SchedulerExecutor {
  constructor(
    private readonly store: SchedulerStore,
    private readonly runAgent: AgentRunFn,
    private readonly deliver?: DeliveryFn,
  ) {}

  /** Execute all due jobs. Returns results for each executed job. */
  async tick(now?: Date): Promise<SchedulerTickResult[]> {
    const dueJobs = await collectDueJobs(this.store, now);
    const results: SchedulerTickResult[] = [];

    for (const { job, due } of dueJobs) {
      if (!due) continue;

      const result = await this.executeJob(job);
      results.push(result);

      // Update job state
      const updated: CronJobDefinition = {
        ...job,
        lastRunAt: new Date().toISOString(),
        lastRunStatus: result.ok ? 'success' : 'error',
        lastRunError: result.error,
        lastRunResult: result.response?.slice(0, 500),
        runCount: (job.runCount ?? 0) + 1,
      };

      // Auto-disable if max runs reached
      if (job.maxRuns && updated.runCount! >= job.maxRuns) {
        updated.enabled = false;
      }

      await markJobRun(this.store, updated, now);
    }

    return results;
  }

  private async executeJob(job: CronJobDefinition): Promise<SchedulerTickResult> {
    const sessionId = `sched-${job.id}-${Date.now()}`;
    const timeoutMs = job.timeoutMs ?? 60_000;

    try {
      const agentResult = await Promise.race([
        this.runAgent({
          sessionId,
          userMessage: job.task,
          agentId: `scheduler-${job.id}`,
          skillSlugs: job.skillSlugs,
          agentPreset: job.agentPreset,
          toolsetPreset: job.toolsetPreset,
          model: job.model,
        }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('Job timed out')), timeoutMs);
        }),
      ]);

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
    }
  }
}

// ---------------------------------------------------------------------------
// Persistent file-based scheduler store
// ---------------------------------------------------------------------------

interface FileStoreData {
  jobs: CronJobDefinition[];
  lastSavedAt: string;
}

export class FileSchedulerStore implements SchedulerStore {
  private jobs: Map<string, CronJobDefinition> | null = null;

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

  // -- Internal helpers --

  private async ensureLoaded(): Promise<void> {
    if (this.jobs !== null) return;
    this.jobs = new Map();

    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const data: FileStoreData = JSON.parse(raw);
      for (const job of data.jobs) {
        this.jobs.set(job.id, job);
      }
    } catch (err: unknown) {
      // File not found is expected on first use
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw err;
    }
  }

  private async persist(): Promise<void> {
    const data: FileStoreData = {
      jobs: [...this.jobs!.values()],
      lastSavedAt: new Date().toISOString(),
    };

    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}
