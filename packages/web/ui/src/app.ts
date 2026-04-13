import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { checkAuth, verifyToken, api } from './lib/api.js';
import { connectWebSocket, type WsClient } from './lib/ws.js';
import { buttonStyles } from './lib/shared-styles.js';

export type ViewName = 'chat' | 'agent' | 'connect' | 'automate' | 'settings';

interface PairingEntry {
  platform: string;
  senderId: string;
  code: string;
  expiresAt: string;
}

interface ActiveSession {
  id: string;
  model?: string;
  createdAt?: string;
  status?: string;
}

/* ------------------------------------------------------------------ */
/*  Pairing Modal                                                      */
/* ------------------------------------------------------------------ */

@customElement('crowclaw-modal')
export class CrowClawModal extends LitElement {
  static styles = [
    buttonStyles,
    css`
      :host { display: block; }

      .overlay {
        display: none;
        position: fixed;
        inset: 0;
        background: var(--bg-overlay);
        z-index: 300;
        align-items: center;
        justify-content: center;
      }

      .overlay.on { display: flex; }

      .modal {
        background: var(--bg-secondary);
        border: 1px solid var(--glass-border);
        padding: var(--sp-6);
        width: 420px;
        max-width: 92vw;
        max-height: 80vh;
        overflow-y: auto;
        border-radius: var(--radius-lg);
      }

      .modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--sp-4);
      }

      .modal-header h3 {
        font-size: var(--text-lg);
        font-weight: 600;
        margin: 0;
      }

      .close-btn {
        background: none;
        border: none;
        color: var(--text-muted);
        font-size: 18px;
        cursor: pointer;
        padding: var(--sp-1);
        line-height: 1;
        transition: color 0.15s;
      }

      .close-btn:hover { color: var(--text-primary); }

      .pairing-list { display: flex; flex-direction: column; gap: var(--sp-3); }

      .pairing-card {
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        padding: var(--sp-3) var(--sp-4);
        border-radius: var(--radius-md);
      }

      .pairing-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: var(--text-sm);
        margin-bottom: var(--sp-1);
      }

      .pairing-row:last-child { margin-bottom: 0; }

      .pairing-label { color: var(--text-muted); font-weight: 500; font-size: var(--text-xs); }
      .pairing-value { color: var(--text-primary); font-family: var(--font-mono); font-size: var(--text-xs); }

      .pairing-actions { margin-top: var(--sp-3); display: flex; justify-content: flex-end; }

      .empty-msg {
        color: var(--text-muted);
        font-size: var(--text-sm);
        text-align: center;
        padding: var(--sp-6) 0;
      }

      .loading-msg {
        color: var(--text-muted);
        font-size: var(--text-xs);
        text-align: center;
        padding: var(--sp-2) 0;
      }
    `,
  ];

  @state() open = false;
  @state() private _pairings: PairingEntry[] = [];
  @state() private _loading = false;
  @state() private _approving = '';
  @state() private _error = '';

  private _pollTimer: ReturnType<typeof setInterval> | null = null;

  show() {
    this.open = true;
    this._fetchPairings();
    this._pollTimer = setInterval(() => this._fetchPairings(), 5000);
  }

  hide() {
    this.open = false;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  private async _fetchPairings() {
    this._loading = true;
    try {
      const res = await api<{ pairings: PairingEntry[] }>('/api/gateway/pairings');
      this._pairings = res.pairings ?? [];
      this._error = '';
    } catch (err: unknown) {
      this._error = err instanceof Error ? err.message : 'Failed to fetch pairings';
    } finally {
      this._loading = false;
    }
  }

  private async _approve(code: string) {
    this._approving = code;
    try {
      await api('/api/gateway/pairing/approve', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      await this._fetchPairings();
    } catch (err: unknown) {
      this._error = err instanceof Error ? err.message : 'Approval failed';
    } finally {
      this._approving = '';
    }
  }

  private _formatExpiry(iso: string): string {
    try {
      const d = new Date(iso);
      const now = Date.now();
      const diffMs = d.getTime() - now;
      if (diffMs <= 0) return 'Expired';
      const mins = Math.ceil(diffMs / 60_000);
      return mins <= 1 ? '<1m' : `${mins}m`;
    } catch {
      return iso;
    }
  }

  render() {
    return html`
      <div class="overlay ${this.open ? 'on' : ''}" @click=${(e: Event) => {
        if ((e.target as HTMLElement).classList.contains('overlay')) this.hide();
      }}>
        <div class="modal" role="dialog" aria-label="Device Pairing">
          <div class="modal-header">
            <h3>Device Pairing</h3>
            <button class="close-btn" aria-label="Close pairing dialog" @click=${() => this.hide()}>&#10005;</button>
          </div>

          ${this._error ? html`<div style="color:var(--error);font-size:var(--text-xs);margin-bottom:var(--sp-3)">${this._error}</div>` : nothing}

          ${this._pairings.length === 0 && !this._loading
            ? html`<div class="empty-msg">No pending pairings</div>`
            : html`
              <div class="pairing-list">
                ${this._pairings.map(p => html`
                  <div class="pairing-card">
                    <div class="pairing-row">
                      <span class="pairing-label">Platform</span>
                      <span class="pairing-value">${p.platform}</span>
                    </div>
                    <div class="pairing-row">
                      <span class="pairing-label">Sender</span>
                      <span class="pairing-value">${p.senderId}</span>
                    </div>
                    <div class="pairing-row">
                      <span class="pairing-label">Code</span>
                      <span class="pairing-value">${p.code}</span>
                    </div>
                    <div class="pairing-row">
                      <span class="pairing-label">Expires</span>
                      <span class="pairing-value">${this._formatExpiry(p.expiresAt)}</span>
                    </div>
                    <div class="pairing-actions">
                      <button class="btn btn-p"
                              aria-label="Approve pairing for ${p.platform} ${p.senderId}"
                              ?disabled=${this._approving === p.code}
                              @click=${() => this._approve(p.code)}>
                        ${this._approving === p.code ? 'Approving...' : 'Approve'}
                      </button>
                    </div>
                  </div>
                `)}
              </div>
            `}

          ${this._loading ? html`<div class="loading-msg">Refreshing...</div>` : nothing}
        </div>
      </div>
    `;
  }
}

/* ------------------------------------------------------------------ */
/*  App Shell                                                          */
/* ------------------------------------------------------------------ */

@customElement('crowclaw-app')
export class CrowClawApp extends LitElement {
  static styles = [
    buttonStyles,
    css`
      :host {
        display: block;
        height: 100%;
      }

      .app {
        display: grid;
        grid-template-columns: 232px 1fr;
        height: 100vh;
      }

      /* Sidebar */
      .sb {
        background: var(--bg-secondary);
        border-right: 1px solid var(--glass-border);
        display: flex;
        flex-direction: column;
      }

      .sb-logo {
        padding: var(--sp-5) var(--sp-5) var(--sp-4);
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        border-bottom: 1px solid var(--glass-border);
        background: linear-gradient(135deg, rgba(224, 85, 69, 0.04) 0%, transparent 60%);
      }

      .sb-logo img { width: 28px; height: 28px; flex-shrink: 0; }
      .sb-logo span { font-size: var(--text-lg); font-weight: 700; letter-spacing: -0.01em; }

      .sb-nav { flex: 1; overflow-y: auto; padding: var(--sp-3) var(--sp-2); }

      .ni {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        padding: var(--sp-2) var(--sp-3);
        font-size: var(--text-sm);
        color: var(--text-secondary);
        cursor: pointer;
        transition: color 0.15s, background 0.15s, border-color 0.15s;
        border-left: 2px solid transparent;
        margin-bottom: 1px;
        border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
      }

      .ni:hover { color: #c8cdd6; background: var(--bg-card-hover); }

      .ni.a {
        color: var(--accent);
        background: var(--accent-soft);
        border-left-color: var(--accent);
        font-weight: 500;
      }

      .ni svg { width: 16px; height: 16px; flex-shrink: 0; opacity: 0.45; transition: opacity 0.15s; }
      .ni:hover svg { opacity: 0.7; }
      .ni.a svg { opacity: 1; }

      .ni .ct {
        margin-left: auto;
        padding: 1px var(--sp-1);
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        color: var(--text-muted);
        border-radius: var(--radius-sm);
      }

      .ni.a .ct { color: var(--accent); background: var(--accent-soft); border-color: rgba(224,85,69,.2); }

      /* Sidebar Footer */
      .sb-ft {
        padding: var(--sp-3) var(--sp-4);
        border-top: 1px solid var(--glass-border);
        display: flex;
        flex-direction: column;
        gap: var(--sp-1);
      }

      .sb-ft-r { display: flex; align-items: center; gap: var(--sp-2); }

      .led { width: 6px; height: 6px; background: var(--text-muted); flex-shrink: 0; border-radius: 50%; }
      .led.ok { background: var(--success); box-shadow: 0 0 8px rgba(48,209,88,.35); }
      .led.er { background: var(--error); box-shadow: 0 0 8px rgba(255,69,58,.35); }

      .sb-ft span { font-size: var(--text-xs); color: var(--text-muted); font-weight: 500; }
      .sb-ft .ft-stat { font-size: var(--text-xs); color: var(--text-muted); font-family: var(--font-mono); }

      .ft-transport {
        font-size: 9px;
        font-weight: 600;
        font-family: var(--font-mono);
        color: var(--text-muted);
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        padding: 0 4px;
        line-height: 16px;
        border-radius: var(--radius-sm);
      }

      .ft-clickable {
        cursor: pointer;
        transition: color 0.15s;
      }

      .ft-clickable:hover { color: var(--text-secondary); }
      .ft-clickable:hover span { color: var(--text-secondary); }

      .ft-btn {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        background: none;
        border: none;
        padding: var(--sp-1) 0;
        color: var(--text-muted);
        font-size: var(--text-xs);
        font-weight: 500;
        font-family: 'Inter', 'Noto Sans KR', var(--font-sans);
        cursor: pointer;
        transition: color 0.15s;
        width: 100%;
        text-align: left;
      }

      .ft-btn:hover { color: var(--accent); }

      .ft-btn svg { width: 12px; height: 12px; flex-shrink: 0; opacity: 0.6; }
      .ft-btn:hover svg { opacity: 1; }

      .presence-panel {
        display: none;
        flex-direction: column;
        gap: var(--sp-1);
        padding: var(--sp-2) 0 0;
        border-top: 1px solid var(--glass-border);
        margin-top: var(--sp-1);
      }

      .presence-panel.on { display: flex; }

      .session-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: var(--text-xs);
        color: var(--text-muted);
        font-family: var(--font-mono);
        padding: 2px 0;
      }

      .session-id { max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .session-status { font-size: 9px; text-transform: uppercase; letter-spacing: 0.4px; }

      /* Main */
      .mn { display: flex; flex-direction: column; overflow: hidden; }

      .mh {
        padding: var(--sp-5) var(--sp-8) 0;
        flex-shrink: 0;
        background: linear-gradient(180deg, rgba(224,85,69,.02) 0%, transparent 100%);
      }

      .mh h2 {
        font-size: var(--text-xl);
        font-weight: 600;
        letter-spacing: -0.01em;
        background: linear-gradient(90deg, var(--text-primary) 0%, var(--text-secondary) 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }

      .mh p { font-size: var(--text-xs); color: var(--text-muted); font-weight: 500; margin-top: 1px; }

      .mb { flex: 1; overflow-y: auto; padding: var(--sp-4) var(--sp-8) var(--sp-8); }

      .vw { display: none; width: 100%; height: 100%; }
      .vw.on { display: flex; flex-direction: column; }

      .placeholder {
        display: flex; align-items: center; justify-content: center;
        height: 100%; color: var(--text-muted); font-size: var(--text-sm);
      }

      /* Auth Overlay */
      .auth-overlay {
        display: none;
        position: fixed; inset: 0;
        background: var(--bg-overlay);
        z-index: 200;
        align-items: center; justify-content: center;
      }

      .auth-overlay.on { display: flex; }

      .auth-box {
        background: var(--bg-secondary);
        border: 1px solid var(--glass-border);
        padding: var(--sp-8);
        width: 360px;
        max-width: 90vw;
        border-radius: var(--radius-lg);
      }

      .auth-box h2 { font-size: var(--text-2xl); font-weight: 700; margin-bottom: var(--sp-2); }
      .auth-box p { font-size: var(--text-sm); color: var(--text-secondary); margin-bottom: var(--sp-5); }

      .auth-box input {
        width: 100%;
        padding: var(--sp-3);
        border: 1px solid var(--glass-border);
        background: var(--bg-input);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: var(--font-mono);
        outline: none;
        margin-bottom: var(--sp-3);
        border-radius: var(--radius-sm);
      }

      .auth-box input:focus { border-color: var(--accent); }

      .auth-err { color: var(--error); font-size: var(--text-xs); margin-bottom: var(--sp-3); min-height: 16px; }

      /* Mobile */
      .mobile-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 99; }
      .mobile-backdrop.on { display: block; }

      .hamburger {
        display: none; position: fixed; top: 12px; left: 12px; z-index: 101;
        background: var(--bg-tertiary); border: 1px solid var(--glass-border);
        color: var(--text-primary); font-size: 20px; padding: 6px 10px; cursor: pointer;
        border-radius: var(--radius-sm);
      }

      @media (max-width: 768px) {
        .hamburger { display: block; }
        .sb { position: fixed; left: -240px; top: 0; bottom: 0; z-index: 100; transition: left 0.2s ease; }
        .sb.mobile-open { left: 0; }
        .app { grid-template-columns: 1fr; }
      }
    `,
  ];

  @state() private currentView: ViewName = 'chat';
  @state() private mobileOpen = false;
  @state() private connectionStatus: 'connecting' | 'connected' | 'error' = 'connecting';
  @state() private authenticated = false;
  @state() private authError = '';
  @state() private sessionCount = 0;
  @state() private jobCount = 0;
  @state() private toolCount = 0;
  @state() private modelName = '';
  @state() private transportType: 'WS' | 'SSE' = 'WS';
  @state() private subscriberCount = 0;
  @state() private presenceOpen = false;
  @state() private activeSessions: ActiveSession[] = [];
  @state() private instanceVersion = '';
  @state() private instanceRuntime = '';

  private _wsClient: WsClient | null = null;

  connectedCallback() {
    super.connectedCallback();
    this._checkAuth();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._wsClient?.close();
    this._wsClient = null;
  }

  private async _checkAuth() {
    try {
      this._checkHealth();
      this._connectTransport();
      const authed = await checkAuth();
      if (authed) {
        this.authenticated = true;
        this._initApp();
      }
    } catch {
      // Auth check failed, show overlay
    }
  }

  private async _checkHealth() {
    try {
      const health = await api<{ ok: boolean; version?: string; runtime?: string }>('/health');
      this.connectionStatus = health.ok ? 'connected' : 'error';
      if (health.version) this.instanceVersion = health.version;
      if (health.runtime) this.instanceRuntime = health.runtime;
    } catch {
      this.connectionStatus = 'error';
    }
  }

  private _connectTransport() {
    this._wsClient?.close();

    this._wsClient = connectWebSocket({
      onEvent: (event) => {
        if (event.type === 'heartbeat') {
          const data = event.data;
          if (typeof data.sessions === 'number') this.sessionCount = data.sessions;
          if (typeof data.subscribers === 'number') this.subscriberCount = data.subscribers;
        }
      },
      onOpen: () => {
        this.connectionStatus = 'connected';
        // Determine transport: if WsClient.isConnected(), it is WS; otherwise SSE fallback
        this.transportType = this._wsClient?.isConnected() ? 'WS' : 'SSE';
      },
      onClose: () => {
        this.connectionStatus = 'connecting';
      },
      onError: () => {
        this.connectionStatus = 'connecting';
      },
    });
  }

  private async _initApp() {
    try {
      const tools = await api<{ tools: unknown[] }>('/api/tools');
      this.toolCount = tools.tools?.length ?? 0;
    } catch { /* non-critical */ }
  }

  private async _authSubmit() {
    const input = this.shadowRoot?.querySelector<HTMLInputElement>('#authIn');
    const token = input?.value.trim();
    if (!token) {
      this.authError = 'Please enter a token';
      return;
    }
    this.authError = '';
    const ok = await verifyToken(token);
    if (ok) {
      this.authenticated = true;
      this._initApp();
    } else {
      this.authError = 'Invalid token';
    }
  }

  private _authKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') this._authSubmit();
  }

  private _openPairingModal() {
    const modal = this.shadowRoot?.querySelector<CrowClawModal>('crowclaw-modal');
    modal?.show();
  }

  private async _togglePresence() {
    this.presenceOpen = !this.presenceOpen;
    if (this.presenceOpen) {
      try {
        const res = await api<{ sessions: ActiveSession[] }>('/api/sessions/active');
        this.activeSessions = res.sessions ?? [];
      } catch {
        this.activeSessions = [];
      }
    }
  }

  render() {
    return html`
      <!-- Auth Overlay -->
      <div class="auth-overlay ${this.authenticated ? '' : 'on'}">
        <div class="auth-box">
          <h2>CrowClaw</h2>
          <p>Enter your dashboard token to continue.</p>
          <input id="authIn" type="password" placeholder="Dashboard token..."
                 aria-label="Dashboard authentication token"
                 @keydown=${this._authKeydown}>
          <div class="auth-err">${this.authError}</div>
          <button class="btn btn-p" style="width:100%" aria-label="Sign in" @click=${this._authSubmit}>Sign In</button>
        </div>
      </div>

      <!-- Pairing Modal -->
      <crowclaw-modal></crowclaw-modal>

      <!-- Mobile -->
      <div class="mobile-backdrop ${this.mobileOpen ? 'on' : ''}"
           @click=${() => { this.mobileOpen = false; }}></div>
      <button class="hamburger" aria-label="Toggle sidebar" @click=${() => { this.mobileOpen = !this.mobileOpen; }}>&#9776;</button>

      <!-- App Shell -->
      <div class="app">
        <aside class="sb ${this.mobileOpen ? 'mobile-open' : ''}">
          <div class="sb-logo">
            <img src="/docs/logo.png" alt="CrowClaw">
            <span>CrowClaw</span>
          </div>
          <nav class="sb-nav">
            <div class="sb-s">
              ${this._nav('chat', 'Chat', this._iconChat, this.sessionCount)}
              ${this._nav('agent', 'Agent', this._iconAgent)}
              ${this._nav('connect', 'Connect', this._iconConnect)}
              ${this._nav('automate', 'Automate', this._iconAutomate, this.jobCount)}
              ${this._nav('settings', 'Settings', this._iconSettings)}
            </div>
          </nav>
          <div class="sb-ft">
            <!-- Connection status + transport badge -->
            <div class="sb-ft-r">
              <div class="led ${this.connectionStatus === 'connected' ? 'ok' : this.connectionStatus === 'error' ? 'er' : ''}"></div>
              <span>${this.connectionStatus === 'connected' ? 'Connected' : this.connectionStatus === 'error' ? 'Error' : 'Connecting'}</span>
              <span class="ft-transport">${this.transportType}</span>
            </div>

            <!-- Presence / connected clients -->
            <div class="sb-ft-r ft-clickable"
                 role="button"
                 tabindex="0"
                 aria-label="Toggle connected clients panel"
                 @click=${this._togglePresence}
                 @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') this._togglePresence(); }}>
              <span class="ft-stat">${this.subscriberCount} client${this.subscriberCount !== 1 ? 's' : ''} connected</span>
            </div>

            <!-- Expandable active sessions panel -->
            <div class="presence-panel ${this.presenceOpen ? 'on' : ''}">
              ${this.activeSessions.length === 0
                ? html`<div class="session-row"><span style="color:var(--text-muted);font-size:var(--text-xs)">No active sessions</span></div>`
                : this.activeSessions.map(s => html`
                  <div class="session-row">
                    <span class="session-id" title="${s.id}">${s.id}</span>
                    <span class="session-status">${s.status ?? 'active'}</span>
                  </div>
                `)}
            </div>

            ${this.modelName ? html`<div class="sb-ft-r"><span class="ft-stat">${this.modelName}</span></div>` : nothing}
            ${this.toolCount ? html`<div class="sb-ft-r"><span class="ft-stat">${this.toolCount} tools</span></div>` : nothing}

            <!-- Instance info from /health -->
            ${this.instanceVersion || this.instanceRuntime
              ? html`
                <div class="sb-ft-r">
                  <span class="ft-stat">
                    ${this.instanceVersion ? `v${this.instanceVersion}` : ''}${this.instanceVersion && this.instanceRuntime ? ' / ' : ''}${this.instanceRuntime || ''}
                  </span>
                </div>`
              : nothing}

            <!-- Pair Device button -->
            ${this.authenticated
              ? html`
                <button class="ft-btn" aria-label="Pair a new device" @click=${this._openPairingModal}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
                    <line x1="12" y1="18" x2="12.01" y2="18"/>
                  </svg>
                  Pair Device
                </button>`
              : nothing}
          </div>
        </aside>

        <main class="mn">
          <div class="vw ${this.currentView === 'chat' ? 'on' : ''}">
            <crowclaw-chat-view></crowclaw-chat-view>
          </div>
          <div class="vw ${this.currentView === 'agent' ? 'on' : ''}">
            <crowclaw-agent-view></crowclaw-agent-view>
          </div>
          <div class="vw ${this.currentView === 'connect' ? 'on' : ''}">
            <div class="mh"><h2>Connect</h2><p>Providers, integrations, and service connections</p></div>
            <div class="mb"><crowclaw-connect-view></crowclaw-connect-view></div>
          </div>
          <div class="vw ${this.currentView === 'automate' ? 'on' : ''}">
            <crowclaw-automate-view></crowclaw-automate-view>
          </div>
          <div class="vw ${this.currentView === 'settings' ? 'on' : ''}">
            <crowclaw-settings-view></crowclaw-settings-view>
          </div>
        </main>
      </div>
    `;
  }

  private _nav(view: ViewName, label: string, icon: ReturnType<typeof html>, count?: number) {
    return html`
      <div class="ni ${this.currentView === view ? 'a' : ''}"
           role="button"
           tabindex="0"
           aria-label="Navigate to ${label}"
           @click=${() => { this.currentView = view; this.mobileOpen = false; }}
           @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { this.currentView = view; this.mobileOpen = false; } }}>
        ${icon}${label}
        ${count ? html`<span class="ct">${count}</span>` : nothing}
      </div>
    `;
  }

  // SVG icons
  private get _iconChat() {
    return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z"/></svg>`;
  }
  private get _iconAgent() {
    return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
  }
  private get _iconConnect() {
    return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
  }
  private get _iconAutomate() {
    return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  }
  private get _iconSettings() {
    return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-app': CrowClawApp;
    'crowclaw-modal': CrowClawModal;
  }
}
