import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';

export type ToastType = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  dismissing: boolean;
}

let nextId = 0;

/** Singleton reference so showToast() can reach the container */
let containerInstance: CrowClawToast | null = null;

@customElement('crowclaw-toast')
export class CrowClawToast extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      top: var(--sp-5, 20px);
      right: var(--sp-5, 20px);
      z-index: 2000;
      display: flex;
      flex-direction: column;
      gap: var(--sp-2, 8px);
      pointer-events: none;
    }

    .toast {
      display: flex;
      align-items: center;
      gap: var(--sp-3, 12px);
      min-width: 260px;
      max-width: 380px;
      padding: var(--sp-3, 12px) var(--sp-4, 16px);
      background: var(--bg-secondary, #13131a);
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.08));
      border-radius: var(--radius-md, 8px);
      box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.5));
      font-size: var(--text-sm, 13px);
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Inter', sans-serif);
      color: var(--text-primary, #ededef);
      pointer-events: auto;
      transform: translateX(0);
      opacity: 1;
      animation: slideIn var(--duration-slow, 300ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1)) both;
    }

    .toast.dismissing {
      animation: fadeOut var(--duration-normal, 200ms) ease-out forwards;
    }

    .indicator {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .toast.success .indicator {
      background: var(--success, #30d158);
      box-shadow: 0 0 6px rgba(48, 209, 88, 0.4);
    }
    .toast.success {
      border-color: rgba(48, 209, 88, 0.2);
    }

    .toast.error .indicator {
      background: var(--error, #ff453a);
      box-shadow: 0 0 6px rgba(255, 69, 58, 0.4);
    }
    .toast.error {
      border-color: rgba(255, 69, 58, 0.2);
    }

    .toast.info .indicator {
      background: var(--info, #64d2ff);
      box-shadow: 0 0 6px rgba(100, 210, 255, 0.4);
    }
    .toast.info {
      border-color: rgba(100, 210, 255, 0.2);
    }

    .message {
      flex: 1;
      line-height: 1.4;
    }

    .dismiss-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border: none;
      background: transparent;
      color: var(--text-muted, #48484a);
      font-size: 14px;
      cursor: pointer;
      border-radius: var(--radius-sm, 6px);
      flex-shrink: 0;
      transition: color var(--duration-fast, 120ms) ease;
      line-height: 1;
    }

    .dismiss-btn:hover {
      color: var(--text-secondary, #8e8e93);
    }

    @keyframes slideIn {
      from {
        transform: translateX(100%);
        opacity: 0;
      }
      to {
        transform: translateX(0);
        opacity: 1;
      }
    }

    @keyframes fadeOut {
      from {
        transform: translateX(0);
        opacity: 1;
      }
      to {
        transform: translateX(40px);
        opacity: 0;
      }
    }
  `;

  @state()
  private _toasts: ToastItem[] = [];

  connectedCallback() {
    super.connectedCallback();
    containerInstance = this;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (containerInstance === this) {
      containerInstance = null;
    }
  }

  render() {
    return html`
      ${this._toasts.map(
        (t) => html`
          <div class="toast ${t.type} ${t.dismissing ? 'dismissing' : ''}">
            <span class="indicator"></span>
            <span class="message">${t.message}</span>
            <button
              class="dismiss-btn"
              @click=${() => this._dismiss(t.id)}
              aria-label="Dismiss"
            >&#215;</button>
          </div>
        `,
      )}
    `;
  }

  /**
   * Add a toast to the stack. Called by showToast() or directly.
   */
  add(message: string, type: ToastType = 'info') {
    const id = nextId++;
    this._toasts = [...this._toasts, { id, message, type, dismissing: false }];

    // Auto-dismiss after 3 seconds
    setTimeout(() => this._dismiss(id), 3000);
  }

  private _dismiss(id: number) {
    // Mark as dismissing to trigger fade-out animation
    this._toasts = this._toasts.map((t) =>
      t.id === id ? { ...t, dismissing: true } : t,
    );

    // Remove from DOM after animation completes
    setTimeout(() => {
      this._toasts = this._toasts.filter((t) => t.id !== id);
    }, 200);
  }
}

/**
 * Show a toast notification.
 * Requires a <crowclaw-toast> element to exist in the DOM.
 * If none exists, one is created and appended to document.body.
 */
export const showToast = (
  message: string,
  type: ToastType = 'info',
): void => {
  if (!containerInstance) {
    const el = document.createElement('crowclaw-toast');
    document.body.appendChild(el);
    // connectedCallback will set containerInstance synchronously
  }
  containerInstance!.add(message, type);
};

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-toast': CrowClawToast;
  }
}
