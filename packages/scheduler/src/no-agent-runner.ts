// ---------------------------------------------------------------------------
// #309 — no_agent cron mode: script-only watchdog jobs
//
// Hermes v0.13 (#19709) added a cron mode where the job just runs a shell
// command and delivers stdout verbatim (or stays silent if empty). No agent
// loop, no LLM call, no cost. Use-cases: certificate-expiry watchdog,
// disk-space alert, simple log-tail summaries.
//
// Delivery semantics (matches the Hermes contract):
//   * Empty stdout (after trim)        → silent (no message sent).
//   * Non-zero exit code                → emit `cron:no_agent_failed`; deliver
//                                         configured failure notice or stay
//                                         silent depending on policy.
//   * Stderr                            → captured to audit log only.
//   * Resource limits (timeout)         → enforced via `SandboxClient`
//                                         primitives — same path the agent
//                                         loop uses for terminal calls.
//
// The runner is intentionally agnostic to *which* sandbox executor is wired
// up (LocalProcessExecutor, DockerExecutor, CloudflareSandbox). It accepts a
// `NoAgentSandboxClient` interface — the duck type implemented by every
// `SandboxClient` in `@crowclaw/sandbox-executor`. The scheduler package
// stays free of the sandbox-executor dep so it can keep loading on the CF
// Worker side where local-spawn is unavailable.
// ---------------------------------------------------------------------------

/**
 * Minimal sandbox-executor surface the no-agent runner needs. Implemented by
 * every executor in `@crowclaw/sandbox-executor` (LocalProcessExecutor,
 * DockerExecutor, SingularityExecutor, CloudflareSandbox bridge). Kept here
 * as a duck-type so the scheduler doesn't import the sandbox-executor
 * package (CF Worker builds can't always load it).
 */
export interface NoAgentSandboxClient {
  executeCommand(
    command: string,
    cwd?: string,
    options?: { timeoutMs?: number },
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut?: boolean;
  }>;
}

/**
 * Outcome of a `NoAgentRunner.run()` call. Mirrors the existing
 * `SchedulerTickResult` shape on the relevant fields so the executor can
 * surface no-agent results through the same delivery / audit code paths
 * without a separate envelope.
 */
export interface NoAgentRunResult {
  /** True when exit code was zero. */
  ok: boolean;
  /** Trimmed stdout. Empty string means "silent — do not deliver". */
  stdout: string;
  /** Raw stderr captured for audit-only. NOT delivered to channels. */
  stderr: string;
  /** Exit code reported by the sandbox executor. */
  exitCode: number;
  /** True when the run hit the configured timeout. */
  timedOut: boolean;
  /** Whether the runner thinks the result should actually be delivered. */
  shouldDeliver: boolean;
  /** Message to deliver. Distinct from `stdout` because failure-notice
   *  delivery may differ from the raw command output. */
  deliveryContent?: string;
}

export interface NoAgentRunnerOptions {
  /** Per-job timeout. Defaults to 60_000ms. Capped at the executor default
   *  if the underlying sandbox enforces its own ceiling. */
  timeoutMs?: number;
  /** Working directory passed to the executor. Optional. */
  cwd?: string;
  /**
   * Policy for non-zero exits:
   *  - `'silent'` (default) — record the failure event but deliver nothing
   *  - `'notify'`           — deliver a one-line failure notice that names
   *                           the cron job id, exit code, and stderr summary
   */
  failurePolicy?: 'silent' | 'notify';
  /** Cron job id, used in the failure-notice message. */
  jobId: string;
  /**
   * Optional sink for the `cron:no_agent_failed` audit event. Called when
   * the command exits non-zero or times out. The runner itself does not
   * touch the security audit log to keep this package dep-free.
   */
  onFailureEvent?: (event: NoAgentFailureEvent) => void;
}

export interface NoAgentFailureEvent {
  type: 'cron:no_agent_failed';
  jobId: string;
  exitCode: number;
  timedOut: boolean;
  /** Truncated stderr (first 2 KB). */
  stderrSummary: string;
  /** Truncated stdout (first 2 KB). Useful when stderr is empty but stdout
   *  reveals the failure mode. */
  stdoutSummary: string;
}

const STDERR_SUMMARY_BYTES = 2 * 1024;
const STDOUT_SUMMARY_BYTES = 2 * 1024;

/**
 * Default per-job timeout when neither `CronJobDefinition.commandTimeoutMs`
 * nor `NoAgentRunnerOptions.timeoutMs` is set. One minute matches the
 * Hermes default; tested against `dd if=/dev/zero` style runaway scripts.
 */
export const DEFAULT_NO_AGENT_TIMEOUT_MS = 60_000;

/**
 * Run a shell command through the sandbox executor and shape the result for
 * the cron delivery pipeline. The runner is stateless — call `run()` per
 * job firing.
 *
 * Note: this is *not* a sandbox replacement. The caller is expected to wire
 * `client` to an executor whose policy already constrains what commands may
 * run (e.g. `LocalProcessExecutor` already strips secret env vars). This
 * runner adds:
 *   1. Empty-stdout → silent semantics
 *   2. Stderr-to-audit-only routing
 *   3. Failure-event emission with truncated summaries
 *   4. Per-job timeout enforcement (delegated to the executor)
 */
export class NoAgentRunner {
  constructor(private readonly client: NoAgentSandboxClient) {}

  async run(command: string, options: NoAgentRunnerOptions): Promise<NoAgentRunResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_NO_AGENT_TIMEOUT_MS;
    const failurePolicy = options.failurePolicy ?? 'silent';

    const raw = await this.client.executeCommand(command, options.cwd, { timeoutMs });
    const stdoutTrimmed = raw.stdout.replace(/\s+$/u, '');
    const ok = raw.exitCode === 0 && !raw.timedOut;
    const timedOut = raw.timedOut === true;

    // Non-zero exit (including timeouts) — emit the failure event always,
    // regardless of delivery policy, so the audit log captures every miss.
    if (!ok) {
      const failureEvent: NoAgentFailureEvent = {
        type: 'cron:no_agent_failed',
        jobId: options.jobId,
        exitCode: raw.exitCode,
        timedOut,
        stderrSummary: truncate(raw.stderr, STDERR_SUMMARY_BYTES),
        stdoutSummary: truncate(raw.stdout, STDOUT_SUMMARY_BYTES),
      };
      options.onFailureEvent?.(failureEvent);

      if (failurePolicy === 'silent') {
        return {
          ok: false,
          stdout: stdoutTrimmed,
          stderr: raw.stderr,
          exitCode: raw.exitCode,
          timedOut,
          shouldDeliver: false,
        };
      }
      // notify: deliver a one-line summary so the operator sees the failure
      // in the configured delivery channel without paying for an LLM round-trip.
      const reason = timedOut
        ? `timed out after ${timeoutMs}ms`
        : `exit code ${raw.exitCode}`;
      const stderrTail = truncate(raw.stderr, 200).trim();
      const deliveryContent = stderrTail
        ? `[cron ${options.jobId}] ${reason}: ${stderrTail}`
        : `[cron ${options.jobId}] ${reason}`;
      return {
        ok: false,
        stdout: stdoutTrimmed,
        stderr: raw.stderr,
        exitCode: raw.exitCode,
        timedOut,
        shouldDeliver: true,
        deliveryContent,
      };
    }

    // Success path. Empty trimmed stdout → silent.
    if (stdoutTrimmed.length === 0) {
      return {
        ok: true,
        stdout: '',
        stderr: raw.stderr,
        exitCode: 0,
        timedOut: false,
        shouldDeliver: false,
      };
    }

    return {
      ok: true,
      stdout: stdoutTrimmed,
      stderr: raw.stderr,
      exitCode: 0,
      timedOut: false,
      shouldDeliver: true,
      deliveryContent: stdoutTrimmed,
    };
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated: ${text.length - max} more bytes]`;
}
