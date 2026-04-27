import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { checkAuth, verifyToken, api, clearAuthToken } from './lib/api.js';
import { connectWebSocket, type WsClient } from './lib/ws.js';
import { buttonStyles } from './lib/shared-styles.js';
import { showToast } from './components/toast.js';

export type ViewName = 'chat' | 'agent' | 'connect' | 'automate' | 'settings';

interface PairingEntry {
  platform: string;
  senderId: string;
  code: string;
  expiresAt: string;
}

interface ActiveSession {
  id: string;
  sessionId?: string;
  model?: string;
  createdAt?: string;
  startedAt?: string;
  status?: string;
}

/* ------------------------------------------------------------------ */
/*  Pairing Modal                                                      */
/* ------------------------------------------------------------------ */

@customElement('crowclaw-pairing-modal')
export class CrowClawPairingModal extends LitElement {
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

      /* Auth Overlay — login dialog, follows design tokens */
      .auth-overlay {
        display: none;
        position: fixed;
        inset: 0;
        background: var(--bg-overlay);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        z-index: 200;
        padding: var(--sp-6);
        box-sizing: border-box;
      }

      .auth-overlay.on {
        display: grid;
        place-items: center;
      }

      .auth-box {
        background: var(--bg-secondary);
        border: 1px solid var(--glass-border);
        padding: var(--sp-6);
        width: 100%;
        max-width: 360px;
        box-sizing: border-box;
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        display: flex;
        flex-direction: column;
        gap: var(--sp-4);
      }

      .auth-brand {
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        margin-bottom: var(--sp-1);
      }

      .auth-brand-mark {
        width: 28px;
        height: 28px;
        border-radius: var(--radius-sm);
        background: linear-gradient(135deg, var(--accent) 0%, var(--accent-hover) 100%);
        display: grid;
        place-items: center;
        color: #fff;
        font-weight: 700;
        font-size: 14px;
        letter-spacing: -0.02em;
      }

      .auth-box h2 {
        font-size: var(--text-lg);
        font-weight: 600;
        letter-spacing: -0.01em;
        margin: 0;
        color: var(--text-primary);
      }

      .auth-box p {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        margin: 0;
        line-height: 1.5;
      }

      .auth-field {
        display: flex;
        flex-direction: column;
        gap: var(--sp-2);
      }

      .auth-label {
        font-size: var(--text-xs);
        font-weight: 500;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      .auth-box input {
        width: 100%;
        padding: 10px var(--sp-3);
        border: 1px solid var(--glass-border);
        background: var(--bg-input);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: var(--font-sans);
        outline: none;
        box-sizing: border-box;
        border-radius: var(--radius-md);
        transition: border-color var(--duration-fast) var(--ease-spring),
                    background var(--duration-fast) var(--ease-spring);
      }

      .auth-box input::placeholder {
        color: var(--text-muted);
        font-family: var(--font-sans);
      }

      .auth-box input:hover:not(:focus) { background: var(--bg-card-hover); }
      .auth-box input:focus {
        border-color: var(--accent);
        background: var(--bg-card-hover);
      }
      .auth-box input:disabled { opacity: 0.5; cursor: not-allowed; }

      .auth-err {
        color: var(--error);
        font-size: var(--text-xs);
        min-height: 14px;
        line-height: 1.2;
      }

      .auth-box .btn {
        width: 100%;
        padding: 10px var(--sp-4);
        font-size: var(--text-sm);
        font-weight: 600;
        margin-top: var(--sp-1);
      }

      /* Mobile */
      .mobile-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 99; }
      .mobile-backdrop.on { display: block; }

      .hamburger {
        display: none; position: fixed; top: 12px; left: 12px; z-index: 101;
        background: var(--bg-tertiary); border: 1px solid var(--glass-border);
        color: var(--text-primary); font-size: 20px; padding: 6px 10px; cursor: pointer;
        border-radius: var(--radius-sm);
      }

      /* Transport / status banners */
      .banner-stack {
        position: sticky;
        top: 0;
        z-index: 50;
        display: flex;
        flex-direction: column;
      }

      .banner {
        padding: 8px var(--sp-4);
        font-size: var(--text-xs);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--sp-3);
        line-height: 1.4;
      }

      .banner.warn {
        background: rgba(255, 214, 10, 0.08);
        border-bottom: 1px solid rgba(255, 214, 10, 0.3);
        color: var(--text-primary);
      }

      .banner.info {
        background: rgba(100, 210, 255, 0.08);
        border-bottom: 1px solid rgba(100, 210, 255, 0.3);
        color: var(--text-primary);
      }

      .banner-msg { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
      .banner-msg svg { flex-shrink: 0; }

      .banner-btn {
        background: transparent;
        border: 1px solid currentColor;
        color: inherit;
        padding: 2px 10px;
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        font-family: inherit;
        cursor: pointer;
        flex-shrink: 0;
      }
      .banner-btn:hover { background: rgba(255, 255, 255, 0.06); }

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
  @state() private authSubmitting = false;
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
  /**
   * True once the WS transport has given up and the SSE fallback is
   * carrying heartbeats only. Surfaces the persistent banner with a
   * reconnect button (issue #141). Cleared on a successful WS open.
   */
  @state() private transportFallback = false;
  /**
   * Snapshot of the most recent `droppedSinceLast` count reported by the
   * heartbeat. The banner shows for ~6s after a non-zero value lands so
   * the user notices a transport issue without it being a permanent UI
   * fixture (issue #145 / web side).
   */
  @state() private droppedFrames = 0;
  private _droppedFramesTimer: ReturnType<typeof setTimeout> | null = null;

  private _wsClient: WsClient | null = null;

  private _authRequiredHandler = () => {
    this.authenticated = false;
    showToast('Session expired. Please sign in again.', 'error');
  };

  private _hashChangeHandler = () => {
    const hash = location.hash.slice(1) as ViewName;
    if (['chat', 'agent', 'connect', 'automate', 'settings'].includes(hash)) {
      this.currentView = hash;
    }
  };

  private _globalKeyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      // Close auth overlay or mobile sidebar
      if (this.mobileOpen) this.mobileOpen = false;
      if (this.presenceOpen) this.presenceOpen = false;
    }
  };

  connectedCallback() {
    super.connectedCallback();
    // Restore view from hash
    const hash = location.hash.slice(1) as ViewName;
    if (['chat', 'agent', 'connect', 'automate', 'settings'].includes(hash)) {
      this.currentView = hash;
    }
    document.addEventListener('crowclaw:auth-required', this._authRequiredHandler);
    window.addEventListener('hashchange', this._hashChangeHandler);
    window.addEventListener('keydown', this._globalKeyHandler);
    this._checkAuth();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._wsClient?.close();
    this._wsClient = null;
    if (this._droppedFramesTimer) {
      clearTimeout(this._droppedFramesTimer);
      this._droppedFramesTimer = null;
    }
    document.removeEventListener('crowclaw:auth-required', this._authRequiredHandler);
    window.removeEventListener('hashchange', this._hashChangeHandler);
    window.removeEventListener('keydown', this._globalKeyHandler);
  }

  private async _checkAuth() {
    try {
      this._checkHealth();
      // Don't connect transport before auth — when a dashToken is configured,
      // the WS/SSE 401s, the client burns through its 3-failure budget, and
      // never reconnects after login. Connect inside _initApp() instead, after
      // we know auth is established.
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
          // Issue #145 (web side): runtime emits droppedSinceLast on the
          // heartbeat when its WS broadcast queue overflows. Surface the
          // count via a transient banner — auto-dismissing keeps the UI
          // calm during a single hiccup but still calls out persistent loss.
          const dropped = typeof data.droppedSinceLast === 'number' ? data.droppedSinceLast : 0;
          if (dropped > 0) {
            this.droppedFrames = dropped;
            if (this._droppedFramesTimer) clearTimeout(this._droppedFramesTimer);
            this._droppedFramesTimer = setTimeout(() => {
              this.droppedFrames = 0;
              this._droppedFramesTimer = null;
            }, 6000);
          }
          return;
        }

        // Issue #140 (web side): typed session lifecycle events. Each one
        // dispatches a DOM event the chat-view picks up to refresh its
        // session list / inject a timeline marker. Toast surfaces the
        // event globally so the user sees it even when on another view.
        if (
          event.type === 'session:steered' ||
          event.type === 'session:aborted' ||
          event.type === 'session:forked' ||
          event.type === 'session:compacted'
        ) {
          document.dispatchEvent(new CustomEvent('crowclaw:session-event', {
            detail: { type: event.type, data: event.data },
          }));
          const verb = event.type.split(':')[1];
          const sid = typeof event.data.sessionId === 'string' ? event.data.sessionId.slice(0, 8) : '';
          showToast(`Session ${sid ? sid + ' ' : ''}${verb}`, 'info');
          return;
        }
      },
      onOpen: () => {
        this.connectionStatus = 'connected';
        // Determine transport: if WsClient.isConnected(), it is WS; otherwise SSE fallback
        this.transportType = this._wsClient?.isConnected() ? 'WS' : 'SSE';
        // A successful WS open clears the fallback banner.
        if (this._wsClient?.isConnected()) {
          this.transportFallback = false;
        }
      },
      onClose: () => {
        this.connectionStatus = 'connecting';
      },
      onError: () => {
        this.connectionStatus = 'connecting';
      },
      onFallback: () => {
        this.transportType = 'SSE';
        this.transportFallback = true;
        // Tell chat-view to switch to non-streaming mode for new sends.
        document.dispatchEvent(new CustomEvent('crowclaw:transport-fallback', { detail: { active: true } }));
      },
      onReconnect: () => {
        this.transportFallback = false;
        document.dispatchEvent(new CustomEvent('crowclaw:transport-fallback', { detail: { active: false } }));
      },
    });
  }

  private _reconnectTransport() {
    this._wsClient?.reconnect();
  }

  private async _initApp() {
    // Establish (or re-establish) the realtime transport now that we're authed.
    // Calling this after a fresh login fixes the empty-dashboard symptom where
    // WS/SSE were started before auth, exhausted their retry budget, and never
    // reconnected.
    this._connectTransport();
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
    this.authSubmitting = true;
    try {
      const ok = await verifyToken(token);
      if (ok) {
        this.authenticated = true;
        this._initApp();
      } else {
        this.authError = 'Invalid token';
      }
    } finally {
      this.authSubmitting = false;
    }
  }

  private _authKeydown(e: KeyboardEvent) {
    // Clear any prior error as soon as the user starts typing again
    if (this.authError) this.authError = '';
    if (e.key === 'Enter') this._authSubmit();
  }

  private _authInput() {
    if (this.authError) this.authError = '';
  }

  private _openPairingModal() {
    const modal = this.shadowRoot?.querySelector<CrowClawPairingModal>('crowclaw-pairing-modal');
    modal?.show();
  }

  private async _togglePresence() {
    this.presenceOpen = !this.presenceOpen;
    if (this.presenceOpen) {
      try {
        const res = await api<{ sessions: Array<{ sessionId: string; status: string; startedAt: string }> }>('/api/sessions/active');
        this.activeSessions = (res.sessions ?? []).map((s) => ({
          id: s.sessionId,
          sessionId: s.sessionId,
          status: s.status,
          startedAt: s.startedAt,
        }));
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
          <div class="auth-brand">
            <div class="auth-brand-mark">C</div>
            <h2>CrowClaw</h2>
          </div>
          <p>Enter your dashboard token to access the runtime control plane.</p>
          <div class="auth-field">
            <label class="auth-label" for="authIn">Dashboard token</label>
            <input id="authIn" type="password" placeholder="••••••••"
                   aria-label="Dashboard authentication token"
                   ?disabled=${this.authSubmitting}
                   @input=${this._authInput}
                   @keydown=${this._authKeydown}>
            <div class="auth-err">${this.authError}</div>
          </div>
          <button class="btn btn-p" aria-label="Sign in"
                  ?disabled=${this.authSubmitting}
                  @click=${this._authSubmit}>
            ${this.authSubmitting ? 'Signing in…' : 'Sign In'}
          </button>
        </div>
      </div>

      <!-- Pairing Modal -->
      <crowclaw-pairing-modal></crowclaw-pairing-modal>

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

            <!-- Pair Device + Logout buttons -->
            ${this.authenticated
              ? html`
                <button class="ft-btn" aria-label="Pair a new device" @click=${this._openPairingModal}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
                    <line x1="12" y1="18" x2="12.01" y2="18"/>
                  </svg>
                  Pair Device
                </button>
                <button class="ft-btn" aria-label="Sign out" @click=${this._logout} style="opacity:0.6">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                    <polyline points="16 17 21 12 16 7"/>
                    <line x1="21" y1="12" x2="9" y2="12"/>
                  </svg>
                  Sign Out
                </button>`
              : nothing}
          </div>
        </aside>

        <main class="mn">
          ${this.authenticated
            ? html`
                <div class="banner-stack">
                  ${this.transportFallback ? html`
                    <div class="banner warn" role="status" aria-live="polite">
                      <span class="banner-msg">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" stroke-width="2" stroke-linecap="round"
                             stroke-linejoin="round" aria-hidden="true">
                          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                          <line x1="12" y1="9" x2="12" y2="13"/>
                          <line x1="12" y1="17" x2="12.01" y2="17"/>
                        </svg>
                        Live streaming unavailable — responses appear after completion.
                      </span>
                      <button class="banner-btn" @click=${this._reconnectTransport}
                              aria-label="Attempt to reconnect WebSocket">Reconnect WS</button>
                    </div>
                  ` : nothing}
                  ${this.droppedFrames > 0 ? html`
                    <div class="banner info" role="status" aria-live="polite">
                      <span class="banner-msg">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" stroke-width="2" stroke-linecap="round"
                             stroke-linejoin="round" aria-hidden="true">
                          <circle cx="12" cy="12" r="10"/>
                          <line x1="12" y1="8" x2="12" y2="12"/>
                          <line x1="12" y1="16" x2="12.01" y2="16"/>
                        </svg>
                        ${this.droppedFrames} event${this.droppedFrames !== 1 ? 's' : ''} dropped from broadcast queue.
                      </span>
                    </div>
                  ` : nothing}
                </div>
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
              `
            : nothing}
        </main>
      </div>
    `;
  }

  private _logout() {
    clearAuthToken();
    this.authenticated = false;
    showToast('Signed out.', 'info');
  }

  private _navigateTo(view: ViewName) {
    this.currentView = view;
    this.mobileOpen = false;
    location.hash = view;
  }

  private _nav(view: ViewName, label: string, icon: ReturnType<typeof html>, count?: number) {
    return html`
      <div class="ni ${this.currentView === view ? 'a' : ''}"
           role="button"
           tabindex="0"
           aria-label="Navigate to ${label}"
           @click=${() => { this._navigateTo(view); }}
           @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { this._navigateTo(view); } }}>
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
    'crowclaw-pairing-modal': CrowClawPairingModal;
  }
}
