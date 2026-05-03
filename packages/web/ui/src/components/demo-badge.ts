import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/**
 * Issue #175: Persistent header pill that surfaces DEMO mode when the runtime
 * is using EchoProvider (no real LLM key). The orchestrator inserts this into
 * the app header when system-status reports `provider === 'echo'`.
 *
 * Renders nothing when `active` is false so it can sit unconditionally in the
 * header template.
 */
@customElement('crowclaw-demo-badge')
export class CrowClawDemoBadge extends LitElement {
  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
    }

    :host([hidden]) {
      display: none;
    }

    /* v0.8.4 #245: switched the demo badge from the legacy warning-red
       brand surface to the muted-blue accent. The badge now reads as an
       info chip rather than an error chip — it's a status indicator,
       not an alert. */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: var(--sp-2, 8px);
      padding: 4px 10px;
      border-radius: var(--radius-pill, 999px);
      background: var(--accent-soft, rgba(91, 141, 239, 0.12));
      border: 1px solid var(--accent, #5b8def);
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Inter', sans-serif);
      font-size: var(--text-xs, 11px);
      font-weight: 600;
      color: var(--accent, #5b8def);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      user-select: none;
    }

    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent, #5b8def);
      box-shadow: 0 0 6px rgba(91, 141, 239, 0.7);
      animation: pulse 1.6s ease-in-out infinite;
    }

    .label {
      line-height: 1;
    }

    .link {
      color: var(--accent, #5b8def);
      text-decoration: none;
      font-weight: 500;
      text-transform: none;
      letter-spacing: 0;
      font-size: var(--text-xs, 11px);
      cursor: pointer;
      border-left: 1px solid rgba(91, 141, 239, 0.35);
      padding-left: var(--sp-2, 8px);
      margin-left: var(--sp-1, 4px);
    }

    .link:hover {
      text-decoration: underline;
    }

    @keyframes pulse {
      0%,
      100% {
        opacity: 1;
        transform: scale(1);
      }
      50% {
        opacity: 0.5;
        transform: scale(0.85);
      }
    }
  `;

  /**
   * When false the badge renders nothing. Parent sets this from
   * `system-status.provider === 'echo'`.
   */
  @property({ type: Boolean, reflect: true }) active = false;

  /**
   * Optional override for the connect link target — defaults to the onboarding
   * Connect view route. Kept overridable so future onboarding flows can deep
   * link to a specific provider step without an app-wide change.
   */
  @property({ type: String }) connectHref = '#/connect';

  /**
   * Hide the trailing "Connect real provider" CTA. Useful in compact mode
   * (sidebar / status bar) where the link wraps awkwardly.
   */
  @property({ type: Boolean }) compact = false;

  render() {
    if (!this.active) return html``;

    return html`
      <span class="badge" role="status" aria-label="Demo mode active">
        <span class="dot" aria-hidden="true"></span>
        <span class="label">Demo</span>
        ${this.compact
          ? ''
          : html`<a
              class="link"
              href=${this.connectHref}
              @click=${this._onConnect}
            >Connect real provider</a>`}
      </span>
    `;
  }

  private _onConnect(event: MouseEvent) {
    // Let the default href navigation happen, but also fire a custom event
    // so the SPA router (or app shell) can intercept and switch view without
    // a full reload if it chooses.
    this.dispatchEvent(
      new CustomEvent('connect-provider', {
        detail: { href: this.connectHref },
        bubbles: true,
        composed: true,
      })
    );
    // If the SPA handler called preventDefault on the dispatched event,
    // mirror that on the original click. Lit's CustomEvent default is not
    // cancellable cross-frame, so we keep the anchor href as a fallback.
    void event;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-demo-badge': CrowClawDemoBadge;
  }
}
