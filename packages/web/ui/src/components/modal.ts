import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export type ModalSize = 'sm' | 'md' | 'lg';

const sizeMap: Record<ModalSize, string> = {
  sm: '400px',
  md: '560px',
  lg: '720px',
};

@customElement('crowclaw-modal')
export class CrowClawModal extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }

    .overlay {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-overlay, rgba(0, 0, 0, 0.6));
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      opacity: 0;
      pointer-events: none;
      transition: opacity var(--duration-normal, 200ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
    }

    .overlay.open {
      opacity: 1;
      pointer-events: auto;
    }

    .box {
      width: 90%;
      background: var(--bg-secondary, #13131a);
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      border-radius: var(--radius-lg, 12px);
      box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.5));
      display: flex;
      flex-direction: column;
      max-height: 85vh;
      transform: translateY(12px);
      opacity: 0;
      transition:
        transform var(--duration-slow, 300ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1)),
        opacity var(--duration-normal, 200ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
    }

    .overlay.open .box {
      transform: translateY(0);
      opacity: 1;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--sp-5, 20px) var(--sp-6, 24px);
      border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      flex-shrink: 0;
    }

    .header-title {
      font-size: var(--text-lg, 16px);
      font-weight: 600;
      color: var(--text-primary, #ededef);
      line-height: 1.2;
    }

    .close-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border: none;
      background: transparent;
      color: var(--text-secondary, #8e8e93);
      font-size: 18px;
      cursor: pointer;
      border-radius: var(--radius-sm, 6px);
      transition: all var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
      line-height: 1;
    }

    .close-btn:hover {
      color: var(--text-primary, #ededef);
      background: var(--surface-1, rgba(255, 255, 255, 0.03));
    }

    .body {
      flex: 1;
      overflow-y: auto;
      padding: var(--sp-6, 24px);
    }

    .footer {
      border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      padding: var(--sp-4, 16px) var(--sp-6, 24px);
      flex-shrink: 0;
    }

    .footer:empty {
      display: none;
    }

    /* Scrollbar inside modal body */
    .body::-webkit-scrollbar {
      width: 5px;
    }
    .body::-webkit-scrollbar-track {
      background: transparent;
    }
    .body::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.08);
      border-radius: var(--radius-sm, 6px);
    }
    .body::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.14);
    }
  `;

  @property({ type: Boolean, reflect: true })
  open = false;

  @property({ type: String })
  title = '';

  @property({ type: String })
  size: ModalSize = 'md';

  render() {
    const maxWidth = sizeMap[this.size] ?? sizeMap.md;

    return html`
      <div
        class="overlay ${this.open ? 'open' : ''}"
        @click=${this._onBackdropClick}
      >
        <div
          class="box"
          style="max-width: ${maxWidth}"
          @click=${(e: Event) => e.stopPropagation()}
        >
          <div class="header">
            <span class="header-title">${this.title}</span>
            <button
              class="close-btn"
              @click=${this._emitClose}
              aria-label="Close"
            >&#215;</button>
          </div>
          <div class="body">
            <slot></slot>
          </div>
          <div class="footer">
            <slot name="footer"></slot>
          </div>
        </div>
      </div>
    `;
  }

  private _onBackdropClick() {
    this._emitClose();
  }

  private _emitClose() {
    this.dispatchEvent(
      new CustomEvent('close', { bubbles: true, composed: true }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-modal': CrowClawModal;
  }
}
