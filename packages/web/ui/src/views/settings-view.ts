import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  buttonStyles,
  cardStyles,
  tagStyles,
  formStyles,
  sectionStyles,
  searchStyles,
  gridStyles,
  kvStyles,
} from '../lib/shared-styles.js';
import { api } from '../lib/api.js';

/* ------------------------------------------------------------------ */
/*  Interfaces                                                        */
/* ------------------------------------------------------------------ */

interface AgentConfig {
  name: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  [key: string]: unknown;
}

interface SecurityProtection {
  key: string;
  name: string;
  enabled: boolean;
  description?: string;
}

interface SecurityStatus {
  protections: SecurityProtection[];
  stats: Record<string, number>;
  grade: string;
  activeCount: number;
  totalCount: number;
}

interface SecurityEvent {
  time: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  detail: string;
}

interface UsageModel {
  model: string;
  tokens: number;
  cost: number;
  requests: number;
}

interface UsageEntry {
  timestamp: string;
  model: string;
  tokens: number;
  cost: number;
}

interface UsageData {
  summary: { totalTokens: number; totalCost: number; totalRequests: number };
  models: UsageModel[];
  entries: UsageEntry[];
}

interface MemoryItem {
  id: string;
  key: string;
  value: string;
  scope: string;
  timestamp: string;
}

type SettingsTab =
  | 'agent'
  | 'security'
  | 'usage'
  | 'system'
  | 'memory'
  | 'logs';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const TABS: { key: SettingsTab; label: string }[] = [
  { key: 'agent', label: 'Agent Config' },
  { key: 'security', label: 'Security' },
  { key: 'usage', label: 'Usage' },
  { key: 'system', label: 'System' },
  { key: 'memory', label: 'Memory' },
  { key: 'logs', label: 'Logs' },
];

const SCOPES = ['All', 'Session', 'User', 'Workspace'] as const;

const gradeColor = (grade: string): string => {
  switch (grade.toUpperCase()) {
    case 'A':
    case 'B':
      return 'var(--success)';
    case 'C':
      return 'var(--warning)';
    default:
      return 'var(--error)';
  }
};

const severityColor = (severity: string): string => {
  switch (severity) {
    case 'warning':
      return 'var(--warning)';
    case 'critical':
      return 'var(--error)';
    default:
      return 'var(--text-secondary)';
  }
};

const formatTime = (iso: string): string => {
  if (!iso) return '--';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

const formatCost = (n: number): string =>
  `$${n.toFixed(4)}`;

const formatTokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}K`
      : String(n);

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

@customElement('crowclaw-settings-view')
export class SettingsView extends LitElement {
  static styles = [
    buttonStyles,
    cardStyles,
    tagStyles,
    formStyles,
    sectionStyles,
    searchStyles,
    gridStyles,
    kvStyles,
    css`
      :host {
        display: block;
        width: 100%;
        height: 100%;
        overflow-y: auto;
        padding: var(--sp-6);
        box-sizing: border-box;
      }

      /* Tab bar */
      .tabs {
        display: flex;
        gap: 0;
        border-bottom: 1px solid var(--glass-border);
        margin-bottom: var(--sp-6);
      }

      .tab {
        padding: var(--sp-2) var(--sp-4);
        font-size: var(--text-xs);
        font-weight: 500;
        color: var(--text-muted);
        cursor: pointer;
        border-bottom: 2px solid transparent;
        transition: all var(--duration-fast);
        user-select: none;
      }

      .tab:hover {
        color: var(--text-secondary);
      }

      .tab.active {
        color: var(--accent);
        border-bottom-color: var(--accent);
      }

      /* Summary cards row */
      .summary-row {
        display: flex;
        gap: var(--sp-3);
        margin-bottom: var(--sp-5);
        flex-wrap: wrap;
      }

      .summary-card {
        flex: 1;
        min-width: 160px;
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        padding: var(--sp-4);
        border-radius: var(--radius-md);
      }

      .summary-card .label {
        font-size: var(--text-xs);
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.8px;
        margin-bottom: var(--sp-1);
      }

      .summary-card .value {
        font-size: var(--text-lg);
        font-weight: 700;
        color: var(--text-primary);
        font-family: var(--font-mono);
      }

      /* Security grade badge */
      .grade-badge {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 56px;
        height: 56px;
        border-radius: var(--radius-md);
        font-size: 28px;
        font-weight: 800;
        font-family: var(--font-mono);
        border: 2px solid;
      }

      /* Toggle switch */
      .toggle-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--sp-3) var(--sp-4);
        border-bottom: 1px solid var(--glass-border);
      }

      .toggle-row:last-child {
        border-bottom: none;
      }

      .toggle-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .toggle-name {
        font-size: var(--text-sm);
        font-weight: 500;
        color: var(--text-primary);
      }

      .toggle-desc {
        font-size: var(--text-xs);
        color: var(--text-muted);
      }

      .switch {
        position: relative;
        width: 36px;
        height: 20px;
        cursor: pointer;
        flex-shrink: 0;
      }

      .switch input {
        opacity: 0;
        width: 0;
        height: 0;
      }

      .switch .slider {
        position: absolute;
        inset: 0;
        background: var(--glass-border);
        border-radius: 10px;
        transition: background var(--duration-fast);
      }

      .switch .slider::before {
        content: '';
        position: absolute;
        width: 16px;
        height: 16px;
        left: 2px;
        bottom: 2px;
        background: var(--text-primary);
        border-radius: 50%;
        transition: transform var(--duration-fast);
      }

      .switch input:checked + .slider {
        background: var(--accent);
      }

      .switch input:checked + .slider::before {
        transform: translateX(16px);
      }

      /* Data table */
      .data-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }

      .data-table th {
        text-align: left;
        padding: var(--sp-2) var(--sp-3);
        font-size: var(--text-xs);
        font-weight: 600;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.6px;
        border-bottom: 1px solid var(--glass-border);
      }

      .data-table td {
        padding: var(--sp-2) var(--sp-3);
        color: var(--text-primary);
        border-bottom: 1px solid var(--glass-border);
      }

      .data-table tr:last-child td {
        border-bottom: none;
      }

      /* Event log filters */
      .filter-row {
        display: flex;
        gap: var(--sp-2);
        margin-bottom: var(--sp-3);
        flex-wrap: wrap;
        align-items: center;
      }

      .filter-row select {
        padding: var(--sp-1) var(--sp-3);
        border: 1px solid var(--glass-border);
        background: var(--bg-input);
        color: var(--text-primary);
        font-size: var(--text-xs);
        font-family: inherit;
        outline: none;
        border-radius: var(--radius-sm);
        cursor: pointer;
      }

      .filter-row select:focus {
        border-color: var(--accent);
      }

      /* Memory list */
      .mem-list {
        display: flex;
        flex-direction: column;
        gap: var(--sp-2);
      }

      .mem-item {
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-md);
        padding: var(--sp-3) var(--sp-4);
        cursor: pointer;
        transition: all var(--duration-fast);
      }

      .mem-item:hover {
        border-color: rgba(255, 255, 255, 0.14);
        background: var(--bg-card-hover);
      }

      .mem-item.selected {
        border-color: var(--accent);
        background: var(--accent-soft);
      }

      .mem-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--sp-1);
      }

      .mem-key {
        font-size: var(--text-sm);
        font-weight: 600;
        color: var(--text-primary);
        font-family: var(--font-mono);
      }

      .mem-meta {
        display: flex;
        gap: var(--sp-2);
        align-items: center;
      }

      .mem-preview {
        font-size: var(--text-xs);
        color: var(--text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .mem-detail {
        margin-top: var(--sp-4);
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-md);
        padding: var(--sp-4);
      }

      .mem-detail-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--sp-3);
      }

      .mem-detail-key {
        font-size: var(--text-sm);
        font-weight: 600;
        color: var(--text-primary);
        font-family: var(--font-mono);
      }

      .mem-detail-body {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.6;
        font-family: var(--font-mono);
        max-height: 300px;
        overflow-y: auto;
      }

      /* Log output */
      .log-output {
        background: rgba(0, 0, 0, 0.3);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-md);
        padding: var(--sp-3);
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        color: var(--text-secondary);
        line-height: 1.6;
        max-height: 500px;
        overflow-y: auto;
        white-space: pre-wrap;
        word-break: break-all;
      }

      /* Save row */
      .form-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--sp-2);
        margin-top: var(--sp-4);
      }

      /* Status text */
      .status-msg {
        font-size: var(--text-xs);
        padding: var(--sp-2) 0;
      }

      .status-msg.ok {
        color: var(--success);
      }

      .status-msg.er {
        color: var(--error);
      }

      /* Section sub-card */
      .sub-card {
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-md);
        overflow: hidden;
        margin-bottom: var(--sp-4);
      }

      /* Memory scope filter row */
      .scope-row {
        display: flex;
        gap: var(--sp-2);
        margin-bottom: var(--sp-3);
      }

      .scope-btn {
        padding: var(--sp-1) var(--sp-3);
        font-size: var(--text-xs);
        font-weight: 500;
        color: var(--text-muted);
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        cursor: pointer;
        border-radius: var(--radius-sm);
        transition: all var(--duration-fast);
      }

      .scope-btn:hover {
        color: var(--text-secondary);
        border-color: rgba(255, 255, 255, 0.15);
      }

      .scope-btn.active {
        color: var(--accent);
        border-color: var(--accent);
        background: var(--accent-soft);
      }

      /* Actions header row */
      .actions-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--sp-4);
      }

      .section-title {
        font-size: var(--text-base);
        font-weight: 600;
        color: var(--text-primary);
      }
    `,
  ];

  /* ---------------------------------------------------------------- */
  /*  Reactive state                                                  */
  /* ---------------------------------------------------------------- */

  @state() private activeTab: SettingsTab = 'agent';

  // Agent config
  @state() private agentConfig: AgentConfig | null = null;
  @state() private agentSaving = false;
  @state() private agentStatus: { msg: string; ok: boolean } | null = null;

  // Security
  @state() private securityStatus: SecurityStatus | null = null;
  @state() private securityEvents: SecurityEvent[] = [];
  @state() private secEventTypeFilter = '';
  @state() private secEventSeverityFilter = '';

  // Usage
  @state() private usageData: UsageData | null = null;

  // System
  @state() private systemConfig: Record<string, string> = {};

  // Memory
  @state() private memories: MemoryItem[] = [];
  @state() private memorySearch = '';
  @state() private memoryScope = 'All';
  @state() private selectedMemoryId: string | null = null;

  // Logs
  @state() private logLines: string[] = [];

  /* ---------------------------------------------------------------- */
  /*  Lifecycle                                                       */
  /* ---------------------------------------------------------------- */

  connectedCallback() {
    super.connectedCallback();
    this._loadTabData();
  }

  /* ---------------------------------------------------------------- */
  /*  Data loading                                                    */
  /* ---------------------------------------------------------------- */

  private _loadTabData() {
    switch (this.activeTab) {
      case 'agent':
        this._loadAgentConfig();
        break;
      case 'security':
        this._loadSecurityStatus();
        this._loadSecurityEvents();
        break;
      case 'usage':
        this._loadUsage();
        break;
      case 'system':
        this._loadSystem();
        break;
      case 'memory':
        this._loadMemories();
        break;
      case 'logs':
        this._loadLogs();
        break;
    }
  }

  private async _loadAgentConfig() {
    try {
      const data = await api<AgentConfig>('/api/agent/config');
      this.agentConfig = data;
    } catch {
      this.agentConfig = {
        name: '',
        model: '',
        systemPrompt: '',
        temperature: 0.7,
        maxTokens: 4096,
      };
    }
  }

  private async _loadSecurityStatus() {
    try {
      const data = await api<SecurityStatus>('/api/security/status');
      this.securityStatus = data;
    } catch {
      this.securityStatus = null;
    }
  }

  private async _loadSecurityEvents() {
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (this.secEventTypeFilter) params.set('type', this.secEventTypeFilter);
      if (this.secEventSeverityFilter) params.set('severity', this.secEventSeverityFilter);
      const data = await api<{ events: SecurityEvent[] }>(
        `/api/security/events?${params.toString()}`,
      );
      this.securityEvents = data.events || [];
    } catch {
      this.securityEvents = [];
    }
  }

  private async _loadUsage() {
    try {
      const data = await api<UsageData>('/api/usage');
      this.usageData = data;
    } catch {
      this.usageData = null;
    }
  }

  private async _loadSystem() {
    try {
      const data = await api<Record<string, string>>('/api/system/config');
      this.systemConfig = data;
    } catch {
      this.systemConfig = {};
    }
  }

  private async _loadMemories() {
    try {
      const params = new URLSearchParams();
      if (this.memoryScope !== 'All') params.set('scope', this.memoryScope);
      if (this.memorySearch) params.set('search', this.memorySearch);
      const q = params.toString();
      const data = await api<{ memories: MemoryItem[] }>(
        `/api/memory${q ? `?${q}` : ''}`,
      );
      this.memories = data.memories || [];
    } catch {
      this.memories = [];
    }
  }

  private async _loadLogs() {
    try {
      const data = await api<{ lines: string[] }>('/api/logs');
      this.logLines = data.lines || [];
      this._scrollLogsToBottom();
    } catch {
      this.logLines = [];
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Actions                                                         */
  /* ---------------------------------------------------------------- */

  private async _saveAgentConfig() {
    if (!this.agentConfig) return;
    this.agentSaving = true;
    this.agentStatus = null;
    try {
      await api('/api/agent/config', {
        method: 'POST',
        body: JSON.stringify(this.agentConfig),
      });
      this.agentStatus = { msg: 'Configuration saved.', ok: true };
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : 'Failed to save configuration.';
      this.agentStatus = { msg, ok: false };
    } finally {
      this.agentSaving = false;
    }
  }

  private async _toggleProtection(key: string, enabled: boolean) {
    try {
      await api('/api/security/policy', {
        method: 'POST',
        body: JSON.stringify({ [key]: enabled }),
      });
      // Optimistic update
      if (this.securityStatus) {
        this.securityStatus = {
          ...this.securityStatus,
          protections: this.securityStatus.protections.map((p) =>
            p.key === key ? { ...p, enabled } : p,
          ),
          activeCount: this.securityStatus.protections.filter((p) =>
            p.key === key ? enabled : p.enabled,
          ).length,
        };
      }
    } catch {
      // Revert: reload
      this._loadSecurityStatus();
    }
  }

  private async _clearSecurityEvents() {
    try {
      await api('/api/security/events/clear', { method: 'POST' });
      this.securityEvents = [];
    } catch {
      /* ignore */
    }
  }

  private async _resetUsage() {
    try {
      await api('/api/usage/reset', { method: 'POST' });
      this._loadUsage();
    } catch {
      /* ignore */
    }
  }

  private async _deleteMemory(id: string) {
    try {
      await api(`/api/memory/${id}`, { method: 'DELETE' });
      this.memories = this.memories.filter((m) => m.id !== id);
      if (this.selectedMemoryId === id) {
        this.selectedMemoryId = null;
      }
    } catch {
      /* ignore */
    }
  }

  private _scrollLogsToBottom() {
    this.updateComplete.then(() => {
      const el = this.shadowRoot?.querySelector('.log-output');
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Tab switching                                                   */
  /* ---------------------------------------------------------------- */

  private _switchTab(tab: SettingsTab) {
    this.activeTab = tab;
    this._loadTabData();
  }

  /* ---------------------------------------------------------------- */
  /*  Render                                                          */
  /* ---------------------------------------------------------------- */

  render() {
    return html`
      <div class="tabs">
        ${TABS.map(
          (t) => html`
            <div
              class="tab ${this.activeTab === t.key ? 'active' : ''}"
              @click=${() => this._switchTab(t.key)}
            >
              ${t.label}
            </div>
          `,
        )}
      </div>

      ${this._renderActiveTab()}
    `;
  }

  private _renderActiveTab() {
    switch (this.activeTab) {
      case 'agent':
        return this._renderAgent();
      case 'security':
        return this._renderSecurity();
      case 'usage':
        return this._renderUsage();
      case 'system':
        return this._renderSystem();
      case 'memory':
        return this._renderMemory();
      case 'logs':
        return this._renderLogs();
      default:
        return nothing;
    }
  }

  /* ---- Agent Config ---- */

  private _renderAgent() {
    const cfg = this.agentConfig;
    if (!cfg) return html`<div class="status-msg">Loading...</div>`;

    return html`
      <div class="section-block">
        <div class="section-header">Agent Configuration</div>

        <div class="form-group">
          <label class="form-label">Agent Name</label>
          <input
            class="form-input"
            type="text"
            .value=${cfg.name}
            @input=${(e: InputEvent) => {
              this.agentConfig = { ...cfg, name: (e.target as HTMLInputElement).value };
            }}
          />
        </div>

        <div class="form-group">
          <label class="form-label">Model</label>
          <input
            class="form-input"
            type="text"
            .value=${cfg.model}
            placeholder="e.g. claude-sonnet-4-20250514"
            @input=${(e: InputEvent) => {
              this.agentConfig = { ...cfg, model: (e.target as HTMLInputElement).value };
            }}
          />
        </div>

        <div class="form-group">
          <label class="form-label">System Prompt</label>
          <textarea
            class="form-input"
            rows="5"
            .value=${cfg.systemPrompt}
            @input=${(e: InputEvent) => {
              this.agentConfig = {
                ...cfg,
                systemPrompt: (e.target as HTMLTextAreaElement).value,
              };
            }}
          ></textarea>
        </div>

        <div class="form-group">
          <label class="form-label">Temperature</label>
          <input
            class="form-input"
            type="number"
            min="0"
            max="2"
            step="0.1"
            .value=${String(cfg.temperature)}
            @input=${(e: InputEvent) => {
              this.agentConfig = {
                ...cfg,
                temperature: parseFloat((e.target as HTMLInputElement).value) || 0,
              };
            }}
          />
          <div class="form-hint">0 = deterministic, 2 = maximum creativity</div>
        </div>

        <div class="form-group">
          <label class="form-label">Max Tokens</label>
          <input
            class="form-input"
            type="number"
            min="1"
            max="200000"
            step="1"
            .value=${String(cfg.maxTokens)}
            @input=${(e: InputEvent) => {
              this.agentConfig = {
                ...cfg,
                maxTokens: parseInt((e.target as HTMLInputElement).value, 10) || 0,
              };
            }}
          />
        </div>

        ${this.agentStatus
          ? html`<div class="status-msg ${this.agentStatus.ok ? 'ok' : 'er'}">
              ${this.agentStatus.msg}
            </div>`
          : nothing}

        <div class="form-actions">
          <button class="btn" @click=${this._loadAgentConfig}>Reset</button>
          <button
            class="btn btn-p"
            ?disabled=${this.agentSaving}
            @click=${this._saveAgentConfig}
          >
            ${this.agentSaving ? 'Saving...' : 'Save Configuration'}
          </button>
        </div>
      </div>
    `;
  }

  /* ---- Security ---- */

  private _renderSecurity() {
    const sec = this.securityStatus;

    return html`
      <div class="section-block">
        <div class="section-header">Security</div>

        <!-- Summary cards -->
        ${sec
          ? html`
              <div class="summary-row">
                <div class="summary-card" style="display:flex;gap:var(--sp-4);align-items:center">
                  <div
                    class="grade-badge"
                    style="color:${gradeColor(sec.grade)};border-color:${gradeColor(sec.grade)}"
                  >
                    ${sec.grade.toUpperCase()}
                  </div>
                  <div>
                    <div class="label">Security Grade</div>
                    <div class="value">${sec.activeCount}/${sec.totalCount} active</div>
                  </div>
                </div>
                <div class="summary-card">
                  <div class="label">Active Protections</div>
                  <div class="value">${sec.activeCount}</div>
                </div>
                <div class="summary-card">
                  <div class="label">Total Events</div>
                  <div class="value">${sec.stats.total ?? 0}</div>
                </div>
                <div class="summary-card">
                  <div class="label">Critical Events</div>
                  <div class="value" style="color:var(--error)">
                    ${sec.stats.critical ?? 0}
                  </div>
                </div>
              </div>

              <!-- Protection toggles -->
              <div class="sec-h">Protections</div>
              <div class="sub-card">
                ${sec.protections.map(
                  (p) => html`
                    <div class="toggle-row">
                      <div class="toggle-info">
                        <div class="toggle-name">${p.name}</div>
                        ${p.description
                          ? html`<div class="toggle-desc">${p.description}</div>`
                          : nothing}
                      </div>
                      <label class="switch">
                        <input
                          type="checkbox"
                          .checked=${p.enabled}
                          @change=${(e: Event) =>
                            this._toggleProtection(
                              p.key,
                              (e.target as HTMLInputElement).checked,
                            )}
                        />
                        <span class="slider"></span>
                      </label>
                    </div>
                  `,
                )}
              </div>
            `
          : html`<div class="status-msg">Loading security status...</div>`}

        <!-- Event log -->
        <div class="actions-row">
          <div class="sec-h" style="margin-bottom:0">Event Log</div>
          <button class="btn btn-danger" @click=${this._clearSecurityEvents}>
            Clear Log
          </button>
        </div>

        <div class="filter-row">
          <select
            @change=${(e: Event) => {
              this.secEventTypeFilter = (e.target as HTMLSelectElement).value;
              this._loadSecurityEvents();
            }}
          >
            <option value="">All Types</option>
            <option value="injection">Injection</option>
            <option value="auth">Auth</option>
            <option value="rate_limit">Rate Limit</option>
            <option value="policy">Policy</option>
          </select>
          <select
            @change=${(e: Event) => {
              this.secEventSeverityFilter = (e.target as HTMLSelectElement).value;
              this._loadSecurityEvents();
            }}
          >
            <option value="">All Severities</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </div>

        ${this.securityEvents.length > 0
          ? html`
              <div class="sub-card" style="overflow-x:auto">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Type</th>
                      <th>Severity</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${this.securityEvents.map(
                      (ev) => html`
                        <tr>
                          <td style="white-space:nowrap;font-family:var(--font-mono);font-size:var(--text-xs)">
                            ${formatTime(ev.time)}
                          </td>
                          <td><span class="tag">${ev.type}</span></td>
                          <td>
                            <span style="color:${severityColor(ev.severity)};font-weight:600;font-size:var(--text-xs)">
                              ${ev.severity.toUpperCase()}
                            </span>
                          </td>
                          <td style="color:var(--text-secondary)">${ev.detail}</td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              </div>
            `
          : html`<div class="status-msg" style="color:var(--text-muted)">
              No events recorded.
            </div>`}
      </div>
    `;
  }

  /* ---- Usage ---- */

  private _renderUsage() {
    const usage = this.usageData;

    return html`
      <div class="section-block">
        <div class="actions-row">
          <div class="section-header" style="border:none;padding:0;margin:0">Usage</div>
          <button class="btn btn-danger" @click=${this._resetUsage}>Reset Usage</button>
        </div>

        ${usage
          ? html`
              <!-- Summary -->
              <div class="summary-row">
                <div class="summary-card">
                  <div class="label">Total Tokens</div>
                  <div class="value">${formatTokens(usage.summary.totalTokens)}</div>
                </div>
                <div class="summary-card">
                  <div class="label">Total Cost</div>
                  <div class="value">${formatCost(usage.summary.totalCost)}</div>
                </div>
                <div class="summary-card">
                  <div class="label">Total Requests</div>
                  <div class="value">${usage.summary.totalRequests}</div>
                </div>
              </div>

              <!-- Per-model breakdown -->
              <div class="sec-h">Per-Model Breakdown</div>
              ${usage.models.length > 0
                ? html`
                    <div class="sub-card" style="overflow-x:auto;margin-bottom:var(--sp-5)">
                      <table class="data-table">
                        <thead>
                          <tr>
                            <th>Model</th>
                            <th>Tokens</th>
                            <th>Cost</th>
                            <th>Requests</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${usage.models.map(
                            (m) => html`
                              <tr>
                                <td style="font-family:var(--font-mono);font-size:var(--text-xs)">
                                  ${m.model}
                                </td>
                                <td>${formatTokens(m.tokens)}</td>
                                <td>${formatCost(m.cost)}</td>
                                <td>${m.requests}</td>
                              </tr>
                            `,
                          )}
                        </tbody>
                      </table>
                    </div>
                  `
                : html`<div class="status-msg" style="color:var(--text-muted)">
                    No model data yet.
                  </div>`}

              <!-- Recent entries -->
              <div class="sec-h">Recent Entries</div>
              ${usage.entries.length > 0
                ? html`
                    <div class="sub-card" style="overflow-x:auto">
                      <table class="data-table">
                        <thead>
                          <tr>
                            <th>Time</th>
                            <th>Model</th>
                            <th>Tokens</th>
                            <th>Cost</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${usage.entries.slice(0, 20).map(
                            (e) => html`
                              <tr>
                                <td style="white-space:nowrap;font-family:var(--font-mono);font-size:var(--text-xs)">
                                  ${formatTime(e.timestamp)}
                                </td>
                                <td style="font-family:var(--font-mono);font-size:var(--text-xs)">
                                  ${e.model}
                                </td>
                                <td>${formatTokens(e.tokens)}</td>
                                <td>${formatCost(e.cost)}</td>
                              </tr>
                            `,
                          )}
                        </tbody>
                      </table>
                    </div>
                  `
                : html`<div class="status-msg" style="color:var(--text-muted)">
                    No usage entries recorded.
                  </div>`}
            `
          : html`<div class="status-msg">Loading usage data...</div>`}
      </div>
    `;
  }

  /* ---- System ---- */

  private _renderSystem() {
    const entries = Object.entries(this.systemConfig);

    return html`
      <div class="section-block">
        <div class="section-header">System Configuration</div>

        ${entries.length > 0
          ? html`
              <div class="sub-card">
                ${entries.map(
                  ([k, v]) => html`
                    <div class="kv">
                      <span class="kv-k">${k}</span>
                      <span class="kv-v">${v}</span>
                    </div>
                  `,
                )}
              </div>
            `
          : html`<div class="status-msg" style="color:var(--text-muted)">
              No system configuration available.
            </div>`}
      </div>
    `;
  }

  /* ---- Memory Browser ---- */

  private _renderMemory() {
    const selected = this.memories.find((m) => m.id === this.selectedMemoryId);

    return html`
      <div class="section-block">
        <div class="section-header">Memory Browser</div>

        <input
          class="srch"
          type="text"
          placeholder="Search memories..."
          .value=${this.memorySearch}
          @input=${(e: InputEvent) => {
            this.memorySearch = (e.target as HTMLInputElement).value;
            this._loadMemories();
          }}
        />

        <div class="scope-row">
          ${SCOPES.map(
            (s) => html`
              <button
                class="scope-btn ${this.memoryScope === s ? 'active' : ''}"
                @click=${() => {
                  this.memoryScope = s;
                  this._loadMemories();
                }}
              >
                ${s}
              </button>
            `,
          )}
        </div>

        ${this.memories.length > 0
          ? html`
              <div class="mem-list">
                ${this.memories.map(
                  (m) => html`
                    <div
                      class="mem-item ${this.selectedMemoryId === m.id ? 'selected' : ''}"
                      @click=${() => {
                        this.selectedMemoryId =
                          this.selectedMemoryId === m.id ? null : m.id;
                      }}
                    >
                      <div class="mem-header">
                        <span class="mem-key">${m.key}</span>
                        <div class="mem-meta">
                          <span class="tag">${m.scope}</span>
                          <span style="font-size:var(--text-xs);color:var(--text-muted)">
                            ${formatTime(m.timestamp)}
                          </span>
                        </div>
                      </div>
                      <div class="mem-preview">
                        ${m.value.length > 120
                          ? `${m.value.slice(0, 120)}...`
                          : m.value}
                      </div>
                    </div>
                  `,
                )}
              </div>

              ${selected
                ? html`
                    <div class="mem-detail">
                      <div class="mem-detail-header">
                        <span class="mem-detail-key">${selected.key}</span>
                        <button
                          class="btn btn-danger"
                          @click=${() => this._deleteMemory(selected.id)}
                        >
                          Delete
                        </button>
                      </div>
                      <div class="mem-detail-body">${selected.value}</div>
                    </div>
                  `
                : nothing}
            `
          : html`<div class="status-msg" style="color:var(--text-muted)">
              No memories found.
            </div>`}
      </div>
    `;
  }

  /* ---- Logs ---- */

  private _renderLogs() {
    return html`
      <div class="section-block">
        <div class="actions-row">
          <div class="section-header" style="border:none;padding:0;margin:0">Logs</div>
          <button class="btn" @click=${this._loadLogs}>Refresh</button>
        </div>

        <div class="log-output">
          ${this.logLines.length > 0
            ? this.logLines.join('\n')
            : 'No log output available.'}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-settings-view': SettingsView;
  }
}
