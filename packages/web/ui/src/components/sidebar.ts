import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export type ViewName = 'chat' | 'agent' | 'connect' | 'automate' | 'settings';

interface NavItem {
  view: ViewName;
  label: string;
  badge?: number;
}

@customElement('crowclaw-sidebar')
export class CrowClawSidebar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 220px;
      background: var(--bg-secondary, #13131a);
      border-right: 1px solid var(--glass-border, rgba(255, 255, 255, 0.08));
      flex-shrink: 0;
      height: 100%;
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Inter', sans-serif);
      user-select: none;
    }

    /* ---- Logo ---- */
    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 20px 16px 16px;
      font-weight: 700;
      font-size: 15px;
      letter-spacing: -0.02em;
      color: var(--text-primary, #ededef);
    }

    .logo svg {
      width: 28px;
      height: 28px;
      flex-shrink: 0;
    }

    /* ---- Navigation ---- */
    .nav {
      flex: 1;
      padding: 0 8px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .nav-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 12px;
      font-size: var(--text-sm, 13px);
      color: var(--text-secondary, #8e8e93);
      cursor: pointer;
      transition: all var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
      border-radius: var(--radius-sm, 6px);
      border-left: 3px solid transparent;
      position: relative;
    }

    .nav-item:hover {
      color: var(--text-primary, #ededef);
      background: var(--bg-card, rgba(255, 255, 255, 0.04));
    }

    .nav-item.active {
      color: var(--text-primary, #ededef);
      background: var(--accent-soft, rgba(224, 85, 69, 0.15));
      border-left-color: var(--accent, #e05545);
    }

    .nav-item.active:hover {
      background: var(--accent-soft, rgba(224, 85, 69, 0.15));
    }

    .nav-item svg {
      width: 18px;
      height: 18px;
      flex-shrink: 0;
    }

    .nav-label {
      flex: 1;
    }

    /* ---- Badge ---- */
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      border-radius: 9px;
      font-size: 10px;
      font-weight: 600;
      font-family: var(--font-mono, 'SF Mono', 'JetBrains Mono', monospace);
      background: var(--bg-card-hover, rgba(255, 255, 255, 0.07));
      color: var(--text-secondary, #8e8e93);
      line-height: 1;
    }

    .nav-item.active .badge {
      background: rgba(224, 85, 69, 0.25);
      color: var(--accent-hover, #ff6b5b);
    }

    /* ---- Footer ---- */
    .footer {
      padding: var(--sp-3, 12px) var(--sp-4, 16px);
      border-top: 1px solid var(--glass-border, rgba(255, 255, 255, 0.08));
      font-size: var(--text-xs, 11px);
      color: var(--text-muted, #48484a);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .footer-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .led {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--text-muted, #48484a);
      flex-shrink: 0;
    }

    .led.ok {
      background: var(--success, #30d158);
    }

    .led.er {
      background: var(--error, #ff453a);
    }

    .footer-meta {
      font-family: var(--font-mono, 'SF Mono', 'JetBrains Mono', monospace);
      color: var(--text-muted, #48484a);
      font-size: 10px;
      letter-spacing: 0.2px;
    }
  `;

  @property({ type: String, reflect: true, attribute: 'current-view' })
  currentView: ViewName = 'chat';

  @property({ type: String, reflect: true, attribute: 'connection-status' })
  connectionStatus: 'connecting' | 'connected' | 'error' = 'connecting';

  @property({ type: Number, attribute: 'session-count' })
  sessionCount = 0;

  @property({ type: Number, attribute: 'job-count' })
  jobCount = 0;

  @property({ type: Number, attribute: 'tool-count' })
  toolCount = 0;

  @property({ type: String, attribute: 'model-name' })
  modelName = '';

  private get _navItems(): NavItem[] {
    return [
      { view: 'chat', label: 'Chat', badge: this.sessionCount },
      { view: 'agent', label: 'Agent' },
      { view: 'connect', label: 'Connect' },
      { view: 'automate', label: 'Automate', badge: this.jobCount },
      { view: 'settings', label: 'Settings' },
    ];
  }

  render() {
    return html`
      <div class="logo">
        ${this._logoIcon}
        <span>CrowClaw</span>
      </div>

      <nav class="nav">
        ${this._navItems.map((item) => this._renderNavItem(item))}
      </nav>

      <div class="footer">
        <div class="footer-row">
          <div class="led ${this._ledClass}"></div>
          <span>${this._statusLabel}</span>
        </div>
        ${this.toolCount > 0 || this.modelName
          ? html`
              <div class="footer-meta">
                ${this.toolCount > 0 ? html`${this.toolCount} tools` : nothing}${this.toolCount > 0 && this.modelName ? html` / ` : nothing}${this.modelName ? html`${this.modelName}` : nothing}
              </div>
            `
          : nothing}
      </div>
    `;
  }

  private _renderNavItem(item: NavItem) {
    const isActive = this.currentView === item.view;
    return html`
      <div
        class="nav-item ${isActive ? 'active' : ''}"
        role="button"
        tabindex="0"
        aria-current=${isActive ? 'page' : 'false'}
        @click=${() => this._onNav(item.view)}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            this._onNav(item.view);
          }
        }}
      >
        ${this._iconFor(item.view)}
        <span class="nav-label">${item.label}</span>
        ${item.badge && item.badge > 0
          ? html`<span class="badge">${item.badge}</span>`
          : nothing}
      </div>
    `;
  }

  private _onNav(view: ViewName) {
    this.currentView = view;
    this.dispatchEvent(
      new CustomEvent('view-change', {
        detail: view,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private get _ledClass(): string {
    switch (this.connectionStatus) {
      case 'connected':
        return 'ok';
      case 'error':
        return 'er';
      default:
        return '';
    }
  }

  private get _statusLabel(): string {
    switch (this.connectionStatus) {
      case 'connected':
        return 'Connected';
      case 'error':
        return 'Error';
      default:
        return 'Connecting';
    }
  }

  // ---- SVG Icons (inline) ----

  private _iconFor(view: ViewName) {
    switch (view) {
      case 'chat':
        return this._chatIcon;
      case 'agent':
        return this._agentIcon;
      case 'connect':
        return this._connectIcon;
      case 'automate':
        return this._automateIcon;
      case 'settings':
        return this._settingsIcon;
    }
  }

  private get _logoIcon() {
    return html`<svg viewBox="0 0 28 28" fill="none">
      <rect width="28" height="28" rx="6" fill="var(--accent, #e05545)" />
      <path
        d="M8 10.5C8 9.67 8.67 9 9.5 9h9c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5H16l-3 2.5V17H9.5C8.67 17 8 16.33 8 15.5v-5z"
        fill="#fff"
      />
    </svg>`;
  }

  private get _chatIcon() {
    return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path
        d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z"
      />
    </svg>`;
  }

  private get _agentIcon() {
    return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>`;
  }

  private get _connectIcon() {
    return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path
        d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"
      />
      <path
        d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
      />
    </svg>`;
  }

  private get _automateIcon() {
    return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>`;
  }

  private get _settingsIcon() {
    return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="3" />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
      />
    </svg>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-sidebar': CrowClawSidebar;
  }
}
