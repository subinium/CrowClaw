import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { cardStyles, tagStyles, formStyles, sectionStyles } from '../lib/shared-styles.js';
import { api } from '../lib/api.js';
import { showToast } from '../components/toast.js';
// v0.8.1 #244 #246 — primitive component library: register custom elements
// so the templates below can use the tags directly.
import '../components/button.js';
import '../components/status-dot.js';
import '../components/icon.js';
import '../components/empty.js';
import '../components/skeleton.js';

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

/**
 * Pending skill draft surfaced from GET /api/learning/drafts/pending.
 * Source distinguishes auto-capture / agent-proposed / explicit drafts so the
 * Drafts tab can label each row with its origin.
 */
interface PendingDraft {
  id: string;
  slug: string;
  title: string;
  summary?: string;
  triggerPhrases?: string[];
  recurrenceCount?: number;
  source?: 'auto-capture' | 'agent-proposed' | 'explicit';
  /** v0.8.4 (#185) — derived four-state status. Older runtimes omit it. */
  stage?: LearningStage;
  ratings?: { helpful?: number; unhelpful?: number };
  createdAt?: string;
  updatedAt?: string;
}

/**
 * v0.8.4 (#185) — four-state learning loop:
 *   captured → reviewed → published
 *                    ↘ rejected
 * The backend derives the stage from existing draft fields; the UI only
 * needs to render colored pills + loop counts.
 */
type LearningStage = 'captured' | 'reviewed' | 'published' | 'rejected';

const LEARNING_STAGES: readonly LearningStage[] = ['captured', 'reviewed', 'published', 'rejected'];

/** Maps to GET /api/learning/dashboard response. */
interface LearningDashboardResponse {
  drafts: Array<{
    id: string;
    slug?: string;
    title: string;
    summary?: string;
    status: 'draft' | 'published';
    stage: LearningStage;
    recurrenceCount?: number;
    ratings?: { helpful: number; unhelpful: number };
    createdAt: string;
    updatedAt: string;
  }>;
  skillMetrics: Array<{
    slug: string;
    stage: LearningStage;
    totalRatings: number;
    successRate: number | null;
    lastActivityAt: string;
    activations: number;
  }>;
  metrics: {
    totalDrafts: number;
    pendingDrafts: number;
    publishedDrafts: number;
    helpfulRatings?: number;
    unhelpfulRatings?: number;
    stageCounts?: Record<LearningStage, number>;
  };
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
        background: var(--surface-1);
        border: 1px solid var(--border);
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
        border: 1px solid var(--border);
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
        border-top: 1px solid var(--border);
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
        background: var(--surface-1);
        border: 1px solid var(--border);
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
        border: 1px solid var(--border);
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
        border-bottom: 1px solid var(--border);
      }

      .history-table td {
        font-size: var(--text-sm);
        color: var(--text-primary);
        padding: var(--sp-3);
        border-bottom: 1px solid var(--border);
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
        border: 1px solid var(--border);
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

      /* Loading skeleton stack — used in the initial loading state */
      .skeleton-stack {
        display: flex;
        flex-direction: column;
        gap: var(--sp-3);
        padding: var(--sp-4) 0;
      }

      .drafts-section {
        margin-top: var(--sp-6);
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

      /* Right-aligned action row inside a card (used by draft cards) */
      .actions-end {
        display: flex;
        gap: var(--sp-2);
        margin-top: var(--sp-3);
        justify-content: flex-end;
      }

      .history-frame {
        margin-top: var(--sp-3);
        border-top: 1px solid var(--border);
        padding-top: var(--sp-3);
      }

      .history-empty {
        font-size: var(--text-xs);
        color: var(--text-muted);
        padding: var(--sp-2) 0;
      }

      .meta-summary,
      .meta-trigger {
        font-family: var(--font-sans);
        font-size: var(--text-xs);
        text-align: right;
        max-width: 65%;
        line-height: 1.4;
      }

      .meta-trigger {
        max-width: 60%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .summary-row {
        align-items: flex-start;
      }

      .history-cell-duration {
        font-family: var(--font-mono);
        font-size: var(--text-xs);
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

      /* v0.8.4 (#185) — Learning loop dashboard styles. */

      .stage-pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 1px 8px;
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.4px;
        text-transform: uppercase;
        border-radius: var(--radius-sm);
        border: 1px solid transparent;
        font-family: var(--font-mono);
      }

      .stage-pill.captured {
        color: var(--text-secondary);
        background: var(--surface-1);
        border-color: var(--border);
      }

      .stage-pill.reviewed {
        color: var(--accent);
        background: var(--accent-soft);
        border-color: rgba(91, 141, 239, 0.35);
      }

      .stage-pill.published {
        color: var(--success);
        background: rgba(48, 209, 88, 0.1);
        border-color: rgba(48, 209, 88, 0.35);
      }

      .stage-pill.rejected {
        color: var(--error);
        background: rgba(255, 69, 58, 0.1);
        border-color: rgba(255, 69, 58, 0.35);
      }

      /* Loop diagram — four nodes laid out horizontally with arrows. */
      .loop-diagram-wrap {
        margin-top: var(--sp-3);
        margin-bottom: var(--sp-4);
        padding: var(--sp-4) var(--sp-5);
        background: var(--surface-1);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }

      .loop-diagram-title {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: var(--text-muted);
        margin-bottom: var(--sp-3);
        font-weight: 600;
      }

      .loop-diagram {
        width: 100%;
        max-width: 760px;
        height: 130px;
        display: block;
      }

      .loop-node text.label {
        font-family: var(--font-mono);
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        fill: var(--text-primary);
        text-anchor: middle;
        dominant-baseline: middle;
      }

      .loop-node text.count {
        font-family: var(--font-mono);
        font-size: 16px;
        font-weight: 700;
        text-anchor: middle;
        dominant-baseline: middle;
      }

      .loop-node rect {
        stroke-width: 1.5;
        rx: 6;
        ry: 6;
      }

      .loop-node.captured rect { fill: var(--surface-2, rgba(255,255,255,0.04)); stroke: var(--border, rgba(255,255,255,0.12)); }
      .loop-node.captured text.count { fill: var(--text-secondary); }
      .loop-node.reviewed rect { fill: rgba(91, 141, 239, 0.1); stroke: rgba(91, 141, 239, 0.35); }
      .loop-node.reviewed text.count { fill: var(--accent); }
      .loop-node.published rect { fill: rgba(48, 209, 88, 0.1); stroke: rgba(48, 209, 88, 0.4); }
      .loop-node.published text.count { fill: var(--success); }
      .loop-node.rejected rect { fill: rgba(255, 69, 58, 0.1); stroke: rgba(255, 69, 58, 0.4); }
      .loop-node.rejected text.count { fill: var(--error); }

      .loop-arrow {
        stroke: var(--text-muted);
        stroke-width: 1.4;
        fill: none;
        marker-end: url(#cc-loop-arrowhead);
      }

      .loop-arrow.reject {
        stroke: var(--error);
        stroke-dasharray: 4 3;
        opacity: 0.7;
      }

      .loop-empty-hint {
        margin-top: var(--sp-2);
        font-size: var(--text-xs);
        color: var(--text-muted);
      }

      /* Per-skill metrics table */
      .metrics-table {
        width: 100%;
        border-collapse: collapse;
        margin-top: var(--sp-3);
      }

      .metrics-table th {
        text-align: left;
        font-size: var(--text-xs);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: var(--text-muted);
        padding: var(--sp-2) var(--sp-3);
        border-bottom: 1px solid var(--border);
      }

      .metrics-table td {
        font-size: var(--text-sm);
        color: var(--text-primary);
        padding: var(--sp-2) var(--sp-3);
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }

      .metrics-table td.numeric {
        font-family: var(--font-mono);
        text-align: right;
      }

      .metrics-table .slug {
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }

      .metrics-empty {
        font-size: var(--text-xs);
        color: var(--text-muted);
        padding: var(--sp-3) 0;
      }

      .stage-counts-row {
        display: flex;
        gap: var(--sp-2);
        flex-wrap: wrap;
        margin-top: var(--sp-2);
      }

      .stage-count-chip {
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        padding: 4px var(--sp-2);
        border-radius: var(--radius-sm);
        background: var(--surface-1);
        border: 1px solid var(--border);
        color: var(--text-secondary);
      }

      .stage-count-chip strong {
        color: var(--text-primary);
        font-weight: 700;
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

  // v0.8.0 (#238) — Drafts tab state
  @state() private pendingDrafts: PendingDraft[] = [];
  @state() private draftsLoading = false;
  @state() private draftActionInFlight: Set<string> = new Set();

  // v0.8.4 (#185) — Learning loop dashboard state
  @state() private learningDashboard: LearningDashboardResponse | null = null;
  @state() private learningDashboardLoading = false;

  private _refreshInterval?: ReturnType<typeof setInterval>;
  private _draftsRefreshInterval?: ReturnType<typeof setInterval>;
  private _learningEventHandler?: (e: Event) => void;

  connectedCallback() {
    super.connectedCallback();
    this._fetchAll();
    // Auto-refresh every 30 seconds
    this._refreshInterval = setInterval(() => {
      this._fetchJobs();
      this._fetchSchedulerStatus();
    }, 30_000);

    // v0.8.0 (#238) — Drafts tab: poll the pending drafts every 10s so the
    // tab stays current even on transports where SSE doesn't reach this view.
    // v0.8.4 (#185) — also pull /api/learning/dashboard alongside it so the
    // loop diagram + per-skill metrics panel stay in sync.
    void this._fetchPendingDrafts();
    void this._fetchLearningDashboard();
    this._draftsRefreshInterval = setInterval(() => {
      void this._fetchPendingDrafts();
      void this._fetchLearningDashboard();
    }, 10_000);

    // Live updates: bridge `crowclaw-event` (window-scoped) for learning:*
    // events emitted by the runtime EventBus. The runtime-node app.ts already
    // dispatches the `learning:*` family alongside session/gateway/job events
    // via the same SSE/WS transport.
    this._learningEventHandler = (e: Event) => {
      const detail = (e as CustomEvent<{ type?: string }>).detail;
      if (detail && typeof detail.type === 'string' && detail.type.startsWith('learning:')) {
        void this._fetchPendingDrafts();
        // v0.8.4 (#185) — keep the loop diagram in sync with promote/reject events.
        void this._fetchLearningDashboard();
      }
    };
    window.addEventListener('crowclaw-event', this._learningEventHandler);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = undefined;
    }
    if (this._draftsRefreshInterval) {
      clearInterval(this._draftsRefreshInterval);
      this._draftsRefreshInterval = undefined;
    }
    if (this._learningEventHandler) {
      window.removeEventListener('crowclaw-event', this._learningEventHandler);
      this._learningEventHandler = undefined;
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

  /**
   * v0.8.0 (#238) — GET /api/learning/drafts/pending returns
   * `{ drafts: PendingDraft[] }`. Tolerates both shapes (bare array or wrapped
   * object) so the UI doesn't break if the contract evolves.
   */
  private async _fetchPendingDrafts() {
    this.draftsLoading = true;
    try {
      const data = await api<{ drafts?: PendingDraft[] } | PendingDraft[]>('/api/learning/drafts/pending');
      this.pendingDrafts = Array.isArray(data) ? data : (data?.drafts ?? []);
    } catch {
      this.pendingDrafts = [];
    } finally {
      this.draftsLoading = false;
    }
  }

  /**
   * v0.8.4 (#185) — GET /api/learning/dashboard. Returns the four-state
   * stage counts, per-skill metrics, and richer draft metadata. Failures
   * fall back to a `null` dashboard so the existing pending-drafts list
   * still renders without a loop diagram.
   */
  private async _fetchLearningDashboard() {
    this.learningDashboardLoading = true;
    try {
      this.learningDashboard = await api<LearningDashboardResponse>('/api/learning/dashboard');
    } catch {
      this.learningDashboard = null;
    } finally {
      this.learningDashboardLoading = false;
    }
  }

  private async _promoteDraft(draft: PendingDraft) {
    if (this.draftActionInFlight.has(draft.id)) return;
    this.draftActionInFlight = new Set([...this.draftActionInFlight, draft.id]);
    try {
      await api(`/api/learning/drafts/${encodeURIComponent(draft.id)}/promote`, { method: 'POST' });
      showToast(`Skill '${draft.slug || draft.title}' promoted.`, 'success');
      await this._fetchPendingDrafts();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'unknown';
      showToast(`Failed to promote draft: ${msg}`, 'error');
    } finally {
      const updated = new Set(this.draftActionInFlight);
      updated.delete(draft.id);
      this.draftActionInFlight = updated;
    }
  }

  private async _rejectDraft(draft: PendingDraft) {
    if (this.draftActionInFlight.has(draft.id)) return;
    if (!confirm(`Reject draft '${draft.title || draft.slug}'? It will be removed from the pending list.`)) return;
    this.draftActionInFlight = new Set([...this.draftActionInFlight, draft.id]);
    try {
      await api(`/api/learning/drafts/${encodeURIComponent(draft.id)}/reject`, { method: 'POST' });
      showToast(`Draft rejected.`, 'success');
      await this._fetchPendingDrafts();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'unknown';
      showToast(`Failed to reject draft: ${msg}`, 'error');
    } finally {
      const updated = new Set(this.draftActionInFlight);
      updated.delete(draft.id);
      this.draftActionInFlight = updated;
    }
  }

  private _editDraft(draft: PendingDraft) {
    // Edit flows through Connect/Skills tab today; surface a helpful pointer
    // rather than implement a duplicate editor here.
    showToast(`Open the Skills tab to edit '${draft.title || draft.slug}'.`, 'info');
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
          ? html`
              <div class="skeleton-stack" role="status" aria-live="polite" aria-busy="true">
                <crowclaw-skeleton-card lines="3"></crowclaw-skeleton-card>
                <crowclaw-skeleton-card lines="4"></crowclaw-skeleton-card>
                <crowclaw-skeleton-list rows="3"></crowclaw-skeleton-list>
              </div>
            `
          : html`
              ${this._renderSchedulerSection()}
              ${this._renderDraftsSection()}
            `}
      </div>
      ${this.showForm ? this._renderForm() : nothing}
    `;
  }

  /**
   * v0.8.0 (#238) — Skill Drafts section. Renders pending drafts surfaced by
   * the auto-capture + agent-proposed flows, with Promote / Edit / Reject
   * actions per row.
   * v0.8.4 (#185) — Now also renders the learning loop diagram + per-skill
   * metrics panel above the drafts list, so operators can see the full
   * captured → reviewed → published / rejected flow in one place.
   */
  private _renderDraftsSection() {
    const drafts = this.pendingDrafts;
    return html`
      <div class="section-block drafts-section">
        <div class="section-header">Learning Loop</div>
        ${this._renderLoopDiagram()}
        ${this._renderSkillMetricsPanel()}
      </div>
      <div class="section-block drafts-section">
        <div class="section-header">Skill Drafts</div>
        ${this.draftsLoading && drafts.length === 0
          ? html`<crowclaw-skeleton-list rows="3" aria-label="Loading drafts"></crowclaw-skeleton-list>`
          : drafts.length === 0
            ? html`
                <crowclaw-empty
                  icon="skills"
                  title="No pending drafts"
                  description="Drafts appear here when the agent proposes a new skill or auto-capture finds a recurring pattern."
                ></crowclaw-empty>
              `
            : html`
                <div class="job-grid">
                  ${drafts.map((draft) => this._renderDraftCard(draft))}
                </div>
              `}
      </div>
    `;
  }

  /**
   * v0.8.4 (#185) — Loop diagram. Static SVG, dynamically populated with
   * per-stage counts. Layout: four nodes laid out left-to-right with
   * arrows showing the canonical flow plus a dashed reject edge from
   * `reviewed → rejected`.
   */
  private _renderLoopDiagram() {
    const counts: Record<LearningStage, number> =
      this.learningDashboard?.metrics.stageCounts ?? this._fallbackStageCounts();
    const total = LEARNING_STAGES.reduce((sum, s) => sum + (counts[s] ?? 0), 0);

    // Node positions on a 760x130 canvas. The y-axis splits the main
    // (captured → reviewed → published) row from the rejected branch
    // so the dashed reject arrow is legible.
    const nodeW = 140;
    const nodeH = 56;
    const yMain = 16;
    const yReject = 16 + nodeH + 22;
    const positions: Record<LearningStage, { x: number; y: number }> = {
      captured: { x: 10, y: yMain },
      reviewed: { x: 200, y: yMain },
      published: { x: 600, y: yMain },
      rejected: { x: 600, y: yReject },
    };

    return html`
      <div class="loop-diagram-wrap" role="figure" aria-label="Learning loop diagram">
        <div class="loop-diagram-title">Loop overview · ${total} total drafts</div>
        <svg
          class="loop-diagram"
          viewBox="0 0 760 130"
          xmlns="http://www.w3.org/2000/svg"
          role="img"
          aria-label="Captured to reviewed to published, with rejected branch"
        >
          <defs>
            <marker
              id="cc-loop-arrowhead"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>

          <!-- Captured → Reviewed -->
          <path
            class="loop-arrow"
            d="M ${positions.captured.x + nodeW} ${positions.captured.y + nodeH / 2}
               L ${positions.reviewed.x} ${positions.reviewed.y + nodeH / 2}"
          />
          <!-- Reviewed → Published -->
          <path
            class="loop-arrow"
            d="M ${positions.reviewed.x + nodeW} ${positions.reviewed.y + nodeH / 2}
               L ${positions.published.x} ${positions.published.y + nodeH / 2}"
          />
          <!-- Reviewed → Rejected (branch) -->
          <path
            class="loop-arrow reject"
            d="M ${positions.reviewed.x + nodeW / 2} ${positions.reviewed.y + nodeH}
               C ${positions.reviewed.x + nodeW / 2} ${(positions.reviewed.y + positions.rejected.y) / 2 + nodeH / 2},
                 ${positions.rejected.x} ${(positions.reviewed.y + positions.rejected.y) / 2 + nodeH / 2},
                 ${positions.rejected.x} ${positions.rejected.y}"
          />

          ${LEARNING_STAGES.map((stage) => {
            const p = positions[stage];
            return html`
              <g class="loop-node ${stage}" transform="translate(${p.x},${p.y})">
                <rect width="${nodeW}" height="${nodeH}" />
                <text class="count" x="${nodeW / 2}" y="${nodeH / 2 - 6}">${counts[stage] ?? 0}</text>
                <text class="label" x="${nodeW / 2}" y="${nodeH / 2 + 12}">${stage}</text>
              </g>
            `;
          })}
        </svg>
        ${total === 0
          ? html`<div class="loop-empty-hint">
              No drafts captured yet — start a chat that uses tools and the agent will surface auto-capture proposals here.
            </div>`
          : html`
              <div class="stage-counts-row" aria-label="Stage counts">
                ${LEARNING_STAGES.map((s) => html`
                  <span class="stage-count-chip">
                    ${s}: <strong>${counts[s] ?? 0}</strong>
                  </span>
                `)}
              </div>
            `}
      </div>
    `;
  }

  /**
   * v0.8.4 (#185) — Per-skill metrics panel. Sourced from the dashboard
   * endpoint's `skillMetrics` array. Currently backed by draft-derived
   * signals (success-rate from helpful/unhelpful ratings, activations
   * from `sourceMessages`); will pivot to `SkillMetricsTracker` data
   * once that's wired into the runtime.
   */
  private _renderSkillMetricsPanel() {
    const rows = this.learningDashboard?.skillMetrics ?? [];
    if (this.learningDashboardLoading && rows.length === 0) {
      return html`<crowclaw-skeleton-list rows="3" aria-label="Loading skill metrics"></crowclaw-skeleton-list>`;
    }
    if (rows.length === 0) {
      return html`<div class="metrics-empty">No per-skill metrics yet — promote a draft to start collecting data.</div>`;
    }
    // Show top 8 by activations descending.
    const sorted = [...rows].sort((a, b) => b.activations - a.activations).slice(0, 8);
    return html`
      <table class="metrics-table" aria-label="Per-skill metrics">
        <thead>
          <tr>
            <th>Skill</th>
            <th>Stage</th>
            <th class="numeric">Activations</th>
            <th class="numeric">Success</th>
            <th class="numeric">Ratings</th>
            <th>Last activity</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map((m) => html`
            <tr>
              <td><span class="slug" title=${m.slug}>${m.slug}</span></td>
              <td><span class="stage-pill ${m.stage}">${m.stage}</span></td>
              <td class="numeric">${m.activations}</td>
              <td class="numeric">${m.successRate === null ? '--' : `${Math.round(m.successRate * 100)}%`}</td>
              <td class="numeric">${m.totalRatings}</td>
              <td>${timeAgo(m.lastActivityAt)}</td>
            </tr>
          `)}
        </tbody>
      </table>
    `;
  }

  /**
   * Best-effort fallback when /api/learning/dashboard fails or hasn't
   * loaded yet. Counts purely off the pending-drafts list so the diagram
   * still shows something useful.
   */
  private _fallbackStageCounts(): Record<LearningStage, number> {
    const counts: Record<LearningStage, number> = {
      captured: 0,
      reviewed: 0,
      published: 0,
      rejected: 0,
    };
    for (const d of this.pendingDrafts) {
      const stage: LearningStage = d.stage ?? 'captured';
      counts[stage] = (counts[stage] ?? 0) + 1;
    }
    return counts;
  }

  private _renderDraftCard(draft: PendingDraft) {
    const sourceLabel: Record<NonNullable<PendingDraft['source']>, string> = {
      'auto-capture': 'auto-capture',
      'agent-proposed': 'agent',
      'explicit': 'explicit',
    };
    const source = draft.source ?? 'auto-capture';
    const inFlight = this.draftActionInFlight.has(draft.id);
    const triggerPreview = (draft.triggerPhrases ?? []).slice(0, 3).join(', ');
    // v0.8.4 (#185) — derive a stage at the row level if the backend
    // omitted it (older runtime). Treat anything without ratings as
    // 'captured' so the pill is never blank.
    const stage: LearningStage = draft.stage ?? 'captured';
    return html`
      <div class="job-card">
        <div class="job-card-header">
          <span class="job-name" title=${draft.title || draft.slug}>${draft.title || draft.slug}</span>
          <span
            class="stage-pill ${stage}"
            aria-label="Learning stage ${stage}"
            title="Learning stage: ${stage}"
          >${stage}</span>
          <span class="tag">${sourceLabel[source] ?? source}</span>
        </div>
        <div class="job-meta">
          ${typeof draft.recurrenceCount === 'number' ? html`
            <div class="job-meta-row">
              <span class="job-meta-label">Recurrence</span>
              <span class="job-meta-value">${draft.recurrenceCount}x</span>
            </div>
          ` : nothing}
          ${triggerPreview ? html`
            <div class="job-meta-row">
              <span class="job-meta-label">Triggers</span>
              <span class="job-meta-value meta-trigger" title=${(draft.triggerPhrases ?? []).join(', ')}>${triggerPreview}</span>
            </div>
          ` : nothing}
          ${draft.summary ? html`
            <div class="job-meta-row summary-row">
              <span class="job-meta-label">Summary</span>
              <span class="job-meta-value meta-summary">${draft.summary.slice(0, 160)}</span>
            </div>
          ` : nothing}
        </div>
        <div class="actions-end">
          <crowclaw-button
            variant="ghost"
            size="sm"
            aria-label="Edit draft skill"
            @click=${() => this._editDraft(draft)}
            ?disabled=${inFlight}
          >Edit</crowclaw-button>
          <crowclaw-button
            variant="secondary"
            size="sm"
            aria-label="Reject draft skill"
            @click=${() => this._rejectDraft(draft)}
            ?disabled=${inFlight}
          >Reject</crowclaw-button>
          <crowclaw-button
            variant="primary"
            size="sm"
            aria-label="Promote draft skill"
            ?loading=${inFlight}
            ?disabled=${inFlight}
            @click=${() => this._promoteDraft(draft)}
          >${inFlight ? 'Working' : 'Promote'}</crowclaw-button>
        </div>
      </div>
    `;
  }

  private _renderSchedulerSection() {
    const showDormantBanner = !this.schedulerRunning && this.jobs.length > 0;
    return html`
      <div class="section-block">
        <div class="section-header">Scheduler</div>

        ${showDormantBanner ? html`
          <div class="dormant-banner" role="status" aria-live="polite">
            <span class="dormant-banner-text">
              Scheduler is stopped — ${this.jobs.length} ${this.jobs.length === 1 ? 'job is' : 'jobs are'} dormant.
            </span>
            <crowclaw-button
              variant="primary"
              size="sm"
              aria-label="Start scheduler"
              @click=${this._startSchedulerFromBanner}
            >Start scheduler</crowclaw-button>
          </div>
        ` : nothing}

        <div class="sched-bar">
          <div class="sched-status" aria-live="polite">
            <crowclaw-status-dot
              status=${this.schedulerRunning ? 'running' : 'idle'}
              ?pulse=${this.schedulerRunning}
            ></crowclaw-status-dot>
            <span>${this.schedulerRunning ? 'Running' : 'Stopped'}</span>
          </div>
          <div class="sched-bar-actions">
            <crowclaw-button
              variant="secondary"
              size="sm"
              aria-label="${this.schedulerRunning ? 'Stop scheduler' : 'Start scheduler'}"
              @click=${this._toggleScheduler}
            >${this.schedulerRunning ? 'Stop' : 'Start'}</crowclaw-button>
            <crowclaw-button
              variant="ghost"
              size="sm"
              aria-label="Run scheduler tick now"
              ?disabled=${!this.schedulerRunning}
              @click=${this._tickNow}
            >Tick Now</crowclaw-button>
            <crowclaw-button
              variant="primary"
              size="sm"
              aria-label="Create new job"
              @click=${this._openForm}
            >New Job</crowclaw-button>
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
    // Map job state to a status-dot kind:
    //   - last run errored      → 'error'
    //   - paused                → 'paused'
    //   - active + last success → 'ok'
    //   - active, no run yet    → 'idle'
    const dotStatus: 'error' | 'paused' | 'ok' | 'idle' =
      job.lastRunStatus === 'error' || job.lastRunStatus === 'timeout'
        ? 'error'
        : !job.enabled
          ? 'paused'
          : job.lastRunStatus === 'success'
            ? 'ok'
            : 'idle';
    return html`
      <div class="job-card">
        <div class="job-card-header">
          <crowclaw-status-dot
            status=${dotStatus}
            aria-live="polite"
          ></crowclaw-status-dot>
          <span class="job-name" title=${job.id}>${job.id}</span>
          <span class="tag ${job.enabled ? 'ok' : 'wn'}">
            ${job.enabled ? 'active' : 'paused'}
          </span>
          <div class="job-card-actions">
            <crowclaw-button
              variant="ghost"
              size="sm"
              title="Dry Run"
              aria-label="Test run job without side effects"
              @click=${() => this._dryRunJob(job)}
            >
              <crowclaw-icon slot="icon" name="play" size="14"></crowclaw-icon>
            </crowclaw-button>
            <crowclaw-button
              variant="ghost"
              size="sm"
              title="History"
              aria-label="Show run history"
              @click=${() => this._toggleJobExpand(job.id)}
            >
              <crowclaw-icon slot="icon" name="activity" size="14"></crowclaw-icon>
            </crowclaw-button>
            <crowclaw-button
              variant="ghost"
              size="sm"
              title="${job.enabled ? 'Pause' : 'Resume'}"
              aria-label="${job.enabled ? 'Pause job' : 'Resume job'}"
              @click=${() => this._toggleJob(job)}
            >
              <crowclaw-icon
                slot="icon"
                name=${job.enabled ? 'pause' : 'play'}
                size="14"
              ></crowclaw-icon>
            </crowclaw-button>
            <crowclaw-button
              variant="ghost"
              size="sm"
              title="Delete"
              aria-label="Delete job"
              @click=${() => this._deleteJob(job)}
            >
              <crowclaw-icon slot="icon" name="x" size="14"></crowclaw-icon>
            </crowclaw-button>
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
          <div class="history-frame">
            ${loadingHistory
              ? html`<crowclaw-skeleton-list rows="3" aria-label="Loading job history"></crowclaw-skeleton-list>`
              : history.length === 0
                ? html`<div class="history-empty">No run history</div>`
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
                            <td class="history-cell-duration">${formatDuration(entry.durationMs)}</td>
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
          <label class="form-label" for="delivery-platform">Delivery Platform</label>
          <select
            id="delivery-platform"
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
          <label class="form-label" for="delivery-channel">Channel / Target</label>
          <input
            id="delivery-channel"
            class="form-input"
            type="text"
            placeholder="#channel or @user"
            .value=${this.formDeliveryChannel}
            @input=${(e: InputEvent) => { this.formDeliveryChannel = (e.target as HTMLInputElement).value; }}
          >
          ${selectedConfigured ? html`<span class="badge ok" role="status" aria-live="polite">token configured</span>` : nothing}
        </div>
      </div>
    `;
  }

  private _renderForm() {
    return html`
      <div class="form-overlay" @click=${(e: Event) => { if (e.target === e.currentTarget) this._closeForm(); }}>
        <div class="form-panel" role="dialog" aria-labelledby="new-job-title" aria-modal="true">
          <div class="form-title" id="new-job-title">New Scheduled Job</div>

          <div class="form-group">
            <label class="form-label" for="job-form-name">Job Name</label>
            <input
              id="job-form-name"
              class="form-input"
              type="text"
              placeholder="e.g., Daily news digest"
              .value=${this.formName}
              @input=${(e: InputEvent) => { this.formName = (e.target as HTMLInputElement).value; }}
            >
          </div>

          <div class="form-group">
            <label class="form-label" for="job-form-prompt">Task / Prompt</label>
            <textarea
              id="job-form-prompt"
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
              <label class="form-label" for="job-form-schedule">Schedule Value</label>
              <input
                id="job-form-schedule"
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
            <label class="form-label" for="job-form-model">Model Override</label>
            <select
              id="job-form-model"
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
            <crowclaw-button
              variant="secondary"
              size="sm"
              aria-label="Cancel job creation"
              @click=${this._closeForm}
            >Cancel</crowclaw-button>
            <crowclaw-button
              variant="primary"
              size="sm"
              aria-label="Create scheduled job"
              ?loading=${this.formSubmitting}
              ?disabled=${this.formSubmitting || !this.formName.trim() || !this.formPrompt.trim() || !this.formScheduleValue.trim()}
              @click=${this._submitJob}
            >${this.formSubmitting ? 'Creating' : 'Create Job'}</crowclaw-button>
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
