import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { api, ApiError } from '../lib/api.js';
import { showToast } from './toast.js';

/**
 * Issue #197 — Header persona switcher.
 *
 * Renders a compact pill that displays the active persona's name with a
 * chevron. Clicking the pill opens a dropdown listing every persona known to
 * the runtime (`GET /api/personas`); each row has a "Preview" affordance that
 * opens a modal showing the persona's identity / system-prompt summary before
 * activation. Confirmation in the modal triggers `POST /api/persona/switch`.
 *
 * Backend contract is the existing PersonaRegistry surface — there is no
 * per-persona detail endpoint, so the modal can show the rich payload only
 * for the *currently active* persona (`GET /api/persona/active` returns
 * `name`, `identity`, and `promptPreview`). For non-active personas the modal
 * shows the name + a sample greeting + a confirm button to switch and load
 * the full prompt afterwards.
 *
 * The pill self-fetches its data on mount and subscribes to a global
 * `crowclaw:persona-switched` event so other surfaces (settings-view,
 * onboarding-view) that mutate the active persona keep this header pill in
 * sync without coupling.
 */

interface PersonaListEntry {
  name: string;
  active: boolean;
}

interface PersonaIdentity {
  name?: string;
  type?: string;
  vibe?: string;
  style?: string;
  [key: string]: unknown;
}

interface ActivePersonaResponse {
  name: string;
  identity: PersonaIdentity;
  promptPreview: string;
}

interface PersonasListResponse {
  personas: PersonaListEntry[];
}

interface SwitchResponse {
  ok: boolean;
  active?: string;
  error?: string;
}

const FALLBACK_GREETING = "Hi — I'm here to help. Tell me what you'd like to work on.";

/**
 * Build a minimal sample greeting from an identity payload. Pure helper —
 * exported so the focused unit test can pin the contract without rendering
 * the Lit element.
 */
export const sampleGreetingFor = (identity: PersonaIdentity | undefined, name: string): string => {
  if (!identity) return FALLBACK_GREETING;
  const persona = (identity.name ?? name).trim();
  const vibe = typeof identity.vibe === 'string' ? identity.vibe.trim() : '';
  if (persona && vibe) return `Hi — I'm ${persona}. ${vibe}`;
  if (persona) return `Hi — I'm ${persona}. How can I help today?`;
  return FALLBACK_GREETING;
};

/**
 * Derive the label rendered in the pill. Trims whitespace, falls back to a
 * sentinel when nothing is loaded yet. Exported for tests.
 */
export const personaPillLabel = (active: string | null | undefined): string => {
  const trimmed = (active ?? '').trim();
  return trimmed || 'persona';
};

@customElement('crowclaw-persona-pill')
export class CrowClawPersonaPill extends LitElement {
  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      position: relative;
      font-family: var(--font-sans, 'Inter', sans-serif);
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: var(--sp-2, 6px);
      height: 28px;
      padding: 0 10px;
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      background: var(--bg-input, rgba(255, 255, 255, 0.03));
      border-radius: var(--radius-pill, 999px);
      color: var(--text-primary, #ededef);
      font-size: var(--text-xs, 11px);
      font-weight: 500;
      cursor: pointer;
      transition: border-color var(--duration-fast, 120ms) ease,
        background var(--duration-fast, 120ms) ease;
      max-width: 200px;
    }

    .pill:hover {
      border-color: var(--accent, #e05545);
    }

    .pill:focus-visible {
      outline: 2px solid var(--accent, #e05545);
      outline-offset: 1px;
    }

    .pill .label {
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .pill .chev {
      width: 10px;
      height: 10px;
      flex-shrink: 0;
      transition: transform 120ms ease;
    }

    .pill[aria-expanded='true'] .chev {
      transform: rotate(180deg);
    }

    /* Dropdown */
    .menu {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      min-width: 280px;
      max-width: 320px;
      max-height: 360px;
      overflow-y: auto;
      background: var(--bg-secondary, #13131a);
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      border-radius: var(--radius-md, 8px);
      box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.5));
      padding: var(--sp-2, 6px);
      z-index: 220;
      display: none;
    }

    .menu.open {
      display: block;
    }

    .menu-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--sp-2, 6px);
      padding: var(--sp-2, 6px) var(--sp-3, 8px);
      border-radius: var(--radius-sm, 6px);
      cursor: pointer;
    }

    .menu-row:hover {
      background: var(--surface-1, rgba(255, 255, 255, 0.04));
    }

    .menu-row .name {
      font-size: var(--text-xs, 11px);
      font-weight: 500;
      color: var(--text-primary, #ededef);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .menu-row .meta {
      display: flex;
      align-items: center;
      gap: var(--sp-2, 6px);
    }

    .menu-row .active-tag {
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--success, #30d158);
      border: 1px solid rgba(48, 209, 88, 0.4);
      padding: 1px 5px;
      border-radius: var(--radius-sm, 4px);
    }

    .preview-btn {
      background: transparent;
      border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
      border-radius: var(--radius-sm, 4px);
      color: var(--text-secondary, #8e8e93);
      font-size: 10px;
      padding: 2px 6px;
      cursor: pointer;
    }

    .preview-btn:hover {
      color: var(--text-primary, #ededef);
      border-color: var(--accent, #e05545);
    }

    .menu-empty {
      padding: var(--sp-3, 12px);
      font-size: var(--text-xs, 11px);
      color: var(--text-muted, #6f6f78);
      text-align: center;
    }

    .menu-footer {
      padding: var(--sp-2, 6px) var(--sp-3, 8px);
      margin-top: var(--sp-1, 4px);
      border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      text-align: right;
    }

    .menu-footer a {
      font-size: 10px;
      color: var(--text-muted, #6f6f78);
      text-decoration: none;
    }

    .menu-footer a:hover {
      color: var(--text-primary, #ededef);
    }

    /* Modal */
    .overlay {
      position: fixed;
      inset: 0;
      background: var(--bg-overlay, rgba(0, 0, 0, 0.6));
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      z-index: 320;
      display: none;
      align-items: center;
      justify-content: center;
    }

    .overlay.open {
      display: flex;
    }

    .modal {
      width: 90%;
      max-width: 560px;
      max-height: 80vh;
      background: var(--bg-secondary, #13131a);
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      border-radius: var(--radius-lg, 12px);
      box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.5));
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--sp-4, 16px) var(--sp-5, 20px);
      border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
    }

    .modal-title {
      font-size: var(--text-lg, 16px);
      font-weight: 600;
      color: var(--text-primary, #ededef);
    }

    .modal-close {
      background: transparent;
      border: none;
      color: var(--text-muted, #6f6f78);
      font-size: 18px;
      cursor: pointer;
      padding: 4px 8px;
    }

    .modal-close:hover {
      color: var(--text-primary, #ededef);
    }

    .modal-body {
      flex: 1;
      overflow-y: auto;
      padding: var(--sp-5, 20px);
      display: flex;
      flex-direction: column;
      gap: var(--sp-4, 16px);
    }

    .section-label {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--text-muted, #6f6f78);
      margin-bottom: var(--sp-2, 6px);
    }

    .identity-grid {
      display: grid;
      grid-template-columns: 80px 1fr;
      row-gap: 6px;
      column-gap: 12px;
      font-size: var(--text-xs, 11px);
    }

    .identity-grid dt {
      color: var(--text-muted, #6f6f78);
      font-family: var(--font-mono, monospace);
    }

    .identity-grid dd {
      margin: 0;
      color: var(--text-primary, #ededef);
    }

    .preview-block {
      font-family: var(--font-mono, monospace);
      font-size: var(--text-xs, 11px);
      color: var(--text-secondary, #b0b0b6);
      background: var(--surface-1, rgba(255, 255, 255, 0.03));
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      border-radius: var(--radius-sm, 6px);
      padding: var(--sp-3, 12px);
      max-height: 220px;
      overflow-y: auto;
      white-space: pre-wrap;
    }

    .greeting {
      font-style: italic;
      color: var(--text-secondary, #b0b0b6);
      font-size: var(--text-sm, 13px);
      padding: var(--sp-2, 8px) var(--sp-3, 12px);
      border-left: 2px solid var(--accent, #e05545);
      background: rgba(224, 85, 69, 0.06);
      border-radius: 0 var(--radius-sm, 6px) var(--radius-sm, 6px) 0;
    }

    .modal-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--sp-2, 8px);
      padding: var(--sp-4, 16px) var(--sp-5, 20px);
      border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
    }

    .btn {
      height: 32px;
      padding: 0 14px;
      border-radius: var(--radius-sm, 6px);
      font-size: var(--text-xs, 11px);
      font-weight: 500;
      cursor: pointer;
      border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
      background: transparent;
      color: var(--text-primary, #ededef);
    }

    .btn:hover {
      border-color: var(--accent, #e05545);
    }

    .btn[disabled] {
      cursor: not-allowed;
      opacity: 0.5;
    }

    .btn-p {
      background: var(--accent, #e05545);
      border-color: var(--accent, #e05545);
      color: #fff;
    }

    .btn-p:hover {
      background: var(--accent-hover, #c54836);
      border-color: var(--accent-hover, #c54836);
    }

    .err {
      font-size: var(--text-xs, 11px);
      color: var(--error, #ff453a);
    }

    .empty-note {
      font-size: var(--text-xs, 11px);
      color: var(--text-muted, #6f6f78);
      font-style: italic;
    }
  `;

  /**
   * Optional explicit active-name prop — the parent shell can pass this so
   * the pill renders the right label immediately while the registry fetch
   * is in flight. Otherwise we rely on the self-fetch.
   */
  @property({ type: String }) activeName = '';

  @state() private _personas: PersonaListEntry[] = [];
  @state() private _activeName = '';
  @state() private _menuOpen = false;
  @state() private _modalOpen = false;
  @state() private _modalPersonaName = '';
  @state() private _modalIdentity: PersonaIdentity | null = null;
  @state() private _modalPrompt = '';
  @state() private _modalLoading = false;
  @state() private _modalError = '';
  @state() private _switching = false;
  @state() private _listError = '';

  private _docClickHandler = (e: Event) => {
    if (!this._menuOpen) return;
    const path = e.composedPath();
    if (!path.includes(this)) {
      this._menuOpen = false;
    }
  };

  private _personaSwitchedHandler = () => {
    void this._fetchPersonas();
  };

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('click', this._docClickHandler, true);
    document.addEventListener('crowclaw:persona-switched', this._personaSwitchedHandler);
    if (this.activeName) {
      this._activeName = this.activeName;
    }
    void this._fetchPersonas();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('click', this._docClickHandler, true);
    document.removeEventListener('crowclaw:persona-switched', this._personaSwitchedHandler);
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has('activeName') && this.activeName && this.activeName !== this._activeName) {
      this._activeName = this.activeName;
    }
  }

  /** Public hook so the orchestrator can force a refresh after setup. */
  refresh(): Promise<void> {
    return this._fetchPersonas();
  }

  private async _fetchPersonas(): Promise<void> {
    try {
      const data = await api<PersonasListResponse>('/api/personas');
      const list = (data.personas ?? []).map((p) => ({
        name: p.name,
        active: Boolean(p.active),
      }));
      this._personas = list;
      const active = list.find((p) => p.active);
      if (active) {
        this._activeName = active.name;
      } else if (!this._activeName && list[0]) {
        this._activeName = list[0].name;
      }
      this._listError = '';
    } catch (err: unknown) {
      this._listError = err instanceof ApiError ? err.message : 'Failed to load personas';
    }
  }

  private _togglePill(): void {
    if (!this._menuOpen) {
      this._menuOpen = true;
      // Best-effort refresh on open so a switch from another surface lands.
      void this._fetchPersonas();
    } else {
      this._menuOpen = false;
    }
  }

  private async _openPreview(name: string): Promise<void> {
    this._menuOpen = false;
    this._modalOpen = true;
    this._modalPersonaName = name;
    this._modalIdentity = null;
    this._modalPrompt = '';
    this._modalError = '';
    this._modalLoading = true;
    try {
      // The runtime only exposes the active persona's full payload. If the
      // user is previewing the currently active persona, hydrate from that
      // endpoint. Otherwise we surface the metadata we already have plus a
      // sample greeting derived from the persona name.
      const isActive = this._activeName === name;
      if (isActive) {
        const data = await api<ActivePersonaResponse>('/api/persona/active');
        this._modalIdentity = data.identity ?? null;
        this._modalPrompt = data.promptPreview ?? '';
      }
    } catch (err: unknown) {
      this._modalError =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Failed to load preview';
    } finally {
      this._modalLoading = false;
    }
  }

  private _closeModal(): void {
    if (this._switching) return;
    this._modalOpen = false;
    this._modalPersonaName = '';
    this._modalIdentity = null;
    this._modalPrompt = '';
    this._modalError = '';
  }

  private async _confirmSwitch(): Promise<void> {
    const name = this._modalPersonaName;
    if (!name) return;
    if (name === this._activeName) {
      // Already active — closing is sufficient.
      this._modalOpen = false;
      return;
    }
    this._switching = true;
    this._modalError = '';
    try {
      const res = await api<SwitchResponse>('/api/persona/switch', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        throw new Error(res.error ?? 'Switch failed');
      }
      this._activeName = res.active ?? name;
      // Notify other surfaces (settings-view persona section) so they can
      // refresh their active marker without polling.
      document.dispatchEvent(
        new CustomEvent('crowclaw:persona-switched', {
          detail: { name: this._activeName },
        }),
      );
      this.dispatchEvent(
        new CustomEvent('persona-switched', {
          detail: { name: this._activeName },
          bubbles: true,
          composed: true,
        }),
      );
      showToast(`Persona switched to ${this._activeName}`, 'success');
      this._modalOpen = false;
      this._modalPersonaName = '';
      void this._fetchPersonas();
    } catch (err: unknown) {
      this._modalError =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Switch failed';
    } finally {
      this._switching = false;
    }
  }

  private _navigateToManage(e: Event): void {
    e.preventDefault();
    this._menuOpen = false;
    location.hash = 'settings';
  }

  private _renderMenu() {
    if (this._listError) {
      return html`<div class="menu-empty">${this._listError}</div>`;
    }
    if (!this._personas.length) {
      return html`<div class="menu-empty">No personas registered.</div>`;
    }
    return html`
      ${this._personas.map(
        (p) => html`
          <div class="menu-row" role="button" tabindex="0"
               @click=${() => this._openPreview(p.name)}
               @keydown=${(e: KeyboardEvent) => {
                 if (e.key === 'Enter' || e.key === ' ') {
                   e.preventDefault();
                   void this._openPreview(p.name);
                 }
               }}>
            <span class="name" title=${p.name}>${p.name}</span>
            <span class="meta">
              ${p.active ? html`<span class="active-tag">Active</span>` : nothing}
              <button class="preview-btn"
                      aria-label="Preview persona ${p.name}"
                      @click=${(e: Event) => {
                        e.stopPropagation();
                        void this._openPreview(p.name);
                      }}>Preview</button>
            </span>
          </div>
        `,
      )}
      <div class="menu-footer">
        <a href="#settings" @click=${this._navigateToManage}>Manage personas →</a>
      </div>
    `;
  }

  private _renderIdentity() {
    if (this._modalLoading) {
      return html`<div class="empty-note">Loading persona…</div>`;
    }
    if (this._modalError) {
      return html`<div class="err">${this._modalError}</div>`;
    }
    const id = this._modalIdentity;
    if (!id) {
      return html`<div class="empty-note">
        Activate this persona to view its full system prompt.
      </div>`;
    }
    const rows: Array<[string, string]> = [];
    for (const key of ['name', 'type', 'vibe', 'style']) {
      const val = id[key];
      if (typeof val === 'string' && val.trim()) rows.push([key, val.trim()]);
    }
    if (rows.length === 0) {
      return html`<div class="empty-note">No identity fields parsed.</div>`;
    }
    return html`
      <dl class="identity-grid">
        ${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}
      </dl>
    `;
  }

  private _renderModal() {
    if (!this._modalOpen) return nothing;
    const isActive = this._modalPersonaName === this._activeName;
    const greeting = sampleGreetingFor(this._modalIdentity ?? undefined, this._modalPersonaName);
    return html`
      <div class="overlay open"
           role="dialog"
           aria-modal="true"
           aria-label="Preview persona ${this._modalPersonaName}"
           @click=${(e: Event) => {
             if ((e.target as HTMLElement).classList.contains('overlay')) this._closeModal();
           }}>
        <div class="modal">
          <div class="modal-header">
            <span class="modal-title">${this._modalPersonaName}</span>
            <button class="modal-close" aria-label="Close preview"
                    @click=${this._closeModal}>&#10005;</button>
          </div>
          <div class="modal-body">
            <div>
              <div class="section-label">Identity</div>
              ${this._renderIdentity()}
            </div>
            <div>
              <div class="section-label">Sample greeting</div>
              <div class="greeting">${greeting}</div>
            </div>
            <div>
              <div class="section-label">System prompt preview</div>
              ${this._modalPrompt
                ? html`<div class="preview-block">${this._modalPrompt}</div>`
                : html`<div class="empty-note">
                    ${isActive
                      ? 'Prompt unavailable.'
                      : 'Confirm switch to load this persona’s full prompt.'}
                  </div>`}
            </div>
          </div>
          <div class="modal-actions">
            <button class="btn"
                    @click=${this._closeModal}
                    ?disabled=${this._switching}>Cancel</button>
            <button class="btn btn-p"
                    @click=${this._confirmSwitch}
                    ?disabled=${this._switching}>
              ${this._switching
                ? 'Switching…'
                : isActive
                  ? 'Already active'
                  : 'Switch to this persona'}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  render() {
    const label = personaPillLabel(this._activeName);
    return html`
      <button class="pill"
              type="button"
              aria-haspopup="menu"
              aria-expanded=${this._menuOpen ? 'true' : 'false'}
              aria-label="Switch persona. Active: ${label}"
              @click=${this._togglePill}>
        <span class="label">${label}</span>
        <svg class="chev" viewBox="0 0 12 12" fill="none" stroke="currentColor"
             stroke-width="1.6" aria-hidden="true">
          <path d="M3 4.5l3 3 3-3" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <div class="menu ${this._menuOpen ? 'open' : ''}" role="menu">
        ${this._renderMenu()}
      </div>
      ${this._renderModal()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-persona-pill': CrowClawPersonaPill;
  }
}
