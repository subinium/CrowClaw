import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/**
 * `<crowclaw-empty>` — shared empty-state card with illustration + CTA.
 *
 * Issue #176: every tab on a fresh install showed literal "0 results" with
 * no guidance. This component renders a 200x150 SVG illustration, a title,
 * a one-line description, and a primary CTA button. Each tab wires the
 * right CTA via either `cta-href` (anchor navigation) or `cta-event`
 * (custom event the host listens for).
 *
 * Props:
 *   icon         — built-in icon key: 'chat' | 'memory' | 'skills'
 *                  | 'jobs' | 'mcp' | 'pairing' | 'feedback' | 'usage'
 *                  | 'sessions'. Falls back to a neutral dot illustration.
 *   title        — single-line headline ("No memories yet").
 *   description  — explanation ("Memories are captured automatically when you chat").
 *   cta-label    — button label ("Start a chat"). Omit to suppress the CTA.
 *   cta-href     — when set, CTA is rendered as an <a> opening the URL in a new tab.
 *   cta-event    — when set (and no href), CTA dispatches a CustomEvent of this name
 *                  on click. Bubbles + composed so the host view can listen.
 */
@customElement('crowclaw-empty')
export class CrowClawEmpty extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: var(--sp-8, 32px) var(--sp-4, 16px);
      gap: var(--sp-3, 12px);
      text-align: center;
      color: var(--text-muted, #8a8a8e);
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Inter', sans-serif);
    }

    .illustration {
      width: 200px;
      height: 150px;
      opacity: 0.55;
      flex-shrink: 0;
      color: var(--accent, #5b8def);
    }

    .title {
      font-size: var(--text-base, 14px);
      font-weight: 600;
      color: var(--text-primary, #ededef);
      letter-spacing: -0.01em;
    }

    .description {
      font-size: var(--text-xs, 12px);
      color: var(--text-muted, #8a8a8e);
      line-height: 1.5;
      max-width: 320px;
    }

    .cta {
      margin-top: var(--sp-2, 8px);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: var(--sp-2, 8px) var(--sp-4, 16px);
      background: var(--accent, #5b8def);
      color: #fff;
      border: 1px solid var(--accent, #5b8def);
      border-radius: var(--radius-sm, 4px);
      font-size: var(--text-sm, 13px);
      font-weight: 500;
      font-family: inherit;
      cursor: pointer;
      text-decoration: none;
      transition: background var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
    }

    .cta:hover {
      background: var(--accent-hover, #c4493b);
      border-color: var(--accent-hover, #c4493b);
    }

    .cta:active {
      opacity: 0.85;
      transform: scale(0.98);
    }
  `;

  @property({ type: String }) icon = '';
  @property({ type: String }) title = '';
  @property({ type: String }) description = '';
  @property({ type: String, attribute: 'cta-label' }) ctaLabel = '';
  @property({ type: String, attribute: 'cta-href' }) ctaHref = '';
  @property({ type: String, attribute: 'cta-event' }) ctaEvent = '';

  render() {
    return html`
      <div class="illustration" aria-hidden="true">
        ${this._renderIcon()}
      </div>
      ${this.title ? html`<div class="title">${this.title}</div>` : nothing}
      ${this.description ? html`<div class="description">${this.description}</div>` : nothing}
      ${this.ctaLabel ? this._renderCta() : nothing}
    `;
  }

  private _renderCta() {
    if (this.ctaHref) {
      return html`<a class="cta" href=${this.ctaHref} target="_blank" rel="noopener noreferrer">${this.ctaLabel}</a>`;
    }
    return html`<button class="cta" type="button" @click=${this._fire}>${this.ctaLabel}</button>`;
  }

  private _fire = () => {
    const name = this.ctaEvent || 'crowclaw-empty-cta';
    this.dispatchEvent(
      new CustomEvent(name, { bubbles: true, composed: true, detail: { icon: this.icon } }),
    );
  };

  /** Minimal inline SVG illustrations — rounded shapes, single accent color. */
  private _renderIcon() {
    switch (this.icon) {
      case 'chat':
      case 'sessions':
        return html`<svg viewBox="0 0 200 150" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <rect x="40" y="35" width="100" height="60" rx="14" />
          <rect x="60" y="55" width="80" height="60" rx="14" opacity="0.5" />
          <circle cx="80" cy="65" r="3" fill="currentColor" />
          <circle cx="100" cy="65" r="3" fill="currentColor" />
          <circle cx="120" cy="65" r="3" fill="currentColor" />
        </svg>`;
      case 'memory':
        return html`<svg viewBox="0 0 200 150" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <rect x="55" y="35" width="90" height="80" rx="10" />
          <line x1="65" y1="55" x2="135" y2="55" opacity="0.6" />
          <line x1="65" y1="70" x2="125" y2="70" opacity="0.6" />
          <line x1="65" y1="85" x2="115" y2="85" opacity="0.6" />
          <circle cx="100" cy="115" r="6" />
        </svg>`;
      case 'skills':
        return html`<svg viewBox="0 0 200 150" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <polygon points="100,30 130,55 130,95 100,120 70,95 70,55" />
          <polygon points="100,55 115,67 115,87 100,99 85,87 85,67" opacity="0.5" />
        </svg>`;
      case 'jobs':
        return html`<svg viewBox="0 0 200 150" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <circle cx="100" cy="75" r="38" />
          <line x1="100" y1="55" x2="100" y2="75" />
          <line x1="100" y1="75" x2="115" y2="85" />
          <circle cx="100" cy="75" r="3" fill="currentColor" />
        </svg>`;
      case 'mcp':
        return html`<svg viewBox="0 0 200 150" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <rect x="50" y="45" width="40" height="60" rx="6" />
          <rect x="110" y="45" width="40" height="60" rx="6" />
          <line x1="90" y1="75" x2="110" y2="75" stroke-dasharray="4 3" />
          <circle cx="70" cy="60" r="3" fill="currentColor" />
          <circle cx="130" cy="60" r="3" fill="currentColor" />
        </svg>`;
      case 'pairing':
        return html`<svg viewBox="0 0 200 150" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <circle cx="75" cy="75" r="22" />
          <circle cx="125" cy="75" r="22" />
          <line x1="97" y1="75" x2="103" y2="75" />
        </svg>`;
      case 'feedback':
        return html`<svg viewBox="0 0 200 150" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <path d="M55 50 h90 a8 8 0 0 1 8 8 v34 a8 8 0 0 1 -8 8 h-50 l-15 15 v-15 h-25 a8 8 0 0 1 -8 -8 v-34 a8 8 0 0 1 8 -8 z" />
          <line x1="80" y1="70" x2="120" y2="70" opacity="0.6" />
          <line x1="80" y1="82" x2="110" y2="82" opacity="0.6" />
        </svg>`;
      case 'usage':
        return html`<svg viewBox="0 0 200 150" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <line x1="50" y1="115" x2="150" y2="115" />
          <rect x="65" y="85" width="14" height="30" rx="3" />
          <rect x="93" y="65" width="14" height="50" rx="3" />
          <rect x="121" y="50" width="14" height="65" rx="3" opacity="0.5" />
        </svg>`;
      default:
        return html`<svg viewBox="0 0 200 150" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
          <circle cx="100" cy="75" r="32" />
          <circle cx="100" cy="75" r="4" fill="currentColor" />
        </svg>`;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-empty': CrowClawEmpty;
  }
}
