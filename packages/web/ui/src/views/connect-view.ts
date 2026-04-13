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
  /** Populated after probe */
  probeResult?: PlatformProbeResult | null;
  /** Policy settings */
  policy?: PlatformPolicy | null;
}

interface PlatformProbeResult {
  ok: boolean;
  platform: string;
  botUsername?: string;
  webhookUrl?: string;
  webhookActive?: boolean;
  error?: string;
}

type DmPolicyMode = 'pairing' | 'allowlist' | 'open' | 'disabled';
type GroupPolicyMode = 'allowlist' | 'open' | 'disabled';

interface PlatformPolicy {
  dmPolicy: DmPolicyMode;
  groupPolicy: GroupPolicyMode;
  requireMention: boolean;
}

interface GatewayChannel {
  platform: string;
  channelId: string;
  lastMessageAt?: string;
  messageCount?: number;
  muted?: boolean;
}

interface PairingEntry {
  code: string;
  platform: string;
  senderId: string;
  channelId: string;
  createdAt: string;
  expiresAt: string;
}

interface TelegramWebhookInfo {
  url?: string;
  has_custom_certificate?: boolean;
  pending_update_count?: number;
  last_error_date?: number;
  last_error_message?: string;
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
        transition: border-color var(--duration-normal) var(--ease-spring),
                    background var(--duration-normal) var(--ease-spring);
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
        transition: border-color var(--duration-fast) var(--ease-spring),
                    background var(--duration-fast) var(--ease-spring);
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

      .platform-card {
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-md);
        padding: var(--sp-4) var(--sp-5);
        display: flex;
        flex-direction: column;
        gap: var(--sp-3);
        transition: border-color var(--duration-normal) var(--ease-spring),
                    background var(--duration-normal) var(--ease-spring);
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

      /* Platform card layout */
      .platform-card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--sp-3);
      }

      .platform-card-body {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }

      .platform-probe-info {
        display: flex;
        flex-direction: column;
        gap: var(--sp-1);
        font-size: var(--text-xs);
        color: var(--text-muted);
        font-family: var(--font-mono);
      }

      .platform-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--sp-2);
        margin-top: var(--sp-1);
      }

      .platform-expand-panel {
        border-top: 1px solid var(--glass-border);
        padding-top: var(--sp-3);
        margin-top: var(--sp-2);
      }

      .platform-expand-panel .form-group {
        margin-bottom: var(--sp-3);
      }

      .platform-expand-panel .form-actions {
        display: flex;
        gap: var(--sp-2);
        justify-content: flex-end;
        margin-top: var(--sp-3);
      }

      /* Policy selector */
      .policy-row {
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        margin-bottom: var(--sp-2);
      }

      .policy-row label {
        font-size: var(--text-xs);
        font-weight: 500;
        color: var(--text-secondary);
        min-width: 100px;
      }

      .policy-row select {
        flex: 1;
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        color: var(--text-primary);
        font-size: var(--text-xs);
        font-family: inherit;
        padding: var(--sp-1) var(--sp-2);
        border-radius: var(--radius-sm);
        outline: none;
      }

      .policy-row select:focus {
        border-color: var(--accent);
      }

      /* Badge for pending counts */
      .badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 18px;
        height: 18px;
        padding: 0 5px;
        font-size: 10px;
        font-weight: 600;
        border-radius: 9px;
        background: var(--accent);
        color: #fff;
      }

      .badge.muted {
        background: var(--text-muted);
      }

      /* Pairing list */
      .pairing-list {
        display: flex;
        flex-direction: column;
        gap: var(--sp-2);
        margin-top: var(--sp-2);
      }

      .pairing-item {
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        padding: var(--sp-2) var(--sp-3);
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
      }

      .pairing-code {
        font-family: var(--font-mono);
        font-weight: 600;
        color: var(--accent);
        letter-spacing: 1px;
      }

      .pairing-meta {
        flex: 1;
        color: var(--text-muted);
        font-family: var(--font-mono);
      }

      .pairing-expires {
        color: var(--warning);
        font-size: 10px;
      }

      /* Channel list */
      .channel-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: var(--sp-3);
      }

      .channel-card {
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-md);
        padding: var(--sp-3) var(--sp-4);
        transition: border-color var(--duration-fast) var(--ease-spring),
                    background var(--duration-fast) var(--ease-spring);
      }

      .channel-card:hover {
        border-color: rgba(255, 255, 255, 0.14);
        background: var(--bg-card-hover);
      }

      .channel-card-header {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        margin-bottom: var(--sp-2);
      }

      .channel-platform {
        font-size: 9px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        color: var(--text-secondary);
      }

      .channel-id {
        font-size: var(--text-xs);
        font-family: var(--font-mono);
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .channel-stats {
        display: flex;
        gap: var(--sp-4);
        font-size: var(--text-xs);
        color: var(--text-muted);
        font-family: var(--font-mono);
        margin-bottom: var(--sp-2);
      }

      .channel-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: var(--sp-2);
      }

      /* Remote access section */
      .remote-grid {
        display: flex;
        flex-direction: column;
        gap: var(--sp-3);
      }

      .remote-row {
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        padding: var(--sp-3) var(--sp-4);
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-md);
      }

      .remote-row .label {
        font-size: var(--text-xs);
        font-weight: 500;
        color: var(--text-secondary);
        min-width: 120px;
        flex-shrink: 0;
      }

      .remote-row .value {
        flex: 1;
        font-size: var(--text-xs);
        font-family: var(--font-mono);
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .copy-btn {
        background: none;
        border: 1px solid var(--glass-border);
        color: var(--text-muted);
        cursor: pointer;
        font-size: 10px;
        padding: 2px 8px;
        border-radius: var(--radius-sm);
        font-family: inherit;
        transition: color var(--duration-fast), border-color var(--duration-fast);
      }

      .copy-btn:hover {
        color: var(--accent);
        border-color: var(--accent);
      }

      .webhook-info {
        display: flex;
        flex-direction: column;
        gap: var(--sp-2);
        padding: var(--sp-3) var(--sp-4);
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-md);
        font-size: var(--text-xs);
        font-family: var(--font-mono);
        color: var(--text-muted);
      }

      .webhook-info .webhook-url {
        color: var(--text-primary);
        word-break: break-all;
      }

      .webhook-info .webhook-error {
        color: var(--error);
      }

      .webhook-actions {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        margin-top: var(--sp-2);
      }

      .webhook-actions input {
        flex: 1;
      }

      .confirm-msg {
        font-size: var(--text-xs);
        color: var(--warning);
        margin-top: var(--sp-1);
      }

      .platform-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
        gap: var(--sp-3);
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

  /* Platform config expand */
  @state() private expandedPlatform: string | null = null;
  @state() private platformConfigForm: Record<string, string> = {};
  @state() private platformPolicyForm: PlatformPolicy = { dmPolicy: 'pairing', groupPolicy: 'open', requireMention: false };
  @state() private probingPlatform: string | null = null;

  /* Channels */
  @state() private channels: GatewayChannel[] = [];

  /* Pairings */
  @state() private pairings: PairingEntry[] = [];
  @state() private showPairings: Record<string, boolean> = {};
  @state() private approvingPairing: string | null = null;

  /* Remote access */
  @state() private publicUrlOverride = '';
  @state() private telegramWebhookInfo: TelegramWebhookInfo | null = null;
  @state() private webhookUrlInput = '';
  @state() private showWebhookDeleteConfirm = false;
  @state() private settingWebhook = false;
  @state() private deletingWebhook = false;

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
      this._fetchPairings(),
      this._fetchTelegramWebhook(),
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
          policy?: PlatformPolicy;
        }>;
        activeSessions?: Array<{
          platform: string;
          channelId: string;
          lastMessageAt?: string;
          messageCount?: number;
          muted?: boolean;
        }>;
      }>('/api/gateway/status');

      this.platforms = (data.platforms ?? []).map((p) => ({
        name: p.name,
        inboundRoute: p.inboundRoute,
        inboundStatus: p.inboundStatus,
        outboundMode: p.outboundMode,
        outboundRoute: p.outboundRoute,
        enabled: p.outboundMode !== 'not-exposed',
        policy: p.policy ?? null,
      }));

      // Extract channel data from activeSessions
      this.channels = (data.activeSessions ?? []).map((s) => ({
        platform: s.platform,
        channelId: s.channelId,
        lastMessageAt: s.lastMessageAt,
        messageCount: s.messageCount ?? 0,
        muted: s.muted ?? false,
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
      this.channels = [];
    }
  }

  /** Tools are fetched from /api/system/status, not a separate endpoint */
  private async _fetchTools() {
    // Tools are already loaded by _fetchStatus; this is a no-op.
    // Kept for structural consistency with _fetchAll.
  }

  private async _fetchPairings() {
    try {
      const data = await api<{ pairings: PairingEntry[] }>('/api/gateway/pairings');
      this.pairings = data.pairings ?? [];
    } catch {
      this.pairings = [];
    }
  }

  private async _fetchTelegramWebhook() {
    try {
      const data = await api<TelegramWebhookInfo>('/api/gateway/telegram/webhook');
      this.telegramWebhookInfo = data;
    } catch {
      this.telegramWebhookInfo = null;
    }
  }

  /* ---- platform operations ---- */

  private async _probePlatform(platform: GatewayPlatform) {
    this.probingPlatform = platform.name;
    try {
      const result = await api<PlatformProbeResult>(
        `/api/gateway/${encodeURIComponent(platform.name)}/probe`,
        { method: 'POST' },
      );
      this.platforms = this.platforms.map((p) =>
        p.name === platform.name ? { ...p, probeResult: result } : p,
      );
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : 'Probe failed';
      this.platforms = this.platforms.map((p) =>
        p.name === platform.name
          ? { ...p, probeResult: { ok: false, platform: platform.name, error: errMsg } }
          : p,
      );
    } finally {
      this.probingPlatform = null;
    }
  }

  private _togglePlatformExpand(platform: GatewayPlatform) {
    if (this.expandedPlatform === platform.name) {
      this.expandedPlatform = null;
      return;
    }
    this.expandedPlatform = platform.name;
    this.platformConfigForm = {};
    this.platformPolicyForm = platform.policy
      ? { ...platform.policy }
      : { dmPolicy: 'pairing', groupPolicy: 'open', requireMention: false };
  }

  private async _savePlatformConfig(platform: GatewayPlatform) {
    try {
      await api(`/api/gateway/${encodeURIComponent(platform.name)}/config`, {
        method: 'POST',
        body: JSON.stringify({
          enabled: platform.enabled,
          ...this.platformConfigForm,
        }),
      });
      this.expandedPlatform = null;
      await this._fetchPlatforms();
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Failed to save platform config:', error.message);
      }
    }
  }

  private async _savePlatformPolicy(platform: GatewayPlatform) {
    try {
      await api(`/api/gateway/${encodeURIComponent(platform.name)}/policy`, {
        method: 'POST',
        body: JSON.stringify({ policy: this.platformPolicyForm }),
      });
      await this._fetchPlatforms();
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Failed to save policy:', error.message);
      }
    }
  }

  /* ---- pairing operations ---- */

  private _togglePairingView(platform: string) {
    this.showPairings = {
      ...this.showPairings,
      [platform]: !this.showPairings[platform],
    };
  }

  private _pendingPairingsForPlatform(platform: string): PairingEntry[] {
    const now = Date.now();
    return this.pairings.filter(
      (p) => p.platform === platform && new Date(p.expiresAt).getTime() > now,
    );
  }

  private async _approvePairing(code: string) {
    this.approvingPairing = code;
    try {
      await api('/api/gateway/pairing/approve', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      await this._fetchPairings();
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Failed to approve pairing:', error.message);
      }
    } finally {
      this.approvingPairing = null;
    }
  }

  /* ---- webhook operations ---- */

  private async _setTelegramWebhook() {
    const url = this.webhookUrlInput.trim();
    if (!url) return;
    this.settingWebhook = true;
    try {
      await api('/api/gateway/telegram/webhook', {
        method: 'POST',
        body: JSON.stringify({ url }),
      });
      this.webhookUrlInput = '';
      await this._fetchTelegramWebhook();
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Failed to set webhook:', error.message);
      }
    } finally {
      this.settingWebhook = false;
    }
  }

  private async _deleteTelegramWebhook() {
    this.deletingWebhook = true;
    try {
      await api('/api/gateway/telegram/webhook', { method: 'DELETE' });
      this.showWebhookDeleteConfirm = false;
      await this._fetchTelegramWebhook();
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Failed to delete webhook:', error.message);
      }
    } finally {
      this.deletingWebhook = false;
    }
  }

  /* ---- channel operations ---- */

  private async _toggleChannelMute(channel: GatewayChannel) {
    const newMuted = !channel.muted;
    // Optimistic update
    this.channels = this.channels.map((c) =>
      c.platform === channel.platform && c.channelId === channel.channelId
        ? { ...c, muted: newMuted }
        : c,
    );
    try {
      await api(`/api/gateway/${encodeURIComponent(channel.platform)}/config`, {
        method: 'POST',
        body: JSON.stringify({ channelId: channel.channelId, muted: newMuted }),
      });
    } catch {
      // Revert
      this.channels = this.channels.map((c) =>
        c.platform === channel.platform && c.channelId === channel.channelId
          ? { ...c, muted: !newMuted }
          : c,
      );
    }
  }

  /* ---- clipboard helper ---- */

  private async _copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback: noop in non-secure contexts
    }
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
      ${this._renderChannels()}
      ${this._renderRemoteAccess()}
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
    const totalPending = this.pairings.filter(
      (p) => new Date(p.expiresAt).getTime() > Date.now(),
    ).length;
    return html`
      <div class="section-block">
        <div class="section-header">
          Platforms
          ${totalPending > 0
            ? html`<span class="badge" title="${totalPending} pending pairings">${totalPending}</span>`
            : nothing}
        </div>
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
    const isExpanded = this.expandedPlatform === platform.name;
    const isProbing = this.probingPlatform === platform.name;
    const probe = platform.probeResult;
    const pendingPairings = this._pendingPairingsForPlatform(platform.name);
    const showPairingsPanel = this.showPairings[platform.name] ?? false;
    const hasPairingPolicy = platform.policy?.dmPolicy === 'pairing';

    return html`
      <div class="platform-card">
        <!-- Header row: status + name + toggle -->
        <div class="platform-card-header">
          <div class="platform-info">
            <span class="dot ${this._statusDotClass(modeStatus)}"></span>
            <span class="platform-name">${platform.name}</span>
            ${hasPairingPolicy && pendingPairings.length > 0
              ? html`<span class="badge" title="${pendingPairings.length} pending pairings">${pendingPairings.length}</span>`
              : nothing}
          </div>
          <crowclaw-toggle
            .checked=${platform.enabled}
            aria-label="Toggle ${platform.name}"
            @change=${() => this._togglePlatform(platform)}
          ></crowclaw-toggle>
        </div>

        <!-- Probe result -->
        ${probe
          ? html`
              <div class="platform-probe-info">
                ${probe.ok
                  ? html`
                      ${probe.botUsername ? html`<span>Bot: @${probe.botUsername}</span>` : nothing}
                      ${probe.webhookUrl ? html`<span>Webhook: ${probe.webhookActive ? 'active' : 'inactive'}</span>` : nothing}
                    `
                  : html`<span style="color: var(--error)">Probe failed: ${probe.error ?? 'unknown'}</span>`}
              </div>
            `
          : nothing}

        <!-- Policy display -->
        ${platform.policy
          ? html`
              <div class="platform-card-body">
                DM: ${platform.policy.dmPolicy} / Group: ${platform.policy.groupPolicy}
                ${platform.policy.requireMention ? ' / mention required' : ''}
              </div>
            `
          : nothing}

        <!-- Actions -->
        <div class="platform-actions">
          <button
            class="btn"
            aria-label="Probe ${platform.name} connectivity"
            ?disabled=${isProbing}
            @click=${() => this._probePlatform(platform)}
          >
            ${isProbing ? 'Probing...' : 'Probe'}
          </button>
          <button
            class="btn ${isExpanded ? 'btn-p' : ''}"
            aria-label="${isExpanded ? 'Close' : 'Configure'} ${platform.name}"
            @click=${() => this._togglePlatformExpand(platform)}
          >
            ${isExpanded ? 'Close' : 'Configure'}
          </button>
          ${hasPairingPolicy && pendingPairings.length > 0
            ? html`
                <button
                  class="btn"
                  aria-label="Show pending pairings for ${platform.name}"
                  @click=${() => this._togglePairingView(platform.name)}
                >
                  Pairings (${pendingPairings.length})
                </button>
              `
            : nothing}
        </div>

        <!-- Pairing list -->
        ${showPairingsPanel && pendingPairings.length > 0
          ? html`
              <div class="platform-expand-panel">
                <div class="pairing-list">
                  ${pendingPairings.map((p) => this._renderPairingItem(p))}
                </div>
              </div>
            `
          : nothing}

        <!-- Config expand panel -->
        ${isExpanded ? this._renderPlatformConfigPanel(platform) : nothing}
      </div>
    `;
  }

  private _renderPairingItem(pairing: PairingEntry) {
    const isApproving = this.approvingPairing === pairing.code;
    const expiresIn = Math.max(0, new Date(pairing.expiresAt).getTime() - Date.now());
    const expiresMinutes = Math.ceil(expiresIn / 60000);
    return html`
      <div class="pairing-item">
        <span class="pairing-code">${pairing.code}</span>
        <span class="pairing-meta">${pairing.senderId} / ${pairing.channelId}</span>
        <span class="pairing-expires">${expiresMinutes}m left</span>
        <button
          class="btn btn-p"
          aria-label="Approve pairing ${pairing.code}"
          ?disabled=${isApproving}
          @click=${() => this._approvePairing(pairing.code)}
        >
          ${isApproving ? 'Approving...' : 'Approve'}
        </button>
      </div>
    `;
  }

  private _renderPlatformConfigPanel(platform: GatewayPlatform) {
    return html`
      <div class="platform-expand-panel">
        <!-- Token / webhook config -->
        <div class="form-group">
          <label class="form-label">Token</label>
          <input
            class="form-input"
            type="password"
            placeholder="Bot token or API key"
            aria-label="Token for ${platform.name}"
            .value=${this.platformConfigForm['token'] ?? ''}
            @input=${(e: InputEvent) => {
              this.platformConfigForm = {
                ...this.platformConfigForm,
                token: (e.target as HTMLInputElement).value,
              };
            }}
          />
        </div>
        <div class="form-group">
          <label class="form-label">Webhook URL</label>
          <input
            class="form-input"
            placeholder="https://..."
            aria-label="Webhook URL for ${platform.name}"
            .value=${this.platformConfigForm['webhookUrl'] ?? ''}
            @input=${(e: InputEvent) => {
              this.platformConfigForm = {
                ...this.platformConfigForm,
                webhookUrl: (e.target as HTMLInputElement).value,
              };
            }}
          />
        </div>

        <!-- Policy settings -->
        <div class="form-group">
          <label class="form-label">Policy</label>
          <div class="policy-row">
            <label>DM Policy</label>
            <select
              aria-label="DM policy for ${platform.name}"
              .value=${this.platformPolicyForm.dmPolicy}
              @change=${(e: Event) => {
                this.platformPolicyForm = {
                  ...this.platformPolicyForm,
                  dmPolicy: (e.target as HTMLSelectElement).value as DmPolicyMode,
                };
              }}
            >
              <option value="pairing">Pairing</option>
              <option value="allowlist">Allowlist</option>
              <option value="open">Open</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>
          <div class="policy-row">
            <label>Group Policy</label>
            <select
              aria-label="Group policy for ${platform.name}"
              .value=${this.platformPolicyForm.groupPolicy}
              @change=${(e: Event) => {
                this.platformPolicyForm = {
                  ...this.platformPolicyForm,
                  groupPolicy: (e.target as HTMLSelectElement).value as GroupPolicyMode,
                };
              }}
            >
              <option value="allowlist">Allowlist</option>
              <option value="open">Open</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>
          <div class="policy-row">
            <label>Require Mention</label>
            <crowclaw-toggle
              .checked=${this.platformPolicyForm.requireMention}
              aria-label="Require mention for ${platform.name}"
              @change=${() => {
                this.platformPolicyForm = {
                  ...this.platformPolicyForm,
                  requireMention: !this.platformPolicyForm.requireMention,
                };
              }}
            ></crowclaw-toggle>
          </div>
        </div>

        <div class="form-actions">
          <button
            class="btn"
            aria-label="Save policy for ${platform.name}"
            @click=${() => this._savePlatformPolicy(platform)}
          >
            Save Policy
          </button>
          <button
            class="btn btn-p"
            aria-label="Save config for ${platform.name}"
            @click=${() => this._savePlatformConfig(platform)}
          >
            Save Config
          </button>
        </div>
      </div>
    `;
  }

  /* ---- Section 5: Channels ---- */

  private _renderChannels() {
    return html`
      <div class="section-block">
        <div class="section-header">Channels</div>
        ${this.channels.length === 0
          ? html`
              <div class="empty-state">
                <div class="title">No Active Channels</div>
                <div class="subtitle">Channels appear when messages are received via gateway platforms</div>
              </div>
            `
          : html`
              <div class="channel-grid">
                ${this.channels.map((c) => this._renderChannelCard(c))}
              </div>
            `}
      </div>
    `;
  }

  private _renderChannelCard(channel: GatewayChannel) {
    const lastMsg = channel.lastMessageAt
      ? new Date(channel.lastMessageAt).toLocaleString()
      : '--';
    return html`
      <div class="channel-card">
        <div class="channel-card-header">
          <span class="channel-platform">${channel.platform}</span>
          <span class="channel-id" title="${channel.channelId}">${channel.channelId}</span>
          ${channel.muted
            ? html`<span class="tag wn">muted</span>`
            : nothing}
        </div>
        <div class="channel-stats">
          <span>Messages: ${channel.messageCount ?? 0}</span>
          <span>Last: ${lastMsg}</span>
        </div>
        <div class="channel-actions">
          <crowclaw-toggle
            .checked=${!channel.muted}
            aria-label="${channel.muted ? 'Unmute' : 'Mute'} channel ${channel.channelId}"
            @change=${() => this._toggleChannelMute(channel)}
          ></crowclaw-toggle>
        </div>
      </div>
    `;
  }

  /* ---- Section 6: Remote Access ---- */

  private _renderRemoteAccess() {
    const origin = typeof location !== 'undefined' ? location.origin : '';
    const hasTelegram = this.platforms.some((p) => p.name === 'telegram');
    const webhookInfo = this.telegramWebhookInfo;

    return html`
      <div class="section-block">
        <div class="section-header">Remote Access</div>
        <div class="remote-grid">
          <!-- Server URL -->
          <div class="remote-row">
            <span class="label">Server URL</span>
            <span class="value">${origin}</span>
            <button
              class="copy-btn"
              aria-label="Copy server URL"
              @click=${() => this._copyToClipboard(origin)}
            >
              Copy
            </button>
          </div>

          <!-- Public URL override -->
          <div class="remote-row">
            <span class="label">Public URL</span>
            <input
              class="form-input"
              style="flex: 1;"
              placeholder="https://your-public-domain.com (for webhook callbacks)"
              aria-label="Public URL override"
              .value=${this.publicUrlOverride}
              @input=${(e: InputEvent) => {
                this.publicUrlOverride = (e.target as HTMLInputElement).value;
              }}
            />
          </div>

          <!-- Gateway URL -->
          <div class="remote-row">
            <span class="label">Gateway URL</span>
            <span class="value">${this.publicUrlOverride || origin}/api/gateway</span>
            <button
              class="copy-btn"
              aria-label="Copy gateway URL"
              @click=${() => this._copyToClipboard(`${this.publicUrlOverride || origin}/api/gateway`)}
            >
              Copy
            </button>
          </div>

          <!-- Telegram webhook management -->
          ${hasTelegram
            ? html`
                <div class="remote-row" style="flex-direction: column; align-items: stretch;">
                  <div style="display: flex; align-items: center; gap: var(--sp-3); margin-bottom: var(--sp-2);">
                    <span class="label">Telegram Webhook</span>
                    ${webhookInfo?.url
                      ? html`<span class="tag ok">active</span>`
                      : html`<span class="tag">not set</span>`}
                  </div>

                  ${webhookInfo?.url
                    ? html`
                        <div class="webhook-info">
                          <div>URL: <span class="webhook-url">${webhookInfo.url}</span></div>
                          ${webhookInfo.pending_update_count != null
                            ? html`<div>Pending updates: ${webhookInfo.pending_update_count}</div>`
                            : nothing}
                          ${webhookInfo.last_error_message
                            ? html`<div class="webhook-error">Last error: ${webhookInfo.last_error_message}</div>`
                            : nothing}
                        </div>
                      `
                    : nothing}

                  <div class="webhook-actions">
                    <input
                      class="form-input"
                      placeholder="${this.publicUrlOverride || origin}/api/gateway/telegram/webhook"
                      aria-label="Webhook URL for Telegram"
                      .value=${this.webhookUrlInput}
                      @input=${(e: InputEvent) => {
                        this.webhookUrlInput = (e.target as HTMLInputElement).value;
                      }}
                    />
                    <button
                      class="btn btn-p"
                      aria-label="Set Telegram webhook"
                      ?disabled=${this.settingWebhook}
                      @click=${() => {
                        if (!this.webhookUrlInput.trim()) {
                          this.webhookUrlInput = `${this.publicUrlOverride || origin}/api/gateway/telegram/webhook`;
                        }
                        this._setTelegramWebhook();
                      }}
                    >
                      ${this.settingWebhook ? 'Setting...' : 'Set Webhook'}
                    </button>
                    ${webhookInfo?.url
                      ? html`
                          <button
                            class="btn btn-danger"
                            aria-label="Delete Telegram webhook"
                            ?disabled=${this.deletingWebhook}
                            @click=${() => {
                              if (this.showWebhookDeleteConfirm) {
                                this._deleteTelegramWebhook();
                              } else {
                                this.showWebhookDeleteConfirm = true;
                              }
                            }}
                          >
                            ${this.deletingWebhook
                              ? 'Deleting...'
                              : this.showWebhookDeleteConfirm
                                ? 'Confirm Delete'
                                : 'Delete Webhook'}
                          </button>
                        `
                      : nothing}
                  </div>
                  ${this.showWebhookDeleteConfirm && !this.deletingWebhook
                    ? html`<div class="confirm-msg">Click "Confirm Delete" to remove the webhook</div>`
                    : nothing}
                </div>
              `
            : nothing}
        </div>
      </div>
    `;
  }

  /* ---- Section 7: Tools Browser ---- */

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
