import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('crowclaw-toggle')
export class CrowClawToggle extends LitElement {
  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: var(--sp-2, 8px);
    }

    :host([disabled]) {
      opacity: 0.4;
      pointer-events: none;
    }

    .track {
      position: relative;
      width: 36px;
      height: 20px;
      border-radius: 10px;
      background: var(--text-muted, #48484a);
      cursor: pointer;
      transition: background var(--duration-normal, 200ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
      flex-shrink: 0;
    }

    .track[aria-checked='true'] {
      background: var(--accent, #e05545);
    }

    .thumb {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #fff;
      transition: transform var(--duration-normal, 200ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    }

    .track[aria-checked='true'] .thumb {
      transform: translateX(16px);
    }

    .label {
      font-size: var(--text-sm, 13px);
      color: var(--text-primary, #ededef);
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Inter', sans-serif);
      user-select: none;
      cursor: pointer;
    }
  `;

  @property({ type: Boolean, reflect: true }) checked = false;
  @property({ type: Boolean, reflect: true }) disabled = false;
  @property({ type: String }) label = '';

  render() {
    return html`
      <div
        class="track"
        role="switch"
        aria-checked=${this.checked}
        aria-disabled=${this.disabled}
        tabindex=${this.disabled ? -1 : 0}
        @click=${this._toggle}
        @keydown=${this._onKeydown}
      >
        <div class="thumb"></div>
      </div>
      ${this.label
        ? html`<span class="label" @click=${this._toggle}>${this.label}</span>`
        : ''}
    `;
  }

  private _toggle() {
    if (this.disabled) return;
    this.checked = !this.checked;
    this.dispatchEvent(
      new CustomEvent('change', {
        detail: this.checked,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onKeydown(e: KeyboardEvent) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      this._toggle();
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-toggle': CrowClawToggle;
  }
}
