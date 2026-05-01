import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  buttonStyles,
  cardStyles,
  tagStyles,
  formStyles,
  tabStyles,
  sectionStyles,
  searchStyles,
  gridStyles,
  kvStyles,
} from '../lib/shared-styles.js';
import { api } from '../lib/api.js';
import { showToast } from '../components/toast.js';
import '../components/toggle-switch.js';

/* ------------------------------------------------------------------ */
/*  Interfaces                                                        */
/* ------------------------------------------------------------------ */

interface AgentConfig {
  name: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  maxToolIterations: number;
  concurrentToolCalls: boolean;
  synthesizeOnExhaustion: boolean;
  maxToolResultLength: number;
  requireApprovalForDangerousTools: boolean;
  [key: string]: unknown;
}

interface ProviderSlot {
  provider?: string;
  model?: string;
  apiKey?: string;
}

interface ProvidersConfig {
  primary?: ProviderSlot;
  fallback?: ProviderSlot;
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
  timestamp: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  detail: string;
}

interface UsageEntry {
  timestamp: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  costUsd: number;
  latencyMs: number;
}

interface UsageData {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  avgLatencyMs: number;
  entries: UsageEntry[];
  byModel: Record<string, { tokens: number; cost: number; calls: number }>;
}

interface MemoryRecord {
  id: string;
  sessionId: string;
  scope: string;
  scopeKey?: string;
  summary: string;
  tags: string[];
  createdAt: string;
  metadata?: Record<string, unknown>;
  // Computed aliases for UI compatibility
  key: string;
  value: string;
  timestamp: string;
}

interface SessionSummary {
  sessionId: string;
  title: string;
  updatedAt: string;
}

interface RemoteAccessConfig {
  serverUrl: string;
  publicUrl: string;
  trustProxy: boolean;
}

interface DiagnosticsInfo {
  nodeVersion: string;
  platform: string;
  wsConnections: number;
  activeSessions: number;
  lastHeartbeat: string;
}

interface FeedbackStats {
  total: number;
  success: number;
  failure: number;
  byTool: Record<string, { ok: number; fail: number }>;
}

interface FeedbackEntry {
  timestamp: string;
  toolName: string;
  ok: boolean;
  durationMs?: number;
  error?: string;
  sessionId: string;
}

/* ---- v0.8.1 (#246): merged from the deleted agent-view.ts ------------ */

interface Preset {
  id: string;
  name: string;
  description: string;
  type: 'persona' | 'toolset' | 'config';
  active?: boolean;
}

interface PresetsResponse {
  agents: Array<{ name: string; role?: string; goal?: string; backstory?: string }>;
  toolsets: Array<{ name: string; description?: string; toolNames?: string[] }>;
  activeAgent?: string | null;
  activeToolset?: string | null;
}

interface PersonasResponse {
  personas: Array<{ name: string; active: boolean }>;
}

interface ToolEntry {
  name: string;
  description: string;
  disabled: boolean;
}

interface ToolsResponse {
  tools: ToolEntry[];
  count?: number;
}

interface ConfigPresetsResponse {
  presets: Array<{ name: string; description?: string }>;
  active: string | null;
}

interface BackendSkill {
  slug: string;
  title: string;
  summary: string;
  triggerPhrases: string[];
  steps: string[];
  requiredTools: string[];
}

interface Skill {
  slug: string;
  title: string;
  summary: string;
  triggers: string[];
  steps: string[];
  tools: string[];
}

interface SkillsResponse {
  skills: BackendSkill[];
}

type IdentityTab = 'personas' | 'toolsets';

/**
 * v0.8.1 (#246): the standalone Agent view was merged here. The four primary
 * tabs are Agent (config + identity), Observability (usage/memory/feedback),
 * System, and Plugins (skills + config presets). Security stays under
 * Advanced as a fifth tab.
 */
type SettingsTab =
  | 'agent'
  | 'observability'
  | 'system'
  | 'plugins'
  | 'security';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/**
 * v0.8.1 (#246) primary tabs. Order is intentional: Agent first (highest-
 * frequency edit surface), Observability second (read-mostly dashboards),
 * System third (config snapshot + remote-access), Plugins last (skills /
 * MCP / config presets — extension point, less common).
 */
const PRIMARY_TABS: { key: SettingsTab; label: string }[] = [
  { key: 'agent', label: 'Agent' },
  { key: 'observability', label: 'Observability' },
  { key: 'system', label: 'System' },
  { key: 'plugins', label: 'Plugins' },
];

const ADVANCED_TABS: { key: SettingsTab; label: string }[] = [
  { key: 'security', label: 'Security' },
];

const MEMORY_SCOPES = ['All', 'Session', 'User', 'Workspace'] as const;


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
    tabStyles,
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
        flex-direction: column;
        gap: 0;
        border-bottom: 1px solid var(--glass-border);
        margin-bottom: var(--sp-6);
      }

      .tab-row {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
      }

      .tab-row-label {
        font-size: 10px;
        font-weight: 600;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 1px;
        padding-right: var(--sp-2);
        opacity: 0.7;
      }

      .tab-row.advanced .tab {
        font-size: 10px;
        opacity: 0.75;
        padding: var(--sp-1) var(--sp-3);
      }

      .tab {
        padding: var(--sp-2) var(--sp-4);
        font-size: var(--text-xs);
        font-weight: 500;
        color: var(--text-muted);
        cursor: pointer;
        border-bottom: 2px solid transparent;
        transition: color var(--duration-fast), border-bottom-color var(--duration-fast);
        user-select: none;
      }

      .tab:hover {
        color: var(--text-secondary);
      }

      .tab.active {
        color: var(--accent);
        border-bottom-color: var(--accent);
      }

      /* Protection badge (read-only enforced state) */
      .protection-badge {
        display: inline-flex;
        align-items: center;
        gap: var(--sp-1);
        padding: var(--sp-1) var(--sp-2);
        font-size: var(--text-xs);
        font-weight: 500;
        color: var(--success);
        background: var(--accent-soft, rgba(46, 160, 67, 0.12));
        border: 1px solid var(--success);
        border-radius: var(--radius-sm);
        cursor: help;
        user-select: none;
        white-space: nowrap;
      }

      /* Hint text */
      .hint {
        font-size: var(--text-xs);
        color: var(--text-muted);
        margin: 0 0 var(--sp-3) 0;
      }

      .hint a {
        color: var(--accent);
        text-decoration: none;
      }

      .hint a:hover {
        text-decoration: underline;
      }

      /* Active profile summary */
      .profile-summary {
        display: flex;
        flex-direction: column;
        gap: var(--sp-1);
        margin-bottom: var(--sp-3);
        font-size: var(--text-sm);
        color: var(--text-primary);
      }

      .profile-summary .label {
        color: var(--text-muted);
        margin-right: var(--sp-2);
      }

      .raw-config-disclosure {
        margin-top: var(--sp-3);
      }

      .raw-config-disclosure summary {
        cursor: pointer;
        font-size: var(--text-xs);
        color: var(--text-muted);
        padding: var(--sp-1) 0;
        user-select: none;
      }

      .raw-config-disclosure summary:hover {
        color: var(--text-secondary);
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
        transition: border-color var(--duration-fast), background-color var(--duration-fast);
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
        transition: color var(--duration-fast), border-color var(--duration-fast), background-color var(--duration-fast);
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

  // #246: sub-tab inside Agent (Identity → Personas / Toolsets) absorbed
  // from the deleted agent-view.
  @state() private identityTab: IdentityTab = 'personas';

  // Agent config
  @state() private agentConfig: AgentConfig | null = null;
  @state() private agentSaving = false;
  @state() private agentStatus: { msg: string; ok: boolean } | null = null;

  // Personas / Toolsets / Tools / Skills / Config presets (merged from
  // agent-view in #246).
  @state() private personas: Preset[] = [];
  @state() private personasLoading = true;
  @state() private presetToolsets: Preset[] = [];
  @state() private presetsLoading = true;
  @state() private tools: ToolEntry[] = [];
  @state() private toolsLoading = true;
  @state() private skills: Skill[] = [];
  @state() private skillsLoading = true;
  @state() private skillSearch = '';
  @state() private showSkillForm = false;
  @state() private showImportForm = false;
  @state() private editingSkillSlug: string | null = null;
  @state() private formTitle = '';
  @state() private formSummary = '';
  @state() private formTriggers = '';
  @state() private formSteps = '';
  @state() private formTools = '';
  @state() private importText = '';
  @state() private configPresets: Preset[] = [];
  @state() private configPresetsLoading = true;

  // Providers config (read-only here; canonical source is Connect → Providers)
  @state() private providersConfig: ProvidersConfig | null = null;

  // Security
  @state() private securityStatus: SecurityStatus | null = null;
  @state() private securityEvents: SecurityEvent[] = [];
  @state() private secEventTypeFilter = '';
  @state() private secEventSeverityFilter = '';

  // Usage
  @state() private usageData: UsageData | null = null;

  // System
  @state() private systemConfig: Record<string, string> = {};
  @state() private activePresetName: string | null = null;
  @state() private activeToolsetName: string | null = null;

  // Remote Access
  @state() private remoteAccess: RemoteAccessConfig = { serverUrl: '', publicUrl: '', trustProxy: false };
  @state() private remoteAccessSaving = false;

  // Diagnostics
  @state() private diagnostics: DiagnosticsInfo | null = null;

  // Feedback
  @state() private feedbackStats: FeedbackStats | null = null;
  @state() private feedbackEntries: FeedbackEntry[] = [];

  // Debounce timer for memory search
  private _memorySearchTimer: ReturnType<typeof setTimeout> | null = null;

  // Memory (session-scoped: backend has /api/sessions/{id}/memories, no global endpoint)
  @state() private memorySessions: SessionSummary[] = [];
  @state() private memorySessionId: string | null = null;
  @state() private memories: MemoryRecord[] = [];
  @state() private memorySearch = '';
  @state() private memoryScope = 'All';
  @state() private selectedMemoryId: string | null = null;

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

  /**
   * v0.8.1 (#246): each tab loads only its own data. Agent now also fetches
   * personas + toolsets + tools (merged from agent-view). Plugins owns
   * skills + config presets. Observability batches usage + memory sessions
   * + feedback because the tab renders them as stacked sub-sections.
   */
  private _loadTabData() {
    switch (this.activeTab) {
      case 'agent':
        this._loadAgentConfig();
        this._loadProvidersConfig();
        this._fetchPresets();
        this._fetchPersonas();
        this._fetchTools();
        break;
      case 'security':
        this._loadSecurityStatus();
        this._loadSecurityEvents();
        break;
      case 'observability':
        this._loadUsage();
        this._loadMemorySessions();
        this._loadFeedback();
        break;
      case 'system':
        this._loadSystem();
        this._loadRemoteAccess();
        this._loadDiagnostics();
        break;
      case 'plugins':
        this._fetchSkills();
        this._fetchPresets();
        break;
    }
  }

  private async _loadAgentConfig() {
    try {
      const data = await api<{ config: AgentConfig }>('/api/config/agent');
      this.agentConfig = data.config;
    } catch {
      this.agentConfig = {
        name: '',
        systemPrompt: '',
        temperature: 0.7,
        maxTokens: 4096,
        maxToolIterations: 10,
        concurrentToolCalls: true,
        synthesizeOnExhaustion: true,
        maxToolResultLength: 4000,
        requireApprovalForDangerousTools: true,
      };
    }
  }

  private async _loadProvidersConfig() {
    try {
      const data = await api<ProvidersConfig>('/api/providers/config');
      this.providersConfig = data;
    } catch {
      this.providersConfig = null;
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
      const data = await api<Record<string, unknown>>('/api/config/snapshot');
      // Capture active profile fields for the human-readable summary
      const presetName = data['activePresetName'];
      const toolsetName = data['activeToolsetName'];
      this.activePresetName =
        typeof presetName === 'string' && presetName ? presetName : null;
      this.activeToolsetName =
        typeof toolsetName === 'string' && toolsetName ? toolsetName : null;
      // Flatten the snapshot into displayable key-value pairs (kept for the
      // raw-config debug disclosure)
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(data)) {
        flat[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }
      this.systemConfig = flat;
    } catch {
      this.systemConfig = {};
      this.activePresetName = null;
      this.activeToolsetName = null;
    }
  }

  private async _loadRemoteAccess() {
    try {
      const data = await api<RemoteAccessConfig>('/api/config/remote-access');
      this.remoteAccess = {
        serverUrl: data.serverUrl ?? window.location.origin,
        publicUrl: data.publicUrl ?? '',
        trustProxy: data.trustProxy ?? false,
      };
    } catch {
      this.remoteAccess = {
        serverUrl: window.location.origin,
        publicUrl: '',
        trustProxy: false,
      };
    }
  }

  private async _loadDiagnostics() {
    try {
      const data = await api<DiagnosticsInfo>('/api/diagnostics');
      this.diagnostics = data;
    } catch {
      this.diagnostics = null;
    }
  }

  private async _loadMemorySessions() {
    try {
      const data = await api<{ sessions: SessionSummary[] }>('/api/sessions');
      this.memorySessions = (data.sessions || []).sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
      // Auto-select first session if none selected
      if (!this.memorySessionId && this.memorySessions.length > 0) {
        this.memorySessionId = this.memorySessions[0].sessionId;
        this._loadMemories();
      }
    } catch {
      this.memorySessions = [];
    }
  }

  private async _loadMemories() {
    if (!this.memorySessionId) {
      this.memories = [];
      return;
    }
    try {
      const params = new URLSearchParams();
      // Backend expects lowercase scope names (session/user/workspace); the
      // UI displays capitalized labels. Normalize on the wire.
      if (this.memoryScope !== 'All') params.set('scope', this.memoryScope.toLowerCase());
      const q = params.toString();
      const data = await api<{ records: Array<{ id: string; sessionId: string; scope: string; scopeKey?: string; summary: string; tags: string[]; createdAt: string; metadata?: Record<string, unknown> }> }>(
        `/api/sessions/${this.memorySessionId}/memories${q ? `?${q}` : ''}`,
      );
      let records: MemoryRecord[] = (data.records || []).map((r) => ({
        ...r,
        key: r.tags?.[0] ?? r.id?.slice(0, 8) ?? 'memory',
        value: r.summary ?? '',
        timestamp: r.createdAt ?? '',
      }));
      // Client-side search filter
      if (this.memorySearch) {
        const term = this.memorySearch.toLowerCase();
        records = records.filter(
          (m) =>
            m.key.toLowerCase().includes(term) ||
            m.value.toLowerCase().includes(term),
        );
      }
      this.memories = records;
    } catch {
      this.memories = [];
    }
  }

  private async _loadFeedback() {
    try {
      const data = await api<{ stats: FeedbackStats; recent: FeedbackEntry[] }>('/api/feedback');
      this.feedbackStats = data.stats ?? null;
      this.feedbackEntries = data.recent ?? [];
    } catch {
      this.feedbackStats = null;
      this.feedbackEntries = [];
    }
  }

  /* ---- #246 fetchers absorbed from agent-view ---- */

  private async _fetchPresets() {
    this.presetsLoading = true;
    this.configPresetsLoading = true;
    try {
      const [data, configData] = await Promise.all([
        api<PresetsResponse>('/api/presets'),
        api<ConfigPresetsResponse>('/api/config-presets').catch(() => ({ presets: [], active: null } as ConfigPresetsResponse)),
      ]);
      const activeToolset = data.activeToolset ?? null;

      this.presetToolsets = (data.toolsets ?? []).map((t) => ({
        id: t.name,
        name: t.name,
        description: t.description ?? `${t.toolNames?.length ?? 0} tools`,
        type: 'toolset',
        active: t.name === activeToolset,
      }));

      this.configPresets = (configData.presets ?? []).map((p) => ({
        id: p.name,
        name: p.name,
        description: p.description ?? 'Bundled configuration',
        type: 'config',
        active: p.name === configData.active,
      }));
    } catch (error: unknown) {
      if (error instanceof Error) showToast('Failed to fetch presets', 'error');
    } finally {
      this.presetsLoading = false;
      this.configPresetsLoading = false;
    }
  }

  /** #217: file-backed PersonaRegistry (the legacy hardcoded list is gone). */
  private async _fetchPersonas() {
    this.personasLoading = true;
    try {
      const data = await api<PersonasResponse>('/api/personas');
      this.personas = (data.personas ?? []).map((p) => ({
        id: p.name,
        name: p.name,
        description: p.active ? 'Currently active persona' : 'Registered persona',
        type: 'persona',
        active: p.active,
      }));
    } catch (error: unknown) {
      if (error instanceof Error) showToast('Failed to fetch personas', 'error');
    } finally {
      this.personasLoading = false;
    }
  }

  /** #218: per-tool override list. */
  private async _fetchTools() {
    this.toolsLoading = true;
    try {
      const data = await api<ToolsResponse>('/api/tools');
      this.tools = (data.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? '',
        disabled: Boolean(t.disabled),
      }));
    } catch (error: unknown) {
      if (error instanceof Error) showToast('Failed to fetch tools', 'error');
    } finally {
      this.toolsLoading = false;
    }
  }

  private async _toggleTool(tool: ToolEntry, nextDisabled: boolean) {
    try {
      await api(`/api/tools/${encodeURIComponent(tool.name)}/toggle`, {
        method: 'POST',
        body: JSON.stringify({ disabled: nextDisabled }),
      });
      await this._fetchTools();
    } catch (error: unknown) {
      if (error instanceof Error) showToast(`Failed to toggle ${tool.name}`, 'error');
    }
  }

  private async _fetchSkills() {
    this.skillsLoading = true;
    try {
      const data = await api<SkillsResponse>('/api/skills');
      this.skills = (data.skills ?? []).map((s) => ({
        slug: s.slug,
        title: s.title,
        summary: s.summary,
        triggers: s.triggerPhrases ?? [],
        steps: s.steps ?? [],
        tools: s.requiredTools ?? [],
      }));
    } catch (error: unknown) {
      if (error instanceof Error) showToast('Failed to fetch skills', 'error');
    } finally {
      this.skillsLoading = false;
    }
  }

  private async _createSkill() {
    const title = this.formTitle.trim();
    const summary = this.formSummary.trim();
    if (!title) return;
    const triggers = this._splitLines(this.formTriggers);
    const steps = this._splitLines(this.formSteps);
    const tools = this._splitLines(this.formTools);
    try {
      await api('/api/skills', {
        method: 'POST',
        body: JSON.stringify({ title, summary, triggerPhrases: triggers, steps, requiredTools: tools }),
      });
      this._resetSkillForm();
      await this._fetchSkills();
    } catch (error: unknown) {
      if (error instanceof Error) showToast('Failed to create skill', 'error');
    }
  }

  private async _updateSkill(slug: string) {
    const title = this.formTitle.trim();
    const summary = this.formSummary.trim();
    if (!title) return;
    const triggers = this._splitLines(this.formTriggers);
    const steps = this._splitLines(this.formSteps);
    const tools = this._splitLines(this.formTools);
    try {
      await api(`/api/skills/${slug}`, {
        method: 'PUT',
        body: JSON.stringify({ title, summary, triggerPhrases: triggers, steps, requiredTools: tools }),
      });
      this._resetSkillForm();
      await this._fetchSkills();
    } catch (error: unknown) {
      if (error instanceof Error) showToast('Failed to update skill', 'error');
    }
  }

  private async _deleteSkill(slug: string) {
    try {
      await api(`/api/skills/${slug}`, { method: 'DELETE' });
      this.skills = this.skills.filter((s) => s.slug !== slug);
    } catch (error: unknown) {
      if (error instanceof Error) showToast('Failed to delete skill', 'error');
    }
  }

  private _editSkill(skill: Skill) {
    this.editingSkillSlug = skill.slug;
    this.formTitle = skill.title;
    this.formSummary = skill.summary;
    this.formTriggers = skill.triggers.join('\n');
    this.formSteps = skill.steps.join('\n');
    this.formTools = skill.tools.join('\n');
    this.showSkillForm = true;
    this.showImportForm = false;
  }

  private async _importSkillMd() {
    const text = this.importText.trim();
    if (!text) return;
    const parsed = this._parseSkillMd(text);
    if (!parsed.title) return;
    try {
      await api('/api/skills', {
        method: 'POST',
        body: JSON.stringify({
          title: parsed.title,
          summary: parsed.summary,
          triggerPhrases: parsed.triggers,
          steps: parsed.steps,
          requiredTools: parsed.tools,
        }),
      });
      this.importText = '';
      this.showImportForm = false;
      await this._fetchSkills();
    } catch (error: unknown) {
      if (error instanceof Error) showToast('Failed to import skill', 'error');
    }
  }

  private async _activatePreset(preset: Preset) {
    const endpointMap: Partial<Record<Preset['type'], string>> = {
      persona: '/api/persona/switch',
      toolset: '/api/toolset/select',
      config: '/api/config-presets/switch',
    };
    const endpoint = endpointMap[preset.type];
    if (!endpoint) {
      showToast(`Activation not supported for ${preset.type} presets`, 'error');
      return;
    }
    try {
      await api(endpoint, {
        method: 'POST',
        body: JSON.stringify({ name: preset.name }),
      });
      await Promise.all([this._fetchPresets(), this._fetchPersonas()]);
    } catch (error: unknown) {
      if (error instanceof Error) showToast('Failed to activate preset', 'error');
    }
  }

  private _splitLines(text: string): string[] {
    return text.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  private _parseSkillMd(md: string): { title: string; summary: string; triggers: string[]; steps: string[]; tools: string[] } {
    const result = { title: '', summary: '', triggers: [] as string[], steps: [] as string[], tools: [] as string[] };
    const titleMatch = md.match(/^#\s+(.+)$/m);
    if (titleMatch) result.title = titleMatch[1].trim();

    const sections = new Map<string, string>();
    const sectionRegex = /^##\s+(.+)$/gm;
    let match: RegExpExecArray | null;
    const headings: { name: string; index: number }[] = [];
    while ((match = sectionRegex.exec(md)) !== null) {
      headings.push({ name: match[1].trim().toLowerCase(), index: match.index + match[0].length });
    }
    for (let i = 0; i < headings.length; i++) {
      const start = headings[i].index;
      const end = i + 1 < headings.length ? headings[i + 1].index - headings[i + 1].name.length - 3 : md.length;
      sections.set(headings[i].name, md.slice(start, end).trim());
    }

    if (!titleMatch) {
      result.summary = md.slice(0, 100);
    } else {
      const afterTitle = md.slice((titleMatch.index ?? 0) + titleMatch[0].length);
      const nextHeading = afterTitle.indexOf('\n##');
      const summaryBlock = nextHeading > -1 ? afterTitle.slice(0, nextHeading) : afterTitle.slice(0, 200);
      result.summary = summaryBlock.trim().split('\n')[0] ?? '';
    }

    const extractListItems = (text: string): string[] =>
      text
        .split('\n')
        .filter((l) => l.match(/^[-*]\s/))
        .map((l) => l.replace(/^[-*]\s+/, '').trim())
        .filter(Boolean);

    for (const [name, content] of sections) {
      if (name.includes('trigger')) result.triggers = extractListItems(content);
      else if (name.includes('step')) result.steps = extractListItems(content);
      else if (name.includes('tool')) result.tools = extractListItems(content);
    }

    return result;
  }

  private _resetSkillForm() {
    this.formTitle = '';
    this.formSummary = '';
    this.formTriggers = '';
    this.formSteps = '';
    this.formTools = '';
    this.showSkillForm = false;
    this.editingSkillSlug = null;
  }

  private get _filteredSkills(): Skill[] {
    const q = this.skillSearch.toLowerCase();
    if (!q) return this.skills;
    return this.skills.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.summary.toLowerCase().includes(q) ||
        s.triggers.some((t) => t.toLowerCase().includes(q)),
    );
  }

  private get _identityLoading(): boolean {
    return this.identityTab === 'personas' ? this.personasLoading : this.presetsLoading;
  }

  /* ---------------------------------------------------------------- */
  /*  Actions                                                         */
  /* ---------------------------------------------------------------- */

  private async _saveAgentConfig() {
    if (!this.agentConfig) return;
    this.agentSaving = true;
    this.agentStatus = null;
    try {
      await api('/api/config/agent', {
        method: 'POST',
        body: JSON.stringify(this.agentConfig),
      });
      this.agentStatus = { msg: 'Configuration saved.', ok: true };
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : 'Failed to save configuration.';
      this.agentStatus = { msg, ok: false };
      showToast(msg, 'error');
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
    if (!window.confirm('Are you sure you want to clear all security events?')) return;
    try {
      await api('/api/security/events/clear', { method: 'POST' });
      this.securityEvents = [];
      showToast('Security events cleared.', 'success');
    } catch {
      /* ignore */
    }
  }

  private async _resetUsage() {
    if (!window.confirm('Are you sure you want to reset all usage data?')) return;
    try {
      await api('/api/usage/reset', { method: 'POST' });
      this._loadUsage();
      showToast('Usage data reset.', 'success');
    } catch {
      /* ignore */
    }
  }

  /**
   * Issue #176: empty-state CTAs in this view (Memory / Usage) navigate to
   * the chat tab so the user can produce data. Uses hash-based routing
   * already wired in `app.ts`.
   */
  private _navigateToChat = () => {
    if (typeof location !== 'undefined') {
      location.hash = 'chat';
    }
  };

  private async _saveRemoteAccess() {
    this.remoteAccessSaving = true;
    try {
      await api('/api/config/remote-access', {
        method: 'POST',
        body: JSON.stringify({
          publicUrl: this.remoteAccess.publicUrl,
          trustProxy: this.remoteAccess.trustProxy,
        }),
      });
    } catch (error: unknown) {
      if (error instanceof Error) {
        showToast('Failed to save remote access config', 'error');
      }
    } finally {
      this.remoteAccessSaving = false;
    }
  }

  private async _deleteMemory(id: string) {
    if (!window.confirm('Are you sure you want to delete this memory?')) return;
    try {
      await api(`/api/memories/${id}`, { method: 'DELETE' });
      this.memories = this.memories.filter((m) => m.id !== id);
      if (this.selectedMemoryId === id) {
        this.selectedMemoryId = null;
      }
      showToast('Memory deleted.', 'success');
    } catch {
      /* ignore */
    }
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
        <div class="tab-row" role="tablist" aria-label="Settings tabs">
          <span class="tab-row-label">Settings</span>
          ${PRIMARY_TABS.map(
            (t) => html`
              <div
                class="tab ${this.activeTab === t.key ? 'active' : ''}"
                role="tab"
                aria-selected=${this.activeTab === t.key}
                @click=${() => this._switchTab(t.key)}
              >
                ${t.label}
              </div>
            `,
          )}
        </div>
        <div class="tab-row advanced" role="tablist" aria-label="Advanced tabs">
          <span class="tab-row-label">Advanced</span>
          ${ADVANCED_TABS.map(
            (t) => html`
              <div
                class="tab ${this.activeTab === t.key ? 'active' : ''}"
                role="tab"
                aria-selected=${this.activeTab === t.key}
                @click=${() => this._switchTab(t.key)}
              >
                ${t.label}
              </div>
            `,
          )}
        </div>
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
      case 'observability':
        return this._renderObservability();
      case 'system':
        return this._renderSystem();
      case 'plugins':
        return this._renderPlugins();
      default:
        return nothing;
    }
  }

  /* ---- v0.8.1 (#246) Observability tab — usage / memory / feedback stacked ---- */

  private _renderObservability() {
    return html`
      ${this._renderUsage()}
      ${this._renderMemory()}
      ${this._renderFeedback()}
    `;
  }

  /* ---- v0.8.1 (#246) Plugins tab — Skills + Config Presets + MCP hint ---- */

  private _renderPlugins() {
    return html`
      ${this._renderSkillsSection()}
      ${this._renderConfigPresetsSection()}
      <div class="section-block">
        <div class="section-header">MCP Servers</div>
        <p class="hint">MCP servers are managed in <a href="#connect">Connect → MCP Servers</a>.</p>
      </div>
    `;
  }

  /* ---- Agent Config ---- */

  private _renderAgent() {
    const cfg = this.agentConfig;
    if (!cfg) return html`<div class="status-msg">Loading...</div>`;

    const primary = this.providersConfig?.primary;
    const activeModelLine = primary?.model
      ? html`<div class="form-group">
          <span class="label" style="color:var(--text-muted);font-size:var(--text-xs)">Active model:</span>
          <span style="font-family:var(--font-mono);font-size:var(--text-sm);color:var(--text-primary);margin-left:var(--sp-2)">${primary.model}</span>
          <span style="color:var(--text-muted);margin:0 var(--sp-2)">·</span>
          <a href="#connect" style="color:var(--accent);font-size:var(--text-xs);text-decoration:none">Edit in Connect → Providers</a>
        </div>`
      : html`<div class="form-group">
          <span class="label" style="color:var(--text-muted);font-size:var(--text-xs)">Active model:</span>
          <span style="font-size:var(--text-sm);color:var(--text-muted);margin-left:var(--sp-2)">not configured</span>
          <span style="color:var(--text-muted);margin:0 var(--sp-2)">·</span>
          <a href="#connect" style="color:var(--accent);font-size:var(--text-xs);text-decoration:none">Set in Connect → Providers</a>
        </div>`;

    return html`
      <div class="section-block">
        <div class="section-header">Agent Configuration</div>

        <p class="hint">Provider, model, and API key are configured in <a href="#connect">Connect → Providers</a>.</p>

        ${activeModelLine}

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

        <div class="form-group">
          <label class="form-label">Max Tool Iterations</label>
          <input
            class="form-input"
            type="number"
            min="1"
            max="50"
            step="1"
            .value=${String(cfg.maxToolIterations ?? 10)}
            @input=${(e: InputEvent) => {
              this.agentConfig = {
                ...cfg,
                maxToolIterations: parseInt((e.target as HTMLInputElement).value, 10) || 10,
              };
            }}
          />
          <div class="form-hint">Maximum number of tool call iterations per turn (1-50)</div>
        </div>

        <div class="form-group">
          <label class="form-label">Max Tool Result Length</label>
          <input
            class="form-input"
            type="number"
            min="100"
            max="20000"
            step="100"
            .value=${String(cfg.maxToolResultLength ?? 4000)}
            @input=${(e: InputEvent) => {
              this.agentConfig = {
                ...cfg,
                maxToolResultLength: parseInt((e.target as HTMLInputElement).value, 10) || 4000,
              };
            }}
          />
          <div class="form-hint">Maximum character length for tool results (100-20000)</div>
        </div>

        <div class="sub-card" style="margin-top:var(--sp-3)">
          <div class="toggle-row">
            <div class="toggle-info">
              <div class="toggle-name">Concurrent Tool Calls</div>
              <div class="toggle-desc">Allow the agent to execute multiple tool calls in parallel.</div>
            </div>
            <label class="switch">
              <input
                type="checkbox"
                .checked=${cfg.concurrentToolCalls ?? true}
                @change=${(e: Event) => {
                  this.agentConfig = {
                    ...cfg,
                    concurrentToolCalls: (e.target as HTMLInputElement).checked,
                  };
                }}
              />
              <span class="slider"></span>
            </label>
          </div>

          <div class="toggle-row">
            <div class="toggle-info">
              <div class="toggle-name">Synthesize on Exhaustion</div>
              <div class="toggle-desc">Generate a summary response when tool iterations are exhausted.</div>
            </div>
            <label class="switch">
              <input
                type="checkbox"
                .checked=${cfg.synthesizeOnExhaustion ?? true}
                @change=${(e: Event) => {
                  this.agentConfig = {
                    ...cfg,
                    synthesizeOnExhaustion: (e.target as HTMLInputElement).checked,
                  };
                }}
              />
              <span class="slider"></span>
            </label>
          </div>

          <div class="toggle-row">
            <div class="toggle-info">
              <div class="toggle-name">Require Approval for Dangerous Tools</div>
              <div class="toggle-desc">Prompt for user confirmation before executing tools marked as dangerous.</div>
            </div>
            <label class="switch">
              <input
                type="checkbox"
                .checked=${cfg.requireApprovalForDangerousTools ?? true}
                @change=${(e: Event) => {
                  this.agentConfig = {
                    ...cfg,
                    requireApprovalForDangerousTools: (e.target as HTMLInputElement).checked,
                  };
                }}
              />
              <span class="slider"></span>
            </label>
          </div>
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

      ${this._renderIdentitySection()}
    `;
  }

  /* ---- #246: Identity sub-section absorbed from agent-view ---- */

  private _renderIdentitySection() {
    return html`
      <div class="section-block">
        <div class="section-header">Identity</div>
        <p class="hint">Manage agent personas and toolset overrides. MCP servers in <a href="#connect">Connect</a>.</p>
        <div class="tabs" role="tablist" aria-label="Identity tabs">
          <div class="tab ${this.identityTab === 'personas' ? 'active' : ''}"
               role="tab"
               aria-selected=${this.identityTab === 'personas'}
               @click=${() => { this.identityTab = 'personas'; }}>Personas</div>
          <div class="tab ${this.identityTab === 'toolsets' ? 'active' : ''}"
               role="tab"
               aria-selected=${this.identityTab === 'toolsets'}
               @click=${() => { this.identityTab = 'toolsets'; }}>Toolsets</div>
        </div>
        ${this._renderIdentityTabContent()}
      </div>
    `;
  }

  private _renderIdentityTabContent() {
    if (this._identityLoading) {
      return html`<div class="status-msg">Loading ${this.identityTab}…</div>`;
    }
    if (this.identityTab === 'personas') {
      return this._renderPersonasPanel();
    }
    return this._renderToolsetsPanel();
  }

  private _renderPersonasPanel() {
    if (this.personas.length === 0) {
      return html`<crowclaw-empty
        icon="memory"
        title="No personas yet"
        description="Create a persona file under your config directory to get started."
        cta-label="View documentation"
        cta-href="https://github.com/subinium/CrowClaw#personas"
      ></crowclaw-empty>`;
    }
    return html`
      <div class="grid">
        ${this.personas.map((p) => this._renderPresetCard(p))}
      </div>
    `;
  }

  private _renderToolsetsPanel() {
    return html`
      ${this.presetToolsets.length === 0
        ? html`<crowclaw-empty
            icon="skills"
            title="No toolsets configured"
            description="Toolsets are bundles of tools you can switch between. Configure them in your runtime config file."
          ></crowclaw-empty>`
        : html`
            <div class="grid">
              ${this.presetToolsets.map((p) => this._renderPresetCard(p))}
            </div>
          `}
      ${this._renderToolOverrides()}
    `;
  }

  private _renderToolOverrides() {
    return html`
      <div class="sec-h" style="margin-top:var(--sp-5)">Individual tool overrides</div>
      ${this.toolsLoading
        ? html`<div class="status-msg">Loading tools…</div>`
        : this.tools.length === 0
          ? html`<crowclaw-empty
              icon="skills"
              title="No tools registered"
              description="Activate a toolset or config preset to populate the tool registry."
            ></crowclaw-empty>`
          : html`
              <div class="grid">
                ${this.tools.map((tool) => this._renderToolRow(tool))}
              </div>
            `}
    `;
  }

  private _renderToolRow(tool: ToolEntry) {
    const enabled = !tool.disabled;
    return html`
      <div class="card">
        <div class="card-name" style="font-size:var(--text-sm);font-weight:600;color:var(--text-primary);margin-bottom:var(--sp-1);display:flex;align-items:center;gap:var(--sp-2)">
          ${tool.name}
          ${enabled ? nothing : html`<span class="tag">Disabled</span>`}
        </div>
        <div class="card-desc" style="font-size:var(--text-xs);color:var(--text-secondary);line-height:1.5;margin-bottom:var(--sp-3)">${tool.description || 'No description'}</div>
        <div class="card-footer" style="display:flex;justify-content:flex-end;margin-top:var(--sp-3);padding-top:var(--sp-3);border-top:1px solid var(--glass-border)">
          <crowclaw-toggle
            .checked=${enabled}
            aria-label="Toggle tool ${tool.name}"
            @change=${(e: CustomEvent<boolean>) => this._toggleTool(tool, !e.detail)}
          ></crowclaw-toggle>
        </div>
      </div>
    `;
  }

  private _renderPresetCard(preset: Preset) {
    return html`
      <div class="card">
        <div class="card-name" style="font-size:var(--text-sm);font-weight:600;color:var(--text-primary);margin-bottom:var(--sp-1);display:flex;align-items:center;gap:var(--sp-2)">
          ${preset.name}
          ${preset.active ? html`<span class="tag" style="color:var(--success)">Active</span>` : nothing}
        </div>
        <div class="card-desc" style="font-size:var(--text-xs);color:var(--text-secondary);line-height:1.5;margin-bottom:var(--sp-3)">${preset.description || 'No description'}</div>
        <div class="card-footer" style="display:flex;justify-content:flex-end;margin-top:var(--sp-3);padding-top:var(--sp-3);border-top:1px solid var(--glass-border)">
          ${preset.active
            ? html`<span class="tag ok">Activated</span>`
            : html`<button class="btn btn-p" @click=${() => this._activatePreset(preset)}>Activate</button>`}
        </div>
      </div>
    `;
  }

  /* ---- #246: Skills + Config Presets sections (Plugins tab) ---- */

  private _renderSkillsSection() {
    return html`
      <div class="section-block">
        <div class="section-header">Skills</div>
        <p class="hint">Reusable skill definitions that map trigger phrases to tool execution steps.</p>

        <div class="filter-row">
          <input class="srch"
                 type="text"
                 placeholder="Search skills..."
                 aria-label="Search skills"
                 .value=${this.skillSearch}
                 @input=${(e: InputEvent) => { this.skillSearch = (e.target as HTMLInputElement).value; }}>
          <button class="btn btn-p"
                  aria-label="Create skill"
                  @click=${() => { this._resetSkillForm(); this.showSkillForm = true; this.showImportForm = false; }}>
            Create Skill
          </button>
          <button class="btn"
                  aria-label="Import skill from markdown"
                  @click=${() => { this.showImportForm = !this.showImportForm; this.showSkillForm = false; this._resetSkillForm(); }}>
            Import SKILL.md
          </button>
        </div>

        ${this.showImportForm ? this._renderImportForm() : nothing}
        ${this.showSkillForm ? this._renderSkillForm() : nothing}

        ${this.skillsLoading
          ? html`<div class="status-msg">Loading skills…</div>`
          : this._filteredSkills.length === 0
            ? this.skills.length === 0
              ? html`<crowclaw-empty
                  icon="skills"
                  title="No skills loaded"
                  description="Skills map trigger phrases to tool execution steps. Browse the OpenClaw catalog or drop SKILL.md files into .crowclaw/skills/."
                  cta-label="Browse the catalog"
                  cta-href="https://github.com/subinium/openclaw"
                ></crowclaw-empty>`
              : html`<crowclaw-empty
                  icon="skills"
                  title="No matching skills"
                  description="Try a different search term."
                ></crowclaw-empty>`
            : html`
                <div class="grid">
                  ${this._filteredSkills.map((s) => this._renderSkillCard(s))}
                </div>
              `}
      </div>
    `;
  }

  private _renderSkillCard(skill: Skill) {
    return html`
      <div class="card ${this.editingSkillSlug === skill.slug ? 'editing' : ''}">
        <div class="card-name" style="font-size:var(--text-sm);font-weight:600;color:var(--text-primary);margin-bottom:var(--sp-1)">${skill.title}</div>
        <div class="card-desc" style="font-size:var(--text-xs);color:var(--text-secondary);line-height:1.5;margin-bottom:var(--sp-3)">${skill.summary || 'No summary'}</div>
        ${skill.triggers.length > 0
          ? html`
              <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:var(--sp-2)">
                ${skill.triggers.map((t) => html`<span class="tag">${t}</span>`)}
              </div>
            `
          : nothing}
        <div style="display:flex;gap:var(--sp-2);margin-top:var(--sp-3);border-top:1px solid var(--glass-border);padding-top:var(--sp-3)">
          <button class="btn" aria-label="Edit skill" @click=${() => this._editSkill(skill)}>Edit</button>
          <button class="btn btn-danger" aria-label="Delete skill" @click=${() => this._deleteSkill(skill.slug)}>Delete</button>
        </div>
      </div>
    `;
  }

  private _renderSkillForm() {
    const isEdit = this.editingSkillSlug !== null;
    return html`
      <div class="sub-card" style="padding:var(--sp-5);margin-bottom:var(--sp-5)">
        <div style="font-size:var(--text-base);font-weight:600;color:var(--text-primary);margin-bottom:var(--sp-4)">${isEdit ? 'Edit Skill' : 'Create Skill'}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-4)">
          <div class="form-group">
            <label class="form-label">Title</label>
            <input class="form-input"
                   type="text"
                   placeholder="e.g. Web Search"
                   .value=${this.formTitle}
                   @input=${(e: InputEvent) => { this.formTitle = (e.target as HTMLInputElement).value; }}>
          </div>
          <div class="form-group">
            <label class="form-label">Summary</label>
            <input class="form-input"
                   type="text"
                   placeholder="Brief description of the skill"
                   .value=${this.formSummary}
                   @input=${(e: InputEvent) => { this.formSummary = (e.target as HTMLInputElement).value; }}>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Trigger Phrases</label>
          <textarea class="form-input"
                    placeholder="One trigger phrase per line"
                    .value=${this.formTriggers}
                    @input=${(e: InputEvent) => { this.formTriggers = (e.target as HTMLTextAreaElement).value; }}></textarea>
          <div class="form-hint">One phrase per line. These are used to match user intent.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Steps</label>
          <textarea class="form-input"
                    placeholder="One step per line"
                    .value=${this.formSteps}
                    @input=${(e: InputEvent) => { this.formSteps = (e.target as HTMLTextAreaElement).value; }}></textarea>
          <div class="form-hint">Ordered execution steps for this skill.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Tools</label>
          <input class="form-input"
                 type="text"
                 placeholder="Tool names, one per line or comma-separated"
                 .value=${this.formTools}
                 @input=${(e: InputEvent) => { this.formTools = (e.target as HTMLInputElement).value; }}>
          <div class="form-hint">Tools required by this skill (e.g. web.search, fs.read).</div>
        </div>
        <div class="form-actions">
          <button class="btn" @click=${() => this._resetSkillForm()}>Cancel</button>
          ${isEdit
            ? html`<button class="btn btn-p" @click=${() => this._updateSkill(this.editingSkillSlug!)}>Save Changes</button>`
            : html`<button class="btn btn-p" @click=${this._createSkill}>Create</button>`}
        </div>
      </div>
    `;
  }

  private _renderImportForm() {
    return html`
      <div class="sub-card" style="padding:var(--sp-5);margin-bottom:var(--sp-5)">
        <div style="font-size:var(--text-base);font-weight:600;color:var(--text-primary);margin-bottom:var(--sp-3)">Import SKILL.md</div>
        <div class="form-group">
          <textarea class="form-input"
                    rows="10"
                    placeholder="Paste the contents of a SKILL.md file here..."
                    .value=${this.importText}
                    @input=${(e: InputEvent) => { this.importText = (e.target as HTMLTextAreaElement).value; }}></textarea>
        </div>
        <div class="form-actions">
          <button class="btn" @click=${() => { this.showImportForm = false; this.importText = ''; }}>Cancel</button>
          <button class="btn btn-p" @click=${this._importSkillMd}>Import</button>
        </div>
      </div>
    `;
  }

  private _renderConfigPresetsSection() {
    return html`
      <div class="section-block">
        <div class="section-header">Config Presets</div>
        <p class="hint">Bundled configurations that combine MCP servers, skills, and tools into a single activatable preset.</p>
        ${this.configPresetsLoading
          ? html`<div class="status-msg">Loading config presets…</div>`
          : this.configPresets.length === 0
            ? html`<crowclaw-empty
                icon="skills"
                title="No config presets"
                description="Config presets bundle MCP servers, skills, and tools together so you can switch the agent's whole environment in one click."
              ></crowclaw-empty>`
            : html`
                <div class="grid">
                  ${this.configPresets.map((p) => this._renderPresetCard(p))}
                </div>
              `}
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
                ${sec.protections.map((p) => {
                  const isSsrf = p.key.toLowerCase().includes('ssrf');
                  return html`
                    <div class="toggle-row">
                      <div class="toggle-info">
                        <div class="toggle-name">${p.name}</div>
                        ${p.description
                          ? html`<div class="toggle-desc">${p.description}</div>`
                          : nothing}
                      </div>
                      ${isSsrf
                        ? html`<span
                            class="protection-badge"
                            title="SSRF protection is enforced at the code level and cannot be disabled at runtime."
                            aria-label="SSRF protection is enforced at the code level and cannot be disabled at runtime."
                          >Always on (enforced)</span>`
                        : html`<label class="switch">
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
                          </label>`}
                    </div>
                  `;
                })}
              </div>
            `
          : html`<div class="status-msg">Loading security status...</div>`}

        <!-- Event log -->
        <div class="actions-row">
          <div class="sec-h" style="margin-bottom:0">Event Log</div>
          <button class="btn btn-danger" aria-label="Clear security event log" @click=${this._clearSecurityEvents}>
            Clear Log
          </button>
        </div>

        <div class="filter-row">
          <select
            aria-label="Filter events by type"
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
            aria-label="Filter events by severity"
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
                            ${formatTime(ev.timestamp)}
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
          <button class="btn btn-danger" aria-label="Reset usage data" @click=${this._resetUsage}>Reset Usage</button>
        </div>

        ${usage
          ? html`
              <!-- Summary -->
              <div class="summary-row">
                <div class="summary-card">
                  <div class="label">Total Tokens</div>
                  <div class="value">${formatTokens(usage.totalTokens)}</div>
                </div>
                <div class="summary-card">
                  <div class="label">Input Tokens</div>
                  <div class="value">${formatTokens(usage.totalInputTokens)}</div>
                </div>
                <div class="summary-card">
                  <div class="label">Output Tokens</div>
                  <div class="value">${formatTokens(usage.totalOutputTokens)}</div>
                </div>
                <div class="summary-card">
                  <div class="label">Total Cost</div>
                  <div class="value">${formatCost(usage.totalCostUsd)}</div>
                </div>
                <div class="summary-card">
                  <div class="label">Avg Latency</div>
                  <div class="value">${Math.round(usage.avgLatencyMs)}ms</div>
                </div>
              </div>

              <!-- Per-model breakdown -->
              <div class="sec-h">Per-Model Breakdown</div>
              ${Object.keys(usage.byModel).length > 0
                ? html`
                    <div class="sub-card" style="overflow-x:auto;margin-bottom:var(--sp-5)">
                      <table class="data-table">
                        <thead>
                          <tr>
                            <th>Model</th>
                            <th>Tokens</th>
                            <th>Cost</th>
                            <th>Calls</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${Object.entries(usage.byModel).map(
                            ([model, stats]) => html`
                              <tr>
                                <td style="font-family:var(--font-mono);font-size:var(--text-xs)">
                                  ${model}
                                </td>
                                <td>${formatTokens(stats.tokens)}</td>
                                <td>${formatCost(stats.cost)}</td>
                                <td>${stats.calls}</td>
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
                            <th>Input</th>
                            <th>Output</th>
                            <th>Total</th>
                            <th>Cost</th>
                            <th>Latency</th>
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
                                <td>${formatTokens(e.inputTokens)}</td>
                                <td>${formatTokens(e.outputTokens)}</td>
                                <td>${formatTokens(e.totalTokens)}</td>
                                <td>${formatCost(e.costUsd)}</td>
                                <td>${Math.round(e.latencyMs)}ms</td>
                              </tr>
                            `,
                          )}
                        </tbody>
                      </table>
                    </div>
                  `
                : html`<crowclaw-empty
                    icon="usage"
                    title="No LLM calls yet"
                    description="LLM usage and cost are tracked per call. Start a chat to populate this dashboard."
                    cta-label="Start a chat"
                    cta-event="cc-empty-go-chat"
                    @cc-empty-go-chat=${this._navigateToChat}
                  ></crowclaw-empty>`}
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
        <div class="section-header">Active Profile</div>

        <div class="profile-summary">
          <div>
            <span class="label">Active persona:</span>
            <span>${this.activePresetName ?? '—'}</span>
          </div>
          <div>
            <span class="label">Active toolset:</span>
            <span>${this.activeToolsetName ?? '—'}</span>
          </div>
        </div>

        ${entries.length > 0
          ? html`
              <details class="raw-config-disclosure">
                <summary>Show raw config</summary>
                <div class="sub-card" style="margin-top:var(--sp-2)">
                  ${entries.map(
                    ([k, v]) => html`
                      <div class="kv">
                        <span class="kv-k">${k}</span>
                        <span class="kv-v">${v}</span>
                      </div>
                    `,
                  )}
                </div>
              </details>
            `
          : html`<div class="status-msg" style="color:var(--text-muted)">
              No system configuration available.
            </div>`}
      </div>

      ${this._renderRemoteAccess()}
      ${this._renderDiagnostics()}
    `;
  }

  /* ---- Remote Access ---- */

  private _renderRemoteAccess() {
    return html`
      <div class="section-block">
        <div class="section-header">Remote Access</div>

        <div class="form-group">
          <label class="form-label">Server URL</label>
          <div class="kv" style="margin-bottom:var(--sp-3)">
            <span class="kv-k">Current</span>
            <span class="kv-v">${this.remoteAccess.serverUrl || window.location.origin}</span>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Public URL</label>
          <input
            class="form-input"
            type="text"
            placeholder="https://your-public-url.example.com"
            aria-label="Public URL"
            .value=${this.remoteAccess.publicUrl}
            @input=${(e: InputEvent) => {
              this.remoteAccess = { ...this.remoteAccess, publicUrl: (e.target as HTMLInputElement).value };
            }}
          />
          <div class="form-hint">External URL used by remote clients to connect to this server.</div>
        </div>

        <div class="toggle-row" style="border:1px solid var(--glass-border);border-radius:var(--radius-md);margin-top:var(--sp-3)">
          <div class="toggle-info">
            <div class="toggle-name">Trust Proxy</div>
            <div class="toggle-desc">Enable when running behind a reverse proxy (e.g. nginx, Cloudflare).</div>
          </div>
          <label class="switch" aria-label="Toggle trust proxy">
            <input
              type="checkbox"
              .checked=${this.remoteAccess.trustProxy}
              @change=${(e: Event) => {
                this.remoteAccess = { ...this.remoteAccess, trustProxy: (e.target as HTMLInputElement).checked };
              }}
            />
            <span class="slider"></span>
          </label>
        </div>

        <div class="form-actions">
          <button
            class="btn btn-p"
            aria-label="Save remote access configuration"
            ?disabled=${this.remoteAccessSaving}
            @click=${this._saveRemoteAccess}
          >
            ${this.remoteAccessSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    `;
  }

  /* ---- Diagnostics ---- */

  private _renderDiagnostics() {
    const diag = this.diagnostics;

    return html`
      <div class="section-block">
        <div class="actions-row">
          <div class="section-header" style="border:none;padding:0;margin:0">Diagnostics</div>
          <button class="btn" aria-label="Refresh diagnostics" @click=${this._loadDiagnostics}>Refresh</button>
        </div>

        ${diag
          ? html`
              <div class="summary-row">
                <div class="summary-card">
                  <div class="label">Node Version</div>
                  <div class="value" style="font-size:var(--text-sm)">${diag.nodeVersion}</div>
                </div>
                <div class="summary-card">
                  <div class="label">Platform</div>
                  <div class="value" style="font-size:var(--text-sm)">${diag.platform}</div>
                </div>
                <div class="summary-card">
                  <div class="label">WebSocket Connections</div>
                  <div class="value">${diag.wsConnections}</div>
                </div>
                <div class="summary-card">
                  <div class="label">Active Sessions</div>
                  <div class="value">${diag.activeSessions}</div>
                </div>
              </div>
              <div class="sub-card">
                <div class="kv">
                  <span class="kv-k">Last Heartbeat</span>
                  <span class="kv-v">${diag.lastHeartbeat ? formatTime(diag.lastHeartbeat) : '--'}</span>
                </div>
              </div>
            `
          : html`<div class="status-msg" style="color:var(--text-muted)">
              Loading diagnostics...
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

        <!-- Session selector -->
        <div class="filter-row" style="margin-bottom:var(--sp-3)">
          <select
            aria-label="Select memory session"
            @change=${(e: Event) => {
              this.memorySessionId = (e.target as HTMLSelectElement).value || null;
              this.selectedMemoryId = null;
              this._loadMemories();
            }}
          >
            <option value="">Select session...</option>
            ${this.memorySessions.map(
              (s) => html`
                <option
                  value=${s.sessionId}
                  ?selected=${this.memorySessionId === s.sessionId}
                >
                  ${s.title || s.sessionId}
                </option>
              `,
            )}
          </select>
        </div>

        ${this.memorySessionId
          ? html`
              <input
                class="srch"
                type="text"
                placeholder="Search memories..."
                aria-label="Search memories"
                .value=${this.memorySearch}
                @input=${(e: InputEvent) => {
                  this.memorySearch = (e.target as HTMLInputElement).value;
                  if (this._memorySearchTimer) clearTimeout(this._memorySearchTimer);
                  this._memorySearchTimer = setTimeout(() => this._loadMemories(), 300);
                }}
              />

              <div class="scope-row">
                ${MEMORY_SCOPES.map(
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
                                aria-label="Delete memory record"
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
                    No memories found for this session.
                  </div>`}
            `
          : this.memorySessions.length === 0
            ? html`<crowclaw-empty
                icon="memory"
                title="No memories yet"
                description="Memories are captured automatically when you chat. Start a conversation to build agent recall."
                cta-label="Start a chat"
                cta-event="cc-empty-go-chat"
                @cc-empty-go-chat=${this._navigateToChat}
              ></crowclaw-empty>`
            : html`<div class="status-msg" style="color:var(--text-muted)">
                Select a session to browse its memories.
              </div>`}
      </div>
    `;
  }

  /* ---- Feedback ---- */

  private _renderFeedback() {
    const stats = this.feedbackStats;
    const successRate = stats && stats.total > 0
      ? ((stats.success / stats.total) * 100).toFixed(1)
      : '0.0';

    // #229: Empty state — when the ledger is unpopulated, show a CTA that
    // points the user toward generating tool-call traffic (i.e. start a chat
    // with tools enabled). Without this, the tab renders four "0" cards plus
    // a "No per-tool data yet" line, which reads as broken to first-run users.
    if (stats && stats.total === 0 && this.feedbackEntries.length === 0) {
      return html`
        <div class="section-block">
          <div class="section-header">Feedback Ledger</div>
          <crowclaw-empty
            icon="feedback"
            title="No tool calls recorded yet"
            description="The feedback ledger fills as the agent invokes tools. Start a chat that asks for web search, file ops, or any other tool to populate this view."
            cta-label="Start a chat"
            cta-event="cc-empty-go-chat"
            @cc-empty-go-chat=${this._navigateToChat}
          ></crowclaw-empty>
        </div>
      `;
    }

    return html`
      <div class="section-block">
        <div class="section-header">Feedback Ledger</div>

        ${stats
          ? html`
              <!-- Summary cards -->
              <div class="summary-row">
                <div class="summary-card">
                  <div class="label">Total Calls</div>
                  <div class="value">${stats.total}</div>
                </div>
                <div class="summary-card">
                  <div class="label">Success</div>
                  <div class="value" style="color:var(--success)">${stats.success}</div>
                </div>
                <div class="summary-card">
                  <div class="label">Failure</div>
                  <div class="value" style="color:var(--error)">${stats.failure}</div>
                </div>
                <div class="summary-card">
                  <div class="label">Success Rate</div>
                  <div class="value">${successRate}%</div>
                </div>
              </div>

              <!-- Per-tool breakdown -->
              <div class="sec-h">Per-Tool Breakdown</div>
              ${Object.keys(stats.byTool).length > 0
                ? html`
                    <div class="sub-card" style="overflow-x:auto;margin-bottom:var(--sp-5)">
                      <table class="data-table">
                        <thead>
                          <tr>
                            <th>Tool</th>
                            <th>Success</th>
                            <th>Failure</th>
                            <th>Success Rate</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${Object.entries(stats.byTool).map(
                            ([tool, counts]) => {
                              const total = counts.ok + counts.fail;
                              const rate = total > 0
                                ? ((counts.ok / total) * 100).toFixed(1)
                                : '0.0';
                              return html`
                                <tr>
                                  <td style="font-family:var(--font-mono);font-size:var(--text-xs)">
                                    ${tool}
                                  </td>
                                  <td style="color:var(--success)">${counts.ok}</td>
                                  <td style="color:var(--error)">${counts.fail}</td>
                                  <td>${rate}%</td>
                                </tr>
                              `;
                            },
                          )}
                        </tbody>
                      </table>
                    </div>
                  `
                : html`<div class="status-msg" style="color:var(--text-muted)">
                    No per-tool data yet.
                  </div>`}
            `
          : html`<div class="status-msg">Loading feedback data...</div>`}

        <!-- Recent entries -->
        <div class="sec-h">Recent Entries</div>
        ${this.feedbackEntries.length > 0
          ? html`
              <div class="sub-card" style="overflow-x:auto">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Tool</th>
                      <th>Status</th>
                      <th>Duration</th>
                      <th>Session</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${this.feedbackEntries.slice(0, 50).map(
                      (entry) => html`
                        <tr>
                          <td style="white-space:nowrap;font-family:var(--font-mono);font-size:var(--text-xs)">
                            ${formatTime(entry.timestamp)}
                          </td>
                          <td style="font-family:var(--font-mono);font-size:var(--text-xs)">
                            ${entry.toolName}
                          </td>
                          <td>
                            <span class="tag" style="color:${entry.ok ? 'var(--success)' : 'var(--error)'}">
                              ${entry.ok ? 'OK' : 'FAIL'}
                            </span>
                            ${entry.error
                              ? html`<span style="font-size:var(--text-xs);color:var(--text-muted);margin-left:var(--sp-1)" title=${entry.error}>
                                  ${entry.error.length > 40 ? `${entry.error.slice(0, 40)}...` : entry.error}
                                </span>`
                              : nothing}
                          </td>
                          <td style="font-family:var(--font-mono);font-size:var(--text-xs)">
                            ${entry.durationMs != null ? `${entry.durationMs}ms` : '--'}
                          </td>
                          <td style="font-family:var(--font-mono);font-size:var(--text-xs);color:var(--text-muted)">
                            ${entry.sessionId.length > 8 ? `${entry.sessionId.slice(0, 8)}...` : entry.sessionId}
                          </td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              </div>
            `
          : html`<crowclaw-empty
              icon="feedback"
              title="No tool feedback yet"
              description="Tool feedback is recorded automatically each time your agent calls a tool. Use the agent and entries appear here."
            ></crowclaw-empty>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-settings-view': SettingsView;
  }
}
