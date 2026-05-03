/**
 * `<crowclaw-button>` — primitive button component (v0.8.1 #246).
 *
 * Variants: primary | secondary | ghost | danger
 * Sizes:    sm | md | lg
 *
 * Slots:
 *   - default: button label (single-line, ellipsis on overflow)
 *   - icon:    leading icon (typically `<crowclaw-icon>`)
 *
 * `loading=true` disables the click and shows a tiny spinner SVG; the icon
 * slot is hidden while loading so the spinner takes its place.
 *
 * `:focus-visible` ring uses `--accent` so keyboard navigation is obvious
 * across all variants. Hover/active states are CSS-only.
 */

import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

@customElement('crowclaw-button')
export class CrowClawButton extends LitElement {
  static styles = css`
    :host {
      display: inline-flex;
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Inter', sans-serif);
    }

    :host([disabled]),
    :host([loading]) {
      cursor: not-allowed;
    }

    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--sp-2, 8px);
      width: 100%;
      border: 1px solid transparent;
      border-radius: var(--radius-sm, 6px);
      font-family: inherit;
      font-weight: 500;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
      transition:
        background var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1)),
        border-color var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1)),
        color var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
    }

    button:focus { outline: none; }
    button:focus-visible {
      outline: 2px solid var(--accent, #5b8def);
      outline-offset: 2px;
    }

    /* Sizes */
    button.sm {
      height: 24px;
      padding: 0 var(--sp-2, 8px);
      font-size: var(--text-xs, 11px);
    }
    button.md {
      height: 32px;
      padding: 0 var(--sp-3, 12px);
      font-size: var(--text-sm, 13px);
    }
    button.lg {
      height: 40px;
      padding: 0 var(--sp-4, 16px);
      font-size: var(--text-base, 14px);
    }

    /* Variants */
    button.primary {
      background: var(--accent, #5b8def);
      border-color: var(--accent, #5b8def);
      color: #fff;
    }
    button.primary:hover:not(:disabled) {
      background: var(--accent-hover, #ff6b5b);
      border-color: var(--accent-hover, #ff6b5b);
    }

    button.secondary {
      background: var(--surface-2, var(--bg-secondary, #1a1a22));
      border-color: var(--border, rgba(255, 255, 255, 0.08));
      color: var(--text, var(--text-primary, #ededef));
    }
    button.secondary:hover:not(:disabled) {
      background: var(--surface-1, rgba(255, 255, 255, 0.06));
      border-color: var(--border, rgba(255, 255, 255, 0.14));
    }

    button.ghost {
      background: transparent;
      border-color: transparent;
      color: var(--text-muted, #8e8e93);
    }
    button.ghost:hover:not(:disabled) {
      background: var(--surface-1, rgba(255, 255, 255, 0.04));
      color: var(--text, var(--text-primary, #ededef));
    }

    button.danger {
      background: var(--error, #ff453a);
      border-color: var(--error, #ff453a);
      color: #fff;
    }
    button.danger:hover:not(:disabled) {
      filter: brightness(1.1);
    }

    button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    /* Single-line label with ellipsis */
    .label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Icon slot wrapper — hidden while loading */
    .icon-slot {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    button.is-loading .icon-slot {
      display: none;
    }

    /* Spinner */
    .spinner {
      display: inline-flex;
      width: 14px;
      height: 14px;
      flex-shrink: 0;
      animation: cc-btn-spin 0.8s linear infinite;
    }
    button.sm .spinner { width: 12px; height: 12px; }
    button.lg .spinner { width: 16px; height: 16px; }

    @keyframes cc-btn-spin {
      to { transform: rotate(360deg); }
    }

    @media (prefers-reduced-motion: reduce) {
      .spinner { animation-duration: 2s; }
      button { transition: none; }
    }
  `;

  @property({ type: String, reflect: true })
  variant: ButtonVariant = 'primary';

  @property({ type: String, reflect: true })
  size: ButtonSize = 'md';

  @property({ type: Boolean, reflect: true })
  loading = false;

  @property({ type: Boolean, reflect: true })
  disabled = false;

  @property({ type: String })
  type: 'button' | 'submit' | 'reset' = 'button';

  @property({ type: String, attribute: 'aria-label' })
  ariaLabelOverride: string | null = null;

  render() {
    const isDisabled = this.disabled || this.loading;
    const cls = `${this.variant} ${this.size}${this.loading ? ' is-loading' : ''}`;
    return html`
      <button
        class=${cls}
        type=${this.type}
        ?disabled=${isDisabled}
        aria-busy=${this.loading ? 'true' : 'false'}
        aria-label=${this.ariaLabelOverride ?? ''}
        @click=${this._onClick}
      >
        ${this.loading
          ? html`
              <span class="spinner" aria-hidden="true">
                <svg viewBox="0 0 16 16" fill="none" width="100%" height="100%">
                  <circle
                    cx="8"
                    cy="8"
                    r="6"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-dasharray="28"
                    stroke-dashoffset="20"
                    opacity="0.85"
                  ></circle>
                </svg>
              </span>
            `
          : null}
        <span class="icon-slot"><slot name="icon"></slot></span>
        <span class="label"><slot></slot></span>
      </button>
    `;
  }

  private _onClick = (e: MouseEvent) => {
    if (this.disabled || this.loading) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-button': CrowClawButton;
  }
}
