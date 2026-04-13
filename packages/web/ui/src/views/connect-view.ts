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
import '../components/toggle-switch.js';

/* ------------------------------------------------------------------ */
/*  Type definitions                                                  */
/* ------------------------------------------------------------------ */

interface ProviderSlot {
  name: string;
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

interface ProviderConfig {
  primary?: ProviderSlot | null;
  fallback?: ProviderSlot | null;
  vision?: ProviderSlot | null;
  compression?: ProviderSlot | null;
  embedding?: ProviderSlot | null;
}

/** Flattened view used in the provider grid UI */
interface ProviderDisplay {
  slot: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  hasKey: boolean;
}

interface McpServer {
  name: string;
  command: string;
  args?: string[];
  description?: string;
  env?: Record<string, string>;
  custom?: boolean;
}

interface GatewayPlatform {
  name: string;
  inboundRoute: string;
  inboundStatus: string;
  outboundMode: string;
  outboundRoute?: string;
  enabled: boolean;
}

interface ToolInfo {
  name: string;
  description: string;
  runtime?: string;
  dangerLevel?: 'safe' | 'moderate' | 'dangerous';
}

/** Matches GET /api/system/status response shape */
interface SystemStatusResponse {
  ok: boolean;
  deployment: string;
  version: string;
  runtime: string;
  service: string;
  plugins: string[];
  counts: {
    bridgeSessions: number;
    bridgeProcesses: number;
    bridgeAliveProcesses: number;
    browserSessions: number;
    schedulerJobs: number;
  };
  mcp: { degraded?: boolean; servers?: Array<{ name: string }> } | null;
  gateway: { slackSigningSecretConfigured: boolean };
  tools: ToolInfo[];
  model: string;
  provider: string;
}

/** Derived status for the overview panel */
interface SystemStatus {
  providers: ProviderDisplay[];
  gateway: { status: string; platforms: number };
  mcp: { status: string; servers: number };
  tools: { count: number };
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

@customElement('crowclaw-connect-view')
export class ConnectView extends LitElement {
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
      }

      /* Status overview rows */
      .status-list {
        display: flex;
        flex-direction: column;
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }

      .status-row {
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        padding: var(--sp-3) var(--sp-4);
        border-bottom: 1px solid var(--glass-border);
        font-size: var(--text-sm);
      }

      .status-row:last-child { border-bottom: none; }

      .status-row .label {
        font-weight: 500;
        color: var(--text-primary);
        min-width: 100px;
      }

      .status-row .detail {
        color: var(--text-secondary);
        font-family: var(--font-mono);
        font-size: var(--text-xs);
      }

      .status-row .count {
        margin-left: auto;
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        color: var(--text-muted);
      }

      /* Status dots */
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .dot.live {
        background: var(--success);
        box-shadow: 0 0 8px rgba(48, 209, 88, 0.35);
      }

      .dot.disc {
        background: var(--text-muted);
      }

      .dot.sim {
        background: var(--warning);
        box-shadow: 0 0 8px rgba(255, 214, 10, 0.25);
      }

      /* Provider cards */
      .provider-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: var(--sp-3);
      }

      .provider-card {
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-md);
        padding: var(--sp-4) var(--sp-5);
        transition: all var(--duration-normal) var(--ease-spring);
      }

      .provider-card:hover {
        border-color: rgba(255, 255, 255, 0.14);
        background: var(--bg-card-hover);
      }

      .provider-hdr {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        margin-bottom: var(--sp-3);
      }

      .provider-name {
        font-size: var(--text-sm);
        font-weight: 600;
        color: var(--text-primary);
      }

      .provider-url {
        font-size: var(--text-xs);
        color: var(--text-muted);
        font-family: var(--font-mono);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin-bottom: var(--sp-3);
      }

      .provider-actions {
        display: flex;
        gap: var(--sp-2);
      }

      /* Provider inline config form */
      .provider-form {
        margin-top: var(--sp-3);
        padding-top: var(--sp-3);
        border-top: 1px solid var(--glass-border);
      }

      .provider-form .form-group { margin-bottom: var(--sp-3); }

      .provider-form .form-actions {
        display: flex;
        gap: var(--sp-2);
        justify-content: flex-end;
        margin-top: var(--sp-3);
      }

      /* MCP server list */
      .mcp-list {
        display: flex;
        flex-direction: column;
        gap: var(--sp-2);
      }

      .mcp-item {
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        padding: var(--sp-3) var(--sp-4);
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-md);
        transition: all var(--duration-fast) var(--ease-spring);
      }

      .mcp-item:hover {
        border-color: rgba(255, 255, 255, 0.14);
        background: var(--bg-card-hover);
      }

      .mcp-info { flex: 1; min-width: 0; }

      .mcp-name {
        font-size: var(--text-sm);
        font-weight: 500;
        color: var(--text-primary);
      }

      .mcp-cmd {
        font-size: var(--text-xs);
        color: var(--text-muted);
        font-family: var(--font-mono);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .mcp-desc {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        margin-top: 2px;
      }

      /* Add MCP server form */
      .add-form {
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-md);
        padding: var(--sp-4) var(--sp-5);
        margin-top: var(--sp-3);
      }

      .add-form-title {
        font-size: var(--text-sm);
        font-weight: 600;
        color: var(--text-primary);
        margin-bottom: var(--sp-3);
      }

      .add-form .row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--sp-3);
      }

      .add-form .form-actions {
        display: flex;
        gap: var(--sp-2);
        justify-content: flex-end;
        margin-top: var(--sp-4);
      }

      /* Env var editor */
      .env-rows {
        display: flex;
        flex-direction: column;
        gap: var(--sp-2);
      }

      .env-row {
        display: flex;
        gap: var(--sp-2);
        align-items: center;
      }

      .env-row input { flex: 1; }

      .env-row .remove-env {
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        font-size: 14px;
        padding: 2px 6px;
        border-radius: var(--radius-sm);
      }

      .env-row .remove-env:hover { color: var(--error); }

      .add-env-btn {
        font-size: var(--text-xs);
        color: var(--accent);
        cursor: pointer;
        background: none;
        border: none;
        padding: var(--sp-1) 0;
        font-family: inherit;
      }

      .add-env-btn:hover { color: var(--accent-hover); }

      /* Platform grid */
      .platform-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: var(--sp-3);
      }

      .platform-card {
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-md);
        padding: var(--sp-4) var(--sp-5);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--sp-3);
        transition: all var(--duration-normal) var(--ease-spring);
      }

      .platform-card:hover {
        border-color: rgba(255, 255, 255, 0.14);
        background: var(--bg-card-hover);
      }

      .platform-info {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
      }

      .platform-name {
        font-size: var(--text-sm);
        font-weight: 500;
        color: var(--text-primary);
      }

      /* Tool browser */
      .tool-ns-group {
        margin-bottom: var(--sp-4);
      }

      .tool-ns-label {
        font-size: var(--text-xs);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 1px;
        color: var(--text-muted);
        margin-bottom: var(--sp-2);
        padding-bottom: var(--sp-1);
        border-bottom: 1px solid var(--glass-border);
      }

      .tool-list {
        display: flex;
        flex-direction: column;
        gap: var(--sp-1);
      }

      .tool-item {
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        padding: var(--sp-2) var(--sp-3);
        border-radius: var(--radius-sm);
        transition: background var(--duration-fast);
      }

      .tool-item:hover { background: var(--bg-card-hover); }

      .tool-name {
        font-size: var(--text-sm);
        font-weight: 500;
        color: var(--text-primary);
        font-family: var(--font-mono);
        white-space: nowrap;
      }

      .tool-desc {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .tool-meta {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        flex-shrink: 0;
      }

      .tool-runtime {
        font-size: 9px;
        font-family: var(--font-mono);
        color: var(--text-muted);
      }

      .danger-badge {
        display: inline-block;
        padding: 1px 6px;
        font-size: 9px;
        font-weight: 600;
        letter-spacing: 0.3px;
        border-radius: var(--radius-sm);
        text-transform: uppercase;
      }

      .danger-badge.safe {
        color: var(--success);
        background: rgba(48, 209, 88, 0.08);
        border: 1px solid rgba(48, 209, 88, 0.2);
      }

      .danger-badge.moderate {
        color: var(--warning);
        background: rgba(255, 214, 10, 0.08);
        border: 1px solid rgba(255, 214, 10, 0.2);
      }

      .danger-badge.dangerous {
        color: var(--error);
        background: rgba(255, 69, 58, 0.08);
        border: 1px solid rgba(255, 69, 58, 0.2);
      }

      /* Loading / empty states */
      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--sp-8) 0;
        color: var(--text-muted);
        font-size: var(--text-sm);
      }

      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: var(--sp-8) 0;
        gap: var(--sp-2);
        opacity: 0.5;
      }

      .empty-state .title {
        font-size: var(--text-base);
        font-weight: 600;
        color: #c8cdd6;
      }

      .empty-state .subtitle {
        font-size: var(--text-xs);
        color: var(--text-muted);
      }

      /* Error message */
      .err-msg {
        color: var(--error);
        font-size: var(--text-xs);
        margin-top: var(--sp-2);
        min-height: 16px;
      }
    `,
  ];

  /* ---- reactive state ---- */

  @state() private systemStatus: SystemStatus | null = null;
  @state() private providers: ProviderDisplay[] = [];
  @state() private mcpServers: McpServer[] = [];
  @state() private platforms: GatewayPlatform[] = [];
  @state() private tools: ToolInfo[] = [];

  @state() private loading = true;
  @state() private toolSearch = '';

  /* Provider config form */
  @state() private configuringProvider: string | null = null;
  @state() private providerForm = { slot: '', name: '', provider: '', baseUrl: '', apiKey: '', model: '' };

  /* MCP add form */
  @state() private showMcpForm = false;
  @state() private mcpForm = { name: '', command: '', args: '', description: '' };
  @state() private mcpEnvVars: { key: string; value: string }[] = [];
  @state() private mcpFormError = '';

  /* ---- lifecycle ---- */

  connectedCallback() {
    super.connectedCallback();
    this._fetchAll();
  }

  private async _fetchAll() {
    this.loading = true;
    await Promise.allSettled([
      this._fetchStatus(),
      this._fetchProviders(),
      this._fetchMcp(),
      this._fetchPlatforms(),
      this._fetchTools(),
    ]);
    this.loading = false;
  }

  private async _fetchStatus() {
    try {
      const raw = await api<SystemStatusResponse>('/api/system/status');

      // Extract tools from the status response (no separate /api/tools endpoint)
      this.tools = (raw.tools ?? []).map((t) =>
        typeof t === 'string'
          ? { name: t as string, description: '', runtime: 'worker' }
          : t,
      );

      // Derive the overview panel status from the raw response
      this.systemStatus = {
        providers: this.providers, // filled by _fetchProviders
        gateway: {
          status: raw.gateway?.slackSigningSecretConfigured ? 'live' : 'disc',
          platforms: 0, // updated after _fetchPlatforms
        },
        mcp: {
          status: raw.mcp ? (raw.mcp.degraded ? 'degraded' : 'live') : 'disc',
          servers: raw.mcp?.servers?.length ?? 0,
        },
        tools: { count: this.tools.length },
      };
    } catch {
      this.systemStatus = null;
    }
  }

  private async _fetchProviders() {
    try {
      const data = await api<{
        ok: boolean;
        config: ProviderConfig | null;
        slots: ProviderConfig;
      }>('/api/providers/config');

      const slots = data.slots ?? data.config ?? {};
      const list: ProviderDisplay[] = [];
      for (const [slotName, slot] of Object.entries(slots) as [string, ProviderSlot | null | undefined][]) {
        if (!slot || slot.provider === 'none') continue;
        list.push({
          slot: slotName,
          name: slot.name ?? slotName,
          provider: slot.provider,
          model: slot.model,
          baseUrl: slot.baseUrl ?? '',
          hasKey: slot.apiKey === '***',
        });
      }
      this.providers = list;
    } catch {
      this.providers = [];
    }
  }

  private async _fetchMcp() {
    try {
      const data = await api<{ servers: McpServer[] }>('/api/mcp/servers');
      this.mcpServers = data.servers ?? [];
    } catch {
      this.mcpServers = [];
    }
  }

  private async _fetchPlatforms() {
    try {
      const data = await api<{
        platforms: Array<{
          name: string;
          inboundRoute: string;
          inboundStatus: string;
          outboundMode: string;
          outboundRoute?: string;
        }>;
      }>('/api/gateway/status');

      this.platforms = (data.platforms ?? []).map((p) => ({
        name: p.name,
        inboundRoute: p.inboundRoute,
        inboundStatus: p.inboundStatus,
        outboundMode: p.outboundMode,
        outboundRoute: p.outboundRoute,
        enabled: p.outboundMode !== 'not-exposed',
      }));

      // Update the gateway platform count in systemStatus if already loaded
      if (this.systemStatus) {
        this.systemStatus = {
          ...this.systemStatus,
          gateway: {
            ...this.systemStatus.gateway,
            platforms: this.platforms.length,
          },
        };
      }
    } catch {
      this.platforms = [];
    }
  }

  /** Tools are fetched from /api/system/status, not a separate endpoint */
  private async _fetchTools() {
    // Tools are already loaded by _fetchStatus; this is a no-op.
    // Kept for structural consistency with _fetchAll.
  }

  /* ---- provider config ---- */

  private _openProviderConfig(provider: ProviderDisplay) {
    if (this.configuringProvider === provider.slot) {
      this.configuringProvider = null;
      return;
    }
    this.configuringProvider = provider.slot;
    this.providerForm = {
      slot: provider.slot,
      name: provider.name,
      provider: provider.provider,
      baseUrl: provider.baseUrl,
      apiKey: '',
      model: provider.model,
    };
  }

  private _closeProviderConfig() {
    this.configuringProvider = null;
  }

  private async _saveProviderConfig() {
    try {
      // Build a full provider config payload keyed by slot name
      // POST /api/providers/config expects { primary: {...}, fallback: {...}, ... }
      const slotData: ProviderSlot = {
        name: this.providerForm.name,
        provider: this.providerForm.provider,
        model: this.providerForm.model,
        baseUrl: this.providerForm.baseUrl || undefined,
      };
      if (this.providerForm.apiKey) {
        slotData.apiKey = this.providerForm.apiKey;
      }
      const payload: Record<string, ProviderSlot> = {
        [this.providerForm.slot]: slotData,
      };
      // Preserve existing slots by re-fetching current config first
      try {
        const current = await api<{ slots: ProviderConfig }>('/api/providers/config');
        const merged = { ...current.slots, ...payload };
        await api('/api/providers/config', {
          method: 'POST',
          body: JSON.stringify(merged),
        });
      } catch {
        // If we cannot fetch current config, send just the slot
        await api('/api/providers/config', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      this.configuringProvider = null;
      await this._fetchProviders();
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Failed to save provider config:', error.message);
      }
    }
  }

  /* ---- MCP server management ---- */

  private _toggleMcpForm() {
    this.showMcpForm = !this.showMcpForm;
    if (this.showMcpForm) {
      this.mcpForm = { name: '', command: '', args: '', description: '' };
      this.mcpEnvVars = [];
      this.mcpFormError = '';
    }
  }

  private _addEnvVar() {
    this.mcpEnvVars = [...this.mcpEnvVars, { key: '', value: '' }];
  }

  private _removeEnvVar(index: number) {
    this.mcpEnvVars = this.mcpEnvVars.filter((_, i) => i !== index);
  }

  private _updateEnvVar(index: number, field: 'key' | 'value', val: string) {
    this.mcpEnvVars = this.mcpEnvVars.map((ev, i) =>
      i === index ? { ...ev, [field]: val } : ev,
    );
  }

  private async _addMcpServer() {
    if (!this.mcpForm.name.trim() || !this.mcpForm.command.trim()) {
      this.mcpFormError = 'Name and command are required';
      return;
    }

    this.mcpFormError = '';

    const args = this.mcpForm.args
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);

    const env: Record<string, string> = {};
    for (const ev of this.mcpEnvVars) {
      if (ev.key.trim()) {
        env[ev.key.trim()] = ev.value;
      }
    }

    try {
      await api('/api/mcp/servers', {
        method: 'POST',
        body: JSON.stringify({
          name: this.mcpForm.name.trim(),
          command: this.mcpForm.command.trim(),
          args,
          description: this.mcpForm.description.trim() || undefined,
          env: Object.keys(env).length > 0 ? env : undefined,
        }),
      });
      this.showMcpForm = false;
      await this._fetchMcp();
    } catch (error: unknown) {
      if (error instanceof Error) {
        this.mcpFormError = error.message;
      } else {
        this.mcpFormError = 'Failed to add server';
      }
    }
  }

  private async _removeMcpServer(name: string) {
    try {
      await api(`/api/mcp/servers/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      await this._fetchMcp();
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Failed to remove MCP server:', error.message);
      }
    }
  }

  /* ---- platform toggle ---- */

  private async _togglePlatform(platform: GatewayPlatform) {
    const newEnabled = !platform.enabled;
    // Optimistic update
    this.platforms = this.platforms.map((p) =>
      p.name === platform.name ? { ...p, enabled: newEnabled } : p,
    );
    try {
      // POST /api/gateway/{platform}/config — sets { enabled, token }
      await api(`/api/gateway/${encodeURIComponent(platform.name)}/config`, {
        method: 'POST',
        body: JSON.stringify({ enabled: newEnabled }),
      });
    } catch {
      // Revert on failure
      this.platforms = this.platforms.map((p) =>
        p.name === platform.name ? { ...p, enabled: !newEnabled } : p,
      );
    }
  }

  /* ---- tools helpers ---- */

  private get _filteredTools(): ToolInfo[] {
    const q = this.toolSearch.toLowerCase();
    if (!q) return this.tools;
    return this.tools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q),
    );
  }

  private get _groupedTools(): Map<string, ToolInfo[]> {
    const groups = new Map<string, ToolInfo[]>();
    for (const tool of this._filteredTools) {
      const dotIndex = tool.name.indexOf('.');
      const ns = dotIndex > 0 ? tool.name.slice(0, dotIndex) : 'other';
      const list = groups.get(ns) ?? [];
      list.push(tool);
      groups.set(ns, list);
    }
    return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  /* ---- status helpers ---- */

  private _statusLabel(status: string): string {
    if (status === 'live' || status === 'connected' || status === 'ok') return 'Live';
    if (status === 'sim' || status === 'simulated') return 'Simulated';
    return 'Disconnected';
  }

  private _statusDotClass(status: string): string {
    if (status === 'live' || status === 'connected' || status === 'ok') return 'live';
    if (status === 'sim' || status === 'simulated') return 'sim';
    return 'disc';
  }

  /* ---- render ---- */

  render() {
    if (this.loading) {
      return html`<div class="loading">Loading connections...</div>`;
    }

    return html`
      ${this._renderStatusOverview()}
      ${this._renderProviders()}
      ${this._renderMcpServers()}
      ${this._renderPlatforms()}
      ${this._renderTools()}
    `;
  }

  /* ---- Section 1: Status Overview ---- */

  private _renderStatusOverview() {
    const s = this.systemStatus;
    const provCount = this.providers.length;
    return html`
      <div class="section-block">
        <div class="section-header">Status Overview</div>
        <div class="status-list">
          <div class="status-row">
            <span class="dot ${provCount > 0 ? 'live' : 'disc'}"></span>
            <span class="label">Providers</span>
            <span class="detail">${provCount > 0 ? `${provCount} configured` : 'No active providers'}</span>
            <span class="count">${provCount}</span>
          </div>
          <div class="status-row">
            <span class="dot ${s?.gateway ? this._statusDotClass(s.gateway.status) : 'disc'}"></span>
            <span class="label">Gateway</span>
            <span class="detail">${s?.gateway ? this._statusLabel(s.gateway.status) : '--'}</span>
            <span class="count">${s?.gateway?.platforms ?? 0} platforms</span>
          </div>
          <div class="status-row">
            <span class="dot ${s?.mcp ? this._statusDotClass(s.mcp.status) : 'disc'}"></span>
            <span class="label">MCP</span>
            <span class="detail">${s?.mcp ? this._statusLabel(s.mcp.status) : '--'}</span>
            <span class="count">${s?.mcp?.servers ?? 0} servers</span>
          </div>
          <div class="status-row">
            <span class="dot ${s && s.tools.count > 0 ? 'live' : 'disc'}"></span>
            <span class="label">Tools</span>
            <span class="detail">${s && s.tools.count > 0 ? 'Available' : '--'}</span>
            <span class="count">${s?.tools.count ?? 0} tools</span>
          </div>
        </div>
      </div>
    `;
  }

  /* ---- Section 2: Providers ---- */

  private _renderProviders() {
    return html`
      <div class="section-block">
        <div class="section-header">Providers</div>
        ${this.providers.length === 0
          ? html`
              <div class="empty-state">
                <div class="title">No Providers</div>
                <div class="subtitle">No provider configurations found</div>
              </div>
            `
          : html`
              <div class="provider-grid">
                ${this.providers.map((p) => this._renderProviderCard(p))}
              </div>
            `}
      </div>
    `;
  }

  private _renderProviderCard(provider: ProviderDisplay) {
    const isConfiguring = this.configuringProvider === provider.slot;
    return html`
      <div class="provider-card">
        <div class="provider-hdr">
          <span class="dot ${provider.hasKey ? 'live' : 'disc'}"></span>
          <span class="provider-name">${provider.name} (${provider.slot})</span>
        </div>
        <div class="provider-url">${provider.baseUrl || provider.provider} / ${provider.model}</div>
        <div class="provider-actions">
          <button
            class="btn ${isConfiguring ? 'btn-p' : ''}"
            @click=${() => this._openProviderConfig(provider)}
          >
            ${isConfiguring ? 'Close' : 'Configure'}
          </button>
        </div>
        ${isConfiguring ? this._renderProviderForm() : nothing}
      </div>
    `;
  }

  private _renderProviderForm() {
    return html`
      <div class="provider-form">
        <div class="form-group">
          <label class="form-label">Name</label>
          <input
            class="form-input"
            .value=${this.providerForm.name}
            @input=${(e: InputEvent) => {
              this.providerForm = {
                ...this.providerForm,
                name: (e.target as HTMLInputElement).value,
              };
            }}
          />
        </div>
        <div class="form-group">
          <label class="form-label">Provider</label>
          <input
            class="form-input"
            placeholder="openai, anthropic, openrouter, ..."
            .value=${this.providerForm.provider}
            @input=${(e: InputEvent) => {
              this.providerForm = {
                ...this.providerForm,
                provider: (e.target as HTMLInputElement).value,
              };
            }}
          />
        </div>
        <div class="form-group">
          <label class="form-label">Model</label>
          <input
            class="form-input"
            placeholder="gpt-4o, claude-sonnet-4-20250514, ..."
            .value=${this.providerForm.model}
            @input=${(e: InputEvent) => {
              this.providerForm = {
                ...this.providerForm,
                model: (e.target as HTMLInputElement).value,
              };
            }}
          />
        </div>
        <div class="form-group">
          <label class="form-label">Base URL</label>
          <input
            class="form-input"
            placeholder="https://api.openai.com/v1"
            .value=${this.providerForm.baseUrl}
            @input=${(e: InputEvent) => {
              this.providerForm = {
                ...this.providerForm,
                baseUrl: (e.target as HTMLInputElement).value,
              };
            }}
          />
        </div>
        <div class="form-group">
          <label class="form-label">API Key</label>
          <input
            class="form-input"
            type="password"
            placeholder="sk-..."
            .value=${this.providerForm.apiKey}
            @input=${(e: InputEvent) => {
              this.providerForm = {
                ...this.providerForm,
                apiKey: (e.target as HTMLInputElement).value,
              };
            }}
          />
          <div class="form-hint">Leave blank to keep the existing key</div>
        </div>
        <div class="form-actions">
          <button class="btn" @click=${this._closeProviderConfig}>Cancel</button>
          <button class="btn btn-p" @click=${this._saveProviderConfig}>Save</button>
        </div>
      </div>
    `;
  }

  /* ---- Section 3: MCP Servers ---- */

  private _renderMcpServers() {
    return html`
      <div class="section-block">
        <div class="section-header">MCP Servers</div>
        ${this.mcpServers.length === 0 && !this.showMcpForm
          ? html`
              <div class="empty-state">
                <div class="title">No MCP Servers</div>
                <div class="subtitle">Add a custom server to get started</div>
              </div>
            `
          : html`
              <div class="mcp-list">
                ${this.mcpServers.map((s) => this._renderMcpItem(s))}
              </div>
            `}
        ${this.showMcpForm ? this._renderMcpAddForm() : nothing}
        <div style="margin-top: var(--sp-3)">
          <button
            class="btn ${this.showMcpForm ? '' : 'btn-p'}"
            @click=${this._toggleMcpForm}
          >
            ${this.showMcpForm ? 'Cancel' : 'Add Custom Server'}
          </button>
        </div>
      </div>
    `;
  }

  private _renderMcpItem(server: McpServer) {
    return html`
      <div class="mcp-item">
        <span class="dot live"></span>
        <div class="mcp-info">
          <div class="mcp-name">${server.name}</div>
          <div class="mcp-cmd">${server.command}${server.args?.length ? ` ${server.args.join(' ')}` : ''}</div>
          ${server.description
            ? html`<div class="mcp-desc">${server.description}</div>`
            : nothing}
        </div>
        ${server.custom !== false
          ? html`
              <button
                class="btn btn-danger"
                @click=${() => this._removeMcpServer(server.name)}
              >
                Remove
              </button>
            `
          : nothing}
      </div>
    `;
  }

  private _renderMcpAddForm() {
    return html`
      <div class="add-form">
        <div class="add-form-title">Add Custom Server</div>
        <div class="row">
          <div class="form-group">
            <label class="form-label">Name</label>
            <input
              class="form-input"
              placeholder="my-server"
              .value=${this.mcpForm.name}
              @input=${(e: InputEvent) => {
                this.mcpForm = {
                  ...this.mcpForm,
                  name: (e.target as HTMLInputElement).value,
                };
              }}
            />
          </div>
          <div class="form-group">
            <label class="form-label">Command</label>
            <input
              class="form-input"
              placeholder="npx @modelcontextprotocol/server-x"
              .value=${this.mcpForm.command}
              @input=${(e: InputEvent) => {
                this.mcpForm = {
                  ...this.mcpForm,
                  command: (e.target as HTMLInputElement).value,
                };
              }}
            />
          </div>
        </div>
        <div class="row">
          <div class="form-group">
            <label class="form-label">Args (comma-separated)</label>
            <input
              class="form-input"
              placeholder="--port, 3000"
              .value=${this.mcpForm.args}
              @input=${(e: InputEvent) => {
                this.mcpForm = {
                  ...this.mcpForm,
                  args: (e.target as HTMLInputElement).value,
                };
              }}
            />
          </div>
          <div class="form-group">
            <label class="form-label">Description</label>
            <input
              class="form-input"
              placeholder="Optional description"
              .value=${this.mcpForm.description}
              @input=${(e: InputEvent) => {
                this.mcpForm = {
                  ...this.mcpForm,
                  description: (e.target as HTMLInputElement).value,
                };
              }}
            />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Environment Variables</label>
          <div class="env-rows">
            ${this.mcpEnvVars.map(
              (ev, i) => html`
                <div class="env-row">
                  <input
                    class="form-input"
                    placeholder="KEY"
                    .value=${ev.key}
                    @input=${(e: InputEvent) =>
                      this._updateEnvVar(i, 'key', (e.target as HTMLInputElement).value)}
                  />
                  <input
                    class="form-input"
                    placeholder="value"
                    .value=${ev.value}
                    @input=${(e: InputEvent) =>
                      this._updateEnvVar(i, 'value', (e.target as HTMLInputElement).value)}
                  />
                  <button class="remove-env" @click=${() => this._removeEnvVar(i)}>x</button>
                </div>
              `,
            )}
          </div>
          <button class="add-env-btn" @click=${this._addEnvVar}>+ Add variable</button>
        </div>
        <div class="err-msg">${this.mcpFormError}</div>
        <div class="form-actions">
          <button class="btn" @click=${this._toggleMcpForm}>Cancel</button>
          <button class="btn btn-p" @click=${this._addMcpServer}>Add Server</button>
        </div>
      </div>
    `;
  }

  /* ---- Section 4: Gateway Platforms ---- */

  private _renderPlatforms() {
    return html`
      <div class="section-block">
        <div class="section-header">Platforms</div>
        ${this.platforms.length === 0
          ? html`
              <div class="empty-state">
                <div class="title">No Platforms</div>
                <div class="subtitle">No gateway platforms available</div>
              </div>
            `
          : html`
              <div class="platform-grid">
                ${this.platforms.map((p) => this._renderPlatformCard(p))}
              </div>
            `}
      </div>
    `;
  }

  private _renderPlatformCard(platform: GatewayPlatform) {
    const modeStatus = platform.outboundMode === 'runtime-route' ? 'live'
      : platform.outboundMode === 'not-exposed' ? 'disc'
      : 'sim';
    return html`
      <div class="platform-card">
        <div class="platform-info">
          <span class="dot ${this._statusDotClass(modeStatus)}"></span>
          <span class="platform-name">${platform.name}</span>
        </div>
        <crowclaw-toggle
          .checked=${platform.enabled}
          @change=${() => this._togglePlatform(platform)}
        ></crowclaw-toggle>
      </div>
    `;
  }

  /* ---- Section 5: Tools Browser ---- */

  private _renderTools() {
    return html`
      <div class="section-block">
        <div class="section-header">Tools</div>
        <input
          class="srch"
          placeholder="Search tools by name or description..."
          .value=${this.toolSearch}
          @input=${(e: InputEvent) => {
            this.toolSearch = (e.target as HTMLInputElement).value;
          }}
        />
        ${this._filteredTools.length === 0
          ? html`
              <div class="empty-state">
                <div class="title">No Tools Found</div>
                <div class="subtitle">
                  ${this.toolSearch
                    ? 'No tools match your search'
                    : 'No tools registered'}
                </div>
              </div>
            `
          : html`
              ${[...this._groupedTools.entries()].map(
                ([ns, tools]) => html`
                  <div class="tool-ns-group">
                    <div class="tool-ns-label">${ns}</div>
                    <div class="tool-list">
                      ${tools.map((t) => this._renderToolItem(t))}
                    </div>
                  </div>
                `,
              )}
            `}
      </div>
    `;
  }

  private _renderToolItem(tool: ToolInfo) {
    return html`
      <div class="tool-item">
        <span class="tool-name">${tool.name}</span>
        <span class="tool-desc">${tool.description}</span>
        <div class="tool-meta">
          ${tool.runtime
            ? html`<span class="tool-runtime">${tool.runtime}</span>`
            : nothing}
          ${tool.dangerLevel
            ? html`<span class="danger-badge ${tool.dangerLevel}">${tool.dangerLevel}</span>`
            : nothing}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-connect-view': ConnectView;
  }
}
