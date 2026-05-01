import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { buttonStyles, cardStyles, tagStyles, formStyles, sectionStyles } from '../lib/shared-styles.js';
import { api } from '../lib/api.js';
import { showToast } from '../components/toast.js';

/** Maps to CronJobDefinition from @crowclaw/scheduler */
interface SchedulerJob {
  id: string;
  schedule: string;
  task: string;
  enabled: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  lastRunStatus?: 'success' | 'error' | 'timeout';
  lastRunError?: string;
  lastRunResult?: string;
  runCount?: number;
  maxRuns?: number;
  model?: string;
  skillSlugs?: string[];
  deliverTo?: { platform: string; config: Record<string, string> };
}

/** Maps to JobRunRecord from @crowclaw/scheduler */
interface HistoryEntry {
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

/** Maps to skill object from GET /api/skills */
interface SkillInfo {
  slug: string;
  title: string;
  triggerPhrases?: string[];
}

const timeAgo = (d: string) => {
  if (!d) return '--';
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 0) return timeUntil(d); // future date
  return s < 60 ? s + 's ago' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago';
};

const timeUntil = (d: string) => {
  if (!d) return '--';
  const s = Math.floor((new Date(d).getTime() - Date.now()) / 1000);
  if (s <= 0) return 'now';
  return s < 60 ? `in ${s}s` : s < 3600 ? `in ${Math.floor(s / 60)}m` : s < 86400 ? `in ${Math.floor(s / 3600)}h` : `in ${Math.floor(s / 86400)}d`;
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
};

@customElement('crowclaw-automate-view')
export class AutomateView extends LitElement {
  static styles = [
    buttonStyles,
    cardStyles,
    tagStyles,
    formStyles,
    sectionStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
      }

      .view-header {
        padding: var(--sp-5) var(--sp-8) 0;
        flex-shrink: 0;
        background: linear-gradient(180deg, rgba(224, 85, 69, 0.02) 0%, transparent 100%);
      }

      .view-header h2 {
        font-size: var(--text-xl);
        font-weight: 600;
        letter-spacing: -0.01em;
        background: linear-gradient(90deg, var(--text-primary) 0%, var(--text-secondary) 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }

      .view-header p {
        font-size: var(--text-xs);
        color: var(--text-muted);
        font-weight: 500;
        margin-top: 1px;
      }

      .view-body {
        flex: 1;
        overflow-y: auto;
        padding: var(--sp-4) var(--sp-8) var(--sp-8);
      }

      /* Scheduler controls bar */
      .sched-bar {
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        margin-bottom: var(--sp-4);
      }

      .sched-status {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        font-size: var(--text-sm);
        color: var(--text-secondary);
        font-weight: 500;
      }

      .sched-led {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .sched-led.running {
        background: var(--success);
        box-shadow: 0 0 8px rgba(48, 209, 88, 0.4);
      }

      .sched-led.stopped {
        background: var(--text-muted);
      }

      .sched-bar-actions {
        margin-left: auto;
        display: flex;
        gap: var(--sp-2);
      }

      /* Job grid */
      .job-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
        gap: var(--sp-3);
        margin-bottom: var(--sp-4);
      }

      .job-card {
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        padding: var(--sp-4) var(--sp-5);
        transition: background-color var(--duration-normal) var(--ease-spring), border-color var(--duration-normal) var(--ease-spring);
        border-radius: var(--radius-md);
      }

      .job-card:hover {
        border-color: rgba(255, 255, 255, 0.14);
        background: var(--bg-card-hover);
      }

      .job-card-header {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        margin-bottom: var(--sp-3);
      }

      .job-name {
        font-size: var(--text-sm);
        font-weight: 600;
        color: var(--text-primary);
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .job-card-actions {
        display: flex;
        gap: var(--sp-1);
        flex-shrink: 0;
      }

      .icon-btn {
        background: none;
        border: 1px solid transparent;
        color: var(--text-muted);
        cursor: pointer;
        font-size: 13px;
        padding: 3px 6px;
        border-radius: var(--radius-sm);
        transition: color var(--duration-fast), background-color var(--duration-fast), border-color var(--duration-fast);
      }

      .icon-btn:hover {
        color: var(--text-primary);
        background: var(--glass-bg);
        border-color: var(--glass-border);
      }

      .icon-btn.danger:hover {
        color: var(--error);
        border-color: var(--error);
        background: rgba(255, 69, 58, 0.08);
      }

      .job-meta {
        display: flex;
        flex-direction: column;
        gap: var(--sp-2);
      }

      .job-meta-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: var(--text-xs);
      }

      .job-meta-label {
        color: var(--text-muted);
        font-weight: 500;
      }

      .job-meta-value {
        color: var(--text-primary);
        font-family: var(--font-mono);
      }

      /* New job form */
      .form-overlay {
        position: fixed;
        inset: 0;
        background: var(--bg-overlay);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100;
      }

      .form-panel {
        background: var(--bg-secondary);
        border: 1px solid var(--glass-border);
        padding: var(--sp-6);
        width: 520px;
        max-width: 90vw;
        max-height: 85vh;
        overflow-y: auto;
        border-radius: var(--radius-lg);
      }

      .form-title {
        font-size: var(--text-lg);
        font-weight: 600;
        color: var(--text-primary);
        margin-bottom: var(--sp-5);
      }

      .form-row {
        display: flex;
        gap: var(--sp-3);
      }

      .form-row > .form-group {
        flex: 1;
      }

      .form-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--sp-2);
        margin-top: var(--sp-5);
        padding-top: var(--sp-4);
        border-top: 1px solid var(--glass-border);
      }

      /* Radio group */
      .radio-group {
        display: flex;
        gap: var(--sp-4);
      }

      .radio-option {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        cursor: pointer;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }

      .radio-option input[type="radio"] {
        accent-color: var(--accent);
        cursor: pointer;
      }

      /* Checkbox group */
      .checkbox-group {
        display: flex;
        flex-wrap: wrap;
        gap: var(--sp-2);
      }

      .checkbox-option {
        display: flex;
        align-items: center;
        gap: var(--sp-1);
        padding: var(--sp-1) var(--sp-2);
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-sm);
        cursor: pointer;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        transition: border-color var(--duration-fast), color var(--duration-fast);
      }

      .checkbox-option:hover {
        border-color: rgba(255, 255, 255, 0.15);
        color: var(--text-primary);
      }

      .checkbox-option input[type="checkbox"] {
        accent-color: var(--accent);
        cursor: pointer;
      }

      .form-select {
        width: 100%;
        padding: var(--sp-2) var(--sp-3);
        border: 1px solid var(--glass-border);
        background: var(--bg-input);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: 'Inter', 'Noto Sans KR', var(--font-sans);
        outline: none;
        border-radius: var(--radius-sm);
        transition: border-color var(--duration-fast);
      }

      .form-select:focus {
        border-color: var(--accent);
      }

      /* History table */
      .history-table {
        width: 100%;
        border-collapse: collapse;
      }

      .history-table th {
        text-align: left;
        font-size: var(--text-xs);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: var(--text-muted);
        padding: var(--sp-2) var(--sp-3);
        border-bottom: 1px solid var(--glass-border);
      }

      .history-table td {
        font-size: var(--text-sm);
        color: var(--text-primary);
        padding: var(--sp-3);
        border-bottom: 1px solid var(--glass-border);
        vertical-align: top;
      }

      .history-row {
        transition: background var(--duration-fast);
        cursor: pointer;
      }

      .history-row:hover {
        background: var(--bg-card-hover);
      }

      .output-preview {
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        color: var(--text-secondary);
        max-width: 300px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .output-expanded {
        display: none;
        padding: var(--sp-3);
        background: rgba(0, 0, 0, 0.2);
        border: 1px solid var(--glass-border);
        border-top: none;
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        color: var(--text-secondary);
        white-space: pre-wrap;
        word-break: break-all;
        max-height: 250px;
        overflow-y: auto;
        line-height: 1.5;
      }

      .output-expanded.open {
        display: block;
      }

      /* Empty state */
      .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: var(--sp-12) 0;
        gap: var(--sp-2);
        opacity: 0.5;
      }

      .empty-title {
        font-size: var(--text-base);
        font-weight: 600;
        color: #c8cdd6;
      }

      .empty-subtitle {
        font-size: var(--text-xs);
        color: var(--text-muted);
      }

      /* Loading */
      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--sp-8);
        color: var(--text-muted);
        font-size: var(--text-sm);
      }

      /* Dormant scheduler warning banner */
      .dormant-banner {
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        padding: var(--sp-3) var(--sp-4);
        margin-bottom: var(--sp-3);
        background: rgba(255, 204, 0, 0.08);
        border: 1px solid rgba(255, 204, 0, 0.35);
        border-radius: var(--radius-md);
      }

      .dormant-banner-text {
        flex: 1;
        font-size: var(--text-sm);
        color: var(--text-primary);
        font-weight: 500;
      }

      /* Inline form badges (e.g., gateway "token configured") */
      .badge {
        display: inline-flex;
        align-items: center;
        gap: var(--sp-1);
        font-size: var(--text-xs);
        font-weight: 500;
        padding: 2px 6px;
        border-radius: var(--radius-sm);
        margin-top: var(--sp-1);
      }

      .badge.ok {
        background: rgba(48, 209, 88, 0.12);
        border: 1px solid rgba(48, 209, 88, 0.35);
        color: var(--success);
      }
    `,
  ];

  @state() private jobs: SchedulerJob[] = [];
  @state() private skills: SkillInfo[] = [];
  @state() private schedulerRunning = false;
  @state() private showForm = false;
  @state() private loading = true;
  /** Per-job history keyed by job id, fetched on expand */
  @state() private jobHistory = new Map<string, HistoryEntry[]>();
  @state() private expandedJobIds = new Set<string>();
  @state() private loadingHistoryFor = new Set<string>();

  // Form state
  @state() private formName = '';
  @state() private formPrompt = '';
  @state() private formScheduleType: 'interval' | 'cron' = 'interval';
  @state() private formScheduleValue = '';
  @state() private formModel = '';
  @state() private formSkills: string[] = [];
  @state() private formDeliveryPlatform = '';
  @state() private formDeliveryChannel = '';
  @state() private formSubmitting = false;

  /**
   * Per-platform gateway token configuration, fetched once per form open.
   * Keys: 'telegram' | 'slack' | 'discord' (others ignored).
   * Discord uses webhook URL not a token, so it's always considered "configured" here.
   */
  @state() private gatewayStatus: Record<string, boolean> = {};
  @state() private gatewayStatusLoaded = false;

  private _refreshInterval?: ReturnType<typeof setInterval>;

  connectedCallback() {
    super.connectedCallback();
    this._fetchAll();
    // Auto-refresh every 30 seconds
    this._refreshInterval = setInterval(() => {
      this._fetchJobs();
      this._fetchSchedulerStatus();
    }, 30_000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = undefined;
    }
  }

  private async _fetchAll() {
    this.loading = true;
    await Promise.all([
      this._fetchJobs(),
      this._fetchSchedulerStatus(),
      this._fetchSkills(),
    ]);
    this.loading = false;
  }

  /** GET /api/scheduler/jobs returns CronJobDefinition[] (bare array) */
  private async _fetchJobs() {
    try {
      const data = await api<SchedulerJob[]>('/api/scheduler/jobs');
      this.jobs = Array.isArray(data) ? data : [];
    } catch {
      this.jobs = [];
    }
  }

  /** GET /api/scheduler/status returns { running, interval, lastTick } */
  private async _fetchSchedulerStatus() {
    try {
      const data = await api<{ running: boolean }>('/api/scheduler/status');
      this.schedulerRunning = data.running ?? false;
    } catch {
      this.schedulerRunning = false;
    }
  }

  /** GET /api/scheduler/jobs/{id}/history returns JobRunRecord[] (bare array) */
  private async _fetchJobHistory(jobId: string) {
    if (this.loadingHistoryFor.has(jobId)) return;
    this.loadingHistoryFor = new Set([...this.loadingHistoryFor, jobId]);
    try {
      const data = await api<HistoryEntry[]>(`/api/scheduler/jobs/${encodeURIComponent(jobId)}/history?limit=20`);
      const next = new Map(this.jobHistory);
      next.set(jobId, Array.isArray(data) ? data : []);
      this.jobHistory = next;
    } catch {
      const next = new Map(this.jobHistory);
      next.set(jobId, []);
      this.jobHistory = next;
    } finally {
      const updated = new Set(this.loadingHistoryFor);
      updated.delete(jobId);
      this.loadingHistoryFor = updated;
    }
  }

  /** GET /api/skills returns { skills: [{ slug, title, ... }] } */
  private async _fetchSkills() {
    try {
      const data = await api<{ skills: SkillInfo[] }>('/api/skills');
      this.skills = data.skills || [];
    } catch {
      this.skills = [];
    }
  }

  private async _toggleScheduler() {
    try {
      const endpoint = this.schedulerRunning ? '/api/scheduler/stop' : '/api/scheduler/start';
      await api(endpoint, { method: 'POST' });
      this.schedulerRunning = !this.schedulerRunning;
    } catch (error: unknown) {
      if (error instanceof Error) {
        showToast('Failed to toggle scheduler', 'error');
      }
    }
  }

  private async _tickNow() {
    try {
      await api('/api/scheduler/tick', { method: 'POST' });
      // Refresh jobs after tick to update lastRunAt / lastRunStatus
      setTimeout(() => this._fetchJobs(), 1000);
    } catch (error: unknown) {
      if (error instanceof Error) {
        showToast('Failed to tick scheduler', 'error');
      }
    }
  }

  private async _toggleJob(job: SchedulerJob) {
    try {
      const action = job.enabled ? 'pause' : 'resume';
      const updated = await api<SchedulerJob>(
        `/api/scheduler/jobs/${encodeURIComponent(job.id)}/${action}`,
        { method: 'POST' },
      );
      this.jobs = this.jobs.map((j) => (j.id === job.id ? updated : j));
    } catch (error: unknown) {
      if (error instanceof Error) {
        showToast('Failed to toggle job', 'error');
      }
    }
  }

  private async _deleteJob(job: SchedulerJob) {
    if (!confirm(`Delete job "${job.id}"? This cannot be undone.`)) return;
    try {
      await api(`/api/scheduler/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
      this.jobs = this.jobs.filter((j) => j.id !== job.id);
      showToast(`Job "${job.id}" deleted`, 'success');
    } catch (error: unknown) {
      if (error instanceof Error) {
        showToast('Failed to delete job', 'error');
      }
    }
  }

  private async _dryRunJob(job: SchedulerJob) {
    showToast(`Running dry-run for "${job.id}"...`, 'info');
    try {
      const result = await api<{ ok: boolean; response?: string; error?: string }>(
        `/api/scheduler/jobs/${encodeURIComponent(job.id)}/dry-run`,
        { method: 'POST' },
      );
      if (result.ok) {
        showToast(`Dry-run completed: ${(result.response ?? '').slice(0, 100)}`, 'success');
      } else {
        showToast(`Dry-run failed: ${result.error ?? 'unknown'}`, 'error');
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        showToast('Dry-run failed', 'error');
      }
    }
  }

  private _openForm() {
    this.showForm = true;
    this.formName = '';
    this.formPrompt = '';
    this.formScheduleType = 'interval';
    this.formScheduleValue = '';
    this.formModel = '';
    this.formSkills = [];
    this.formDeliveryPlatform = '';
    this.formDeliveryChannel = '';
    // Fetch gateway status once for the form's lifetime so we can disable
    // unconfigured platform options and show "configured" badges.
    this.gatewayStatusLoaded = false;
    void this._fetchGatewayStatus();
  }

  /**
   * GET /api/gateway/status — returns per-platform token configuration.
   * We accept a few shapes defensively: a flat record of booleans, or an object
   * with a `platforms` map. Discord uses a webhook URL (not a token), so it's
   * treated as always-configured at the option level.
   */
  private async _fetchGatewayStatus() {
    try {
      const data = await api<Record<string, unknown>>('/api/gateway/status');
      const next: Record<string, boolean> = {};
      const source: Record<string, unknown> =
        data && typeof data === 'object' && 'platforms' in data && data.platforms && typeof data.platforms === 'object'
          ? (data.platforms as Record<string, unknown>)
          : (data ?? {});
      for (const platform of ['telegram', 'slack', 'discord']) {
        const v = source[platform];
        if (typeof v === 'boolean') {
          next[platform] = v;
        } else if (v && typeof v === 'object') {
          const obj = v as Record<string, unknown>;
          next[platform] = Boolean(obj.configured ?? obj.hasToken ?? obj.ok);
        } else {
          next[platform] = false;
        }
      }
      // Discord delivery is webhook-URL-based, not token-gated server-side here.
      // Keep behavior as-is: never disable the Discord option for missing token.
      next.discord = true;
      this.gatewayStatus = next;
    } catch {
      // On failure, don't disable any options — fall back to all-enabled so
      // the user isn't blocked by a transient gateway-status fetch error.
      this.gatewayStatus = { telegram: true, slack: true, discord: true };
    } finally {
      this.gatewayStatusLoaded = true;
    }
  }

  /** Start the scheduler from the dormant-jobs banner (POST /api/scheduler/start). */
  private async _startSchedulerFromBanner() {
    try {
      await api('/api/scheduler/start', { method: 'POST' });
      this.schedulerRunning = true;
      showToast('Scheduler started.', 'success');
    } catch (error: unknown) {
      if (error instanceof Error) {
        showToast('Failed to start scheduler', 'error');
      }
    }
  }

  private _closeForm() {
    this.showForm = false;
  }

  private _toggleFormSkill(slug: string) {
    if (this.formSkills.includes(slug)) {
      this.formSkills = this.formSkills.filter((s) => s !== slug);
    } else {
      this.formSkills = [...this.formSkills, slug];
    }
  }

  private async _submitJob() {
    if (!this.formName.trim() || !this.formPrompt.trim() || !this.formScheduleValue.trim()) return;
    this.formSubmitting = true;
    try {
      // Build schedule string: backend supports cron expressions or "every:Nm" interval syntax
      const scheduleValue = this.formScheduleValue.trim();
      const schedule = this.formScheduleType === 'interval'
        ? `every:${scheduleValue}`
        : scheduleValue;

      const body: Record<string, unknown> = {
        id: this.formName.trim(),
        task: this.formPrompt.trim(),
        schedule,
        model: this.formModel || undefined,
        skillSlugs: this.formSkills.length > 0 ? this.formSkills : undefined,
      };

      if (this.formDeliveryPlatform) {
        body.deliverTo = {
          platform: this.formDeliveryPlatform,
          config: this.formDeliveryChannel ? { channel: this.formDeliveryChannel } : {},
        };
      }

      const response = await api<{ wasStarted?: boolean }>('/api/scheduler/jobs', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      this.showForm = false;
      if (response?.wasStarted === true) {
        showToast('Scheduler started — your job will fire on schedule.', 'success');
        // Reflect new running state immediately; refresh status to confirm.
        this.schedulerRunning = true;
        void this._fetchSchedulerStatus();
      } else {
        showToast('Job created.', 'success');
      }
      await this._fetchJobs();
    } catch (error: unknown) {
      if (error instanceof Error) {
        showToast('Failed to create job', 'error');
      }
    } finally {
      this.formSubmitting = false;
    }
  }

  private _toggleJobExpand(jobId: string) {
    const next = new Set(this.expandedJobIds);
    if (next.has(jobId)) {
      next.delete(jobId);
    } else {
      next.add(jobId);
      // Fetch history on first expand
      if (!this.jobHistory.has(jobId)) {
        void this._fetchJobHistory(jobId);
      }
    }
    this.expandedJobIds = next;
  }

  render() {
    return html`
      <div class="view-header">
        <h2>Automate</h2>
        <p>Scheduled jobs and automation</p>
      </div>
      <div class="view-body">
        ${this.loading
          ? html`<div class="loading">Loading scheduler data...</div>`
          : html`
              ${this._renderSchedulerSection()}
            `}
      </div>
      ${this.showForm ? this._renderForm() : nothing}
    `;
  }

  private _renderSchedulerSection() {
    const showDormantBanner = !this.schedulerRunning && this.jobs.length > 0;
    return html`
      <div class="section-block">
        <div class="section-header">Scheduler</div>

        ${showDormantBanner ? html`
          <div class="dormant-banner" role="status">
            <span class="dormant-banner-text">
              Scheduler is stopped — ${this.jobs.length} ${this.jobs.length === 1 ? 'job is' : 'jobs are'} dormant.
            </span>
            <button class="btn btn-p" aria-label="Start scheduler" @click=${this._startSchedulerFromBanner}>
              Start scheduler
            </button>
          </div>
        ` : nothing}

        <div class="sched-bar">
          <div class="sched-status">
            <div class="sched-led ${this.schedulerRunning ? 'running' : 'stopped'}"></div>
            <span>${this.schedulerRunning ? 'Running' : 'Stopped'}</span>
          </div>
          <div class="sched-bar-actions">
            <button class="btn" aria-label="${this.schedulerRunning ? 'Stop scheduler' : 'Start scheduler'}" @click=${this._toggleScheduler}>
              ${this.schedulerRunning ? 'Stop' : 'Start'}
            </button>
            <button class="btn" aria-label="Run scheduler tick now" @click=${this._tickNow} ?disabled=${!this.schedulerRunning}>
              Tick Now
            </button>
            <button class="btn btn-p" aria-label="Create new job" @click=${this._openForm}>
              New Job
            </button>
          </div>
        </div>

        ${this.jobs.length === 0
          ? html`
              <crowclaw-empty
                icon="jobs"
                title="No automated jobs"
                description="Schedule a recurring task and your agent will run it on cron or interval — no chat needed."
                cta-label="Create a recurring task"
                cta-event="cc-empty-new-job"
                @cc-empty-new-job=${this._openForm}
              ></crowclaw-empty>
            `
          : html`
              <div class="job-grid">
                ${this.jobs.map((job) => this._renderJobCard(job))}
              </div>
            `}
      </div>
    `;
  }

  private _renderJobCard(job: SchedulerJob) {
    const expanded = this.expandedJobIds.has(job.id);
    const history = this.jobHistory.get(job.id) ?? [];
    const loadingHistory = this.loadingHistoryFor.has(job.id);
    return html`
      <div class="job-card">
        <div class="job-card-header">
          <span class="job-name" title=${job.id}>${job.id}</span>
          <span class="tag ${job.enabled ? 'ok' : 'wn'}">
            ${job.enabled ? 'active' : 'paused'}
          </span>
          <div class="job-card-actions">
            <button
              class="icon-btn"
              @click=${() => this._dryRunJob(job)}
              title="Dry Run"
              aria-label="Test run job without side effects"
            >&#x25B7;</button>
            <button
              class="icon-btn"
              @click=${() => this._toggleJobExpand(job.id)}
              title="History"
              aria-label="Show run history"
            >&#x1F4CB;</button>
            <button
              class="icon-btn"
              @click=${() => this._toggleJob(job)}
              title="${job.enabled ? 'Pause' : 'Resume'}"
              aria-label="${job.enabled ? 'Pause job' : 'Resume job'}"
            >${job.enabled ? '&#x23F8;' : '&#x25B6;'}</button>
            <button
              class="icon-btn danger"
              @click=${() => this._deleteJob(job)}
              title="Delete"
              aria-label="Delete job"
            >&#x2715;</button>
          </div>
        </div>
        <div class="job-meta">
          <div class="job-meta-row">
            <span class="job-meta-label">Schedule</span>
            <span class="job-meta-value">${job.schedule}</span>
          </div>
          <div class="job-meta-row">
            <span class="job-meta-label">Last Run</span>
            <span class="job-meta-value">${job.lastRunAt ? timeAgo(job.lastRunAt) : '--'}</span>
          </div>
          <div class="job-meta-row">
            <span class="job-meta-label">Next Run</span>
            <span class="job-meta-value">${job.nextRunAt ? timeAgo(job.nextRunAt) : '--'}</span>
          </div>
          ${job.lastRunStatus ? html`
            <div class="job-meta-row">
              <span class="job-meta-label">Status</span>
              <span class="tag ${job.lastRunStatus === 'success' ? 'ok' : 'er'}">${job.lastRunStatus}</span>
            </div>
          ` : nothing}
        </div>
        ${expanded ? html`
          <div style="margin-top:var(--sp-3);border-top:1px solid var(--glass-border);padding-top:var(--sp-3)">
            ${loadingHistory
              ? html`<div class="loading" style="padding:var(--sp-2)">Loading history...</div>`
              : history.length === 0
                ? html`<div style="font-size:var(--text-xs);color:var(--text-muted)">No run history</div>`
                : html`
                    <table class="history-table">
                      <thead>
                        <tr>
                          <th>Started</th>
                          <th>Duration</th>
                          <th>Status</th>
                          <th>Output</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${history.map((entry) => html`
                          <tr class="history-row">
                            <td>${timeAgo(entry.startedAt)}</td>
                            <td style="font-family:var(--font-mono);font-size:var(--text-xs)">${formatDuration(entry.durationMs)}</td>
                            <td>
                              <span class="tag ${entry.ok ? 'ok' : 'er'}">${entry.ok ? 'success' : 'error'}</span>
                            </td>
                            <td>
                              <div class="output-preview" title=${entry.response || entry.error || '--'}>${(entry.response || entry.error || '--').slice(0, 80)}</div>
                            </td>
                          </tr>
                        `)}
                      </tbody>
                    </table>
                  `}
          </div>
        ` : nothing}
      </div>
    `;
  }

  /**
   * Renders the Delivery Platform / Channel row in the new-job form.
   *
   * Issue #215: Removed the dead `webhook` option (backend rejects it).
   * Issue #216: For telegram/slack, disable the option when the gateway has no
   * token configured server-side, and show a green "token configured" badge
   * next to the channel input when the selected platform is configured.
   * Discord uses webhook URL not a token — its option is never disabled.
   */
  private _renderDeliveryRow() {
    type Platform = 'slack' | 'discord' | 'telegram';
    const platforms: { value: Platform; label: string }[] = [
      { value: 'slack', label: 'Slack' },
      { value: 'discord', label: 'Discord' },
      { value: 'telegram', label: 'Telegram' },
    ];
    const isConfigured = (p: Platform) =>
      // Before status loads, treat as available so the form isn't gated on the fetch.
      // Discord is always treated as configured (webhook-URL based).
      !this.gatewayStatusLoaded || p === 'discord' || this.gatewayStatus[p] === true;
    const selectedConfigured =
      (this.formDeliveryPlatform === 'slack' || this.formDeliveryPlatform === 'telegram') &&
      this.gatewayStatusLoaded &&
      this.gatewayStatus[this.formDeliveryPlatform] === true;
    return html`
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Delivery Platform</label>
          <select
            class="form-select"
            .value=${this.formDeliveryPlatform}
            @change=${(e: Event) => { this.formDeliveryPlatform = (e.target as HTMLSelectElement).value; }}
          >
            <option value="">None</option>
            ${platforms.map((p) => {
              const ok = isConfigured(p.value);
              return html`
                <option value=${p.value} ?disabled=${!ok}>
                  ${ok ? p.label : `${p.label} (set up in Connect → Platforms)`}
                </option>
              `;
            })}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Channel / Target</label>
          <input
            class="form-input"
            type="text"
            placeholder="#channel or @user"
            .value=${this.formDeliveryChannel}
            @input=${(e: InputEvent) => { this.formDeliveryChannel = (e.target as HTMLInputElement).value; }}
          >
          ${selectedConfigured ? html`<span class="badge ok">token configured</span>` : nothing}
        </div>
      </div>
    `;
  }

  private _renderForm() {
    return html`
      <div class="form-overlay" @click=${(e: Event) => { if (e.target === e.currentTarget) this._closeForm(); }}>
        <div class="form-panel">
          <div class="form-title">New Scheduled Job</div>

          <div class="form-group">
            <label class="form-label">Job Name</label>
            <input
              class="form-input"
              type="text"
              placeholder="e.g., Daily news digest"
              .value=${this.formName}
              @input=${(e: InputEvent) => { this.formName = (e.target as HTMLInputElement).value; }}
            >
          </div>

          <div class="form-group">
            <label class="form-label">Task / Prompt</label>
            <textarea
              class="form-input"
              placeholder="Describe what this job should do..."
              .value=${this.formPrompt}
              @input=${(e: InputEvent) => { this.formPrompt = (e.target as HTMLTextAreaElement).value; }}
            ></textarea>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Schedule Type</label>
              <div class="radio-group">
                <label class="radio-option">
                  <input
                    type="radio"
                    name="scheduleType"
                    value="interval"
                    .checked=${this.formScheduleType === 'interval'}
                    @change=${() => { this.formScheduleType = 'interval'; }}
                  >
                  Interval
                </label>
                <label class="radio-option">
                  <input
                    type="radio"
                    name="scheduleType"
                    value="cron"
                    .checked=${this.formScheduleType === 'cron'}
                    @change=${() => { this.formScheduleType = 'cron'; }}
                  >
                  Cron
                </label>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">Schedule Value</label>
              <input
                class="form-input"
                type="text"
                placeholder=${this.formScheduleType === 'interval' ? 'e.g., 30m, 1h, 6h' : 'e.g., 0 9 * * *'}
                .value=${this.formScheduleValue}
                @input=${(e: InputEvent) => { this.formScheduleValue = (e.target as HTMLInputElement).value; }}
              >
              <div class="form-hint">
                ${this.formScheduleType === 'interval'
                  ? 'Interval between runs (e.g., 30m, 1h, 6h)'
                  : 'Cron expression (e.g., 0 9 * * * for daily at 9am)'}
              </div>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Model Override</label>
            <select
              class="form-select"
              .value=${this.formModel}
              @change=${(e: Event) => { this.formModel = (e.target as HTMLSelectElement).value; }}
            >
              <option value="">Default</option>
              <option value="gpt-4o">gpt-4o</option>
              <option value="gpt-4o-mini">gpt-4o-mini</option>
              <option value="claude-sonnet-4-20250514">claude-sonnet-4</option>
              <option value="claude-opus-4-20250514">claude-opus-4</option>
              <option value="claude-3-5-haiku-20241022">claude-3.5-haiku</option>
            </select>
          </div>

          ${this.skills.length > 0 ? html`
            <div class="form-group">
              <label class="form-label">Skills</label>
              <div class="checkbox-group">
                ${this.skills.map((skill) => html`
                  <label class="checkbox-option">
                    <input
                      type="checkbox"
                      .checked=${this.formSkills.includes(skill.slug)}
                      @change=${() => this._toggleFormSkill(skill.slug)}
                    >
                    ${skill.title || skill.slug}
                  </label>
                `)}
              </div>
            </div>
          ` : nothing}

          ${this._renderDeliveryRow()}

          <div class="form-actions">
            <button class="btn" aria-label="Cancel job creation" @click=${this._closeForm}>Cancel</button>
            <button
              class="btn btn-p"
              aria-label="Create scheduled job"
              @click=${this._submitJob}
              ?disabled=${this.formSubmitting || !this.formName.trim() || !this.formPrompt.trim() || !this.formScheduleValue.trim()}
            >${this.formSubmitting ? 'Creating...' : 'Create Job'}</button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-automate-view': AutomateView;
  }
}
