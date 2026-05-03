import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { api, ApiError } from '../lib/api.js';

/**
 * Issue #227 — header badge that surfaces the active provider/model so the
 * user always knows what's powering the chat without hunting through Settings.
 *
 * Reads `GET /api/providers/config`, picks the `primary` slot, renders
 * `<provider> · <model>` as a clickable pill that navigates to
 * Connect → Providers when activated.
 *
 * The component also subscribes to a global `crowclaw:provider-config-changed`
 * event so other surfaces (Connect view's provider editor) can broadcast
 * updates without this badge needing to poll.
 */

export interface ProviderBadgeSlot {
  name?: string;
  provider?: string;
  model?: string;
}

interface ProvidersConfigResponse {
  ok?: boolean;
  config?: {
    primary?: ProviderBadgeSlot | null;
  } | null;
  slots?: {
    primary?: ProviderBadgeSlot | null;
  };
}

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  nvidia: 'NVIDIA',
  xai: 'xAI',
  echo: 'Demo',
  cloudflare: 'Cloudflare',
};

/**
 * Pure formatter: derive the visible label from a provider config slot. The
 * unit test pins this contract — keep it total over `null`/missing fields.
 */
export const formatActiveModel = (slot: ProviderBadgeSlot | null | undefined): string => {
  if (!slot) return '';
  const provider = (slot.provider ?? '').trim();
  const model = (slot.model ?? '').trim();
  if (!provider && !model) return '';
  const friendly = provider ? (PROVIDER_LABELS[provider.toLowerCase()] ?? provider) : '';
  if (friendly && model) return `${friendly} · ${model}`;
  return friendly || model;
};

@customElement('crowclaw-active-model-badge')
export class CrowClawActiveModelBadge extends LitElement {
  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
    }

    :host([hidden]) {
      display: none;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: var(--sp-2, 6px);
      height: 28px;
      padding: 0 10px;
      border-radius: var(--radius-pill, 999px);
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      background: var(--bg-input, rgba(255, 255, 255, 0.03));
      color: var(--text-primary, #ededef);
      font-size: var(--text-xs, 11px);
      font-weight: 500;
      font-family: var(--font-sans, 'Inter', sans-serif);
      cursor: pointer;
      max-width: 260px;
    }

    .badge:hover {
      border-color: var(--accent, #e05545);
    }

    .badge:focus-visible {
      outline: 2px solid var(--accent, #e05545);
      outline-offset: 1px;
    }

    .label {
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .icon {
      width: 12px;
      height: 12px;
      flex-shrink: 0;
      opacity: 0.7;
    }

    .err {
      color: var(--text-muted, #6f6f78);
      font-style: italic;
    }
  `;

  /**
   * Optional override of the click target. Defaults to `#connect`. The
   * orchestrator (or future routing changes) can deep-link to a sub-section
   * by setting e.g. `#connect/providers`.
   */
  @property({ type: String }) connectHref = '#connect';

  @state() private _label = '';
  @state() private _empty = true;
  @state() private _error = '';

  private _configChangedHandler = () => {
    void this._fetch();
  };

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener(
      'crowclaw:provider-config-changed',
      this._configChangedHandler,
    );
    void this._fetch();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener(
      'crowclaw:provider-config-changed',
      this._configChangedHandler,
    );
  }

  /** Public hook so the orchestrator can force a refresh after a save. */
  refresh(): Promise<void> {
    return this._fetch();
  }

  private async _fetch(): Promise<void> {
    try {
      const data = await api<ProvidersConfigResponse>('/api/providers/config');
      const slot =
        data.config?.primary ??
        data.slots?.primary ??
        null;
      const label = formatActiveModel(slot ?? null);
      this._label = label;
      this._empty = !label;
      this._error = '';
    } catch (err: unknown) {
      this._error = err instanceof ApiError ? err.message : 'Failed to load provider';
      this._empty = true;
      this._label = '';
    }
  }

  private _onClick(e: Event): void {
    // Let anchor href handle the hash navigation, but emit a custom event so
    // the SPA shell can intercept (mirrors demo-badge contract).
    this.dispatchEvent(
      new CustomEvent('navigate-providers', {
        detail: { href: this.connectHref },
        bubbles: true,
        composed: true,
      }),
    );
    void e;
  }

  render() {
    if (this._empty && this._error) {
      return html`
        <a class="badge err"
           href=${this.connectHref}
           aria-label="Provider unavailable. Configure in Connect."
           @click=${this._onClick}>
          <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor"
               stroke-width="1.5" aria-hidden="true">
            <circle cx="8" cy="8" r="6.5"/>
            <line x1="8" y1="5" x2="8" y2="9" stroke-linecap="round"/>
            <line x1="8" y1="11" x2="8.01" y2="11" stroke-linecap="round"/>
          </svg>
          <span class="label">Configure provider</span>
        </a>
      `;
    }
    if (this._empty) {
      return html`
        <a class="badge err"
           href=${this.connectHref}
           aria-label="No provider configured. Open Connect → Providers."
           @click=${this._onClick}>
          <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor"
               stroke-width="1.5" aria-hidden="true">
            <path d="M3 5h10M3 8h10M3 11h6" stroke-linecap="round"/>
          </svg>
          <span class="label">Configure provider</span>
        </a>
      `;
    }
    return html`
      <a class="badge"
         href=${this.connectHref}
         aria-label="Active provider: ${this._label}. Click to manage in Connect."
         title="Active provider — click to edit in Connect"
         @click=${this._onClick}>
        <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor"
             stroke-width="1.5" aria-hidden="true">
          <rect x="2.5" y="3.5" width="11" height="9" rx="1.2"/>
          <line x1="2.5" y1="6" x2="13.5" y2="6"/>
          <circle cx="4.5" cy="4.75" r="0.4" fill="currentColor"/>
        </svg>
        <span class="label">${this._label}</span>
        ${nothing}
      </a>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-active-model-badge': CrowClawActiveModelBadge;
  }
}
