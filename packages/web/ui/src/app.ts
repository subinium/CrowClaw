import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { checkAuth, verifyToken, api } from './lib/api.js';
import { connectEventStream } from './lib/sse.js';
import { buttonStyles } from './lib/shared-styles.js';

export type ViewName = 'chat' | 'agent' | 'connect' | 'automate' | 'settings';

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
        transition: all var(--duration-fast) var(--ease-spring);
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

      .ni svg { width: 16px; height: 16px; flex-shrink: 0; opacity: 0.45; transition: opacity var(--duration-fast); }
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

  private _disconnectSSE?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this._checkAuth();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._disconnectSSE?.();
  }

  private async _checkAuth() {
    try {
      this._checkHealth();
      this._connectSSE();
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
      const health = await api<{ ok: boolean }>('/health');
      this.connectionStatus = health.ok ? 'connected' : 'error';
    } catch {
      this.connectionStatus = 'error';
    }
  }

  private _connectSSE() {
    this._disconnectSSE?.();
    this._disconnectSSE = connectEventStream({
      onOpen: () => { this.connectionStatus = 'connected'; },
      onHeartbeat: (data) => {
        if (data.sessions !== undefined) this.sessionCount = data.sessions;
      },
      onError: () => { this.connectionStatus = 'connecting'; },
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

  render() {
    return html`
      <!-- Auth Overlay -->
      <div class="auth-overlay ${this.authenticated ? '' : 'on'}">
        <div class="auth-box">
          <h2>CrowClaw</h2>
          <p>Enter your dashboard token to continue.</p>
          <input id="authIn" type="password" placeholder="Dashboard token..."
                 @keydown=${this._authKeydown}>
          <div class="auth-err">${this.authError}</div>
          <button class="btn btn-p" style="width:100%" @click=${this._authSubmit}>Sign In</button>
        </div>
      </div>

      <!-- Mobile -->
      <div class="mobile-backdrop ${this.mobileOpen ? 'on' : ''}"
           @click=${() => { this.mobileOpen = false; }}></div>
      <button class="hamburger" @click=${() => { this.mobileOpen = !this.mobileOpen; }}>&#9776;</button>

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
            <div class="sb-ft-r">
              <div class="led ${this.connectionStatus === 'connected' ? 'ok' : this.connectionStatus === 'error' ? 'er' : ''}"></div>
              <span>${this.connectionStatus === 'connected' ? 'Connected' : this.connectionStatus === 'error' ? 'Error' : 'Connecting'}</span>
            </div>
            ${this.modelName ? html`<div class="sb-ft-r"><span class="ft-stat">${this.modelName}</span></div>` : ''}
            ${this.toolCount ? html`<div class="sb-ft-r"><span class="ft-stat">${this.toolCount} tools</span></div>` : ''}
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
           @click=${() => { this.currentView = view; this.mobileOpen = false; }}>
        ${icon}${label}
        ${count ? html`<span class="ct">${count}</span>` : ''}
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
  }
}
