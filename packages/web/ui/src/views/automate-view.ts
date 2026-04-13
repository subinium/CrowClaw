import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { buttonStyles, cardStyles, tagStyles, formStyles, sectionStyles } from '../lib/shared-styles.js';
import { api } from '../lib/api.js';

interface SchedulerJob {
  id: string;
  name: string;
  schedule: string;
  scheduleType: 'interval' | 'cron';
  status: 'active' | 'paused';
  lastRun?: string;
  nextRun?: string;
  prompt?: string;
  model?: string;
  skills?: string[];
  deliveryPlatform?: string;
  deliveryChannel?: string;
}

interface HistoryEntry {
  id: string;
  jobId: string;
  jobName: string;
  startTime: string;
  duration: number;
  status: 'success' | 'error';
  output: string;
}

interface SkillInfo {
  name: string;
  id?: string;
}

const timeAgo = (d: string) => {
  if (!d) return '--';
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  return s < 60 ? s + 's ago' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago';
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
        transition: all var(--duration-normal) var(--ease-spring);
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
        transition: all var(--duration-fast);
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
        transition: all var(--duration-fast);
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
    `,
  ];

  @state() private jobs: SchedulerJob[] = [];
  @state() private history: HistoryEntry[] = [];
  @state() private skills: SkillInfo[] = [];
  @state() private schedulerRunning = false;
  @state() private showForm = false;
  @state() private loading = true;
  @state() private expandedHistoryIds = new Set<string>();

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

  connectedCallback() {
    super.connectedCallback();
    this._fetchAll();
  }

  private async _fetchAll() {
    this.loading = true;
    await Promise.all([
      this._fetchJobs(),
      this._fetchHistory(),
      this._fetchSkills(),
    ]);
    this.loading = false;
  }

  private async _fetchJobs() {
    try {
      const data = await api<{ jobs: SchedulerJob[]; running?: boolean }>('/api/scheduler/jobs');
      this.jobs = data.jobs || [];
      if (data.running !== undefined) {
        this.schedulerRunning = data.running;
      }
    } catch {
      this.jobs = [];
    }
  }

  private async _fetchHistory() {
    try {
      const data = await api<{ history: HistoryEntry[] }>('/api/scheduler/history');
      this.history = data.history || [];
    } catch {
      this.history = [];
    }
  }

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
        console.error('Failed to toggle scheduler:', error.message);
      }
    }
  }

  private async _tickNow() {
    try {
      await api('/api/scheduler/tick', { method: 'POST' });
      // Refresh history after tick
      setTimeout(() => this._fetchHistory(), 1000);
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Failed to tick scheduler:', error.message);
      }
    }
  }

  private async _toggleJob(job: SchedulerJob) {
    try {
      await api(`/api/scheduler/jobs/${job.id}/toggle`, { method: 'POST' });
      this.jobs = this.jobs.map((j) =>
        j.id === job.id
          ? { ...j, status: j.status === 'active' ? 'paused' as const : 'active' as const }
          : j,
      );
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Failed to toggle job:', error.message);
      }
    }
  }

  private async _deleteJob(job: SchedulerJob) {
    try {
      await api(`/api/scheduler/jobs/${job.id}`, { method: 'DELETE' });
      this.jobs = this.jobs.filter((j) => j.id !== job.id);
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Failed to delete job:', error.message);
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
  }

  private _closeForm() {
    this.showForm = false;
  }

  private _toggleFormSkill(skillName: string) {
    if (this.formSkills.includes(skillName)) {
      this.formSkills = this.formSkills.filter((s) => s !== skillName);
    } else {
      this.formSkills = [...this.formSkills, skillName];
    }
  }

  private async _submitJob() {
    if (!this.formName.trim() || !this.formPrompt.trim() || !this.formScheduleValue.trim()) return;
    this.formSubmitting = true;
    try {
      const body = {
        name: this.formName.trim(),
        prompt: this.formPrompt.trim(),
        scheduleType: this.formScheduleType,
        schedule: this.formScheduleValue.trim(),
        model: this.formModel || undefined,
        skills: this.formSkills.length > 0 ? this.formSkills : undefined,
        deliveryPlatform: this.formDeliveryPlatform || undefined,
        deliveryChannel: this.formDeliveryChannel || undefined,
      };
      await api('/api/scheduler/jobs', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      this.showForm = false;
      await this._fetchJobs();
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Failed to create job:', error.message);
      }
    } finally {
      this.formSubmitting = false;
    }
  }

  private _toggleHistoryExpand(id: string) {
    const next = new Set(this.expandedHistoryIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.expandedHistoryIds = next;
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
              ${this._renderHistorySection()}
            `}
      </div>
      ${this.showForm ? this._renderForm() : nothing}
    `;
  }

  private _renderSchedulerSection() {
    return html`
      <div class="section-block">
        <div class="section-header">Scheduler</div>

        <div class="sched-bar">
          <div class="sched-status">
            <div class="sched-led ${this.schedulerRunning ? 'running' : 'stopped'}"></div>
            <span>${this.schedulerRunning ? 'Running' : 'Stopped'}</span>
          </div>
          <div class="sched-bar-actions">
            <button class="btn" @click=${this._toggleScheduler}>
              ${this.schedulerRunning ? 'Stop' : 'Start'}
            </button>
            <button class="btn" @click=${this._tickNow} ?disabled=${!this.schedulerRunning}>
              Tick Now
            </button>
            <button class="btn btn-p" @click=${this._openForm}>
              New Job
            </button>
          </div>
        </div>

        ${this.jobs.length === 0
          ? html`
              <div class="empty">
                <div class="empty-title">No Jobs</div>
                <div class="empty-subtitle">Create a scheduled job to get started</div>
              </div>
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
    return html`
      <div class="job-card">
        <div class="job-card-header">
          <span class="job-name">${job.name}</span>
          <span class="tag ${job.status === 'active' ? 'ok' : 'wn'}">
            ${job.status}
          </span>
          <div class="job-card-actions">
            <button
              class="icon-btn"
              @click=${() => this._toggleJob(job)}
              title="${job.status === 'active' ? 'Pause' : 'Resume'}"
            >${job.status === 'active' ? '&#x23F8;' : '&#x25B6;'}</button>
            <button
              class="icon-btn danger"
              @click=${() => this._deleteJob(job)}
              title="Delete"
            >&#x2715;</button>
          </div>
        </div>
        <div class="job-meta">
          <div class="job-meta-row">
            <span class="job-meta-label">Schedule</span>
            <span class="job-meta-value">
              <span class="tag">${job.scheduleType}</span>
              ${job.schedule}
            </span>
          </div>
          <div class="job-meta-row">
            <span class="job-meta-label">Last Run</span>
            <span class="job-meta-value">${job.lastRun ? timeAgo(job.lastRun) : '--'}</span>
          </div>
          <div class="job-meta-row">
            <span class="job-meta-label">Next Run</span>
            <span class="job-meta-value">${job.nextRun ? timeAgo(job.nextRun) : '--'}</span>
          </div>
        </div>
      </div>
    `;
  }

  private _renderHistorySection() {
    return html`
      <div class="section-block">
        <div class="section-header">Job History</div>

        ${this.history.length === 0
          ? html`
              <div class="empty">
                <div class="empty-title">No History</div>
                <div class="empty-subtitle">Job execution logs will appear here</div>
              </div>
            `
          : html`
              <table class="history-table">
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Started</th>
                    <th>Duration</th>
                    <th>Status</th>
                    <th>Output</th>
                  </tr>
                </thead>
                <tbody>
                  ${this.history.map((entry) => this._renderHistoryRow(entry))}
                </tbody>
              </table>
            `}
      </div>
    `;
  }

  private _renderHistoryRow(entry: HistoryEntry) {
    const expanded = this.expandedHistoryIds.has(entry.id);
    return html`
      <tr class="history-row" @click=${() => this._toggleHistoryExpand(entry.id)}>
        <td>${entry.jobName}</td>
        <td>${timeAgo(entry.startTime)}</td>
        <td style="font-family:var(--font-mono);font-size:var(--text-xs)">${formatDuration(entry.duration)}</td>
        <td>
          <span class="tag ${entry.status === 'success' ? 'ok' : 'er'}">${entry.status}</span>
        </td>
        <td>
          <div class="output-preview">${entry.output?.slice(0, 80) || '--'}</div>
        </td>
      </tr>
      <tr>
        <td colspan="5" style="padding:0;border:none">
          <div class="output-expanded ${expanded ? 'open' : ''}">${entry.output || 'No output'}</div>
        </td>
      </tr>
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
                      .checked=${this.formSkills.includes(skill.name)}
                      @change=${() => this._toggleFormSkill(skill.name)}
                    >
                    ${skill.name}
                  </label>
                `)}
              </div>
            </div>
          ` : nothing}

          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Delivery Platform</label>
              <select
                class="form-select"
                .value=${this.formDeliveryPlatform}
                @change=${(e: Event) => { this.formDeliveryPlatform = (e.target as HTMLSelectElement).value; }}
              >
                <option value="">None</option>
                <option value="slack">Slack</option>
                <option value="discord">Discord</option>
                <option value="telegram">Telegram</option>
                <option value="webhook">Webhook</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Channel / Target</label>
              <input
                class="form-input"
                type="text"
                placeholder=${this.formDeliveryPlatform === 'webhook' ? 'https://...' : '#channel or @user'}
                .value=${this.formDeliveryChannel}
                @input=${(e: InputEvent) => { this.formDeliveryChannel = (e.target as HTMLInputElement).value; }}
              >
            </div>
          </div>

          <div class="form-actions">
            <button class="btn" @click=${this._closeForm}>Cancel</button>
            <button
              class="btn btn-p"
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
