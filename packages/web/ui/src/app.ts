import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { checkAuth, verifyToken, api, clearAuthToken } from './lib/api.js';
import { connectWebSocket, type WsClient } from './lib/ws.js';
import { buttonStyles } from './lib/shared-styles.js';
import { showToast } from './components/toast.js';
// Pill action event names live with the component so a rename trips a
// type/build error rather than a silent runtime drift between emitter
// and listener (#177 agent A4).
import { STATUS_PILL_ACTIONS } from './components/status-pill.js';

/* ------------------------------------------------------------------ */
/*  v0.7.0 component contracts (defensive)                             */
/*                                                                     */
/*  Each of these modules is authored by a sibling agent for the       */
/*  v0.7.0 release. We resolve them at runtime via dynamic import in   */
/*  `firstUpdated()` so this file stays type-safe and runtime-safe     */
/*  whether or not the module has landed yet:                          */
/*                                                                     */
/*    - <crowclaw-status-pill>     — issue #177, agent A4              */
/*        components/status-pill.ts                                    */
/*    - <crowclaw-demo-badge>      — issue #175, agent A2 (LANDED)     */
/*        components/demo-badge.ts                                     */
/*    - <crowclaw-onboarding>      — issue #174, agent A1              */
/*        views/onboarding-view.ts                                     */
/*    - registerCommandPalette()   — issue #178, agent A5 (LANDED,     */
/*        depends on components/command-palette.ts which is in flight) */
/*        lib/keyboard.ts                                              */
/*    - shouldShowOnboarding()     — agent A1                          */
/*        views/onboarding-view.ts                                     */
/*                                                                     */
/*  Local fallbacks below let `tsc --noEmit` pass and degrade the      */
/*  runtime gracefully (console.warn instead of throw) until every     */
/*  module is on disk. The dynamic import will swap in real            */
/*  implementations when available.                                    */
/* ------------------------------------------------------------------ */

/** System status payload returned by GET /api/system/status. */
interface SystemStatus {
  /** Provider slot name. 'echo' = demo provider, 'none' = unconfigured. */
  provider?: string;
  /** True iff a real (non-echo) provider is configured. Derived if absent. */
  hasProvider?: boolean;
  /** True iff a config preset is bound (agent A1 onboarding milestone). */
  hasPreset?: boolean;
  /** True iff the user has completed at least one chat (A1 milestone). */
  firstChatComplete?: boolean;
  [key: string]: unknown;
}

/**
 * Handle returned by `registerCommandPalette` — mirrors the contract from
 * `lib/keyboard.ts` (agent A5, issue #178). Restated locally so this file
 * compiles even when the keyboard module fails to load.
 */
interface CommandPaletteHandle {
  open(): void;
  close(): void;
  dispose(): void;
}

/**
 * Type of the dynamic-import payload from `lib/keyboard.js`. We narrow at
 * call-site to avoid taking a hard dependency on the module shape until
 * #178 ships.
 */
type RegisterCommandPaletteFn = (parent: HTMLElement) => CommandPaletteHandle;

/**
 * Default predicate: show the onboarding view when no real provider is
 * configured. Agent A1 is expected to export a richer version from
 * views/onboarding-view.ts; we re-declare the contract locally so this
 * file compiles before A1 lands. Exported for test coverage.
 */
export function defaultShouldShowOnboarding(status: SystemStatus | null): boolean {
  if (!status) return false;
  if (typeof status.hasProvider === 'boolean') return !status.hasProvider;
  // Derive from `provider` field: 'none' or missing means no provider.
  const provider = (status.provider ?? '').toLowerCase();
  return provider === '' || provider === 'none';
}

/**
 * Last-resort Cmd+K registrar used when `lib/keyboard.js` (agent A5) fails
 * to load. Dispatches `crowclaw:open-command-palette` so any later-loaded
 * palette element can still react. Mirrors the real
 * `CommandPaletteHandle` contract. Exported for test coverage.
 */
export function fallbackRegisterCommandPalette(_parent: HTMLElement): CommandPaletteHandle {
  void _parent;
  const handler = (e: KeyboardEvent) => {
    const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
    if (!isCmdK) return;
    e.preventDefault();
    e.stopPropagation();
    document.dispatchEvent(new CustomEvent('crowclaw:open-command-palette'));
  };
  window.addEventListener('keydown', handler, { capture: true });
  return {
    open: () => document.dispatchEvent(new CustomEvent('crowclaw:open-command-palette')),
    close: () => document.dispatchEvent(new CustomEvent('crowclaw:close-command-palette')),
    dispose: () => window.removeEventListener('keydown', handler, { capture: true }),
  };
}

/**
 * v0.8.1 (#246 Phase A): the dedicated Agent view has been merged into
 * Settings → Agent. The top-nav and hash router only know about the four
 * primary surfaces plus onboarding. Bookmarks pointing at the legacy
 * `#agent` hash are redirected to `#settings` in the hash handlers below.
 */
export type ViewName = 'chat' | 'connect' | 'automate' | 'settings' | 'onboarding';

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

      /* #246 Phase B: when the palette dispatches a toggle-sidebar action
         the sidebar collapses to a fixed off-canvas position. We keep it
         in the DOM so focus management and reactive state stay intact. */
      .app.sidebar-collapsed { grid-template-columns: 0 1fr; }
      .app.sidebar-collapsed crowclaw-sidebar { display: none; }

      /* #249 — Skip-to-content link. Visually hidden by default; pulls into
         the top-left corner only when keyboard-focused so AT/keyboard users
         can jump past the sidebar nav. */
      .skip-to-content {
        position: absolute;
        left: -9999px;
        top: auto;
        width: 1px;
        height: 1px;
        overflow: hidden;
        z-index: 1000;
        background: var(--bg-secondary);
        color: var(--accent);
        border: 1px solid var(--accent);
        border-radius: var(--radius-sm);
        padding: var(--sp-2) var(--sp-3);
        font-size: var(--text-sm);
        font-weight: 600;
        text-decoration: none;
      }
      .skip-to-content:focus {
        left: var(--sp-3);
        top: var(--sp-3);
        width: auto;
        height: auto;
        outline: 2px solid var(--accent);
      }

      /* Sidebar (delegated to <crowclaw-sidebar>) — only the slotted
         footer-extras need shell-local styles now. The component owns logo,
         nav, and base footer rendering. */
      .sb-extras { display: flex; flex-direction: column; gap: var(--sp-1); margin-top: var(--sp-2); padding-top: var(--sp-2); border-top: 1px solid var(--glass-border); }
      .sb-extras-row { display: flex; align-items: center; gap: var(--sp-2); }
      .sb-extras .ft-stat { font-size: var(--text-xs); color: var(--text-muted); font-family: var(--font-mono); }

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

      /* App header strip — v0.7.0 (status pill, demo badge, persona, theme) */
      .app-header {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: var(--sp-2);
        padding: var(--sp-2) var(--sp-4);
        border-bottom: 1px solid var(--glass-border);
        background: var(--bg-secondary);
        flex-shrink: 0;
        min-height: 40px;
      }

      .app-header-right {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
      }

      .header-select {
        height: 28px;
        border: 1px solid var(--glass-border);
        background: var(--bg-input);
        color: var(--text-primary);
        border-radius: var(--radius-sm);
        padding: 0 var(--sp-2);
        font-size: var(--text-xs);
      }

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
        crowclaw-sidebar { position: fixed; left: -240px; top: 0; bottom: 0; z-index: 100; transition: left 0.2s ease; }
        crowclaw-sidebar.mobile-open { left: 0; }
        .app { grid-template-columns: 1fr; }
      }
    `,
  ];

  @state() private currentView: ViewName = 'chat';
  @state() private mobileOpen = false;
  /** #248: command palette dispatches `crowclaw:cmdk-action` toggle-sidebar. */
  @state() private sidebarCollapsed = false;
  /** #248: keyboard-help modal shown on `crowclaw:open-shortcut-help`. */
  @state() private shortcutHelpOpen = false;
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
  @state() private themeMode: 'light' | 'dark' | 'system' = 'system';
  @state() private localeMode: 'en' | 'ko' = 'en';
  @state() private releaseLatest: string | null = null;
  @state() private releaseOutdated = false;
  /** Latest snapshot from /api/system/status. Drives onboarding + demo badge. */
  @state() private systemStatus: SystemStatus | null = null;
  /** True when no real provider is configured — gates the onboarding view. */
  @state() private showOnboarding = false;
  /** True when the active provider is the demo "echo" — drives demo-badge. */
  @state() private demoMode = false;
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

  /** Handle returned by registerCommandPalette(); set in firstUpdated. */
  private _commandPaletteHandle: CommandPaletteHandle | null = null;
  /** True after firstUpdated has run once — guards against double registration. */
  private _commandPaletteRegistered = false;
  private _systemThemeQuery: MediaQueryList | null = null;
  private _systemThemeHandler = () => {
    if (this.themeMode === 'system') this._applyTheme();
  };

  private _authRequiredHandler = () => {
    this.authenticated = false;
    showToast('Session expired. Please sign in again.', 'error');
  };

  private _hashChangeHandler = () => {
    const raw = location.hash.slice(1);
    // #246: legacy `#agent` bookmarks redirect to `#settings` (Agent tab lives
    // there now). Mutating the hash re-enters this handler with the canonical
    // value, so we early-return to avoid double-applying state.
    if (raw === 'agent' || raw.startsWith('agent/')) {
      location.hash = 'settings';
      return;
    }
    // `#settings/agent` is the canonical deep-link form for the absorbed
    // Agent surface — strip the sub-route here; the settings view picks up
    // the sub-tab via its own hash listener.
    const view = raw.split('/')[0] as ViewName;
    if (['chat', 'connect', 'automate', 'settings', 'onboarding'].includes(view)) {
      this.currentView = view;
    }
  };

  private _globalKeyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      // Close auth overlay or mobile sidebar / floating panels.
      if (this.mobileOpen) this.mobileOpen = false;
      if (this.presenceOpen) this.presenceOpen = false;
      // #248: dismiss shortcut-help on Esc — A1's component dispatches its
      // own close event but we backstop it here so a stuck modal cannot
      // capture focus indefinitely.
      if (this.shortcutHelpOpen) this.shortcutHelpOpen = false;
    }
  };

  /**
   * Issue #177 (agent A4): the status pill emits these custom events when
   * the user clicks its quick actions. Each one maps to a runtime API call
   * plus a toast. We swallow API errors into the toast so a failed action
   * never crashes the app shell.
   */
  private _reconnectWsHandler = () => {
    this._reconnectTransport();
    showToast('Reconnecting WebSocket…', 'info');
  };

  private _testProviderHandler = async () => {
    try {
      const res = await api<{ ok: boolean; error?: string }>('/api/providers/test', {
        method: 'POST',
        body: JSON.stringify({ slot: 'primary' }),
      });
      if (res.ok) {
        showToast('Provider check passed.', 'success');
      } else {
        showToast(`Provider check failed: ${res.error ?? 'unknown error'}`, 'error');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Provider check failed';
      showToast(msg, 'error');
    }
  };

  private _resumeSchedulerHandler = async () => {
    try {
      await api('/api/scheduler/resume', { method: 'POST' });
      showToast('Scheduler resumed.', 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to resume scheduler';
      showToast(msg, 'error');
    }
  };

  /**
   * #248: command palette dispatches `crowclaw:cmdk-action` with a string
   * `detail.action`. The orchestrator translates each action into the right
   * effect — direct state mutation (sidebar collapse), a re-broadcast
   * window event for chat-view (new-chat / abort-session) or a navigate
   * call (open-settings). Unknown actions are ignored so a future palette
   * update with new actions does not crash the shell.
   */
  private _cmdkActionHandler = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    const action: string | undefined = detail?.action;
    if (!action) return;
    switch (action) {
      case 'new-chat':
        window.dispatchEvent(new CustomEvent('crowclaw:new-chat'));
        break;
      case 'abort-session':
        window.dispatchEvent(new CustomEvent('crowclaw:abort-session'));
        break;
      case 'toggle-sidebar':
        this.sidebarCollapsed = !this.sidebarCollapsed;
        break;
      case 'toggle-inspector':
        window.dispatchEvent(new CustomEvent('crowclaw:toggle-inspector'));
        break;
      case 'open-settings':
        this._navigateTo('settings');
        break;
      case 'open-keyboard-help':
        window.dispatchEvent(new CustomEvent('crowclaw:open-shortcut-help'));
        break;
      default:
        // Unknown action — ignore. Palette may emit other shapes for
        // session/memory/skill picks; those have no shell-level effect.
        break;
    }
  };

  /**
   * #248: window-level open/close events for the keyboard-help modal so any
   * surface (palette, footer button, future hotkey) can request the help
   * sheet without coupling to the modal's element identity.
   */
  private _shortcutHelpOpenHandler = () => {
    this.shortcutHelpOpen = true;
  };

  private _shortcutHelpCloseHandler = () => {
    this.shortcutHelpOpen = false;
  };

  /**
   * #174: when the onboarding wizard reports completion we re-fetch system
   * status (so the demo badge / hasProvider flags reflect the new key) and
   * route to the chat view. We never re-enter onboarding from the same
   * mount unless `/api/system/status` says we should.
   */
  private _onboardingCompleteHandler = async () => {
    try {
      const status = await api<SystemStatus>('/api/system/status');
      this.systemStatus = status;
      this.showOnboarding = defaultShouldShowOnboarding(status);
      this.demoMode = (status.provider ?? '').toLowerCase() === 'echo';
    } catch {
      // If status refetch fails, optimistically clear onboarding so the
      // user isn't stuck on the wizard. Next page load will reconcile.
      this.showOnboarding = false;
    }
    if (!this.showOnboarding) {
      this.currentView = 'chat';
      location.hash = 'chat';
      showToast('Setup complete — welcome to CrowClaw.', 'success');
    }
  };

  connectedCallback() {
    super.connectedCallback();
    this._restorePreferences();
    // Restore view from hash. Legacy `#agent` bookmarks rewrite to `#settings`
    // (the Agent surface was merged into Settings → Agent in v0.8.1 / #246).
    const raw = location.hash.slice(1);
    if (raw === 'agent' || raw.startsWith('agent/')) {
      location.hash = 'settings';
      this.currentView = 'settings';
    } else {
      const view = raw.split('/')[0] as ViewName;
      if (['chat', 'connect', 'automate', 'settings', 'onboarding'].includes(view)) {
        this.currentView = view;
      }
    }
    document.addEventListener('crowclaw:auth-required', this._authRequiredHandler);
    window.addEventListener('hashchange', this._hashChangeHandler);
    window.addEventListener('keydown', this._globalKeyHandler);
    // v0.7.0 status-pill custom events (issue #177, agent A4). Names come
    // from STATUS_PILL_ACTIONS so a rename in either file is caught at
    // build time, not as silent dead UI in production.
    document.addEventListener(STATUS_PILL_ACTIONS.reconnectWs, this._reconnectWsHandler);
    document.addEventListener(STATUS_PILL_ACTIONS.testProvider, this._testProviderHandler);
    document.addEventListener(STATUS_PILL_ACTIONS.resumeScheduler, this._resumeSchedulerHandler);
    // #174 onboarding-view emits this when the user completes the wizard.
    document.addEventListener('crowclaw:onboarding-complete', this._onboardingCompleteHandler);
    // #248 (v0.8.1): command palette → orchestrator action bus. Listening on
    // window because the palette is mounted under document.body, outside
    // this shell's shadow DOM.
    window.addEventListener('crowclaw:cmdk-action', this._cmdkActionHandler);
    window.addEventListener('crowclaw:open-shortcut-help', this._shortcutHelpOpenHandler);
    window.addEventListener('crowclaw:close-shortcut-help', this._shortcutHelpCloseHandler);
    this._systemThemeQuery = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
    this._systemThemeQuery?.addEventListener('change', this._systemThemeHandler);
    this._checkAuth();
  }

  private _restorePreferences() {
    const storedTheme = localStorage.getItem('crowclaw:theme');
    this.themeMode = storedTheme === 'light' || storedTheme === 'dark' || storedTheme === 'system'
      ? storedTheme
      : 'system';
    const storedLocale = localStorage.getItem('crowclaw:locale');
    this.localeMode = storedLocale === 'ko' || storedLocale === 'en'
      ? storedLocale
      : (navigator.language?.toLowerCase().startsWith('ko') ? 'ko' : 'en');
    this._applyTheme();
    document.documentElement.lang = this.localeMode;
  }

  private _applyTheme() {
    const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
    const resolved = this.themeMode === 'system' ? (systemDark ? 'dark' : 'light') : this.themeMode;
    document.documentElement.dataset.theme = resolved;
  }

  private _setTheme(mode: 'light' | 'dark' | 'system') {
    this.themeMode = mode;
    localStorage.setItem('crowclaw:theme', mode);
    this._applyTheme();
  }

  private _setLocale(locale: 'en' | 'ko') {
    this.localeMode = locale;
    localStorage.setItem('crowclaw:locale', locale);
    document.documentElement.lang = locale;
    window.dispatchEvent(new CustomEvent('crowclaw:locale-change', { detail: { locale } }));
  }

  /**
   * Cmd+K registration runs exactly once after the element is in the DOM.
   * `_commandPaletteRegistered` is flipped synchronously so any concurrent
   * `firstUpdated` (Lit can re-run on attribute mutations during boot) is
   * a no-op. We resolve the real `registerCommandPalette` via dynamic
   * import; if `lib/keyboard.js` is missing or its dependency
   * `command-palette.ts` is still in flight, we fall back to a minimal
   * dispatch-only handler so the shortcut still feels alive.
   */
  firstUpdated() {
    if (this._commandPaletteRegistered) return;
    this._commandPaletteRegistered = true;

    // Dynamic import keeps this file independent of agent A5's landing
    // schedule. The keyboard module side-effect-imports
    // `components/command-palette.js`, which currently doesn't exist —
    // failing here is expected and falls through to the fallback.
    import('./lib/keyboard.js')
      .then((mod) => {
        const register = (mod as { registerCommandPalette?: RegisterCommandPaletteFn })
          .registerCommandPalette;
        if (typeof register !== 'function') {
          throw new Error('lib/keyboard.js is missing registerCommandPalette export');
        }
        // `parent` is the element the palette is appended to. Using
        // `document.body` so the palette overlays on top of the app
        // shell's shadow DOM without needing slot plumbing.
        this._commandPaletteHandle = register(document.body);
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn(
          '[crowclaw-app] registerCommandPalette unavailable, using fallback:',
          err,
        );
        this._commandPaletteHandle = fallbackRegisterCommandPalette(document.body);
      });
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
    document.removeEventListener(STATUS_PILL_ACTIONS.reconnectWs, this._reconnectWsHandler);
    document.removeEventListener(STATUS_PILL_ACTIONS.testProvider, this._testProviderHandler);
    document.removeEventListener(STATUS_PILL_ACTIONS.resumeScheduler, this._resumeSchedulerHandler);
    document.removeEventListener('crowclaw:onboarding-complete', this._onboardingCompleteHandler);
    window.removeEventListener('crowclaw:cmdk-action', this._cmdkActionHandler);
    window.removeEventListener('crowclaw:open-shortcut-help', this._shortcutHelpOpenHandler);
    window.removeEventListener('crowclaw:close-shortcut-help', this._shortcutHelpCloseHandler);
    this._systemThemeQuery?.removeEventListener('change', this._systemThemeHandler);
    this._systemThemeQuery = null;
    if (this._commandPaletteHandle) {
      this._commandPaletteHandle.dispose();
      this._commandPaletteHandle = null;
    }
    this._commandPaletteRegistered = false;
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
        }

        // #177 (agent A4): bridge any session:*/gateway:*/job:* event into
        // the window-scoped STATUS_PILL_EVENTBUS_BRIDGE_EVENT so the pill
        // refreshes immediately instead of waiting for its 30s tick. We
        // do this AFTER the toast so the user gets both the notification
        // and the up-to-date pill colour at the same time.
        if (
          typeof event.type === 'string' &&
          (event.type.startsWith('session:') ||
            event.type.startsWith('gateway:') ||
            event.type.startsWith('job:') ||
            // v0.8.0 (#238) — self-improvement loop. Drafts tab listens to
            // `crowclaw-event` for `learning:*` to live-refresh its pending
            // drafts list without waiting for the polling tick.
            event.type.startsWith('learning:') ||
            // v0.8.1 (#246) — chat-view's memory stream subscribes to the
            // `crowclaw-event` bridge for `memory:captured` / `memory:recalled`.
            // Without this allowlist entry the bridge silently drops every
            // memory event and the panel never updates outside its polling tick.
            event.type.startsWith('memory:'))
        ) {
          window.dispatchEvent(new CustomEvent('crowclaw-event', {
            detail: { type: event.type },
          }));
          if (event.type.startsWith('session:')) return; // already handled above
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
    try {
      const release = await api<{ current?: string; latest?: string | null; isOutdated?: boolean }>('/api/system/release-check');
      this.releaseLatest = release.latest ?? null;
      this.releaseOutdated = Boolean(release.isOutdated);
    } catch { /* non-critical */ }

    // v0.7.0: pull system status to decide onboarding + demo-mode flags. The
    // /api/system/status endpoint returns `provider: 'echo'|name|'none'` —
    // 'none' (or absent provider) routes the user to the onboarding view,
    // 'echo' lights the demo badge in the header.
    try {
      const status = await api<SystemStatus>('/api/system/status');
      this.systemStatus = status;

      // Prefer agent A1's `shouldShowOnboarding` from views/onboarding-view.js
      // when available; otherwise use the local default (provider==='none').
      let predicate: (s: SystemStatus | null) => boolean = defaultShouldShowOnboarding;
      try {
        const mod = await import('./views/onboarding-view.js');
        const fn = (mod as { shouldShowOnboarding?: (s: SystemStatus | null) => boolean })
          .shouldShowOnboarding;
        if (typeof fn === 'function') predicate = fn;
      } catch {
        // Module not ready — keep local default.
      }

      this.showOnboarding = predicate(status);
      const provider = (status.provider ?? '').toLowerCase();
      this.demoMode = provider === 'echo';
      // If we have no provider, force the onboarding view as the landing
      // route so the user lands on it regardless of any persisted hash.
      if (this.showOnboarding) {
        this.currentView = 'onboarding';
      }
    } catch {
      // Non-critical: leave onboarding/demoMode at defaults. The header
      // pills simply don't render until status resolves.
    }
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

      <!-- #249 — Skip-to-content link, visually hidden until focused. -->
      <a class="skip-to-content" href="#main-content">Skip to content</a>

      <!-- App Shell -->
      <div class="app ${this.sidebarCollapsed ? 'sidebar-collapsed' : ''}">
        <!-- #246 Phase B — sidebar mounted as the shared
             crowclaw-sidebar component. The previous duplicated inline
             aside-sb markup and CSS was deleted; the sidebar now owns
             its own logo, nav, and footer rendering. The shell still
             owns the connection footer (transport badge + presence list
             + pair/logout) which the component does not render today,
             so we keep that block as a distinct aside-sb-footer next to
             the sidebar. -->
        <crowclaw-sidebar
          class="${this.mobileOpen ? 'mobile-open' : ''}"
          .currentView=${this.currentView === 'onboarding' ? 'chat' : this.currentView}
          .connectionStatus=${this.connectionStatus}
          .sessionCount=${this.sessionCount}
          .jobCount=${this.jobCount}
          .toolCount=${this.toolCount}
          .modelName=${this.modelName}
          @view-change=${(e: CustomEvent<ViewName>) => this._navigateTo(e.detail)}
        >
          <!-- Slotted into <crowclaw-sidebar slot="footer-extras">: transport
               badge, presence panel, instance info, pair/logout. These rely
               on app-shell state + APIs (sessions/active, pairings, auth)
               that don't belong inside the reusable sidebar component. -->
          <div slot="footer-extras" class="sb-extras">
            <div class="sb-extras-row">
              <span class="ft-transport">${this.transportType}</span>
              <span class="ft-stat">${this.subscriberCount} client${this.subscriberCount !== 1 ? 's' : ''}</span>
            </div>

            <div class="sb-extras-row ft-clickable"
                 role="button"
                 tabindex="0"
                 aria-label="Toggle connected clients panel"
                 @click=${this._togglePresence}
                 @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') this._togglePresence(); }}>
              <span class="ft-stat">${this.presenceOpen ? 'Hide sessions' : 'Show sessions'}</span>
            </div>

            <div class="presence-panel ${this.presenceOpen ? 'on' : ''}">
              ${this.activeSessions.length === 0
                ? html`<div class="session-row"><span class="ft-stat">No active sessions</span></div>`
                : this.activeSessions.map(s => html`
                  <div class="session-row">
                    <span class="session-id" title="${s.id}">${s.id}</span>
                    <span class="session-status">${s.status ?? 'active'}</span>
                  </div>
                `)}
            </div>

            ${this.instanceVersion || this.instanceRuntime
              ? html`
                <div class="sb-extras-row">
                  <span class="ft-stat">
                    ${this.instanceVersion ? `v${this.instanceVersion}` : ''}${this.instanceVersion && this.instanceRuntime ? ' / ' : ''}${this.instanceRuntime || ''}
                  </span>
                </div>`
              : nothing}

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
        </crowclaw-sidebar>

        <main class="mn" id="main-content" tabindex="-1">
          ${this.authenticated
            ? html`
                <!-- v0.7.0 header strip: status pill, demo badge, persona, theme -->
                <header class="app-header" role="banner">
                  <div class="app-header-right">
                    <!-- Issue #177 (agent A4) — pill self-polls /api/diagnostics
                         and emits STATUS_PILL_ACTIONS.* CustomEvents which
                         this shell listens for. No props needed; the pill
                         owns its data fetching to keep the orchestrator
                         from coupling to the diagnostics shape. -->
                    <crowclaw-status-pill></crowclaw-status-pill>

                    <!-- Issue #175 (agent A2) — demo-mode badge. Component
                         renders nothing when .active is false, so we set
                         the property and let it self-hide. -->
                    <crowclaw-demo-badge .active=${this.demoMode}></crowclaw-demo-badge>

                    <select
                      class="header-select"
                      aria-label="Language"
                      .value=${this.localeMode}
                      @change=${(e: Event) => this._setLocale((e.target as HTMLSelectElement).value as 'en' | 'ko')}
                    >
                      <option value="en">EN</option>
                      <option value="ko">KO</option>
                    </select>
                    <select
                      class="header-select"
                      aria-label="Theme"
                      .value=${this.themeMode}
                      @change=${(e: Event) => this._setTheme((e.target as HTMLSelectElement).value as 'light' | 'dark' | 'system')}
                    >
                      <option value="system">System</option>
                      <option value="dark">Dark</option>
                      <option value="light">Light</option>
                    </select>
                  </div>
                </header>

                <div class="banner-stack">
                  ${this.releaseOutdated && this.releaseLatest ? html`
                    <div class="banner warn" role="status" aria-live="polite">
                      <span class="banner-msg">CrowClaw v${this.releaseLatest} is available. Running v${this.instanceVersion || 'unknown'}.</span>
                      <a class="banner-btn" href="https://github.com/subinium/CrowClaw/releases" target="_blank" rel="noreferrer">Changelog</a>
                    </div>
                  ` : nothing}
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

                ${this.showOnboarding
                  ? html`
                      <!-- v0.7.0 onboarding (issue #174, agent A1). Shown when
                           shouldShowOnboarding(systemStatus) is true. -->
                      <div class="vw on">
                        <crowclaw-onboarding></crowclaw-onboarding>
                      </div>
                    `
                  : html`
                      <!-- #246 Phase A: 4-surface render. The legacy
                           crowclaw-agent-view block was removed; its
                           content lives under Settings - Agent now. -->
                      <div class="vw ${this.currentView === 'chat' ? 'on' : ''}">
                        <crowclaw-chat-view></crowclaw-chat-view>
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
                    `}
              `
            : nothing}
        </main>
      </div>

      <!-- #248: keyboard-help modal. Mounted only while open so a missing
           crowclaw-shortcut-help element is inert. The component is
           expected to dispatch crowclaw:close-shortcut-help on dismiss;
           we also unmount on Esc via the global keydown handler below. -->
      ${this.shortcutHelpOpen
        ? html`<crowclaw-shortcut-help
            @close=${this._shortcutHelpCloseHandler}
            @crowclaw:close-shortcut-help=${this._shortcutHelpCloseHandler}
          ></crowclaw-shortcut-help>`
        : nothing}
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

  // #246 Phase B: the inline `_nav` row helper and per-view SVG getters were
  // deleted along with `aside.sb`; nav rendering now lives in
  // `<crowclaw-sidebar>` (components/sidebar.ts).
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-app': CrowClawApp;
    'crowclaw-pairing-modal': CrowClawPairingModal;
  }
}
